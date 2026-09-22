/**
 * NOVA API — the wire vocabulary of an LLM provider, independent of transport.
 *
 * The service speaks Anthropic's Messages vocabulary internally (`ChatMessage`
 * with `tool_use` / `tool_result` blocks, `ToolDefinition` with `input_schema`).
 * An OpenAI-compatible fallback provider speaks a different one, and both
 * protocols answer with a body that has to become the same normalised result.
 * Those translations live here, so `./llm-transport.js` and `./ai.js` read a
 * provider's answer the same way and cannot drift on how a `tool_use` block or a
 * usage count is interpreted.
 */
import type { ChatContentBlock, ChatMessage, ToolDefinition, ToolUseBlock } from './ai.js';

/** One provider request, in the Anthropic-shaped vocabulary both paths use. */
export interface LlmRequest {
	messages: ChatMessage[];
	systemPrompt: string;
	model: string;
	maxTokens: number;
	temperature: number;
	tools?: ToolDefinition[];
}

/** A streamed (or completed) turn, assembled. */
export interface LlmStreamResult {
	content: string;
	model: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		/**
		 * The share of `outputTokens` a reasoning model spent thinking rather than
		 * answering. Optional because only a reasoning provider reports it, and
		 * absent means "not reported", never "zero".
		 *
		 * It exists so an empty reply can be *explained* rather than merely
		 * detected: `glm-5.3` answered nothing because 1023 of its 1024 output
		 * tokens went to `reasoning_content`. The trace itself is still discarded
		 * — this is a count, not the text.
		 */
		reasoningTokens?: number;
	};
	blocks: ChatContentBlock[];
	stopReason: string | null;
	toolUses: ToolUseBlock[];
}

// ─── "There was no answer in the answer" ────────────────────────────

/**
 * Provider stop reasons that mean the model was cut off mid-thought, in both
 * vocabularies: OpenAI-compatible endpoints say `length`, Anthropic says
 * `max_tokens`. `mapFinishReason` normalises the former to the latter, but the
 * raw spelling is accepted too so an assembled result cannot slip through.
 */
export function isTruncationStopReason(reason: string | null | undefined): boolean {
	return reason === 'max_tokens' || reason === 'length';
}

/** What a client shows when the model was cut off before it answered. */
export const TRUNCATED_AI_REPLY_MESSAGE =
	'The AI model ran out of room before it answered, so there was no reply to show. Please try again, or ask for something shorter.';

/** What a client shows when the model simply returned nothing. */
export const EMPTY_AI_REPLY_MESSAGE = 'The AI model returned an empty reply. Please try again.';

/**
 * A provider call that succeeded at the HTTP level and produced no reply.
 *
 * This is the failure the voice route used to report as **HTTP 200 with
 * `text: ""`**: the fallback model is a reasoning model whose reasoning tokens
 * are billed against `max_tokens`, so on a non-trivial turn the reasoning ate
 * the whole budget, `finish_reason` came back `length`, and `content` was empty.
 * `mapOpenAIResult` faithfully turned that into `content: ''`, and every caller
 * treated a blank string as a finished turn.
 *
 * It carries the provider's own finish reason and its reasoning-token count, so
 * the two shapes stay distinguishable in logs and in what the user is told:
 * "the model was cut off" is not the same condition as "the model said nothing".
 */
export class EmptyCompletionError extends Error {
	/** The provider's own reason, normalised to the Anthropic vocabulary. */
	readonly stopReason: string | null;
	/** True when the provider reported it stopped because it hit the ceiling. */
	readonly truncated: boolean;
	/** `reasoningTokens` when the provider reported it, else null. */
	readonly reasoningTokens: number | null;
	/** Output tokens the provider billed for the empty reply, when reported. */
	readonly outputTokens: number | null;

	constructor(info: { stopReason: string | null; reasoningTokens?: number | null; outputTokens?: number | null }) {
		const truncated = isTruncationStopReason(info.stopReason);
		super(truncated ? TRUNCATED_AI_REPLY_MESSAGE : EMPTY_AI_REPLY_MESSAGE);
		this.name = 'EmptyCompletionError';
		this.stopReason = info.stopReason;
		this.truncated = truncated;
		this.reasoningTokens = info.reasoningTokens ?? null;
		this.outputTokens = info.outputTokens ?? null;
	}
}

/**
 * True when a provider result carries no reply a user could be shown.
 *
 * A result with **tool calls is a valid answer** — the model acted, and the
 * caller's loop runs the tools and asks again. Everything else with no
 * non-whitespace text is "the model said nothing", whether it claimed to have
 * finished or was cut off first.
 *
 * Deliberately not a length test: a one-word answer like `Ok` is a real reply,
 * so the only question asked is whether any visible text exists at all.
 */
export function isEmptyCompletion(result: { content: string; toolUses: ToolUseBlock[] }): boolean {
	return result.content.trim() === '' && result.toolUses.length === 0;
}

/**
 * Turns an unusable provider result into an `EmptyCompletionError`, or returns
 * null when there is something to show.
 */
export function emptyCompletionError(result: {
	content: string;
	toolUses: ToolUseBlock[];
	stopReason: string | null;
	usage?: { outputTokens: number; reasoningTokens?: number };
}): EmptyCompletionError | null {
	if (!isEmptyCompletion(result)) return null;
	return new EmptyCompletionError({
		stopReason: result.stopReason,
		reasoningTokens: result.usage?.reasoningTokens ?? null,
		outputTokens: result.usage?.outputTokens ?? null,
	});
}

/**
 * Throws `EmptyCompletionError` for a provider result carrying no reply.
 *
 * Called at every point a provider answer becomes an answer, so no path can
 * report a blank turn as a success.
 *
 * Non-retryable by design: `isProviderUnusableFailure` returns false for it, so
 * an empty answer never triggers a paid retry against the secondary provider. A
 * retry would most likely be empty for the same reason — the same reasoning
 * model, the same budget — and a silent second billed call is exactly what the
 * fallback policy exists to avoid.
 */
export function assertUsableCompletion(result: {
	content: string;
	toolUses: ToolUseBlock[];
	stopReason: string | null;
	usage?: { outputTokens: number; reasoningTokens?: number };
}): void {
	const empty = emptyCompletionError(result);
	if (empty) throw empty;
}

// ─── OpenAI-compatible translation ──────────────────────────────────

export interface OpenAIMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
}

/**
 * Rewrites Anthropic-shaped messages into the OpenAI chat format.
 *
 * Three translations matter: `tool_use` blocks become `assistant.tool_calls`
 * (with `input` serialised into `function.arguments`), each `tool_result` block
 * becomes its own `role: 'tool'` message keyed by `tool_call_id`, and the system
 * prompt moves from a top-level field into a leading `system` message. Getting
 * any of these wrong makes the provider reject a mid-loop request — exactly the
 * request a fallback is most likely to have to serve.
 */
export function toOpenAIMessages(messages: ChatMessage[], systemPrompt: string): OpenAIMessage[] {
	const out: OpenAIMessage[] = [{ role: 'system', content: systemPrompt }];

	for (const message of messages) {
		if (typeof message.content === 'string') {
			out.push({ role: message.role, content: message.content });
			continue;
		}

		const text = message.content
			.filter((b): b is Extract<ChatContentBlock, { type: 'text' }> => b.type === 'text')
			.map((b) => b.text)
			.join('');

		if (message.role === 'user') {
			// A user turn carries either prose or tool results. Each result is a
			// separate `tool` message; prose stays an ordinary user message.
			const results = message.content.filter(
				(b): b is Extract<ChatContentBlock, { type: 'tool_result' }> => b.type === 'tool_result',
			);
			if (results.length) {
				if (text) out.push({ role: 'user', content: text });
				for (const block of results) {
					const body = block.is_error ? `Error: ${block.content}` : block.content;
					out.push({ role: 'tool', content: body, tool_call_id: block.tool_use_id });
				}
				continue;
			}
			out.push({ role: 'user', content: text });
			continue;
		}

		const toolCalls = message.content
			.filter((b): b is Extract<ChatContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
			.map((b) => ({
				id: b.id,
				type: 'function' as const,
				function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
			}));

		out.push({
			role: 'assistant',
			content: text || null,
			...(toolCalls.length ? { tool_calls: toolCalls } : {}),
		});
	}

	return out;
}

/** Rewrites Anthropic-shaped tool definitions into OpenAI function tools. */
export function toOpenAITools(tools?: ToolDefinition[]): unknown[] | undefined {
	if (!tools?.length) return undefined;
	return tools.map((tool) => ({
		type: 'function',
		function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
	}));
}

/** `tool_calls` finish reason → the Anthropic vocabulary the callers read. */
function mapFinishReason(reason: unknown, hasTools: boolean): string | null {
	if (typeof reason !== 'string') return hasTools ? 'tool_use' : null;
	if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
	if (reason === 'length') return 'max_tokens';
	if (reason === 'stop') return 'end_turn';
	return reason;
}

/** Assembles the normalised result from text and tool calls, in provider order. */
function buildResult(
	content: string,
	toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
	model: string,
	usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number },
	stopReason: string | null,
): LlmStreamResult {
	const blocks: ChatContentBlock[] = [];
	if (content) blocks.push({ type: 'text', text: content });
	for (const call of toolCalls) {
		blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
	}
	const toolUses: ToolUseBlock[] = toolCalls.map((c) => ({ id: c.id, name: c.name, input: c.input }));
	return { content, model, usage, blocks, stopReason, toolUses };
}

/**
 * The reasoning-token count from an OpenAI-compatible `usage` block.
 *
 * Only a count is read — never `message.reasoning_content`. That field is
 * deliberately dropped in both directions: a reasoning trace is not the reply
 * and must never reach a user. What it cost, however, is exactly the number
 * needed to explain an empty answer, so it is kept as data.
 *
 * Both spellings seen in the wild are accepted (`completion_tokens_details.
 * reasoning_tokens`, which is what the configured fallback sends, and a
 * top-level `reasoning_tokens`).
 */
function reasoningTokensFrom(usage: any): number | undefined {
	const value = usage?.completion_tokens_details?.reasoning_tokens ?? usage?.reasoning_tokens;
	return typeof value === 'number' ? value : undefined;
}

/** Parses `arguments`, which providers stream as a JSON string. */
function parseArguments(raw: unknown): Record<string, unknown> {
	if (typeof raw !== 'string' || !raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Maps an OpenAI chat completion body onto the shared result shape. */
export function mapOpenAIResult(json: Record<string, any>): LlmStreamResult {
	const choice = json?.choices?.[0] ?? {};
	const message = choice.message ?? {};
	const toolCalls = (message.tool_calls ?? []).map((call: any) => ({
		id: String(call?.id ?? ''),
		name: String(call?.function?.name ?? ''),
		input: parseArguments(call?.function?.arguments),
	}));
	const reasoningTokens = reasoningTokensFrom(json?.usage);
	return buildResult(
		// `reasoning_content` is intentionally never read: the reply is the visible
		// `content`, and a turn that produced none is detected as empty rather than
		// filled in from the model's private trace.
		typeof message.content === 'string' ? message.content : '',
		toolCalls,
		String(json?.model ?? ''),
		{
			inputTokens: json?.usage?.prompt_tokens ?? 0,
			outputTokens: json?.usage?.completion_tokens ?? 0,
			...(reasoningTokens === undefined ? {} : { reasoningTokens }),
		},
		mapFinishReason(choice.finish_reason, toolCalls.length > 0),
	);
}

/**
 * The subset of an Anthropic Messages response this service reads.
 *
 * Structural rather than `Anthropic.Message` so the same mapping serves both the
 * SDK's typed object (the primary path in `./ai.js`) and the raw JSON of a
 * fallback endpoint.
 */
export interface AnthropicMessagesLike {
	content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
	model?: string;
	usage?: { input_tokens?: number; output_tokens?: number };
	stop_reason?: string | null;
}

/** Maps an Anthropic Messages response body (SDK object or raw JSON). */
export function mapAnthropicResult(response: AnthropicMessagesLike): LlmStreamResult {
	let content = '';
	const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
	for (const block of response.content ?? []) {
		if (block?.type === 'text' && typeof block.text === 'string') {
			content += block.text;
		} else if (block?.type === 'tool_use') {
			toolCalls.push({
				id: String(block.id),
				name: String(block.name),
				input: (block.input ?? {}) as Record<string, unknown>,
			});
		}
	}
	return buildResult(
		content,
		toolCalls,
		response.model ?? '',
		{
			inputTokens: response.usage?.input_tokens ?? 0,
			outputTokens: response.usage?.output_tokens ?? 0,
		},
		response.stop_reason ?? null,
	);
}

/** Builds a result from already-assembled pieces — used by the SSE readers. */
export function resultFromParts(
	content: string,
	toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
	model: string,
	usage: { inputTokens: number; outputTokens: number; reasoningTokens?: number },
	stopReason: string | null,
): LlmStreamResult {
	return buildResult(content, toolCalls, model, usage, stopReason);
}

export { reasoningTokensFrom };

/** Maps a streaming finish reason, exported for the OpenAI SSE reader. */
export function streamFinishReason(reason: unknown, hasTools: boolean): string | null {
	return mapFinishReason(reason, hasTools);
}

/** Parses streamed tool `arguments`, exported for the OpenAI SSE reader. */
export function streamToolArguments(raw: unknown): Record<string, unknown> {
	return parseArguments(raw);
}
