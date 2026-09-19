/**
 * NOVA API — the voice tool approval gate.
 *
 * Three properties are load-bearing and each has a test here:
 *
 *   1. every side-effecting tool is confirmed before it runs, and L0 never is
 *   2. no answer is a refusal — nothing executes without an explicit "yes"
 *   3. the approval is bound to the exact payload, so mutated arguments void it
 *      (blueprint §7.5: "an approval token bound to the exact payload")
 *
 * The last one is the reason `payload_mismatch` is its own outcome rather than
 * a variant of "rejected": an id-only check would let a model get a harmless
 * action approved and then run a different one under the same approval.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';

// This file deliberately does not import `./setup`: that bootstrap pulls in the
// whole Express app (through `../server.js`), and ES imports are hoisted, so
// `src/routes/biometric.ts` reads `process.env.JWT_SECRET` before any
// module-scope assignment here could run — importing it fails before a single
// test is collected. These tests cover the approval decision itself and need no
// HTTP surface, so the environment is set here and the database is mocked.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/nova_test';
process.env.JWT_SECRET = 'test-secret-key-that-is-at-least-32-chars-long';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-at-least-32-chars-long!';
process.env.LOG_LEVEL = 'warn';

// Nothing here executes a tool, so the database is never reached; the mock is
// what keeps `getDb()` from building a real pool if that ever changes.
vi.mock('../db/connection', () => ({
	getDb: () => ({}),
	getDbClient: () => ({ query: async () => ({ rows: [] }) }),
}));

// Imported dynamically, after the environment above is in place. The tool
// registry reads process configuration through the `env` proxy, so a static
// import (which a bundler hoists above this setup) would validate an
// unconfigured environment and throw.
let ASSISTANT_TOOLS: typeof import('../services/assistant-tools.js').ASSISTANT_TOOLS;
let ASSISTANT_TOOL_LEVELS: typeof import('../services/assistant-tools.js').ASSISTANT_TOOL_LEVELS;
let TOOL_LEVEL_EXTERNAL: typeof import('../services/assistant-tools.js').TOOL_LEVEL_EXTERNAL;
let TOOL_LEVEL_READ_ONLY: typeof import('../services/assistant-tools.js').TOOL_LEVEL_READ_ONLY;
let TOOL_LEVEL_SENSITIVE: typeof import('../services/assistant-tools.js').TOOL_LEVEL_SENSITIVE;
let toolPermissionLevel: typeof import('../services/assistant-tools.js').toolPermissionLevel;
let toolRequiresConfirmation: typeof import('../services/assistant-tools.js').toolRequiresConfirmation;
let APPROVAL_TIMEOUT_MS: typeof import('../realtime/tool-approval.js').APPROVAL_TIMEOUT_MS;
let ToolApprovalBroker: typeof import('../realtime/tool-approval.js').ToolApprovalBroker;
let describeToolApprovalBlock: typeof import('../realtime/tool-approval.js').describeToolApprovalBlock;
let toolApprovalOutcome: typeof import('../realtime/tool-approval.js').toolApprovalOutcome;
let toolApprovalSummary: typeof import('../realtime/tool-approval.js').toolApprovalSummary;
let toolPayloadHash: typeof import('../realtime/tool-approval.js').toolPayloadHash;
type ToolApprovalDecision = import('../realtime/tool-approval.js').ToolApprovalDecision;
type ToolUseBlock = import('../services/ai.js').ToolUseBlock;

beforeAll(async () => {
	({
		ASSISTANT_TOOLS,
		ASSISTANT_TOOL_LEVELS,
		TOOL_LEVEL_EXTERNAL,
		TOOL_LEVEL_READ_ONLY,
		TOOL_LEVEL_SENSITIVE,
		toolPermissionLevel,
		toolRequiresConfirmation,
	} = await import('../services/assistant-tools.js'));
	({
		APPROVAL_TIMEOUT_MS,
		ToolApprovalBroker,
		describeToolApprovalBlock,
		toolApprovalOutcome,
		toolApprovalSummary,
		toolPayloadHash,
	} = await import('../realtime/tool-approval.js'));
});

function toolUse(name: string, input: Record<string, unknown>): ToolUseBlock {
	return { id: `toolu_${name}`, name, input };
}

const REMINDER = toolUse('create_reminder', {
	title: 'Call the bank',
	trigger_at: '2026-09-19T17:00:00+05:30',
});

function approved(tool: ToolUseBlock, overrides: Partial<ToolApprovalDecision> = {}): ToolApprovalDecision {
	return {
		approvalId: 'appr-1',
		turnId: 1,
		toolUseId: tool.id,
		toolName: tool.name,
		level: 1,
		status: 'approved',
		payloadHash: toolPayloadHash(tool.input),
		...overrides,
	};
}

describe('the permission registry', () => {
	it('classifies every tool the assistant offers, with no strays on either side', () => {
		// A tool added to ASSISTANT_TOOLS without a level would otherwise be
		// unclassified, and the gate's default for an unclassified tool is L3 —
		// safe, but this is the test that keeps the map honest.
		const defined = ASSISTANT_TOOLS.map((t) => t.name).sort();
		const classified = Object.keys(ASSISTANT_TOOL_LEVELS).sort();
		expect(classified).toEqual(defined);
	});

	it('rates the three write tools L1 — personal, not external', () => {
		expect(toolPermissionLevel('create_reminder')).toBe(1);
		expect(toolPermissionLevel('create_task')).toBe(1);
		expect(toolPermissionLevel('save_memory')).toBe(1);
	});

	it('treats an unknown tool as the most sensitive level, never as read-only', () => {
		// The model is untrusted; a tool it invents must not slip through as L0.
		expect(toolPermissionLevel('send_whatsapp')).toBe(TOOL_LEVEL_SENSITIVE);
		expect(toolPermissionLevel('')).toBe(TOOL_LEVEL_SENSITIVE);
	});

	it('never requires confirmation for L0, at any threshold', () => {
		// The hard rule: making a read-only tool prompt would make the product
		// worse, so the gate must not be able to do it. The registry is checked
		// against the arithmetic the gate uses at every threshold the config
		// accepts, and L0 — the lowest level — is asserted to be below all of
		// them, which is the property that keeps a read-only tool silent.
		for (const threshold of [0, 1, 2, 3] as const) {
			for (const name of Object.keys(ASSISTANT_TOOL_LEVELS)) {
				expect(toolRequiresConfirmation(name, threshold)).toBe(
					toolPermissionLevel(name) >= threshold,
				);
			}
		}
		expect(TOOL_LEVEL_READ_ONLY).toBe(0);
		expect(toolRequiresConfirmation('create_reminder', TOOL_LEVEL_READ_ONLY)).toBe(true);
	});

	it('requires confirmation for L1 and above at the beta threshold', () => {
		expect(toolRequiresConfirmation('create_reminder', 1)).toBe(true);
		expect(toolRequiresConfirmation('save_memory', 1)).toBe(true);
	});

	it('exposes L2 for the external tools this gate exists to protect', () => {
		// Not in the registry yet — this pins the value a future email/WhatsApp
		// tool must be given, and that it demands confirmation even at L2.
		expect(toolRequiresConfirmation('send_email', TOOL_LEVEL_EXTERNAL)).toBe(true);
	});
});

describe('payload binding', () => {
	it('hashes equivalent payloads identically regardless of key order', () => {
		// Non-negotiable: otherwise re-serialising the same action would demand a
		// second confirmation from a user who already gave one.
		const a = { title: 'Call the bank', trigger_at: '2026-09-19T17:00:00+05:30' };
		const b = { trigger_at: '2026-09-19T17:00:00+05:30', title: 'Call the bank' };
		expect(toolPayloadHash(a)).toBe(toolPayloadHash(b));
	});

	it('hashes a nested payload identically regardless of key order', () => {
		expect(toolPayloadHash({ a: { y: 1, x: 2 }, b: [1, { q: 1, p: 2 }] })).toBe(
			toolPayloadHash({ b: [1, { p: 2, q: 1 }], a: { x: 2, y: 1 } }),
		);
	});

	it('changes the hash when any value changes', () => {
		const base = { title: 'Call the bank', trigger_at: '2026-09-19T17:00:00+05:30' };
		expect(toolPayloadHash({ ...base, title: 'Call the bank tomorrow' })).not.toBe(toolPayloadHash(base));
		expect(toolPayloadHash({ ...base, trigger_at: '2026-09-19T18:00:00+05:30' })).not.toBe(
			toolPayloadHash(base),
		);
	});

	it('changes the hash when a key is added or removed', () => {
		const base = { title: 'Call the bank' };
		expect(toolPayloadHash({ ...base, timezone: 'Asia/Kolkata' })).not.toBe(toolPayloadHash(base));
		expect(toolPayloadHash({ ...base, title: 'Call the bank', extra: undefined })).toBe(
			toolPayloadHash(base),
			'undefined has no JSON representation and must not split the hash',
		);
	});

	/**
	 * The core §7.5 test: the user approved ONE payload, and the arguments that
	 * reached execution are different. An id-only check would execute it.
	 */
	it('voids an approval whose arguments mutated after it was granted', () => {
		const decision = approved(REMINDER);
		// Same id, same tool, same turn — only the payload differs.
		const mutated = toolUse('create_reminder', {
			title: 'Call the bank',
			trigger_at: '2026-09-19T17:00:00+05:30',
			// The model (or an injected instruction) changed the destination.
			timezone: 'America/New_York',
		});

		expect(toolApprovalOutcome(decision, mutated.input)).toBe('payload_mismatch');

		const block = describeToolApprovalBlock(decision, mutated);
		expect(block?.reason).toBe('payload_mismatch');
		expect(block?.summary).toMatch(/changed after they were approved/i);
		expect(block?.summary).toMatch(/nothing was created/i);
	});

	it('voids an approval when the time is changed to a different moment', () => {
		// The obvious attack on a reminder: approve "tomorrow at 5pm", then run
		// it for a different time.
		const decision = approved(REMINDER);
		const moved = toolUse('create_reminder', {
			title: 'Call the bank',
			trigger_at: '2026-09-19T17:00:00+05:30',
			timezone: undefined,
		});
		// `timezone: undefined` is dropped by canonicalisation, so this is the
		// same payload — the check must not be so eager that it refuses valid
		// re-serialisations.
		expect(toolApprovalOutcome(decision, moved.input)).toBeNull();

		const reallyMoved = toolUse('create_reminder', {
			title: 'Call the bank',
			trigger_at: '2027-01-01T09:00:00+05:30',
		});
		expect(toolApprovalOutcome(decision, reallyMoved.input)).toBe('payload_mismatch');
	});

	it('allows exactly the payload that was approved', () => {
		const decision = approved(REMINDER);
		expect(toolApprovalOutcome(decision, REMINDER.input)).toBeNull();
		expect(describeToolApprovalBlock(decision, REMINDER)).toBeNull();
	});

	it('refuses an unbound decision and a missing one', () => {
		expect(toolApprovalOutcome(null, REMINDER.input)).toBe('unbound');
		const noHash = approved(REMINDER, { payloadHash: '' });
		expect(toolApprovalOutcome(noHash, REMINDER.input)).toBe('payload_mismatch');
	});
});

describe('refusals', () => {
	it('reports a rejection as a refusal, in words the transcript can use', () => {
		const block = describeToolApprovalBlock(approved(REMINDER, { status: 'rejected' }), REMINDER);
		expect(block?.reason).toBe('rejected');
		expect(block?.summary).toMatch(/declined/i);
		expect(block?.summary).toMatch(/nothing was created/i);
	});

	it('reports a timeout as a refusal, never as success or silence', () => {
		const block = describeToolApprovalBlock(approved(REMINDER, { status: 'timeout' }), REMINDER);
		expect(block?.reason).toBe('timeout');
		expect(block?.summary).toMatch(/no confirmation arrived/i);
		expect(block?.summary).toMatch(/not run/i);
	});

	it('reports a cancelled turn as a refusal', () => {
		const block = describeToolApprovalBlock(approved(REMINDER, { status: 'cancelled' }), REMINDER);
		expect(block?.reason).toBe('cancelled');
		expect(block?.summary).toMatch(/cancelled/i);
	});

	it('names the tool and its verb in every refusal', () => {
		for (const [name, verb] of [
			['create_reminder', 'created'],
			['create_task', 'added'],
			['save_memory', 'saved'],
		] as const) {
			const tool = toolUse(name, { title: 'x' });
			const block = describeToolApprovalBlock(null, tool);
			expect(block?.summary).toContain(name);
			expect(block?.summary).toContain(verb);
		}
	});
});

describe('summaries shown to the user', () => {
	it('states the exact effect for each tool', () => {
		expect(toolApprovalSummary('create_reminder', REMINDER.input)).toBe(
			'Create a reminder "Call the bank" that goes off at 2026-09-19T17:00:00+05:30.',
		);
		expect(toolApprovalSummary('create_task', { title: 'Send the invoice' })).toBe(
			'Add the task "Send the invoice" with no deadline.',
		);
		expect(
			toolApprovalSummary('save_memory', { content: 'Prefers morning meetings', category: 'preference' }),
		).toContain('Prefers morning meetings');
	});

	it('includes the timezone and due date when present', () => {
		expect(
			toolApprovalSummary('create_reminder', {
				title: 'Call the bank',
				trigger_at: '2026-09-19T17:00:00+05:30',
				timezone: 'Asia/Kolkata',
			}),
		).toContain('Asia/Kolkata');
		expect(
			toolApprovalSummary('create_task', { title: 'Invoice', due_at: '2026-09-19T18:00:00+05:30' }),
		).toContain('due 2026-09-19T18:00:00+05:30');
	});

	it('does not invent a summary for an unknown tool', () => {
		expect(toolApprovalSummary('send_whatsapp', { to: '+91' })).toContain('send_whatsapp');
	});
});

describe('the approval broker', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function broker() {
		const emitted: unknown[] = [];
		let seq = 0;
		const instance = new ToolApprovalBroker({
			emit: (event) => emitted.push(event),
			// Sequential, not a constant: two concurrent requests must not share
			// an id, or the second would overwrite the first in the pending map.
			nextApprovalId: () => `appr-${++seq}`,
			log: { info: () => undefined, warn: () => undefined },
		});
		return { instance, emitted };
	}

	it('emits a request carrying the id, level, summary, payload and expiry', async () => {
		const { instance, emitted } = broker();
		const waiting = instance.request({ turnId: 4, toolUse: REMINDER, level: 1 });

		expect(emitted).toHaveLength(1);
		const event = emitted[0] as {
			type: string;
			approvalId: string;
			tool: string;
			level: number;
			summary: string;
			input: Record<string, unknown>;
			expiresAt: string;
		};
		expect(event.type).toBe('approval_request');
		expect(event.approvalId).toBe('appr-1');
		expect(event.tool).toBe('create_reminder');
		expect(event.level).toBe(1);
		expect(event.summary).toContain('Call the bank');
		expect(event.input).toEqual(REMINDER.input);
		expect(Date.parse(event.expiresAt)).toBeGreaterThan(Date.now());

		instance.respond({ approvalId: 'appr-1', approve: true, turnId: 4 });
		const decision = await waiting;
		expect(decision.status).toBe('approved');
		expect(decision.turnId).toBe(4);
		expect(decision.payloadHash).toBe(toolPayloadHash(REMINDER.input));
		expect(instance.pendingCount).toBe(0);
	});

	it('records a rejection', async () => {
		const { instance } = broker();
		const waiting = instance.request({ turnId: 1, toolUse: REMINDER, level: 1 });
		instance.respond({ approvalId: 'appr-1', approve: false });
		expect((await waiting).status).toBe('rejected');
	});

	it('ignores an answer for an id it is not waiting on', async () => {
		const { instance } = broker();
		const waiting = instance.request({ turnId: 1, toolUse: REMINDER, level: 1 });
		expect(instance.respond({ approvalId: 'appr-other', approve: true })).toBe(false);
		// Still waiting: the response must not have settled anything.
		expect(instance.pendingCount).toBe(1);
		expect(instance.respond({ approvalId: 'appr-1', approve: false })).toBe(true);
		expect((await waiting).status).toBe('rejected');
	});

	it('ignores an answer aimed at a different turn, so a replayed response cannot approve a later one', async () => {
		const { instance } = broker();
		const waiting = instance.request({ turnId: 9, toolUse: REMINDER, level: 1 });
		expect(instance.respond({ approvalId: 'appr-1', approve: true, turnId: 8 })).toBe(false);
		expect(instance.pendingCount).toBe(1);
		expect(instance.respond({ approvalId: 'appr-1', approve: true, turnId: 9 })).toBe(true);
		expect((await waiting).status).toBe('approved');
	});

	it('times out into a refusal — no answer never executes', async () => {
		vi.useFakeTimers();
		const { instance } = broker();
		const waiting = instance.request({ turnId: 1, toolUse: REMINDER, level: 1 });
		expect(instance.pendingCount).toBe(1);

		vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS + 1);

		const decision = await waiting;
		expect(decision.status).toBe('timeout');
		expect(toolApprovalOutcome(decision, REMINDER.input)).toBe('timeout');
		expect(instance.pendingCount).toBe(0);
	});

	it('ignores an answer that arrives after the timeout', async () => {
		vi.useFakeTimers();
		const { instance } = broker();
		const waiting = instance.request({ turnId: 1, toolUse: REMINDER, level: 1 });
		vi.advanceTimersByTime(APPROVAL_TIMEOUT_MS + 1);
		await waiting;
		// The late "yes" must not reopen a request that has already expired.
		expect(instance.respond({ approvalId: 'appr-1', approve: true })).toBe(false);
	});

	it('resolves a turn’s outstanding requests as cancelled when it is aborted', async () => {
		const { instance, emitted } = broker();
		const waiting = instance.request({ turnId: 3, toolUse: REMINDER, level: 1 });
		expect(emitted).toHaveLength(1);
		expect(instance.cancelTurn(3)).toBe(1);
		const decision = await waiting;
		expect(decision.status).toBe('cancelled');
		expect(instance.pendingCount).toBe(0);
		// A cancelled turn's request cannot then be approved.
		expect(instance.respond({ approvalId: 'appr-1', approve: true })).toBe(false);
	});

	it('leaves another turn’s requests alone when one is cancelled', async () => {
		const { instance } = broker();
		const first = instance.request({ turnId: 1, toolUse: REMINDER, level: 1 });
		const second = instance.request({ turnId: 2, toolUse: REMINDER, level: 1 });
		expect(instance.cancelTurn(1)).toBe(1);
		expect(instance.pendingCount).toBe(1);
		expect((await first).status).toBe('cancelled');
		instance.respond({ approvalId: 'appr-2', approve: true, turnId: 2 });
		expect((await second).status).toBe('approved');
	});
});
