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
import { EmptyCompletionError } from './llm-wire-format.js';

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
export type AssistantErrorCode =
	| 'AI_NOT_CONFIGURED'
	| 'AI_BLOCKED'
	| 'AI_CREDIT_EXHAUSTED'
	/**
	 * The provider answered and the answer was empty — most often a reasoning
	 * model that spent its whole `max_tokens` on `reasoning_content` and was cut
	 * off before writing a reply (`finish_reason: length`).
	 *
	 * Its own code because the alternative that shipped was a **HTTP 200 with
	 * `text: ""`**, which the app rendered as a blank reply bubble. See
	 * `services/llm-wire-format.ts#EmptyCompletionError`.
	 */
	| 'AI_EMPTY_REPLY'
	| 'AI_ERROR';

export interface AssistantError {
	code: AssistantErrorCode;
	message: string;
}

/**
 * The message for a server whose provider account cannot pay for a call.
 *
 * A credit exhaustion is not the caller's request being wrong and it is not an
 * anonymous crash: it is a named operational condition, and the product has to
 * be able to say so. It therefore has its own code and its own sentence instead
 * of the generic "The AI reply could not be generated", and
 * `middleware/error-handler.ts` is told this one code is safe to surface.
 */
export const AI_CREDIT_EXHAUSTED_MESSAGE =
	"NOVA's AI credit has run out, so it can't reply right now. Please try again later.";

/**
 * Provider wording for "this account cannot pay for the next call".
 *
 * Matched against the thrown error's text *and* its HTTP status, because the
 * two providers report it differently: the Anthropic SDK raises an `APIError`
 * carrying `status: 402` and the body `{"error":{"message":"Insufficient
 * Balance","type":"billing_error"}}`, while the aggregator gateway answers HTTP
 * 200 with the notice as ordinary message text and zero output tokens (see
 * `looksLikeProviderNotice` in `services/ai.ts`).
 */
const CREDIT_EXHAUSTED_PATTERN =
	/insufficient[_\s-]?(?:balance|credit|credits|funds|quota)|billing_error|out of credit|credits? (?:has|have) run out|ran out of credit|exceeded your current quota|payment required/i;

/** The upstream HTTP status an SDK error carries, when it carries one. */
function upstreamStatus(err: unknown): number | null {
	const candidate = (err as { status?: unknown; statusCode?: unknown }) ?? {};
	const value = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
	return typeof value === 'number' ? value : null;
}

/**
 * Whether a provider failure means "this account cannot pay for the next call".
 *
 * Shared rather than duplicated, because there are two ways to reach the
 * condition and two code paths that have to agree about it. The SDK path throws
 * an error carrying `status: 402`; the gateway instead answers HTTP 200 with the
 * billing text as ordinary content and zero output tokens, so the wording is the
 * only signal (`services/ai.ts#looksLikeProviderNotice` rethrows that text). The
 * realtime streaming path in `realtime/llm.ts` reads the status and the body
 * itself, which is why this takes them as arguments instead of an error object.
 */
export function isCreditExhausted(status: number | null, raw: string): boolean {
	return status === 402 || CREDIT_EXHAUSTED_PATTERN.test(raw);
}

/**
 * Map a thrown provider error onto a stable code.
 *
 * `services/ai.ts#chatCompletion` throws a plain `Error` for every failure:
 * missing `ANTHROPIC_API_KEY`/`BROCODE_API_KEY`, jailbreak/unsafe pre-flight
 * blocks, and upstream API errors. Callers must not turn "no API key" into a
 * 500 that discards the user's message, so the distinction is made here.
 *
 * The credit check comes first, and its message never contains the provider's
 * own text: the client is told what the product can do about it, not what the
 * upstream body said.
 */
export function toAssistantError(err: unknown): AssistantError {
	const raw = err instanceof Error ? err.message : String(err);

	if (isCreditExhausted(upstreamStatus(err), raw)) {
		return {
			code: 'AI_CREDIT_EXHAUSTED',
			message: AI_CREDIT_EXHAUSTED_MESSAGE,
		};
	}

	// The provider answered, and the answer had no reply in it. Classified by
	// type rather than by wording, because the two shapes need different
	// sentences and the distinction ("cut off" vs "said nothing") is carried as
	// data on the error. Checked before the wording rules below so that a
	// truncation message cannot be mistaken for a configuration problem.
	if (err instanceof EmptyCompletionError) {
		return { code: 'AI_EMPTY_REPLY', message: err.message };
	}

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

/**
 * The HTTP status each assistant failure deserves.
 *
 * One function rather than the `code === 'AI_NOT_CONFIGURED' ? 503 : 502`
 * repeated per route, which is what made a refused input come back as a server
 * fault: `AI_BLOCKED` — a request this service deliberately declined to send —
 * was answered with 502, indistinguishable at the client from the service being
 * broken. A blocked request is the caller's, so it is a 4xx; a provider this
 * server cannot pay or reach is ours, so it stays 5xx.
 */
export function assistantErrorStatus(code: AssistantErrorCode): number {
	switch (code) {
		case 'AI_BLOCKED':
			return 400;
		case 'AI_NOT_CONFIGURED':
		case 'AI_CREDIT_EXHAUSTED':
			return 503;
		default:
			return 502;
	}
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
