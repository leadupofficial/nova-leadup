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
 */
import { ASSISTANT_TOOLS, MAX_TOOL_ITERATIONS } from '../services/assistant-tools.js';
import {
	executeToolUses,
	toolSummaryText,
	toToolResultBlock,
	type ExecutedToolCall,
} from '../services/assistant-tool-executor.js';
import type { ChatMessage } from '../services/ai.js';
import { logger } from '../utils/logger.js';
import { streamChatCompletion } from './llm.js';

export interface StreamingToolLoopOptions {
	systemPrompt: string;
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
}

export interface StreamingToolLoopResult {
	content: string;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
	toolCalls: ExecutedToolCall[];
	iterations: number;
	capped: boolean;
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

	let streamed = '';
	let model = '';
	let usage = { inputTokens: 0, outputTokens: 0 };

	for (let iteration = 1; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
		const completion = await streamChatCompletion(
			conversation,
			{
				systemPrompt: options.systemPrompt,
				maxTokens: options.maxTokens,
				temperature: options.temperature,
				tools: ASSISTANT_TOOLS,
				signal: options.signal,
			},
			(text) => {
				streamed += text;
				onTextDelta(text);
			},
		);

		model = completion.model;
		usage = {
			inputTokens: usage.inputTokens + completion.usage.inputTokens,
			outputTokens: usage.outputTokens + completion.usage.outputTokens,
		};

		if (!completion.toolUses.length) {
			return {
				content: streamed || completion.content,
				model,
				usage,
				toolCalls,
				iterations: iteration,
				capped: false,
			};
		}

		const results = await executeToolUses(userId, completion.toolUses);
		toolCalls.push(...results);

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
	};
}
