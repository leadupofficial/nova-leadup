/**
 * NOVA API — streaming variant of the assistant tool loop.
 *
 * `runAssistantToolLoop` in `services/assistant-tools.ts` is the REST contract:
 * call the model, run whatever tools it asks for, feed the results back and
 * repeat until it answers — capped at `MAX_TOOL_ITERATIONS`. Voice needs the
 * same behaviour (so "remind me to…" still creates a reminder when spoken) but
 * with text emitted as it is generated, which the non-streaming
 * `chatCompletion` cannot do.
 *
 * Semantics are otherwise deliberately identical: same tool definitions, same
 * executor, same iteration cap, same conversation replay of assistant blocks
 * followed by matching tool_result blocks. The user id comes from the
 * authenticated socket, never from the model.
 *
 * The one deliberate difference is the approval gate. The typed path confirms
 * before it sends the request, so its tools execute immediately; a spoken turn
 * arrives as raw audio, and this loop is the last point at which a
 * side-effecting call can still be stopped. Every tool at or above the
 * configured level is therefore put to the user first and executed only when
 * the answer approves *that exact payload* (see `./tool-approval.js`).
 */
import {
	ASSISTANT_TOOLS,
	MAX_TOOL_ITERATIONS,
	claimsStateChange,
	nothingPerformedReply,
	UNBACKED_CLAIM_CORRECTION,
	toolPermissionLevel,
	toolRequiresConfirmation,
	userTurnText,
	type ToolPermissionLevel,
} from '../services/assistant-tools.js';
import {
	executeAssistantTool,
	toolSummaryText,
	toToolResultBlock,
	type ExecutedToolCall,
} from '../services/assistant-tool-executor.js';
import type { ChatMessage, ToolUseBlock } from '../services/ai.js';
import { logger } from '../utils/logger.js';
import {
	describeToolApprovalBlock,
	type ToolApprovalDecision,
	type ToolApprovalRequest,
} from './tool-approval.js';
import { streamChatCompletion } from './llm.js';

export interface StreamingToolLoopOptions {
	systemPrompt: string;
	/** Called once per executed write tool, so the caller can surface it. */
	onToolCall?: (call: ExecutedToolCall) => void;
	/**
	 * Asks the user to confirm one side-effecting tool. Resolves with the answer
	 * or, once the broker's timeout expires, with a refusal — this loop never
	 * executes on an unanswered request and never reads "no answer" as approval.
	 *
	 * Omitting it disables the gate and is only for unit tests of the loop's
	 * other behaviour.
	 */
	approval?: ToolApprovalRequest;
	/** Turn this loop belongs to, so an answer can be matched back to it. */
	turnId?: number;
	/**
	 * Permission level at or above which a tool must be confirmed. Defaults to
	 * the configured threshold (`VOICE_TOOL_CONFIRM_LEVEL`, L1 during beta).
	 * L0 is below every value in range, so a read-only tool can never be made to
	 * prompt however this is set.
	 */
	confirmationLevel?: ToolPermissionLevel;
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	/**
	 * The language the user is speaking, so the corrective sentence this loop can
	 * author itself is written in it. Optional; the English wording is used when
	 * it is absent.
	 */
	language?: string;
}

export interface StreamingToolLoopResult {
	content: string;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
	toolCalls: ExecutedToolCall[];
	iterations: number;
	capped: boolean;
	/** Which provider served the turn's last model call. */
	provider?: string;
	/** True when the configured secondary provider served any part of the turn. */
	fellBack?: boolean;
	/**
	 * True when the model's prose claimed a change that no tool made and a
	 * correction was spoken after it. This path had no honesty check at all.
	 */
	claimCorrected?: boolean;
	/** The corrective sentence that was appended, when there was one. */
	claimCorrection?: string;
	/**
	 * True when the corrective turn was sent because the model claimed a change and
	 * called no tool. The user hears the claim, then the correction, then — if this
	 * worked — the model actually doing it and saying so.
	 */
	claimReprompted?: boolean;
}

export async function runStreamingAssistantLoop(
	userId: string,
	messages: ChatMessage[],
	options: StreamingToolLoopOptions,
	onTextDelta: (text: string) => void,
): Promise<StreamingToolLoopResult> {
	// Copy: the session's history must not be mutated with tool traffic.
	const conversation: ChatMessage[] = [...messages];
	const toolCalls: ExecutedToolCall[] = [];

	// ── The user's own words, read once, before any tool traffic ────────
	// The executor refuses a clock time the user never gave (P0-G: NOVA wrote
	// 18:00 for both tasks when the user said only "tomorrow"). This loop is the
	// **primary** voice path and it was calling the executor with no turn at all,
	// so that guard did not apply where most spoken reminders are created — the
	// same one-path-only mistake the honesty guard made.
	//
	// Read from `messages` rather than from `conversation`: after the first
	// iteration the conversation carries this loop's own `tool_result` user turns,
	// and `userTurnText` would have to skip them anyway. Reading the input once
	// also means the answer cannot change mid-turn.
	const userTurn = userTurnText(messages);

	let streamed = '';
	let model = '';
	let usage = { inputTokens: 0, outputTokens: 0 };
	/** Which provider answered, and whether it was the secondary one. */
	let provider: string | undefined;
	let fellBack = false;
	/**
	 * Sticky provider selection, scoped to this turn — the streaming twin of the
	 * flag in `runAssistantToolLoop`. Once a call of this turn is served by the
	 * fallback, every later iteration goes straight to it instead of re-probing a
	 * primary this turn already knows is unusable. A local of the loop body, so
	 * the next turn probes the primary again.
	 */
	let preferFallback = false;
	/**
	 * Whether the corrective turn has already been sent this turn.
	 *
	 * The REST loop has had a second chance since the "nothing was performed" defect
	 * was fixed: a turn that claims a change with no tool call gets re-prompted, and
	 * only then falls back to the honest floor. This loop never had it — it appended
	 * the correction and *ended the turn*, so on the primary voice path the user was
	 * told nothing happened and the thing they asked for was never done. Same
	 * one-path-only gap as the honesty guard itself, found by the subagent that
	 * built the REST half and reported rather than left silent.
	 *
	 * Spent at most once, for the same reason as the REST side: a model that will not
	 * call the tool after being told to will not call it after being told twice, and
	 * every extra call is spoken latency.
	 */
	let reprompted = false;

	/**
	 * Decides whether one tool may run, asking the user when its level requires
	 * it. Returns the wording to refuse with, or null to execute.
	 */
	const gate = async (toolUse: ToolUseBlock): Promise<ReturnType<typeof describeToolApprovalBlock>> => {
		const level = toolPermissionLevel(toolUse.name);
		if (!toolRequiresConfirmation(toolUse.name, options.confirmationLevel)) {
			// L0 must never prompt: a read-only tool that asked for confirmation
			// would make the product worse, so this branch is a hard rule.
			return null;
		}
		if (!options.approval) {
			logger.warn(
				{ tool: toolUse.name, level, userId },
				'Voice tool requires confirmation but no approval channel is wired — refusing to execute',
			);
			return { reason: 'unbound', summary: `${toolUse.name} could not be confirmed, so nothing was run.` };
		}

		const decision: ToolApprovalDecision | null = await options.approval({
			turnId: options.turnId ?? 0,
			toolUse,
			level,
		});
		return describeToolApprovalBlock(decision, toolUse);
	};

	for (let iteration = 1; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
		const completion = await streamChatCompletion(
			conversation,
			{
				systemPrompt: options.systemPrompt,
				maxTokens: options.maxTokens,
				temperature: options.temperature,
				tools: ASSISTANT_TOOLS,
				signal: options.signal,
				// ── Retry safety ─────────────────────────────────────────────
				// The fallback may serve a call only while this turn has executed
				// nothing. `streamChatCompletion` adds its own, stricter guard for
				// the streaming case: it also refuses once a delta has been spoken,
				// because audio cannot be unsaid. Together they mean the secondary
				// provider covers the first model call of a turn and nothing after
				// the first side-effecting write.
				allowProviderFallback: toolCalls.length === 0,
				// Sticky selection: the provider for this turn was chosen when its
				// first call fell back, so later iterations are sent to it rather
				// than re-probing the primary. The streaming commit point inside
				// `streamChatCompletion` is untouched — a fallback that has already
				// spoken a delta still cannot be retried.
				preferFallback,
			},
			(text) => {
				streamed += text;
				onTextDelta(text);
			},
		);

		model = completion.model;
		provider = completion.provider ?? provider;
		if (completion.fellBack) {
			fellBack = true;
			// Remember the choice for the rest of *this* turn.
			preferFallback = true;
		}
		usage = {
			inputTokens: usage.inputTokens + completion.usage.inputTokens,
			outputTokens: usage.outputTokens + completion.usage.outputTokens,
		};

		if (!completion.toolUses.length) {
			// ── The honesty check this loop was missing ──────────────────
			// `services/assistant-tools.ts` refuses to forward a claim of a change
			// that no tool made, and its doc comment promises this streaming twin has
			// "deliberately identical" semantics. It did not: there was no
			// `claimsStateChange` call anywhere in this file, so on the *primary*
			// voice path — the streaming socket, not the REST fallback — a model
			// could say "Done, I've set the reminder" with `toolUses: []` and the
			// user would hear it. The REST path would have replaced that sentence.
			//
			// Audio already played cannot be retracted, and buffering the turn to
			// check it first would destroy time-to-first-word — the property this
			// whole path exists for. So the correction is *appended* and spoken
			// immediately after, which is the only honest option that keeps
			// streaming: the user hears the claim and then the truth, instead of
			// only the claim.
			let content = streamed || completion.content;
			let claimCorrection: string | undefined;
			if (!toolCalls.length && claimsStateChange(content)) {
				claimCorrection = nothingPerformedReply(options.language);
				onTextDelta(` ${claimCorrection}`);
				content = `${content} ${claimCorrection}`;
				logger.warn(
					{ userId, iteration, model, provider },
					'Spoken reply claimed an action with no tool call — a correction was spoken after it',
				);

				// ── The second chance, which this loop did not have ────────
				// The REST loop re-prompts here and the action actually happens. Doing
				// it after the correction has been spoken is deliberate: the claim is
				// already in the user's ear, so the sequence they hear is "done" →
				// "nothing was performed" → (the tool runs) → the model's real
				// confirmation. Three short utterances instead of one, to turn a
				// politely-worded nothing into the thing they asked for. Buffering to
				// avoid the first false sentence is the option that was already
				// rejected, because it costs time-to-first-word on every turn.
				//
				// `userTurnText` is not re-derived here: the corrective turn is a host
				// instruction, and appending it as a *user* message is the shape both
				// loops already use for the REST corrective turn.
				if (!reprompted && iteration < MAX_TOOL_ITERATIONS) {
					reprompted = true;
					conversation.push({ role: 'assistant', content: completion.blocks });
					conversation.push({ role: 'user', content: UNBACKED_CLAIM_CORRECTION });
					// `streamed` holds only this call's deltas, so it is cleared to keep
					// the next call's text separate from the sentence already spoken.
					streamed = '';
					continue;
				}
			}
			return {
				content,
				model,
				usage,
				toolCalls,
				iterations: iteration,
				capped: false,
				provider,
				fellBack,
				...(claimCorrection ? { claimCorrected: true, claimCorrection } : {}),
				...(reprompted ? { claimReprompted: true } : {}),
			};
		}

		// ── The approval gate ─────────────────────────────────────────
		// One tool at a time, in the order the model asked for them, and each
		// one resolved before the next is considered. A tool whose arguments
		// change between the request and execution is refused by the broker's
		// payload check, so an approval can never be reused for a different
		// action (§7.5).
		const results: ExecutedToolCall[] = [];
		for (const toolUse of completion.toolUses) {
			const blocked = await gate(toolUse);
			const result = blocked
				? await executeAssistantTool(userId, toolUse, { blocked, userTurn })
				: await executeAssistantTool(userId, toolUse, { userTurn });
			results.push(result);
		}
		toolCalls.push(...results);
		// Report as each one lands, not at the end: the point is to acknowledge
		// the action while the reply is still being written.
		for (const result of results) options.onToolCall?.(result);

		if (iteration === MAX_TOOL_ITERATIONS) {
			logger.warn(
				{ userId, iteration, tools: results.map((r) => r.name) },
				'Realtime tool loop hit its iteration cap — returning the last text',
			);
			return {
				content: streamed || toolSummaryText(toolCalls),
				model,
				usage,
				toolCalls,
				iterations: iteration,
				capped: true,
				provider,
				fellBack,
			};
		}

		// Replay the assistant's own blocks (text + tool_use) and answer each
		// tool_use with a matching tool_result in the following user turn — the
		// provider rejects a tool_use that is not answered immediately.
		conversation.push({ role: 'assistant', content: completion.blocks });
		conversation.push({ role: 'user', content: results.map(toToolResultBlock) });
	}

	// Unreachable: the loop returns on its final iteration.
	return {
		content: streamed || toolSummaryText(toolCalls),
		model,
		usage,
		toolCalls,
		iterations: MAX_TOOL_ITERATIONS,
		capped: true,
		provider,
		fellBack,
	};
}
