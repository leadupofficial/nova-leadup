/**
 * NOVA API — token-streamed chat completions for the realtime voice socket.
 *
 * `services/ai.ts#chatCompletion` wraps the Anthropic SDK's non-streaming
 * `messages.create()`. That is fine for REST, but a spoken reply must start
 * being synthesised after the *first sentence*, not after the whole answer, so
 * the voice path needs deltas as they are produced.
 *
 * This talks the Anthropic Messages SSE protocol directly over `fetch`
 * (verified against the AICredits gateway: first token in ~1.5 s, `content_block_delta`
 * events, `tool_use` blocks streamed as `input_json_delta`), reusing the same
 * base URL, credential and auth style as the SDK path via
 * `getAnthropicHttpConfig()`, and the same safety pre-flight via the exported
 * guardrails in `services/ai.ts`. The SSE reading itself lives in
 * `services/llm-transport.ts` so the primary and the fallback provider cannot
 * be parsed differently.
 *
 * ── The fallback rule on this path ──────────────────────────────────────
 * A spoken turn cannot be unsaid, so the fallback is taken **only when the
 * request failed before a single delta reached the caller** — the natural
 * first-token boundary, since nothing exists to emit before then. That is the
 * "buffer until the first token, then commit" option with no extra buffering:
 * the first `onTextDelta` *is* the commit. Once a token has been handed to TTS
 * the turn belongs to the primary provider and its failure propagates.
 *
 * The trade-off, stated plainly: a provider that dies mid-sentence still ends
 * the turn with half a sentence spoken and no retry. Buffering the whole reply
 * to make that retryable would destroy the latency-to-first-word that is the
 * entire reason this path streams.
 *
 * A turn that has already executed a tool is never retried on either path — see
 * `services/llm-fallback.ts#shouldUseFallback`. Tools are executed *between*
 * model calls, so the fallback covers the first model call of a turn and stops
 * covering the turn the moment a reminder or task has actually been written.
 */
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { AI_CREDIT_EXHAUSTED_MESSAGE, isCreditExhausted } from '../services/assistant.js';
import {
	getAnthropicHttpConfig,
	SAFETY_SYSTEM_PROMPT_SUFFIX,
	containsJailbreak,
	containsUnsafeContent,
	redactPII,
	defaultMaxOutputTokens,
	type ChatContentBlock,
	type ChatMessage,
	type ToolDefinition,
	type ToolUseBlock,
} from '../services/ai.js';
import {
	FALLBACK_PROVIDER_LABEL,
	ProviderRequestError,
	getLlmFallbackConfig,
	isAbortError,
	withProviderFallback,
} from '../services/llm-fallback.js';
import { streamOnEndpoint, TRANSPORT_TIMEOUT_MS, type LlmRequest } from '../services/llm-transport.js';

// Re-exported so `session.ts` and the socket tests keep importing both from here.
export { isAbortError };

/**
 * The 120 s provider ceiling, re-exported from the transport that enforces it so
 * a change to the budget is one edit.
 */
export const STREAM_REQUEST_TIMEOUT_MS = TRANSPORT_TIMEOUT_MS;

export interface StreamChatOptions {
	model?: string;
	maxTokens?: number;
	temperature?: number;
	systemPrompt?: string;
	tools?: ToolDefinition[];
	signal?: AbortSignal;
	/**
	 * Whether a pre-first-token provider failure may be retried on the configured
	 * secondary provider. Defaults to `true` (nothing has been emitted yet at the
	 * moment the request is made); `runStreamingAssistantLoop` passes `false` once
	 * it has executed a tool, because a retry must never be able to repeat a
	 * side-effecting write.
	 */
	allowProviderFallback?: boolean;
	/**
	 * Serve this call directly from the configured secondary provider because an
	 * **earlier call of the same assistant turn** already found the primary
	 * unusable.
	 *
	 * Sticky provider selection for one turn, exactly as on the REST path: a turn
	 * whose first call fell back must not re-probe the dead primary on its next
	 * iteration. It changes nothing about the commit point — the fallback is
	 * still only *started* before any delta, and the caller's `retrySafe` answer
	 * still governs whether a failure may be retried on top of that. Owned by the
	 * caller's loop, so one turn never pins another.
	 */
	preferFallback?: boolean;
}

export interface StreamChatResult {
	content: string;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
	blocks: ChatContentBlock[];
	stopReason: string | null;
	toolUses: ToolUseBlock[];
	/** Which provider served this turn: `'anthropic'` or `'llm-fallback'`. */
	provider?: string;
	/** True when the secondary provider served this turn. */
	fellBack?: boolean;
}

function messageText(content: string | ChatContentBlock[]): string {
	if (typeof content === 'string') return content;
	return content
		.filter((b): b is Extract<ChatContentBlock, { type: 'text' }> => b.type === 'text')
		.map((b) => b.text)
		.join('');
}

function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.map((m) => {
		if (m.role !== 'user') return m;
		if (typeof m.content === 'string') return { ...m, content: redactPII(m.content) };
		return {
			...m,
			content: m.content.map((b) => (b.type === 'text' ? { ...b, text: redactPII(b.text) } : b)),
		};
	});
}

/**
 * Maps a provider failure onto the stable `HttpError` codes the socket and the
 * REST voice route share. A plain abort is a cancellation, not a failure, and is
 * rethrown untouched so `session.ts` can tell a barge-in from an outage.
 */
function toStreamHttpError(err: unknown): unknown {
	if (!(err instanceof ProviderRequestError)) return err;

	const detail = err.message;
	// A 402, or a `200` carrying the billing notice, is the gateway saying the
	// account cannot pay for the next call. Classified with the same detector
	// REST uses, so the two cannot drift.
	if (isCreditExhausted(err.status, detail)) {
		return new HttpError(503, AI_CREDIT_EXHAUSTED_MESSAGE, 'AI_CREDIT_EXHAUSTED');
	}
	if (err.kind === 'notice') {
		return new HttpError(502, `AI provider rejected the request: ${detail.slice(0, 200)}`, 'AI_ERROR');
	}
	if (err.kind === 'stream') {
		// Byte-for-byte the message the SSE reader produced before the fallback
		// existed, so a client's error handling is unchanged.
		return new HttpError(502, detail.slice(0, 200), 'AI_ERROR');
	}
	if (err.status === 401 || err.status === 403) {
		return new HttpError(
			503,
			'The AI provider rejected this server’s credentials.',
			'AI_NOT_CONFIGURED',
		);
	}
	return new HttpError(502, `AI provider failed (${err.status ?? 'unknown'})`, 'AI_ERROR');
}

/**
 * Streams one model turn. `onTextDelta` is called with each text fragment as it
 * arrives; the resolved value carries the assembled blocks so a tool loop can
 * replay them exactly like the non-streaming path does.
 */
export async function streamChatCompletion(
	messages: ChatMessage[],
	options: StreamChatOptions,
	onTextDelta: (text: string) => void,
): Promise<StreamChatResult> {
	// Same pre-flight as chatCompletion: a spoken jailbreak attempt is still a
	// jailbreak attempt. Only text counts — tool_result blocks are ours.
	for (const message of messages) {
		if (message.role !== 'user') continue;
		const text = messageText(message.content);
		if (containsJailbreak(text)) {
			throw new HttpError(400, 'Request contains a jailbreak attempt and was blocked', 'AI_BLOCKED');
		}
		if (containsUnsafeContent(text)) {
			throw new HttpError(400, 'Request contains unsafe content and was blocked', 'AI_BLOCKED');
		}
	}

	const cfg = getAnthropicHttpConfig();
	if (!cfg.apiKey) {
		throw new HttpError(503, 'The AI provider is not configured on this server.', 'AI_NOT_CONFIGURED');
	}

	const systemPrompt = options.systemPrompt
		? `${options.systemPrompt}\n\n${SAFETY_SYSTEM_PROMPT_SUFFIX}`
		: SAFETY_SYSTEM_PROMPT_SUFFIX;

	// The realtime model, not the general one: time-to-first-token is the
	// dominant cost in a spoken turn and a faster model is what closes the gap
	// to a Siri-class response.
	const request: LlmRequest = {
		messages: sanitizeMessages(messages),
		systemPrompt,
		model: options.model || cfg.realtimeModel,
		maxTokens: options.maxTokens ?? defaultMaxOutputTokens(),
		temperature: options.temperature ?? 0.7,
		tools: options.tools,
	};

	const primaryEndpoint = {
		label: 'anthropic',
		baseURL: cfg.baseURL,
		apiKey: cfg.apiKey,
		authStyle: cfg.authStyle,
		protocol: 'anthropic' as const,
	};

	// ── The commit point ────────────────────────────────────────────────
	// Nothing has been emitted before the first delta, so a failure up to that
	// point is retryable. The instant this flag flips, the turn is committed and
	// a retry can no longer happen.
	let committed = false;
	const emit = (text: string): void => {
		committed = true;
		onTextDelta(text);
	};

	const fallback = getLlmFallbackConfig(cfg.realtimeModel);
	const allowFallback = options.allowProviderFallback !== false;
	const cancelled = (): boolean => options.signal?.aborted === true;

	let served;
	try {
		served = await withProviderFallback<StreamChatResult>({
			primaryProvider: 'anthropic',
			primaryModel: request.model,
			secrets: [cfg.apiKey, fallback?.apiKey],
			// Sticky per turn: an iteration after the first fallback must not
			// re-probe a primary this turn has already found unusable. This is
			// independent of the commit point below — nothing is retried, the
			// turn's next request is simply sent to the provider it already chose.
			preferFallback: options.preferFallback === true,
			isRetrySafe: () => allowFallback && !committed && !cancelled(),
			primary: async () => {
				const result = await streamOnEndpoint(primaryEndpoint, request, emit, options.signal);
				return { ...result, provider: 'anthropic', fellBack: false };
			},
			fallback: fallback
				? {
						provider: FALLBACK_PROVIDER_LABEL,
						model: fallback.model,
						protocol: fallback.protocol,
						call: async () => {
							const result = await streamOnEndpoint(
								fallback,
								{ ...request, model: fallback.model },
								emit,
								options.signal,
							);
							return { ...result, provider: FALLBACK_PROVIDER_LABEL, fellBack: true };
						},
					}
				: null,
		});
	} catch (err) {
		throw toStreamHttpError(err);
	}

	if (served.fellBack) {
		logger.info(
			{ provider: served.provider, model: served.model, fellBack: true },
			'Realtime voice turn served by the fallback LLM provider',
		);
	}

	return served.result;
}
