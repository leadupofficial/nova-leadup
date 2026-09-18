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
 * guardrails in `services/ai.ts`.
 */
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import {
	getAnthropicHttpConfig,
	SAFETY_SYSTEM_PROMPT_SUFFIX,
	containsJailbreak,
	containsUnsafeContent,
	redactPII,
	looksLikeProviderNotice,
	type ChatContentBlock,
	type ChatMessage,
	type ToolDefinition,
	type ToolUseBlock,
} from '../services/ai.js';

/** Provider calls are capped like the REST path (P0-06: 120 s). */
const REQUEST_TIMEOUT_MS = 120_000;

export interface StreamChatOptions {
	model?: string;
	maxTokens?: number;
	temperature?: number;
	systemPrompt?: string;
	tools?: ToolDefinition[];
	signal?: AbortSignal;
}

export interface StreamChatResult {
	content: string;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
	blocks: ChatContentBlock[];
	stopReason: string | null;
	toolUses: ToolUseBlock[];
}

/** True when a rejection is our own cancellation rather than a provider fault. */
export function isAbortError(err: unknown): boolean {
	return (
		!!err &&
		typeof err === 'object' &&
		((err as { name?: string }).name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR')
	);
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

	const body: Record<string, unknown> = {
		model: options.model || cfg.model,
		max_tokens: options.maxTokens ?? 1024,
		temperature: options.temperature ?? 0.7,
		// Array-of-blocks `system` is what the REST path sends and what the
		// gateway accepts; keep it byte-compatible.
		system: [{ type: 'text', text: systemPrompt }],
		messages: sanitizeMessages(messages),
		stream: true,
	};
	if (options.tools?.length) body.tools = options.tools;

	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'anthropic-version': '2023-06-01',
	};
	if (cfg.authStyle === 'bearer') headers.Authorization = `Bearer ${cfg.apiKey}`;
	else headers['x-api-key'] = cfg.apiKey;

	const controller = new AbortController();
	const abortFromCaller = () => controller.abort();
	if (options.signal) {
		if (options.signal.aborted) controller.abort();
		else options.signal.addEventListener('abort', abortFromCaller, { once: true });
	}
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	const blocks = new Map<number, ChatContentBlock>();
	const order: number[] = [];
	const partialJson = new Map<number, string>();
	let content = '';
	let model = String(body.model);
	let inputTokens = 0;
	let outputTokens = 0;
	let stopReason: string | null = null;

	try {
		const response = await fetch(`${cfg.baseURL.replace(/\/+$/, '')}/v1/messages`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!response.ok || !response.body) {
			const detail = await response.text().catch(() => '');
			logger.warn({ status: response.status, detail: detail.slice(0, 300) }, 'Streaming chat provider failed');
			throw new HttpError(
				response.status === 401 || response.status === 403 ? 503 : 502,
				response.status === 401 || response.status === 403
					? 'The AI provider rejected this server’s credentials.'
					: `AI provider failed (${response.status})`,
				response.status === 401 || response.status === 403 ? 'AI_NOT_CONFIGURED' : 'AI_ERROR',
			);
		}

		const reader = response.body.getReader();
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

				let event: any;
				try {
					event = JSON.parse(payload);
				} catch {
					continue;
				}

				switch (event.type) {
					case 'message_start':
						model = event.message?.model ?? model;
						inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
						break;
					case 'content_block_start': {
						const index = event.index ?? order.length;
						const block = event.content_block;
						if (block?.type === 'text') {
							blocks.set(index, { type: 'text', text: block.text ?? '' });
						} else if (block?.type === 'tool_use') {
							blocks.set(index, {
								type: 'tool_use',
								id: block.id,
								name: block.name,
								input: (block.input ?? {}) as Record<string, unknown>,
							});
							partialJson.set(index, '');
						} else {
							continue;
						}
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
								logger.warn({ index, json: json.slice(0, 200) }, 'Unparseable tool_use input');
							}
						}
						break;
					}
					case 'message_delta':
						stopReason = event.delta?.stop_reason ?? stopReason;
						outputTokens = event.usage?.output_tokens ?? outputTokens;
						break;
					case 'error':
						throw new HttpError(502, `AI provider error: ${event.error?.message ?? 'unknown'}`, 'AI_ERROR');
					default:
						break;
				}
			}
		}
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener('abort', abortFromCaller);
	}

	// A gateway that answers 200 with a credential/quota notice as ordinary
	// text would otherwise have NOVA read it aloud. Same guard as the REST path.
	if (outputTokens === 0 && looksLikeProviderNotice(content)) {
		throw new HttpError(502, `AI provider rejected the request: ${content.slice(0, 200)}`, 'AI_ERROR');
	}

	const orderedBlocks = order
		.map((index) => blocks.get(index))
		.filter((b): b is ChatContentBlock => !!b);
	const toolUses: ToolUseBlock[] = orderedBlocks
		.filter((b): b is Extract<ChatContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
		.map((b) => ({ id: b.id, name: b.name, input: b.input }));

	return { content, model, usage: { inputTokens, outputTokens }, blocks: orderedBlocks, stopReason, toolUses };
}
