/**
 * NOVA API — the wire transport for a secondary LLM provider.
 *
 * `./llm-fallback.js` decides *whether* to fall back; this module does the
 * calling. It speaks both protocols a fallback is likely to need, in streaming
 * and non-streaming form, and normalises both onto `LlmStreamResult` (see
 * `./llm-wire-format.js` for the translations):
 *
 *   - OpenAI-compatible: `POST {base}/chat/completions`, `Authorization: Bearer`
 *     (or `api-key`), SSE `choices[0].delta`;
 *   - Anthropic: `POST {base}/v1/messages`, `x-api-key` (or Bearer), SSE
 *     `content_block_delta`.
 *
 * The likely fallback providers (apimaster.ai, Z.ai/GLM, Moonshot/Kimi,
 * DeepSeek) are OpenAI-compatible, which is why that protocol is the inferred
 * default; the Anthropic branch exists so a second relay can be dropped in with
 * no translation at all.
 */
import { logger } from '../utils/logger.js';
import { isCreditExhausted } from './assistant.js';
import {
	PROVIDER_DETAIL_LIMIT,
	ProviderRequestError,
	isAbortError,
	looksLikeProviderNotice,
	type LlmEndpoint,
	type LlmProtocol,
} from './llm-fallback.js';
import {
	assertUsableCompletion,
	mapAnthropicResult,
	mapOpenAIResult,
	reasoningTokensFrom,
	resultFromParts,
	streamFinishReason,
	streamToolArguments,
	toOpenAIMessages,
	toOpenAITools,
	type LlmRequest,
	type LlmStreamResult,
} from './llm-wire-format.js';
import type { ChatContentBlock, ToolUseBlock } from './ai.js';

/** Provider calls are capped like the primary path (P0-06: 120 s). */
const REQUEST_TIMEOUT_MS = 120_000;

// Re-exported so a caller needs one import for the transport and its shapes.
export type { LlmRequest, LlmStreamResult };
export { mapAnthropicResult, mapOpenAIResult, toOpenAIMessages, toOpenAITools };

// ─── HTTP plumbing ──────────────────────────────────────────────────

function urlFor(endpoint: LlmEndpoint): string {
	const base = endpoint.baseURL.replace(/\/+$/, '');
	return endpoint.protocol === 'openai' ? `${base}/chat/completions` : `${base}/v1/messages`;
}

function headersFor(endpoint: LlmEndpoint): Record<string, string> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (endpoint.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
	if (endpoint.authStyle === 'bearer') headers.Authorization = `Bearer ${endpoint.apiKey}`;
	else headers['x-api-key'] = endpoint.apiKey;
	return headers;
}

/** The request body in the endpoint's own protocol. */
function bodyFor(endpoint: LlmEndpoint, request: LlmRequest, stream: boolean): Record<string, unknown> {
	if (endpoint.protocol === 'openai') {
		return {
			model: request.model,
			max_tokens: request.maxTokens,
			temperature: request.temperature,
			messages: toOpenAIMessages(request.messages, request.systemPrompt),
			...(request.tools?.length ? { tools: toOpenAITools(request.tools) } : {}),
			...(stream ? { stream: true } : {}),
		};
	}
	return {
		model: request.model,
		max_tokens: request.maxTokens,
		temperature: request.temperature,
		system: [{ type: 'text', text: request.systemPrompt }],
		messages: request.messages,
		...(request.tools?.length ? { tools: request.tools } : {}),
		...(stream ? { stream: true } : {}),
	};
}

/** A controller that follows the caller's signal and its own 120 s ceiling. */
function aborter(signal?: AbortSignal): { controller: AbortController; done: () => void } {
	const controller = new AbortController();
	const forward = (): void => controller.abort();
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener('abort', forward, { once: true });
	}
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	return {
		controller,
		done: () => {
			clearTimeout(timeout);
			signal?.removeEventListener('abort', forward);
		},
	};
}

/** Classifies a `200` that carried a notice rather than an answer. */
function noticeFailure(
	endpoint: LlmEndpoint,
	content: string,
	outputTokens: number,
): ProviderRequestError | null {
	if (!content || outputTokens !== 0) return null;
	if (!looksLikeProviderNotice(content)) return null;
	return new ProviderRequestError(
		endpoint.label,
		'notice',
		null,
		`AI provider rejected the request: ${content}`,
		[endpoint.apiKey],
	);
}

// ─── Calls ──────────────────────────────────────────────────────────

/**
 * One non-streaming provider call, in whichever protocol the endpoint speaks.
 * Both are normalised to `LlmStreamResult` so the caller never has to know which
 * one served it.
 */
export async function completeOnEndpoint(
	endpoint: LlmEndpoint,
	request: LlmRequest,
	signal?: AbortSignal,
): Promise<LlmStreamResult> {
	const { controller, done } = aborter(signal);
	try {
		const response = await fetch(urlFor(endpoint), {
			method: 'POST',
			headers: headersFor(endpoint),
			body: JSON.stringify(bodyFor(endpoint, request, false)),
			signal: controller.signal,
		});

		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new ProviderRequestError(
				endpoint.label,
				'http',
				response.status,
				`LLM provider failed (${response.status}): ${detail}`,
				[endpoint.apiKey],
			);
		}

		const json = (await response.json()) as Record<string, any>;
		const result = endpoint.protocol === 'openai' ? mapOpenAIResult(json) : mapAnthropicResult(json);

		const notice = noticeFailure(endpoint, result.content, result.usage.outputTokens);
		if (notice) throw notice;

		// A `200` carrying no reply is not a turn the user can be shown. Checked
		// here — at the one place a provider body becomes a normalised result —
		// so neither protocol, and no caller, can report a blank answer as a
		// success. A result carrying tool calls is an answer and passes.
		assertUsableCompletion(result);
		return result;
	} finally {
		done();
	}
}

/**
 * One streaming provider call, in whichever protocol the endpoint speaks.
 *
 * `onTextDelta` is called per text fragment. This function never buffers beyond
 * the SSE frame it is parsing — the caller owns the decision about whether a
 * delta has been committed, which is what makes a pre-first-token failure
 * retryable and a post-first-token failure not.
 */
export async function streamOnEndpoint(
	endpoint: LlmEndpoint,
	request: LlmRequest,
	onTextDelta: (text: string) => void,
	signal?: AbortSignal,
): Promise<LlmStreamResult> {
	const { controller, done } = aborter(signal);
	try {
		const response = await fetch(urlFor(endpoint), {
			method: 'POST',
			headers: headersFor(endpoint),
			body: JSON.stringify(bodyFor(endpoint, request, true)),
			signal: controller.signal,
		});

		if (!response.ok || !response.body) {
			const detail = await response.text().catch(() => '');
			logger.warn(
				{ provider: endpoint.label, protocol: endpoint.protocol, status: response.status },
				'Streaming LLM provider failed',
			);
			throw new ProviderRequestError(
				endpoint.label,
				'http',
				response.status,
				`LLM provider failed (${response.status}): ${detail}`,
				[endpoint.apiKey],
			);
		}

		const streamed =
			endpoint.protocol === 'openai'
				? await readOpenAIStream(endpoint, response.body, onTextDelta, request.model)
				: await readAnthropicStream(endpoint, response.body, onTextDelta, request.model);

		// ── The same truncation exposure as the non-streaming path ────────
		// A reasoning model can spend the entire `max_tokens` on
		// `reasoning_content` and emit no `delta.content` at all. Nothing reaches
		// `onTextDelta`, TTS is handed no sentence, and without this check the
		// reply pipeline resolves `text: ''` — the spoken twin of the empty 200.
		// Empty content here means no delta was committed, so throwing costs no
		// already-spoken audio.
		assertUsableCompletion(streamed);
		return streamed;
	} finally {
		done();
	}
}

/** Iterates the JSON payloads of an SSE body. */
async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const rawLine of lines) {
			const line = rawLine.replace(/\r$/, '');
			if (!line.startsWith('data:')) continue;
			const payload = line.slice(5).trim();
			if (!payload || payload === '[DONE]') continue;
			try {
				yield JSON.parse(payload);
			} catch {
				continue;
			}
		}
	}
}

/** Reads an Anthropic Messages SSE stream. */
async function readAnthropicStream(
	endpoint: LlmEndpoint,
	body: ReadableStream<Uint8Array>,
	onTextDelta: (text: string) => void,
	requestedModel: string,
): Promise<LlmStreamResult> {
	const blocks = new Map<number, ChatContentBlock>();
	const order: number[] = [];
	const partialJson = new Map<number, string>();
	let content = '';
	let model = '';
	let inputTokens = 0;
	let outputTokens = 0;
	let stopReason: string | null = null;

	for await (const event of sseFrames(body)) {
		switch (event.type) {
			case 'message_start':
				model = event.message?.model ?? model;
				inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
				break;
			case 'content_block_start': {
				const index = event.index ?? order.length;
				const block = event.content_block;
				if (block?.type === 'text') blocks.set(index, { type: 'text', text: block.text ?? '' });
				else if (block?.type === 'tool_use') {
					blocks.set(index, {
						type: 'tool_use',
						id: block.id,
						name: block.name,
						input: (block.input ?? {}) as Record<string, unknown>,
					});
					partialJson.set(index, '');
				} else continue;
				order.push(index);
				break;
			}
			case 'content_block_delta': {
				const index = event.index ?? 0;
				const delta = event.delta;
				if (delta?.type === 'text_delta' && delta.text) {
					const block = blocks.get(index);
					if (block && block.type === 'text') block.text += delta.text;
					content += delta.text;
					onTextDelta(delta.text);
				} else if (delta?.type === 'input_json_delta') {
					partialJson.set(index, (partialJson.get(index) ?? '') + (delta.partial_json ?? ''));
				}
				break;
			}
			case 'content_block_stop': {
				const index = event.index ?? 0;
				const block = blocks.get(index);
				const json = partialJson.get(index);
				if (block && block.type === 'tool_use' && json) {
					try {
						block.input = JSON.parse(json) as Record<string, unknown>;
					} catch {
						logger.warn({ index }, 'Unparseable tool_use input');
					}
				}
				break;
			}
			case 'message_delta':
				stopReason = event.delta?.stop_reason ?? stopReason;
				outputTokens = event.usage?.output_tokens ?? outputTokens;
				break;
			case 'error':
				throw new ProviderRequestError(
					endpoint.label,
					'stream',
					null,
					`AI provider error: ${event.error?.message ?? 'unknown'}`,
					[endpoint.apiKey],
				);
			default:
				break;
		}
	}

	const ordered = order.map((index) => blocks.get(index)).filter((b): b is ChatContentBlock => !!b);
	const toolUses: ToolUseBlock[] = ordered
		.filter((b): b is Extract<ChatContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
		.map((b) => ({ id: b.id, name: b.name, input: b.input }));

	const notice = noticeFailure(endpoint, content, outputTokens);
	if (notice) throw notice;

	return {
		content,
		// `message_start` carries the model the provider actually ran; fall back
		// to what was asked for when a gateway omits it.
		model: model || requestedModel,
		usage: { inputTokens, outputTokens },
		blocks: ordered,
		stopReason,
		toolUses,
	};
}

/** Reads an OpenAI-compatible `chat/completions` SSE stream. */
async function readOpenAIStream(
	endpoint: LlmEndpoint,
	body: ReadableStream<Uint8Array>,
	onTextDelta: (text: string) => void,
	requestedModel: string,
): Promise<LlmStreamResult> {
	let content = '';
	let model = '';
	let inputTokens = 0;
	let outputTokens = 0;
	let reasoningTokens: number | undefined;
	let finishReason: unknown = null;
	const calls = new Map<number, { id: string; name: string; args: string }>();

	for await (const chunk of sseFrames(body)) {
		if (!model && typeof chunk?.model === 'string') model = chunk.model;
		if (chunk?.usage) {
			inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
			outputTokens = chunk.usage.completion_tokens ?? outputTokens;
			// The count only — `delta.reasoning_content` is never accumulated, so a
			// reasoning trace cannot become a spoken sentence.
			reasoningTokens = reasoningTokensFrom(chunk.usage) ?? reasoningTokens;
		}
		if (chunk?.error) {
			throw new ProviderRequestError(
				endpoint.label,
				'stream',
				null,
				`AI provider error: ${chunk.error?.message ?? 'unknown'}`,
				[endpoint.apiKey],
			);
		}

		const choice = chunk?.choices?.[0];
		if (!choice) continue;
		if (choice.finish_reason) finishReason = choice.finish_reason;

		const delta = choice.delta ?? {};
		if (typeof delta.content === 'string' && delta.content) {
			content += delta.content;
			onTextDelta(delta.content);
		}
		for (const call of delta.tool_calls ?? []) {
			const index = call?.index ?? 0;
			const existing = calls.get(index) ?? { id: '', name: '', args: '' };
			if (call?.id) existing.id = String(call.id);
			if (call?.function?.name) existing.name = String(call.function.name);
			if (typeof call?.function?.arguments === 'string') existing.args += call.function.arguments;
			calls.set(index, existing);
		}
	}

	const toolCalls = [...calls.entries()]
		.sort(([a], [b]) => a - b)
		.map(([index, call]) => ({
			id: call.id || `call_${index}`,
			name: call.name,
			input: streamToolArguments(call.args),
		}));

	// Without `stream_options.include_usage` a compatible provider reports no
	// usage, so `outputTokens` stays 0 and the zero-token notice guard would be
	// far too eager: any legitimate reply that merely mentions "credit" would be
	// thrown away. Narrow it to the billing wording itself, which is the one
	// condition the fallback also has to recognise. The trade-off is that a
	// fallback-served stream usually reports zero tokens, so its cost is recorded
	// as unknown rather than measured.
	if (outputTokens === 0 && content.length <= PROVIDER_DETAIL_LIMIT && isCreditExhausted(null, content)) {
		throw new ProviderRequestError(
			endpoint.label,
			'notice',
			null,
			`AI provider rejected the request: ${content}`,
			[endpoint.apiKey],
		);
	}

	return resultFromParts(
		content,
		toolCalls,
		model || requestedModel,
		{ inputTokens, outputTokens, ...(reasoningTokens === undefined ? {} : { reasoningTokens }) },
		streamFinishReason(finishReason, toolCalls.length > 0),
	);
}

/** The 120 s provider ceiling, exported so a caller can name or pin it. */
export const TRANSPORT_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

export type { LlmProtocol };
export { isAbortError };
