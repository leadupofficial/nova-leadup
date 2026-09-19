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
	toolPermissionLevel,
	toolRequiresConfirmation,
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
				? await executeAssistantTool(userId, toolUse, { blocked })
				: await executeAssistantTool(userId, toolUse);
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
