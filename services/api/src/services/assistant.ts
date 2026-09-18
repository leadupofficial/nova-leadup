/**
 * NOVA API — Shared assistant-reply plumbing.
 *
 * The conversation routes (`conversations.ts`, `chat.ts`) and the SSE route
 * (`streaming.ts`) all need the same three things:
 *
 *   1. a single NOVA system prompt,
 *   2. a bounded replay of stored history that respects the provider context,
 *   3. an identical, machine-readable failure mode when no AI credential is
 *      configured (the API must never lose the user's persisted message just
 *      because the provider is unavailable).
 *
 * The provider switch itself lives in `./ai.js`; this module only shapes
 * prompts and maps provider failures onto stable error codes for clients.
 */
import type { ChatMessage } from './ai.js';

/**
 * Maximum number of prior turns replayed into one completion. Claude returns at
 * most `maxTokens` (4 096 by default); replaying more than the last handful of
 * turns buys nothing and inflates latency and cost.
 */
export const HISTORY_MESSAGE_LIMIT = 20;

/**
 * Character budget for replayed history. Roughly 4 characters per token, so
 * ~24 000 characters ≈ 6 000 prompt tokens — comfortably inside the context
 * window of every chat model `./ai.js` can select, and well below the 200k
 * window of the default `claude-sonnet-4-20250514`.
 */
export const HISTORY_CHAR_BUDGET = 24_000;

/** Per-message ceiling so one pasted document cannot consume the whole budget. */
export const MAX_MESSAGE_CHARS = 8_000;

/** Default NOVA persona, matching the tone used by the voice chat route. */
export const NOVA_SYSTEM_PROMPT =
	'You are NOVA, a warm AI companion. Be helpful, friendly, and slightly playful. Keep answers concise.';

/** Machine-readable assistant failure returned to clients instead of a 500. */
export type AssistantErrorCode = 'AI_NOT_CONFIGURED' | 'AI_BLOCKED' | 'AI_ERROR';

export interface AssistantError {
	code: AssistantErrorCode;
	message: string;
}

/**
 * Map a thrown provider error onto a stable code.
 *
 * `services/ai.ts#chatCompletion` throws a plain `Error` for every failure:
 * missing `ANTHROPIC_API_KEY`/`BROCODE_API_KEY`, jailbreak/unsafe pre-flight
 * blocks, and upstream API errors. Callers must not turn "no API key" into a
 * 500 that discards the user's message, so the distinction is made here.
 */
export function toAssistantError(err: unknown): AssistantError {
	const raw = err instanceof Error ? err.message : String(err);

	if (/api[_ ]?key|not configured|credentials|unauthorized|authentication/i.test(raw)) {
		return {
			code: 'AI_NOT_CONFIGURED',
			message: 'The AI provider is not configured on this server.',
		};
	}

	if (/jailbreak|unsafe content/i.test(raw)) {
		return {
			code: 'AI_BLOCKED',
			message: 'That request was blocked by the safety filter.',
		};
	}

	return {
		code: 'AI_ERROR',
		message: 'The AI reply could not be generated.',
	};
}

/** Subset of a stored message row this module needs. */
export interface HistoryRow {
	role: string;
	content: string;
}

/**
 * Map stored messages to provider chat messages, newest turn last, dropping the
 * oldest turns once the character budget is exhausted. A role the provider does
 * not accept (anything other than `user`/`assistant`) is skipped rather than
 * forwarded.
 */
export function toChatMessages(rows: HistoryRow[]): ChatMessage[] {
	const kept: ChatMessage[] = [];
	let budget = HISTORY_CHAR_BUDGET;

	for (let i = rows.length - 1; i >= 0; i--) {
		const row = rows[i];
		if (!row || (row.role !== 'user' && row.role !== 'assistant')) continue;

		const content =
			row.content.length > MAX_MESSAGE_CHARS ? row.content.slice(0, MAX_MESSAGE_CHARS) : row.content;

		// Always keep the newest turn, even if it alone exceeds the budget.
		if (kept.length > 0 && content.length > budget) break;

		budget -= content.length;
		kept.push({ role: row.role, content });
	}

	return kept.reverse();
}
