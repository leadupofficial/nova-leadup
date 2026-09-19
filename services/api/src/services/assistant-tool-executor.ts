/**
 * NOVA API — execution of the assistant's write tools.
 *
 * Everything that touches the database lives here, behind one rule: the user
 * the write belongs to is supplied by the *caller*, taken from the
 * authenticated request (`req.user.id`), and is never read out of the model's
 * tool input. A tool call is untrusted model output.
 *
 * The `.strict()` schemas below make that explicit rather than merely implied:
 * a key the model was not offered — `user_id`, `userId`, `tenant_id`,
 * `organization_id`, `status`, `priority` — fails validation and comes back as
 * a tool error, so an attempted injection is visible in the result instead of
 * being silently dropped or honoured.
 */
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { reminders, tasks, memories } from '@nova/database';
import { logger } from '../utils/logger.js';
import { USER_TIMEZONE } from './user-context.js';
import { formatInZone, normalizeTimeZone, parseDateTime } from './assistant-datetime.js';
import type { ChatContentBlock, ToolUseBlock } from './ai.js';

// ─── Input schemas ───────────────────────────────────────────────────

const DateTimeString = z
	.string()
	.min(1)
	.max(64)
	.superRefine((value, ctx) => {
		if (!parseDateTime(value, USER_TIMEZONE)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'must be an ISO 8601 date-time such as 2026-09-19T17:00:00+05:30',
			});
		}
	});

export const CreateReminderInput = z
	.object({
		title: z.string().min(1).max(500),
		trigger_at: DateTimeString,
		timezone: z.string().min(1).max(50).optional(),
	})
	.strict();

export const CreateTaskInput = z
	.object({
		title: z.string().min(1).max(500),
		due_at: DateTimeString.optional(),
	})
	.strict();

export const SaveMemoryInput = z
	.object({
		content: z.string().min(1).max(2000),
		category: z.enum(['fact', 'preference', 'event', 'contact', 'decision']),
	})
	.strict();

// ─── Results ─────────────────────────────────────────────────────────

export interface ExecutedToolCall {
	/** The provider's `tool_use` id, so the result can be matched back. */
	toolUseId: string;
	name: string;
	input: Record<string, unknown>;
	ok: boolean;
	/** One-line statement of what happened, for logs and cap fallbacks. */
	summary: string;
	error?: string;
	/** The created row's identity, echoed to the model in the tool result. */
	data?: Record<string, unknown>;
	/**
	 * Why the tool did not run, when the reason was the user's answer to the
	 * approval request rather than the tool itself. `summary` already says so in
	 * words for the model and the transcript; this is the machine-readable cause
	 * the client turns into a notice.
	 */
	approvalReason?: ToolApprovalReason;
}

/**
 * The ways an approval can stop a tool.
 *
 * `payload_mismatch` is separate from `rejected` on purpose: it means the user
 * approved *something*, but the arguments changed before execution, so the
 * approval does not cover what would now run (blueprint §7.5).
 */
export type ToolApprovalReason =
	| 'rejected'
	| 'timeout'
	| 'cancelled'
	| 'payload_mismatch'
	| 'unbound';

export interface ExecuteToolOptions {
	/**
	 * Refuse the call without running it, with this wording. Set by the voice
	 * approval gate; absent on the typed path, which decides upstream.
	 */
	blocked?: { summary: string; reason: ToolApprovalReason };
}

function failed(toolUse: ToolUseBlock, error: string): ExecutedToolCall {
	return { toolUseId: toolUse.id, name: toolUse.name, input: toolUse.input, ok: false, summary: error, error };
}

/** Human-readable zod problems, without leaking the schema internals. */
function describeIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
		.join('; ');
}

// ─── Execution ───────────────────────────────────────────────────────

/**
 * Runs one tool call as `userId`. The id comes from the authenticated request;
 * nothing in `toolUse.input` can influence whose data is written.
 */
export async function executeAssistantTool(
	userId: string,
	toolUse: ToolUseBlock,
	options: ExecuteToolOptions = {},
): Promise<ExecutedToolCall> {
	// Checked before anything else — before validation, before the database.
	// A tool the user did not approve must leave no trace of having been tried.
	const blocked = options.blocked;
	if (blocked) {
		return {
			toolUseId: toolUse.id,
			name: toolUse.name,
			input: toolUse.input,
			ok: false,
			summary: blocked.summary,
			error: blocked.summary,
			approvalReason: blocked.reason,
		};
	}

	const db = getDb();

	switch (toolUse.name) {
		case 'create_reminder': {
			const parsed = CreateReminderInput.safeParse(toolUse.input);
			if (!parsed.success) return failed(toolUse, `Invalid create_reminder input — ${describeIssues(parsed.error)}`);

			const timeZone = parsed.data.timezone ? normalizeTimeZone(parsed.data.timezone) : USER_TIMEZONE;
			if (!timeZone) {
				return failed(toolUse, `"${parsed.data.timezone}" is not a valid IANA timezone name (e.g. Asia/Kolkata)`);
			}
			const triggerAt = parseDateTime(parsed.data.trigger_at, timeZone);
			if (!triggerAt) return failed(toolUse, 'trigger_at is not a valid date-time');

			// A reminder in the past is a dead row: it can never fire, and the
			// upcoming-reminders query ignores it. This is not hypothetical —
			// given a year-less "current time" the model wrote 2025 for
			// "tomorrow", so refuse the date and let it correct itself rather
			// than silently saving something useless. 60s of slack absorbs
			// clock skew on a reminder the user asked for right now.
			if (triggerAt.getTime() < Date.now() - 60_000) {
				return failed(
					toolUse,
					`trigger_at ${triggerAt.toISOString()} (${formatInZone(triggerAt, timeZone)}) is in the past; ` +
						`the current time is ${formatInZone(new Date(), timeZone)} (${timeZone}). ` +
						'Recompute the date from the current time given in your instructions.',
				);
			}

			try {
				const [reminder] = await db
					.insert(reminders)
					.values({
						userId,
						title: parsed.data.title,
						triggerAt,
						timezone: timeZone,
						repeatRule: null,
						notificationChannel: ['push'],
						dismissed: false,
						createdAt: new Date(),
					})
					.returning();

				logger.info({ userId, reminderId: reminder?.id, timeZone }, 'Assistant created a reminder');
				return {
					toolUseId: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
					ok: true,
					summary: `Reminder "${parsed.data.title}" set for ${formatInZone(triggerAt, timeZone)} (${timeZone}).`,
					data: {
						reminder_id: reminder?.id ?? null,
						title: parsed.data.title,
						trigger_at: triggerAt.toISOString(),
						timezone: timeZone,
						trigger_at_local: formatInZone(triggerAt, timeZone),
					},
				};
			} catch (err) {
				logger.warn({ err, userId }, 'Assistant failed to create a reminder');
				return failed(toolUse, 'the reminder could not be saved');
			}
		}

		case 'create_task': {
			const parsed = CreateTaskInput.safeParse(toolUse.input);
			if (!parsed.success) return failed(toolUse, `Invalid create_task input — ${describeIssues(parsed.error)}`);

			let dueAt: Date | null = null;
			if (parsed.data.due_at) {
				dueAt = parseDateTime(parsed.data.due_at, USER_TIMEZONE);
				if (!dueAt) return failed(toolUse, 'due_at is not a valid date-time');
			}

			try {
				const now = new Date();
				const [task] = await db
					.insert(tasks)
					.values({
						userId,
						title: parsed.data.title,
						description: null,
						status: 'pending',
						dueAt,
						// Provenance, so a task the assistant created is
						// distinguishable from one the user typed. `tasks` has
						// no priority column — the API accepts one and drops it.
						source: 'assistant',
						tags: [],
						createdAt: now,
						updatedAt: now,
					})
					.returning();

				const duePhrase = dueAt ? `, due ${formatInZone(dueAt, USER_TIMEZONE)}` : '';
				logger.info({ userId, taskId: task?.id }, 'Assistant created a task');
				return {
					toolUseId: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
					ok: true,
					summary: `Task "${parsed.data.title}" added${duePhrase}.`,
					data: {
						task_id: task?.id ?? null,
						title: parsed.data.title,
						due_at: dueAt ? dueAt.toISOString() : null,
						due_at_local: dueAt ? formatInZone(dueAt, USER_TIMEZONE) : null,
						status: 'pending',
					},
				};
			} catch (err) {
				logger.warn({ err, userId }, 'Assistant failed to create a task');
				return failed(toolUse, 'the task could not be saved');
			}
		}

		case 'save_memory': {
			const parsed = SaveMemoryInput.safeParse(toolUse.input);
			if (!parsed.success) return failed(toolUse, `Invalid save_memory input — ${describeIssues(parsed.error)}`);

			try {
				const now = new Date();
				const [memory] = await db
					.insert(memories)
					.values({
						userId,
						content: parsed.data.content,
						category: parsed.data.category,
						sourceType: 'conversation',
						visibility: 'private',
						sensitivity: 'normal',
						importance: 50,
						confidence: 50,
						sourceIds: [],
						normalizedFacts: {},
						// `memories` has no deletedAt — it is archived through
						// `status`, and the grounding block reads 'proposed',
						// so a new memory is immediately visible to NOVA.
						status: 'proposed',
						createdAt: now,
						updatedAt: now,
					})
					.returning();

				logger.info({ userId, memoryId: memory?.id, category: parsed.data.category }, 'Assistant saved a memory');
				return {
					toolUseId: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
					ok: true,
					summary: `Saved to memory (${parsed.data.category}).`,
					data: { memory_id: memory?.id ?? null, category: parsed.data.category },
				};
			} catch (err) {
				logger.warn({ err, userId }, 'Assistant failed to save a memory');
				return failed(toolUse, 'the memory could not be saved');
			}
		}

		default:
			return failed(toolUse, `Unknown tool "${toolUse.name}"`);
	}
}

/**
 * Runs the requested tools in order.
 *
 * Sequential and never throwing: a failure becomes a `tool_result` with
 * `is_error`, which is the only way the model can honestly tell the user that
 * the reminder was not saved.
 */
export async function executeToolUses(
	userId: string,
	toolUses: ToolUseBlock[],
	options: ExecuteToolOptions = {},
): Promise<ExecutedToolCall[]> {
	const results: ExecutedToolCall[] = [];
	for (const toolUse of toolUses) {
		results.push(await executeAssistantTool(userId, toolUse, options));
	}
	return results;
}

/** The `tool_result` turn fed back to the model. */
export function toToolResultBlock(call: ExecutedToolCall): ChatContentBlock {
	return {
		type: 'tool_result',
		tool_use_id: call.toolUseId,
		content: JSON.stringify({
			ok: call.ok,
			tool: call.name,
			result: call.data ?? null,
			error: call.error ?? null,
			message: call.summary,
		}),
		is_error: !call.ok,
	};
}

/**
 * Fallback acknowledgement for the case where the loop cap is reached with no
 * text to return. Better a plain statement of what actually happened than an
 * empty assistant message.
 */
export function toolSummaryText(calls: ExecutedToolCall[]): string {
	if (!calls.length) return "I wasn't able to complete that.";
	const done = calls.filter((c) => c.ok);
	const failedCalls = calls.filter((c) => !c.ok);
	const parts: string[] = [];
	if (done.length) parts.push(`Done — ${done.map((c) => c.summary).join(' ')}`);
	if (failedCalls.length) {
		parts.push(`That didn't work: ${failedCalls.map((c) => `${c.name} failed (${c.error}).`).join(' ')}`);
	}
	return parts.join(' ');
}
