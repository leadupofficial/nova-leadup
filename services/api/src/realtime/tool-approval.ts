/**
 * NOVA API — the ask-before-running gate for side-effecting voice tools.
 *
 * `runStreamingAssistantLoop` used to call `executeToolUses` the moment the
 * model asked for a tool, so a spoken "remind me to…" wrote a reminder with no
 * prompt — while the typed path showed the Tool Confirmation sheet first
 * (blueprint §5.7: "shown before every side-effecting action"). The three tools
 * the voice path offers are all L1 today, so the exposure was bounded, but the
 * gate is structural: the first L2 tool (email, WhatsApp) added to the list
 * would otherwise have executed unconfirmed, and §10.1 requires L2 to always
 * show the full payload first.
 *
 * This module owns the whole decision:
 *
 *   permission level  — from `ASSISTANT_TOOL_LEVELS`, never inferred elsewhere
 *   payload binding   — the approval is bound to the exact canonical JSON the
 *                       user was shown (blueprint §7.5: "side-effecting tools
 *                       need an approval token bound to the exact payload"), so
 *                       mutated arguments void it
 *   correlation       — a globally unique id, checked against the turn, so a
 *                       late response cannot be paired with a later turn
 *   timeout           — no answer is a refusal, never a default-allow
 *
 * Nothing here touches the database or the socket directly; the caller supplies
 * `emit`, which is what makes both branches testable without a live connection.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ToolUseBlock } from '../services/ai.js';
import { toolPermissionLevel, type ToolPermissionLevel } from '../services/assistant-tools.js';
import type { ServerEvent } from './protocol.js';
import { logger } from '../utils/logger.js';

/**
 * How long the client has to answer an approval request.
 *
 * Generous enough to read a payload and decide, short enough that a client that
 * silently dropped the frame (an older build with no approval handling at all)
 * does not leave the turn — and the user — hanging. On expiry the tool does not
 * run: no answer is a refusal.
 */
export const APPROVAL_TIMEOUT_MS = 60_000;

/**
 * Canonical, order-independent hash of a tool payload.
 *
 * Two things matter here. Object keys are sorted, so an equivalent-but-
 * reordered payload hashes the same and the user is not re-prompted for the
 * same action. Everything else is hashed verbatim — a changed title, a changed
 * time, an added key all produce a different hash. That is the property the
 * approval is bound to: the payload that runs is the payload that was shown.
 */
export function toolPayloadHash(input: Record<string, unknown>): string {
	return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		// `undefined` has no JSON representation; dropping it keeps the hash of a
		// payload equal to the hash of the same payload as it crossed the wire.
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

// ─── What will happen, in words ──────────────────────────────────────

function display(value: unknown): string {
	if (value === null || value === undefined) return '—';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return JSON.stringify(value);
}

/**
 * A one-line, human-readable statement of the exact action.
 *
 * The sheet renders the resolved arguments verbatim beside this, so the summary
 * only has to say what the tool *does*; it must never be the only description
 * of the effect.
 */
export function toolApprovalSummary(name: string, input: Record<string, unknown>): string {
	switch (name) {
		case 'create_reminder': {
			const when = input.trigger_at ?? input.triggerAt;
			const zone = input.timezone;
			return `Create a reminder "${display(input.title)}" that goes off at ${display(when)}${
				zone ? ` (${display(zone)})` : ''
			}.`;
		}
		case 'create_task':
			return `Add the task "${display(input.title)}"${
				input.due_at ? `, due ${display(input.due_at)}` : ' with no deadline'
			}.`;
		case 'save_memory':
			return `Save to memory (${display(input.category)}): "${display(input.content)}".`;
		default:
			// Unknown tools are L3 and only reach here if a definition is missing
			// from the registry; say "run" rather than invent an effect.
			return `Run "${name}" with the arguments shown below.`;
	}
}

// ─── Decisions ───────────────────────────────────────────────────────

export type ToolApprovalStatus = 'approved' | 'rejected' | 'timeout' | 'cancelled';

/**
 * A resolved answer from the client.
 *
 * `payloadHash` is the hash of the payload the user was *shown*, not of
 * whatever the model produced afterwards — comparing the two is the binding.
 */
export interface ToolApprovalDecision {
	approvalId: string;
	turnId: number;
	toolUseId: string;
	toolName: string;
	level: ToolPermissionLevel;
	status: ToolApprovalStatus;
	payloadHash: string;
}

/**
 * How the tool loop reaches the user.
 *
 * Injected rather than imported so the loop stays testable without a socket and
 * so the wording of "what will happen" is decided in exactly one module.
 */
export type ToolApprovalRequest = (params: {
	turnId: number;
	toolUse: ToolUseBlock;
	level: ToolPermissionLevel;
}) => Promise<ToolApprovalDecision>;

/**
 * Why a tool did not run, or null when it may run.
 *
 * Kept as one pure predicate on purpose: this is the security boundary, and the
 * three ways past it — no decision, a rejection, a mutated payload — are all
 * visible and testable in one place. An id-only check would let the model
 * approve a harmless action and then execute a different one under the same id;
 * the hash comparison is what stops that.
 */
export function toolApprovalOutcome(
	decision: ToolApprovalDecision | null,
	input: Record<string, unknown>,
): 'rejected' | 'timeout' | 'cancelled' | 'payload_mismatch' | 'unbound' | null {
	if (!decision) return 'unbound';
	if (decision.status === 'rejected') return 'rejected';
	if (decision.status === 'timeout') return 'timeout';
	if (decision.status === 'cancelled') return 'cancelled';
	if (decision.payloadHash !== toolPayloadHash(input)) return 'payload_mismatch';
	return null;
}

export interface ToolApprovalBlock {
	/** What to tell the model and the transcript. */
	summary: string;
	/** The machine-readable cause, for the client-facing `tool` event. */
	reason: 'rejected' | 'timeout' | 'cancelled' | 'payload_mismatch' | 'unbound';
}

/**
 * Applies the approval predicate and produces the honest wording for a blocked
 * action. Returns null when the action is clear to run.
 */
export function describeToolApprovalBlock(
	decision: ToolApprovalDecision | null,
	toolUse: ToolUseBlock,
): ToolApprovalBlock | null {
	const reason = toolApprovalOutcome(decision, toolUse.input);
	if (!reason) return null;

	switch (reason) {
		case 'rejected':
			return {
				reason,
				summary: `The user declined to confirm ${toolUse.name}; nothing was ${verbFor(toolUse.name)}.`,
			};
		case 'timeout':
			return {
				reason,
				summary: `No confirmation arrived for ${toolUse.name} in time, so it was not run and nothing was ${verbFor(toolUse.name)}.`,
			};
		case 'cancelled':
			return {
				reason,
				summary: `The turn was cancelled before ${toolUse.name} was confirmed, so nothing was ${verbFor(toolUse.name)}.`,
			};
		case 'payload_mismatch':
			return {
				reason,
				summary: `The arguments for ${toolUse.name} changed after they were approved, so the approval no longer applies and nothing was ${verbFor(toolUse.name)}.`,
			};
		default:
			return {
				reason: 'unbound',
				summary: `${toolUse.name} had no recorded approval, so nothing was ${verbFor(toolUse.name)}.`,
			};
	}
}

function verbFor(toolName: string): string {
	switch (toolName) {
		case 'create_reminder':
			return 'created';
		case 'create_task':
			return 'added';
		case 'save_memory':
			return 'saved';
		default:
			return 'run';
	}
}

// ─── The broker ──────────────────────────────────────────────────────

export interface ToolApprovalBrokerDeps {
	/** Emits one server event. The session owns the socket. */
	emit(event: ServerEvent): void;
	/** A fresh approval id. Injectable so a test can pin the id it expects. */
	nextApprovalId?(): string;
	log?: Pick<typeof logger, 'info' | 'warn'>;
}

/** One outstanding request: what the user is being asked, and how to answer it. */
interface PendingApproval {
	turnId: number;
	base: Omit<ToolApprovalDecision, 'status'>;
	settle(status: ToolApprovalStatus): void;
}

/**
 * Tracks the approvals one voice session is waiting on.
 *
 * One instance per socket: the pending map is per-connection state, and nothing
 * here is shared across users.
 */
export class ToolApprovalBroker {
	private readonly pending = new Map<string, PendingApproval>();

	constructor(private readonly deps: ToolApprovalBrokerDeps) {}

	private get log(): Pick<typeof logger, 'info' | 'warn'> {
		return this.deps.log ?? logger;
	}

	/**
	 * Emits the request and waits for the answer.
	 *
	 * Resolves — never rejects — so a client that never answers cannot throw
	 * through the tool loop. The expiry timer is unref'd: a socket that dies
	 * while an approval is outstanding must not hold the process open.
	 */
	request(params: {
		turnId: number;
		toolUse: ToolUseBlock;
		level: ToolPermissionLevel;
	}): Promise<ToolApprovalDecision> {
		const { turnId, toolUse, level } = params;
		const approvalId = (this.deps.nextApprovalId ?? randomUUID)();
		const payloadHash = toolPayloadHash(toolUse.input);

		return new Promise<ToolApprovalDecision>((resolve) => {
			let settled = false;
			const settle = (status: ToolApprovalStatus): void => {
				if (settled) return;
				settled = true;
				this.pending.delete(approvalId);
				clearTimeout(timer);
				resolve({ ...base, status });
			};

			// Built before `settle` so the closure and the record agree on exactly
			// one base decision — including the hash the broker computed. A
			// response can therefore never introduce a payload hash of its own.
			const base: Omit<ToolApprovalDecision, 'status'> = {
				approvalId,
				turnId,
				toolUseId: toolUse.id,
				toolName: toolUse.name,
				level,
				payloadHash,
			};

			const timer = setTimeout(() => {
				this.log.warn(
					{ approvalId, turnId, tool: toolUse.name, level },
					'Tool approval timed out — treating no answer as a refusal and not executing',
				);
				settle('timeout');
			}, APPROVAL_TIMEOUT_MS);
			timer.unref?.();

			this.pending.set(approvalId, { turnId, base, settle });
			this.deps.emit({
				type: 'approval_request',
				approvalId,
				turnId,
				tool: toolUse.name,
				level,
				summary: toolApprovalSummary(toolUse.name, toolUse.input),
				input: toolUse.input,
				expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
			});
			this.log.info(
				{ approvalId, turnId, tool: toolUse.name, level, payloadHash: payloadHash.slice(0, 12) },
				'Voice tool awaiting user confirmation',
			);
		});
	}

	/**
	 * A client answer.
	 *
	 * Returns false for an unknown id, for a response carrying a stale turn id
	 * (an id is already unique, so this is belt-and-braces against a buggy or
	 * hostile client replaying an old answer), and for a second answer to the
	 * same request — which `settle` ignores rather than letting it overwrite the
	 * first decision.
	 */
	respond(message: { approvalId: string; approve: boolean; turnId?: number }): boolean {
		const pending = this.pending.get(message.approvalId);
		if (!pending) {
			this.log.warn(
				{ approvalId: message.approvalId },
				'Ignoring an approval response for an unknown request',
			);
			return false;
		}
		if (message.turnId !== undefined && message.turnId !== pending.turnId) {
			this.log.warn(
				{
					approvalId: message.approvalId,
					sentTurnId: message.turnId,
					waitingTurnId: pending.turnId,
				},
				'Ignoring an approval response aimed at a different turn',
			);
			return false;
		}
		this.log.info(
			{ approvalId: message.approvalId, turnId: pending.turnId, approve: message.approve },
			message.approve ? 'User approved the voice tool call' : 'User rejected the voice tool call',
		);
		pending.settle(message.approve ? 'approved' : 'rejected');
		return true;
	}

	/**
	 * Resolves everything still waiting for [turnId] as cancelled.
	 *
	 * Called when a turn is aborted (barge-in, `cancel`, socket teardown). The
	 * tool does not run — the user interrupted, and an interrupted turn is not
	 * an approval — and the awaiting loop is released rather than hanging until
	 * the timeout.
	 */
	cancelTurn(turnId: number): number {
		const stops: Array<() => void> = [];
		for (const pending of this.pending.values()) {
			if (pending.turnId === turnId) stops.push(() => pending.settle('cancelled'));
		}
		for (const stop of stops) stop();
		return stops.length;
	}

	/** Approvals still awaiting an answer, for tests and diagnostics. */
	get pendingCount(): number {
		return this.pending.size;
	}
}
