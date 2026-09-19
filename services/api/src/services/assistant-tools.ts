/**
 * NOVA API — the assistant's write tools: what the model is offered, and the
 * bounded loop that runs them.
 *
 * The conversation and voice routes can already *read* the user's tasks,
 * reminders and memories (`./user-context.js`), but until this module existed
 * the assistant had no way to *create* any of them. Ask it "remind me to call
 * the bank tomorrow at 5pm" and it correctly answered that it could not create
 * reminders — because it genuinely could not, and told the user to add it
 * manually. A companion that cannot take a reminder is not a companion.
 *
 * Tool execution itself lives in `./assistant-tool-executor.js` (which is where
 * the database lives, and where the authenticated user id is applied) and date
 * resolution in `./assistant-datetime.js`.
 */
import { chatCompletion, type ChatMessage, type ToolDefinition } from './ai.js';
import { logger } from '../utils/logger.js';
import {
	executeToolUses,
	toolSummaryText,
	toToolResultBlock,
	type ExecutedToolCall,
} from './assistant-tool-executor.js';

/**
 * Instruction appended to the system prompt wherever the tools are offered. It
 * is not part of the persona prompt because the routes that do not offer tools
 * must not advertise them.
 */
export const ASSISTANT_TOOLS_PROMPT =
	'You can create things for the user with tools: create_reminder, create_task and save_memory. ' +
	'When they ask you to remind them of something, add a task, or remember something about them, ' +
	'call the matching tool — never tell them to add it themselves and never say you are unable ' +
	'to create reminders, tasks or memories. Call a tool only when they clearly asked for that ' +
	'action; do not invent reminders or tasks they did not ask for. If a tool result says ok is ' +
	'false, tell them plainly that it failed and why. If it succeeded, confirm what you saved and ' +
	'repeat the resolved date and time when there is one. Use the current time and timezone given ' +
	'above to resolve "tomorrow", "next Monday" and similar phrasing.';

// ─── Tool definitions ────────────────────────────────────────────────

const CREATE_REMINDER_DESCRIPTION = [
	'Create a reminder that will notify the user at a specific date and time.',
	'Use this whenever the user asks to be reminded of something ("remind me to call the bank tomorrow at 5pm").',
	'`trigger_at` must be an ISO 8601 date-time. Include the UTC offset when you know it',
	'(2026-09-19T17:00:00+05:30); if you send a wall-clock time with no offset it is interpreted in the user timezone.',
	'It must be in the future — a past time is rejected.',
].join(' ');

const CREATE_TASK_DESCRIPTION = [
	'Add a task to the user\'s task list.',
	'Use this when the user asks to add, note down or keep track of something to do but gives no specific time to be alerted',
	'("add a task to send the invoice"). If they give a deadline, put it in `due_at` as an ISO 8601 date-time.',
	'When they name a day but no time ("due tomorrow"), use the end of that day — 18:00 in the user timezone —',
	'not midnight. A task due tomorrow is due by the end of tomorrow, and midnight sorts it to the very start of the day.',
].join(' ');

const SAVE_MEMORY_DESCRIPTION = [
	'Save a durable fact, preference, event, contact or decision about the user so you remember it later.',
	'Use this when the user tells you something about themselves they would expect you to recall ("I prefer morning meetings").',
].join(' ');

export const ASSISTANT_TOOLS: ToolDefinition[] = [
	{
		name: 'create_reminder',
		description: CREATE_REMINDER_DESCRIPTION,
		input_schema: {
			type: 'object',
			properties: {
				title: {
					type: 'string',
					description: 'Short reminder text, e.g. "Call the bank". Always in the user\'s language.',
				},
				trigger_at: {
					type: 'string',
					description:
						'When to notify, ISO 8601, e.g. "2026-09-19T17:00:00+05:30". A value with no offset is read in the user timezone. Must be in the future. ' +
						'If the user gives a day but no time, send 18:00 that day rather than a date on its own: a bare date is read as midnight, which would fire at the very start of the day.',
				},
				timezone: {
					type: 'string',
					description: 'Optional IANA timezone for the reminder, e.g. "Asia/Kolkata". Defaults to the user timezone.',
				},
			},
			required: ['title', 'trigger_at'],
			additionalProperties: false,
		},
	},
	{
		name: 'create_task',
		description: CREATE_TASK_DESCRIPTION,
		input_schema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'Short task text, e.g. "Send the invoice".' },
				due_at: {
					type: 'string',
					description:
						'Optional deadline, ISO 8601, e.g. "2026-09-19T17:00:00+05:30". A value with no offset is read in the user timezone. ' +
						'If the user gives a day but no time, send 18:00 that day rather than a date on its own: a bare date is read as midnight, which is the start of the day, not the deadline.',
				},
			},
			required: ['title'],
			additionalProperties: false,
		},
	},
	{
		name: 'save_memory',
		description: SAVE_MEMORY_DESCRIPTION,
		input_schema: {
			type: 'object',
			properties: {
				content: {
					type: 'string',
					description: 'The fact to remember, written as a short standalone statement, e.g. "Prefers morning meetings".',
				},
				category: {
					type: 'string',
					enum: ['fact', 'preference', 'event', 'contact', 'decision'],
					description: 'What kind of thing this is. Use "preference" for likes and dislikes.',
				},
			},
			required: ['content', 'category'],
			additionalProperties: false,
		},
	},
];

// ─── Bounded tool loop ───────────────────────────────────────────────

/**
 * Hard ceiling on model calls per user turn. A model that answers directly
 * uses one; the ordinary "call a tool, then confirm" turn uses two; a turn that
 * chains two rounds of tools uses three. Beyond that we stop calling the model
 * and return the last text we have, so a looping model cannot spend unbounded
 * tokens or take unbounded time.
 */
export const MAX_TOOL_ITERATIONS = 3;

export interface AssistantToolLoopResult {
	content: string;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
	toolCalls: ExecutedToolCall[];
	/** Model calls actually made (1..MAX_TOOL_ITERATIONS). */
	iterations: number;
	/** True when the cap stopped the loop before the model finished. */
	capped: boolean;
}

export interface AssistantToolLoopOptions {
	systemPrompt: string;
	maxTokens?: number;
	temperature?: number;
}

/**
 * Runs the model, executes any tools it asks for, feeds the results back, and
 * repeats until it produces a final text answer — or until the cap is reached,
 * in which case the last text produced (or a summary of what the tools did) is
 * returned rather than an empty reply.
 *
 * `userId` is the authenticated user. It is passed straight to the executor and
 * is never derived from anything the model sent.
 */
export async function runAssistantToolLoop(
	userId: string,
	messages: ChatMessage[],
	options: AssistantToolLoopOptions,
): Promise<AssistantToolLoopResult> {
	// Copy: the caller's history array must not be mutated with tool traffic.
	const conversation: ChatMessage[] = [...messages];
	const toolCalls: ExecutedToolCall[] = [];

	let lastText = '';
	let model = '';
	let usage = { inputTokens: 0, outputTokens: 0 };

	for (let iteration = 1; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
		const completion = await chatCompletion(conversation, {
			systemPrompt: options.systemPrompt,
			maxTokens: options.maxTokens,
			temperature: options.temperature,
			tools: ASSISTANT_TOOLS,
		});

		model = completion.model;
		usage = {
			inputTokens: usage.inputTokens + completion.usage.inputTokens,
			outputTokens: usage.outputTokens + completion.usage.outputTokens,
		};
		if (completion.content.trim()) lastText = completion.content;

		if (!completion.toolUses.length) {
			return { content: lastText, model, usage, toolCalls, iterations: iteration, capped: false };
		}

		const results = await executeToolUses(userId, completion.toolUses);
		toolCalls.push(...results);

		if (iteration === MAX_TOOL_ITERATIONS) {
			logger.warn(
				{ userId, iteration, tools: results.map((r) => r.name) },
				'Assistant tool loop hit its iteration cap — returning the last text',
			);
			return {
				content: lastText || toolSummaryText(toolCalls),
				model,
				usage,
				toolCalls,
				iterations: iteration,
				capped: true,
			};
		}

		// Replay the assistant's own blocks (text + tool_use) and answer each
		// tool_use with a matching tool_result in the following user turn —
		// the provider rejects a tool_use that is not answered immediately.
		conversation.push({ role: 'assistant', content: completion.blocks });
		conversation.push({ role: 'user', content: results.map(toToolResultBlock) });
	}

	// Unreachable: the loop returns on its final iteration.
	return {
		content: lastText || toolSummaryText(toolCalls),
		model,
		usage,
		toolCalls,
		iterations: MAX_TOOL_ITERATIONS,
		capped: true,
	};
}
