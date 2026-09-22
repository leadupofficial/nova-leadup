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
import { and, eq } from 'drizzle-orm';
import { getPrivacyPreferences } from './privacy-preferences.js';
import { getDb } from '../db/connection.js';
import { auditLogs, reminders, tasks } from '@nova/database';
import { logger } from '../utils/logger.js';
import { HttpError } from '../middleware/error-handler.js';
import { createMemory, forgetMatchingMemories, archiveSupersededMemories } from './memory.js';
import { USER_TIMEZONE } from './user-context.js';
import { formatInZone, normalizeTimeZone, parseDateTime } from './assistant-datetime.js';
import { clockTimeInDateTime, statedTimeIn, type StatedTime } from './stated-time.js';
import {
	MAX_REPEAT_RULE_LENGTH,
	REPEAT_RULE_FORMS,
	describeRepeatRule,
	formatRepeatRule,
	monthlyDayIsSkippedSomeMonths,
	nextOccurrence,
	parseRepeatRule,
	type ReminderRecurrence,
} from './reminder-recurrence.js';
import {
	FOLLOW_UP_SNOOZE_MAX_MINUTES,
	FOLLOW_UP_SNOOZE_MIN_MINUTES,
	recordFollowUpDecision,
} from './follow-up-state.js';
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
		/**
		 * The recurrence, in the format `./reminder-recurrence.js` owns (§14).
		 *
		 * A plain string here rather than a zod enum, because the grammar is one
		 * module's business and the refusal the model reads has to name the part that
		 * was wrong — `parseRepeatRule` in that module produces it, and a zod enum of
		 * allowed spellings could not.
		 */
		repeat_rule: z.string().min(1).max(MAX_REPEAT_RULE_LENGTH).optional(),
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

/**
 * `forget_memory` takes the *fact*, not an id.
 *
 * Every other tool that acts on an existing row takes an id, and the reason this
 * one cannot is structural rather than a preference: the grounding block lists
 * memories by content only (`user-context.ts` renders `- [category] content`), so
 * the model has never been given a memory id to send. A `memory_id` field here
 * would therefore be filled in by a guess — which is how the wrong row is
 * forgotten. The matching is done in `memory.ts`, scoped by the authenticated
 * user, exactly as an id lookup would be.
 */
export const ForgetMemoryInput = z
	.object({
		content: z.string().min(1).max(2000),
	})
	.strict();

// ─── Targeting an existing row ───────────────────────────────────────
//
// These four verbs act on something the user already has, so each one takes an
// id rather than a title. The id is the *only* handle the model gets: it is
// resolved against `eq(<table>.id, id) AND eq(<table>.userId, userId)`, so an id
// that belongs to another user fails exactly like an id that does not exist.
// Matching by title instead would be the bug — two reminders called "call
// Mummy" are indistinguishable, and a fuzzy match is how a tool edits the
// wrong row.

/**
 * Ids the model may send for a row it was shown.
 *
 * Validated as UUIDs on purpose. These columns are Postgres `uuid`, so a
 * non-uuid string is not a miss — it is a type error the database raises, and the
 * model gets a raw `DatabaseError` it cannot act on. Measured: `reopen_task` was
 * called with the placeholder `"task_id_for_warranty_claim"`, and the turn ended
 * with "the system rejected the request" and a task left completed. Rejecting the
 * shape here turns that into an ordinary validation failure the model can retry
 * from, and keeps a malformed id away from the database entirely.
 */
const ReminderId = z.string().uuid();
const TaskId = z.string().uuid();

export const UpdateReminderInput = z
	.object({
		reminder_id: ReminderId,
		title: z.string().min(1).max(500).optional(),
		trigger_at: DateTimeString.optional(),
		/**
		 * A *relative* move — "in an hour", "snooze it by 30 minutes", "not now,
		 * remind me after lunch" — which is what §31 asks for and what the
		 * absolute-only contract could not express: the model had to do the
		 * arithmetic from a prompt heading, and the measured result was a refusal.
		 *
		 * The ceiling is the follow-up snooze ceiling (a week), so the two
		 * relative durations in the product cannot disagree about how far ahead
		 * "later" may mean. The floor is 1 rather than the follow-up engine's 5:
		 * "remind me in a minute" is a legitimate thing to ask a reminder for,
		 * while a *follow-up* sooner than five minutes is nagging.
		 */
		in_minutes: z.number().int().min(1).max(FOLLOW_UP_SNOOZE_MAX_MINUTES).optional(),
		/**
		 * The new recurrence: a rule to start or change one, `null` to stop an
		 * existing reminder repeating, omitted to leave it as it is.
		 *
		 * `null` rather than an empty string or a magic `"NONE"`, because "stop
		 * repeating" is a real thing a user asks for ("just this once from now on")
		 * and this is the only field that can carry it.
		 */
		repeat_rule: z.string().min(1).max(MAX_REPEAT_RULE_LENGTH).nullable().optional(),
	})
	.strict();

export const CancelReminderInput = z.object({ reminder_id: ReminderId }).strict();

export const CompleteTaskInput = z.object({ task_id: TaskId }).strict();

export const ReopenTaskInput = z.object({ task_id: TaskId }).strict();

/**
 * Rescheduling or renaming an existing task.
 *
 * The lifecycle the product promises is create → modify → reschedule → complete
 * → reopen, and there was no tool for the middle two: a task could be created,
 * completed and reopened, but never moved. Measured: "move that to Friday" was
 * answered with "I need the time for Friday" and the task never moved, because
 * the model had nothing to call.
 */
export const UpdateTaskInput = z
	.object({
		task_id: TaskId,
		title: z.string().min(1).max(500).optional(),
		due_at: z.string().min(1).optional(),
		priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
	})
	.strict();

/** Renames and/or moves a task, keeping everything else as it is. */
async function changeTask(
	userId: string,
	taskId: string,
	patch: { title?: string; dueAt?: Date | null; priority?: string },
): Promise<{ existing: typeof tasks.$inferSelect; updated: typeof tasks.$inferSelect }> {
	const db = getDb();
	const where = ownedBy(userId, 'task', taskId);
	const [existing] = await db.select().from(tasks).where(where).limit(1);
	if (!existing) throw new ToolTargetError('task');

	const [updated] = await db
		.update(tasks)
		.set({ ...patch, updatedAt: new Date() })
		.where(where)
		.returning();
	return { existing, updated };
}

/**
 * The user's answer to a follow-up (§18).
 *
 * `.strict()`, like every other input here, so a key the model was never offered
 * fails validation instead of being ignored. `item_id` is deliberately not
 * `z.string().uuid()`: the row is looked up by `(id, userId)` and a malformed id
 * simply misses, which is both cheaper and a clearer error than a schema message the
 * model has to interpret. Every other targeting verb in this file does the same.
 */
export const ResolveFollowUpInput = z
	.object({
		item_type: z.enum(['task', 'reminder']),
		item_id: z.string().min(1).max(64),
		decision: z.enum(['leave', 'snooze']),
		snooze_minutes: z
			.number()
			.int()
			.min(FOLLOW_UP_SNOOZE_MIN_MINUTES)
			.max(FOLLOW_UP_SNOOZE_MAX_MINUTES)
			.optional(),
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
	/**
	 * The instant a *relative* time is resolved against (`update_reminder`'s
	 * `in_minutes`).
	 *
	 * A parameter rather than a `new Date()` inside the handler for the same
	 * reason `buildUserContext` takes its `now`: "in an hour" is only testable
	 * against a clock the caller owns, and a snooze is arithmetic on the server's
	 * instant — never on the model's idea of "now", which is rebuilt from the
	 * prompt on every turn. Production leaves it unset and the server clock is
	 * used.
	 */
	now?: Date;
	/**
	 * The user's own turn — the last thing they said — so a clock time in a tool
	 * call can be checked against the words that produced it.
	 *
	 * `now` above is the clock a *relative* duration is resolved against; this is
	 * the language an *absolute* time has to be licensed by, and it is the only
	 * evidence that an hour the model sent was the user's rather than the model's
	 * own invention. See `./stated-time.js` for the measured defect.
	 *
	 * Absent means "cannot check", never "refuse everything": a caller that has no
	 * turn — a scripted or internal call — keeps exactly the behaviour it had
	 * before this option existed.
	 */
	userTurn?: string;
}

function failed(toolUse: ToolUseBlock, error: string): ExecutedToolCall {
	return { toolUseId: toolUse.id, name: toolUse.name, input: toolUse.input, ok: false, summary: error, error };
}

// ─── A clock time the user never gave ────────────────────────────────

/** Collapses whitespace and shortens a turn so a refusal stays one readable line. */
function quotedTurn(turn: string): string {
	const collapsed = turn.replace(/\s+/g, ' ').trim();
	return collapsed.length > 160 ? `${collapsed.slice(0, 157)}…` : collapsed;
}

/** The refusal the model reads when it supplied an hour the user did not. */
function inventedTimeMessage(
	tool: string,
	field: 'due_at' | 'trigger_at',
	clock: string,
	turn: string,
	stated: StatedTime,
): string {
	const said = `"${quotedTurn(turn)}"`;
	const howItWasStated =
		stated.kind === 'part_of_day'
			? `the user's turn named only a part of the day — they said ${said} ("${stated.evidence}"), with no hour — ` +
				'and nothing stored says which hour that is for them'
			: `the user's turn stated no time — they said ${said}, and a day on its own is not a time`;
	// One step for the model either way, and the step has to be one the tool can
	// actually take: `trigger_at` is required on create_reminder, so "leave it
	// out" is not available there and offering it would send the model into a
	// schema failure instead of a resolved turn.
	const fix =
		tool === 'create_reminder'
			? 'either call create_reminder again with trigger_at as a date on its own (it is required, so it cannot be ' +
				'left out), or ask them, in one short question, what time they mean'
			: `either call ${tool} again with a date and no clock time (${field} left out, or a date on its own), ` +
				'or ask them, in one short question, what time they mean';

	return `${field} ${clock} is a clock time, but ${howItWasStated}. Do not choose an hour for them: ${fix}.`;
}

/**
 * Refuses a supplied clock time the user's own turn never stated, or returns null
 * when the call may go ahead.
 *
 * This is the deterministic half of the §5 requirement that NOVA either asks for
 * a time or leaves it unset: a prompt asking the model not to invent one was
 * measured failing, and a time in the database is indistinguishable from a time
 * the user gave. Three things have to be true before it refuses anything —
 *
 *   1. the caller supplied the turn at all (absent means "cannot check");
 *   2. the turn stated no clock time (a part of the day is not one);
 *   3. the value the model sent actually carries an hour (a date on its own is
 *      the "leave it unset" this refusal is asking for, not a fabrication).
 *
 * Anything the guard cannot see through is let through: a false positive here
 * would refuse a time the user did state, which is a worse failure than the one
 * being fixed.
 */
function refuseInventedTime(
	toolUse: ToolUseBlock,
	field: 'due_at' | 'trigger_at',
	supplied: string,
	userTurn: string | undefined,
): ExecutedToolCall | null {
	if (userTurn === undefined) return null;

	const stated = statedTimeIn(userTurn);
	if (stated.kind === 'clock_time') return null;

	const clock = clockTimeInDateTime(supplied);
	if (!clock) return null;

	return failed(toolUse, inventedTimeMessage(toolUse.name, field, clock, userTurn, stated));
}

// ─── Recurrence (§14) ────────────────────────────────────────────────

/**
 * Reads a `repeat_rule` the model sent, or the wording that says why it cannot be
 * used. `null` means "no rule", which is the ordinary one-shot reminder.
 *
 * The refusal is the whole point of validating here rather than at the column:
 * `repeat_rule` is free text, so anything at all can be stored in it — and a rule
 * neither the server nor the phone can interpret is a reminder that repeats
 * silently never, with the user told it was set. Naming the bad part lets the
 * model retry in the same turn instead of the user hearing about it.
 */
function readRepeatRule(
	input: string | null | undefined,
): { ok: true; rule: ReminderRecurrence | null; text: string | null } | { ok: false; error: string } {
	if (input === undefined || input === null) return { ok: true, rule: null, text: null };

	const parsed = parseRepeatRule(input);
	if (!parsed.ok) {
		return {
			ok: false,
			error: `repeat_rule could not be used — ${parsed.error}. Use one of ${REPEAT_RULE_FORMS}.`,
		};
	}

	// The format and the pure next-occurrence function both handle INTERVAL — but
	// nothing on the device can *repeat* one: `flutter_local_notifications` exposes
	// `time`, `dayOfWeekAndTime` and `dayOfMonthAndTime`, and none of them carries an
	// interval. Storing it would promise a repeat the phone cannot keep with the app
	// closed, so it is refused here, where the model can still be told what to offer
	// instead.
	if (parsed.rule.interval > 1) {
		const words = describeRepeatRule(parsed.rule);
		return {
			ok: false,
			error:
				`repeat_rule asks for ${words}, which NOVA cannot repeat — the phone repeats every day, ` +
				'every week on one weekday, or every month on one day, and nothing in between. ' +
				`Tell the user you can do one of those rather than promising ${words}.`,
		};
	}

	return { ok: true, rule: parsed.rule, text: formatRepeatRule(parsed.rule) };
}

/**
 * The recurrence clause of a confirmation — ", repeating every Monday" — or an
 * empty string for a reminder that does not repeat.
 *
 * The next occurrence is named only when it is not the reminder's `trigger_at`:
 * that is the case worth reporting, because it is the one where the user's own
 * words ("every Tuesday") and the date they were shown could otherwise disagree.
 * The rule is re-read from what is *stored* rather than from what was sent, so a
 * row written before this vocabulary existed is described as it is, and a rule the
 * parser does not know is passed over in silence rather than guessed at.
 */
function recurrenceClause(
	ruleText: string | null | undefined,
	start: Date | null,
	after: Date,
	timeZone: string,
): string {
	if (!ruleText) return '';
	const parsed = parseRepeatRule(ruleText);
	if (!parsed.ok) return '';

	const caveat = monthlyDayIsSkippedSomeMonths(parsed.rule)
		? ' (a month without that day is skipped)'
		: '';

	if (start) {
		try {
			const upcoming = nextOccurrence(parsed.rule, start, after, timeZone);
			if (upcoming.getTime() !== start.getTime()) {
				return `, repeating ${describeRepeatRule(parsed.rule)}${caveat}; the next one is ${formatInZone(upcoming, timeZone)} (${timeZone})`;
			}
		} catch {
			// An unusable stored zone is not worth failing a saved reminder over:
			// the reminder is written either way, and its date was already rendered
			// by the caller.
		}
	}

	return `, repeating ${describeRepeatRule(parsed.rule)}${caveat}`;
}

/** Human-readable zod problems, without leaking the schema internals. */
function describeIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
		.join('; ');
}

/**
 * The one wording every id-taking tool uses when the row is not the user's.
 *
 * Deliberately identical for "does not exist" and "belongs to somebody else":
 * distinguishing them would turn the assistant into an existence oracle over
 * other people's ids, and the model has no legitimate use for the difference.
 * The advice is the same either way — ask which item, or list what they have.
 */
function notFoundMessage(kind: 'reminder' | 'task'): string {
	return (
		`No ${kind} with that id belongs to this user, so nothing was changed. ` +
		`Use the id shown beside the ${kind} in the list you were given, or ask them which one they mean.`
	);
}

// ─── Execution ───────────────────────────────────────────────────────

/**
 * Thrown when a tool targets a row the authenticated user does not own.
 *
 * A typed error rather than a returned sentinel: the sentinel (`ExecutedToolCall
 * | Row`) is a union whose members are structurally indistinguishable, so the
 * caller would have to test for `ok` and TypeScript could not narrow it. One
 * catch site converts this into the ordinary failed tool result, and the
 * wording is the same for "no such row" and "somebody else's row" on purpose.
 */
class ToolTargetError extends Error {
	constructor(readonly target: 'reminder' | 'task') {
		super(notFoundMessage(target));
	}
}

/** The `WHERE` that makes the ownership boundary, used for the read and the write. */
function ownedBy(userId: string, table: 'reminder' | 'task', id: string) {
	return table === 'reminder'
		? and(eq(reminders.id, id), eq(reminders.userId, userId))
		: and(eq(tasks.id, id), eq(tasks.userId, userId));
}

/**
 * `update_reminder` and `cancel_reminder` share this.
 *
 * Scoped by `(id, userId)` in the `WHERE` as well as in the read: the read
 * decides whether to proceed, and the write would still refuse a foreign row if
 * the read were ever loosened. Belt and braces on the security boundary, and
 * the write is a no-op for anyone else's row rather than a second error path.
 */
async function changeReminder(
	userId: string,
	reminderId: string,
	patch: Record<string, unknown>,
): Promise<{ existing: typeof reminders.$inferSelect; updated: typeof reminders.$inferSelect }> {
	const db = getDb();
	const where = ownedBy(userId, 'reminder', reminderId);
	const [existing] = await db.select().from(reminders).where(where).limit(1);
	if (!existing) throw new ToolTargetError('reminder');

	const [updated] = await db.update(reminders).set(patch).where(where).returning();
	return { existing, updated };
}

/**
 * `complete_task` and `reopen_task` share this — they are one state transition
 * in two directions.
 *
 * The status values are the vocabulary `routes/tasks.ts` and `UpdateTaskSchema`
 * already use (`pending | in_progress | completed | cancelled`). No new status
 * is invented here, and `completed_at` is stamped on completion and cleared on
 * reopen so the two columns cannot disagree about whether the task is open.
 */
async function setTaskStatus(
	userId: string,
	taskId: string,
	status: 'pending' | 'completed',
): Promise<{ existing: typeof tasks.$inferSelect; updated: typeof tasks.$inferSelect }> {
	const db = getDb();
	const where = ownedBy(userId, 'task', taskId);
	const [existing] = await db.select().from(tasks).where(where).limit(1);
	if (!existing) throw new ToolTargetError('task');

	const now = new Date();
	const [updated] = await db
		.update(tasks)
		.set({ status, completedAt: status === 'completed' ? now : null, updatedAt: now })
		.where(where)
		.returning();
	return { existing, updated };
}

/**
 * Runs one tool call as `userId`. The id comes from the authenticated request;
 * nothing in `toolUse.input` can influence whose data is written.
 */
async function runAssistantTool(
	userId: string,
	toolUse: ToolUseBlock,
	options: ExecuteToolOptions = {},
): Promise<ExecutedToolCall> {
	// One owner of the "not yours" wording and of the failure shape: the
	// id-taking handlers below signal it by throwing, and every path out of
	// this function is an `ExecutedToolCall` the model can read.
	try {
		return await executeAssistantToolAs(userId, toolUse, options);
	} catch (err) {
		if (err instanceof ToolTargetError) return failed(toolUse, err.message);
		throw err;
	}
}

async function executeAssistantToolAs(
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

			// Checked before the recurrence and the past-date check: an hour the
			// user never gave is the defect this call has to be stopped for, and a
			// message about it is the one the model can act on without re-sending
			// the same invention.
			const invented = refuseInventedTime(toolUse, 'trigger_at', parsed.data.trigger_at, options.userTurn);
			if (invented) return invented;

			// The recurrence is validated before the past-date check: a rule that
			// cannot be kept makes the whole call unusable, and the model should hear
			// about that first rather than about a date it would only re-send.
			const recurrence = readRepeatRule(parsed.data.repeat_rule);
			if (!recurrence.ok) return failed(toolUse, recurrence.error);

			// A reminder in the past is a dead row: it can never fire, and the
			// upcoming-reminders query ignores it. This is not hypothetical —
			// given a year-less "current time" the model wrote 2025 for
			// "tomorrow", so refuse the date and let it correct itself rather
			// than silently saving something useless. 60s of slack absorbs
			// clock skew on a reminder the user asked for right now.
			if (triggerAt.getTime() < Date.now() - 60_000) {
				// The correction has to state *when* it is unambiguously. It used to
				// render "now" year-lessly ("Mon 21 Sept, 02:54 pm"), so the model
				// recomputed "tomorrow" against an unknown year, produced another
				// 2025 date, and did so on all three iterations — the user's reply
				// then both set a reminder and denied setting one. Both instants are
				// now named with their year, and "now" additionally as a full ISO
				// timestamp so the retry is mechanical rather than a guess.
				const now = new Date();
				return failed(
					toolUse,
					`trigger_at ${triggerAt.toISOString()} (${formatInZone(triggerAt, timeZone)}) is in the past; ` +
						`the current time is ${now.toISOString()} in ${timeZone} — ` +
						`${formatInZone(now, timeZone)}. ` +
						'Recompute the date from the current time given in your instructions, using the full year shown.',
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
						// Was hard-coded to `null`, which is why the column was always
						// empty no matter what the user asked for.
						repeatRule: recurrence.text,
						notificationChannel: ['push'],
						dismissed: false,
						createdAt: new Date(),
					})
					.returning();

				logger.info(
					{ userId, reminderId: reminder?.id, timeZone, repeatRule: recurrence.text },
					'Assistant created a reminder',
				);
				const repeats = recurrenceClause(
					recurrence.text,
					triggerAt,
					options.now ?? new Date(),
					timeZone,
				);
				return {
					toolUseId: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
					ok: true,
					summary: `Reminder "${parsed.data.title}" set for ${formatInZone(triggerAt, timeZone)} (${timeZone})${repeats}.`,
					data: {
						reminder_id: reminder?.id ?? null,
						title: parsed.data.title,
						trigger_at: triggerAt.toISOString(),
						timezone: timeZone,
						trigger_at_local: formatInZone(triggerAt, timeZone),
						...(recurrence.rule
							? {
									repeat_rule: recurrence.text,
									repeats: describeRepeatRule(recurrence.rule),
								}
							: {}),
					},
				};
			} catch (err) {
				logger.warn({ err, userId }, 'Assistant failed to create a reminder');
				return failed(toolUse, 'the reminder could not be saved');
			}
		}

		case 'update_reminder': {
			const parsed = UpdateReminderInput.safeParse(toolUse.input);
			if (!parsed.success) return failed(toolUse, `Invalid update_reminder input — ${describeIssues(parsed.error)}`);

			// Two spellings of "when" in one call means the model is hedging, and
			// either choice would be a guess about which one the user meant. Refuse
			// it so the retry sends one, rather than silently preferring one of them.
			if (parsed.data.trigger_at !== undefined && parsed.data.in_minutes !== undefined) {
				return failed(
					toolUse,
					'update_reminder takes either trigger_at (the new date and time) or in_minutes (that many minutes from now), not both — send the one the user asked for.',
				);
			}

			const patch: Partial<typeof reminders.$inferInsert> = {};
			if (parsed.data.title !== undefined) patch.title = parsed.data.title;

			let triggerAt: Date | null = null;
			if (parsed.data.trigger_at !== undefined) {
				triggerAt = parseDateTime(parsed.data.trigger_at, USER_TIMEZONE);
				if (!triggerAt) return failed(toolUse, 'trigger_at is not a valid date-time');

				// The guard is on `trigger_at` only, never on `in_minutes`: a
				// relative move is a duration the user *did* state ("in an hour",
				// "after lunch") and the server resolves it against its own clock,
				// so there is no hour for the model to invent. Refusing it would
				// break every snooze in order to fix a different defect.
				const invented = refuseInventedTime(toolUse, 'trigger_at', parsed.data.trigger_at, options.userTurn);
				if (invented) return invented;

				patch.triggerAt = triggerAt;
			} else if (parsed.data.in_minutes !== undefined) {
				// A duration is only meaningful against a clock, and the only clock
				// either side actually has is this server's. Adding it to the
				// *instant* (rather than to a wall-clock reading) is what makes
				// "in an hour" an hour across a DST boundary, and what makes a
				// snooze testable against an injected `now`. The reminder's own
				// timezone is then what the result is rendered in, below — the
				// update never moves a row into the server's default zone.
				const now = options.now ?? new Date();
				triggerAt = new Date(now.getTime() + parsed.data.in_minutes * 60_000);
				patch.triggerAt = triggerAt;
			}

			// A recurrence, a change to one, or `null` to stop repeating. Read before
			// the empty-patch check below, so "just this once from now on" on a
			// recurring reminder is a real patch rather than an empty one.
			if (parsed.data.repeat_rule !== undefined) {
				const recurrence = readRepeatRule(parsed.data.repeat_rule);
				if (!recurrence.ok) return failed(toolUse, recurrence.error);
				patch.repeatRule = recurrence.text;
			}

			// A patch with neither field would be an empty `SET`, which Postgres
			// rejects and which the user did not ask for anyway. Refuse it so the
			// model retries with the field it forgot instead of reporting success.
			if (Object.keys(patch).length === 0) {
				return failed(
					toolUse,
					'update_reminder needs a new title, a new trigger_at, in_minutes or repeat_rule — none was given',
				);
			}

			try {
				const { existing, updated } = await changeReminder(userId, parsed.data.reminder_id, patch);
				const title = updated?.title ?? existing.title;
				const when = updated?.triggerAt ?? existing.triggerAt;
				const timeZone = updated?.timezone ?? existing.timezone ?? USER_TIMEZONE;
				// The rule as it now stands, which is what the confirmation has to
				// describe — not what this call happened to send. `updated` is what
				// decides, not `??`: a cleared rule *is* null, and falling through to
				// the previous value would tell the user it still repeats.
				const repeatRule = updated ? updated.repeatRule ?? null : existing.repeatRule ?? null;
				// Which of the two paths moved it, so the confirmation the user hears
				// can be about a snooze rather than a vaguer "updated".
				const inMinutes = parsed.data.in_minutes;
				const repeats = recurrenceClause(repeatRule, when, options.now ?? new Date(), timeZone);
				// "Stop repeating this" is a change the user asked for and can hear
				// nothing about otherwise: the date and time are unchanged, so without
				// this the reply would be the same sentence as a rename.
				const stopped = !repeatRule && existing.repeatRule
					? ', and it no longer repeats'
					: '';
				logger.info(
					{ userId, reminderId: existing.id, inMinutes, repeatRule },
					inMinutes === undefined ? 'Assistant updated a reminder' : 'Assistant snoozed a reminder',
				);
				return {
					toolUseId: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
					ok: true,
					summary:
						inMinutes === undefined
							? `Reminder "${title}" updated to ${formatInZone(when, timeZone)} (${timeZone})${repeats}${stopped}.`
							: `Reminder "${title}" snoozed: it will now go off ${formatInZone(when, timeZone)} (${timeZone}), ${inMinutes} minutes from now${repeats}${stopped}.`,
					data: {
						reminder_id: existing.id,
						title,
						trigger_at: when.toISOString(),
						timezone: timeZone,
						trigger_at_local: formatInZone(when, timeZone),
						repeat_rule: repeatRule,
						...(inMinutes === undefined ? {} : { in_minutes: inMinutes, snoozed: true }),
					},
				};
			} catch (err) {
				if (err instanceof ToolTargetError) throw err; // the single owner of this wording
				logger.warn({ err, userId }, 'Assistant failed to update a reminder');
				return failed(toolUse, 'the reminder could not be updated');
			}
		}

		case 'cancel_reminder': {
			const parsed = CancelReminderInput.safeParse(toolUse.input);
			if (!parsed.success) return failed(toolUse, `Invalid cancel_reminder input — ${describeIssues(parsed.error)}`);

			try {
				// `dismissed`, not a delete. This is the flag the reminders screen
				// writes for "Dismiss" (and clears for "Restore") and the flag every
				// read filters on, so a cancellation the user regrets is recoverable
				// from the app. `DELETE /reminders/:id` destroys the row and is the
				// wrong verb to reach for when the model merely misheard.
				const { existing } = await changeReminder(userId, parsed.data.reminder_id, { dismissed: true });
				logger.info({ userId, reminderId: existing.id }, 'Assistant cancelled a reminder');
				return {
					toolUseId: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
					ok: true,
					summary: `Reminder "${existing.title}" cancelled — it will not notify again and no longer counts as coming up.`,
					data: { reminder_id: existing.id, title: existing.title, dismissed: true },
				};
			} catch (err) {
				if (err instanceof ToolTargetError) throw err;
				logger.warn({ err, userId }, 'Assistant failed to cancel a reminder');
				return failed(toolUse, 'the reminder could not be cancelled');
			}
		}

		case 'create_task': {
			const parsed = CreateTaskInput.safeParse(toolUse.input);
			if (!parsed.success) return failed(toolUse, `Invalid create_task input — ${describeIssues(parsed.error)}`);

			let dueAt: Date | null = null;
			if (parsed.data.due_at) {
				dueAt = parseDateTime(parsed.data.due_at, USER_TIMEZONE);
				if (!dueAt) return failed(toolUse, 'due_at is not a valid date-time');

				// `due_at` is optional, so unlike a reminder the honest answer to a
				// day with no time is available in one step: send this again without
				// the hour, or ask.
				const invented = refuseInventedTime(toolUse, 'due_at', parsed.data.due_at, options.userTurn);
				if (invented) return invented;
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

		case 'update_task': {
			const parsed = UpdateTaskInput.safeParse(toolUse.input);
			if (!parsed.success) return failed(toolUse, `Invalid update_task input — ${describeIssues(parsed.error)}`);

			const patch: { title?: string; dueAt?: Date | null; priority?: string } = {};
			if (parsed.data.title !== undefined) patch.title = parsed.data.title;
			if (parsed.data.priority !== undefined) patch.priority = parsed.data.priority;
			if (parsed.data.due_at !== undefined) {
				// A bare date is read in the user's timezone, exactly as a reminder's
				// time is; a task with a day and no hour keeps that day.
				const parsedDate = parseDateTime(parsed.data.due_at, USER_TIMEZONE);
				if (!parsedDate) {
					return failed(toolUse, `I could not read "${parsed.data.due_at}" as a date`);
				}
				patch.dueAt = parsedDate;
			}

			if (Object.keys(patch).length === 0) {
				return failed(toolUse, 'update_task needs a new title, due_at or priority — none was given');
			}

			try {
				const { existing, updated } = await changeTask(userId, parsed.data.task_id, patch);
				const title = updated?.title ?? existing.title;
				return {
					toolUseId: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
					ok: true,
					summary: `Task "${title}" updated.`,
					data: {
						task_id: existing.id,
						title,
						status: updated?.status ?? existing.status,
						due_at: (updated?.dueAt ?? null)?.toISOString?.() ?? null,
						priority: updated?.priority ?? existing.priority,
					},
				};
			} catch (err) {
				if (err instanceof ToolTargetError) throw err;
				logger.warn({ err, userId }, 'Assistant failed to update a task');
				return failed(toolUse, 'the task could not be updated');
			}
		}

		case 'complete_task': {
			const parsed = CompleteTaskInput.safeParse(toolUse.input);
			if (!parsed.success) return failed(toolUse, `Invalid complete_task input — ${describeIssues(parsed.error)}`);

			try {
				const { existing, updated } = await setTaskStatus(userId, parsed.data.task_id, 'completed');
				logger.info({ userId, taskId: existing.id }, 'Assistant completed a task');
				return {
					toolUseId: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
					ok: true,
					summary: `Task "${updated?.title ?? existing.title}" marked as completed.`,
					data: {
						task_id: existing.id,
						title: updated?.title ?? existing.title,
						status: 'completed',
						completed_at: (updated?.completedAt ?? null)?.toISOString?.() ?? null,
					},
				};
			} catch (err) {
				if (err instanceof ToolTargetError) throw err;
				logger.warn({ err, userId }, 'Assistant failed to complete a task');
				return failed(toolUse, 'the task could not be marked as completed');
			}
		}

		case 'reopen_task': {
			const parsed = ReopenTaskInput.safeParse(toolUse.input);
			if (!parsed.success) return failed(toolUse, `Invalid reopen_task input — ${describeIssues(parsed.error)}`);

			try {
				const { existing, updated } = await setTaskStatus(userId, parsed.data.task_id, 'pending');
				logger.info({ userId, taskId: existing.id }, 'Assistant reopened a task');
				return {
					toolUseId: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
					ok: true,
					summary: `Task "${updated?.title ?? existing.title}" is open again (pending).`,
					data: { task_id: existing.id, title: updated?.title ?? existing.title, status: 'pending', completed_at: null },
				};
			} catch (err) {
				if (err instanceof ToolTargetError) throw err;
				logger.warn({ err, userId }, 'Assistant failed to reopen a task');
				return failed(toolUse, 'the task could not be reopened');
			}
		}

		case 'save_memory': {
			const parsed = SaveMemoryInput.safeParse(toolUse.input);
			if (!parsed.success) return failed(toolUse, `Invalid save_memory input — ${describeIssues(parsed.error)}`);

			// "Save memories" in Profile → Privacy controls. Returning a *tool result*
			// rather than throwing matters here: the model reads it and can tell the
			// user their memory saving is off, instead of the turn failing.
			if (!(await getPrivacyPreferences(db, userId)).saveMemories) {
				return failed(
					toolUse,
					'Memory saving is switched off in the user’s privacy controls, so nothing was stored. Tell them that, and do not claim the memory was saved.',
				);
			}

			try {
				// Routed through `createMemory` rather than inserting here. That
				// function is the only caller of `storeEmbedding`, so inserting
				// directly made the embedding hook dead code on this path too.
				//
				// The tool's contract is preserved: `createMemory` applies exactly
				// the defaults hard-coded here (`visibility: 'private'`,
				// `sensitivity: 'normal'`, `importance/confidence: 50`, empty
				// `sourceIds`/`normalizedFacts`, `status: 'proposed'`) and returns
				// the inserted row, so `memory_id`, the summary and the error
				// handling below are unchanged. It is not transactional
				// (a single insert either way), and it does not throw for anything
				// this path did not already handle.
				const memory = await createMemory({
					userId,
					category: parsed.data.category,
					content: parsed.data.content,
					sourceType: 'conversation',
				});

				// ── Supersession, decided here and not by the model ──────────
				// The measured defect: "actually my favourite colour is green,
				// not blue" produced "Updated!" and left *both* rows live, so the
				// user had two contradictory facts and a confirmation that said
				// otherwise. Whether the new row replaces an older one is a
				// property of the two rows, not an intention the model has to
				// remember to express — so it is computed after the insert, from
				// the data, and reported back in the tool result. A failure here
				// does not fail the save: the new memory is already committed, and
				// claiming otherwise would be the same lie in the other direction.
				let superseded: { id: string; content: string }[] = [];
				let supersedeFailed = false;
				try {
					superseded = await archiveSupersededMemories({
						userId,
						category: parsed.data.category,
						content: parsed.data.content,
						keepId: memory.id,
					});
				} catch (err) {
					supersedeFailed = true;
					logger.warn(
						{ err, userId, memoryId: memory.id },
						'Assistant saved a memory but could not archive the older memory it supersedes',
					);
				}

				let summary = `Saved to memory (${parsed.data.category}).`;
				if (superseded.length) {
					const replaced = superseded.map((row) => `"${row.content}"`).join(', ');
					summary = `Saved to memory (${parsed.data.category}), replacing ${replaced} — only the new version is remembered now.`;
				}
				if (supersedeFailed) {
					summary =
						`Saved to memory (${parsed.data.category}), but an earlier memory this one replaces could not be archived — ` +
						'tell them the old version may still be there.';
				}

				logger.info(
					{ userId, memoryId: memory.id, category: parsed.data.category, superseded: superseded.length },
					'Assistant saved a memory',
				);
				return {
					toolUseId: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
					ok: true,
					summary,
					// Additive only when it happened: the pre-existing contract for
					// an ordinary save is exactly `{ memory_id, category }`.
					data: {
						memory_id: memory.id ?? null,
						category: parsed.data.category,
						...(superseded.length
							? { superseded: superseded.map((row) => ({ memory_id: row.id, content: row.content })) }
							: {}),
						...(supersedeFailed ? { supersede_failed: true } : {}),
					},
				};
			} catch (err) {
				// `createMemory` re-checks the privacy switch itself and throws the
				// same 409 the pre-check above returns. Surface it as the tool result
				// the model is told to relay, not as a generic save failure.
				if (err instanceof HttpError && err.code === 'MEMORY_SAVING_DISABLED') {
					return failed(
						toolUse,
						'Memory saving is switched off in the user’s privacy controls, so nothing was stored. Tell them that, and do not claim the memory was saved.',
					);
				}
				logger.warn({ err, userId }, 'Assistant failed to save a memory');
				return failed(toolUse, 'the memory could not be saved');
			}
		}

		/**
		 * Forgetting a memory the user asked to drop.
		 *
		 * Archival, not deletion: see `forgetMatchingMemories`. The `ok: false`
		 * when nothing matched is the point of the tool — it is what stops the
		 * model from answering "done, I've forgotten that" about a fact it never
		 * had, which is the memory-side form of the defect `groundAssistantReply`
		 * exists to catch.
		 */
		case 'forget_memory': {
			const parsed = ForgetMemoryInput.safeParse(toolUse.input);
			if (!parsed.success) return failed(toolUse, `Invalid forget_memory input — ${describeIssues(parsed.error)}`);

			try {
				const forgotten = await forgetMatchingMemories(userId, parsed.data.content);
				if (!forgotten.length) {
					return failed(
						toolUse,
						`No saved memory matches "${parsed.data.content}", so nothing was forgotten. Do not tell them it is gone — say you have nothing saved about that, or ask which memory they mean.`,
					);
				}

				logger.info({ userId, forgotten: forgotten.length }, 'Assistant forgot memories on request');
				return {
					toolUseId: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
					ok: true,
					summary: `Forgotten: ${forgotten.map((row) => `"${row.content}"`).join(', ')}. It is archived, so it no longer appears in what you know about them and will not come up again.`,
					data: {
						forgotten: forgotten.map((row) => ({ memory_id: row.id, content: row.content })),
						count: forgotten.length,
					},
				};
			} catch (err) {
				logger.warn({ err, userId }, 'Assistant failed to forget a memory');
				return failed(toolUse, 'the memory could not be forgotten, so it is still remembered');
			}
		}

		/**
		 * The user's answer to a follow-up NOVA raised on its own initiative (§18).
		 *
		 * The lookup, the ownership check and the write all live in
		 * `recordFollowUpDecision`, so that the tool call and any other caller of the
		 * same answer record it identically — and so the item is resolved by
		 * `(id, userId)` rather than trusted from the model, which is the rule this
		 * whole file is built around. `recorded: false` means the id is not on this
		 * account's rows, and the model is told so instead of being handed a success.
		 */
		case 'resolve_follow_up': {
			const parsed = ResolveFollowUpInput.safeParse(toolUse.input);
			if (!parsed.success) {
				return failed(toolUse, `Invalid resolve_follow_up input — ${describeIssues(parsed.error)}`);
			}

			try {
				const outcome = await recordFollowUpDecision(getDb(), {
					userId,
					itemType: parsed.data.item_type,
					itemId: parsed.data.item_id,
					decision: parsed.data.decision,
					snoozeMinutes: parsed.data.snooze_minutes,
				});

				if (!outcome.recorded) {
					return failed(
						toolUse,
						`No ${parsed.data.item_type} with that id is on this account, so nothing was recorded and NOVA will keep asking. Ask them which one they mean.`,
					);
				}

				const noun = parsed.data.item_type === 'task' ? 'task' : 'reminder';
				const summary =
					parsed.data.decision === 'leave'
						? outcome.dismissedReminder
							? 'Left as is: the reminder was dismissed and NOVA will stop asking about it.'
							: 'Left as is: NOVA will stop asking about that task.'
						: `Snoozed: NOVA will ask again after ${outcome.snoozeUntil?.toISOString() ?? 'later'}.`;

				logger.info(
					{
						userId,
						itemType: parsed.data.item_type,
						itemId: parsed.data.item_id,
						decision: parsed.data.decision,
					},
					'Assistant recorded a follow-up decision',
				);

				return {
					toolUseId: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
					ok: true,
					summary,
					data: {
						item_type: parsed.data.item_type,
						item_id: parsed.data.item_id,
						decision: parsed.data.decision,
						snooze_until: outcome.snoozeUntil?.toISOString() ?? null,
						answered: true,
						note: `The ${noun} itself was not changed.`,
					},
				};
			} catch (err) {
				logger.warn({ err, userId }, 'Assistant failed to record a follow-up decision');
				return failed(toolUse, 'the answer could not be recorded, so NOVA will keep asking');
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
/**
 * The tools whose success changes stored state, and so belongs in the user's
 * history.
 *
 * The `/activity` surface reads `audit_logs`, and nothing on this path wrote to
 * it: measured on the device, cancelling a reminder by voice set
 * `reminders.dismissed = true` and left **no** history row at all, so the
 * interaction the mandate requires to be recorded was invisible. Recording it
 * here rather than in each tool keeps a newly added write tool from being the
 * one that silently forgets.
 */
const HISTORY_ACTIONS: Record<string, { action: string; targetType: string }> = {
	create_reminder: { action: 'reminder.create', targetType: 'reminder' },
	update_reminder: { action: 'reminder.update', targetType: 'reminder' },
	cancel_reminder: { action: 'reminder.cancel', targetType: 'reminder' },
	create_task: { action: 'task.create', targetType: 'task' },
	update_task: { action: 'task.update', targetType: 'task' },
	complete_task: { action: 'task.complete', targetType: 'task' },
	reopen_task: { action: 'task.reopen', targetType: 'task' },
	save_memory: { action: 'memory.save', targetType: 'memory' },
	forget_memory: { action: 'memory.delete', targetType: 'memory' },
	resolve_follow_up: { action: 'follow_up.resolve', targetType: 'follow_up' },
};

/**
 * Writes the history row for one successful tool call.
 *
 * Never throws: the action has already happened, and losing the log must not turn
 * a completed reminder into a reported failure.
 */
async function recordHistory(userId: string, call: ExecutedToolCall): Promise<void> {
	const entry = HISTORY_ACTIONS[call.name];
	if (!entry) return;
	try {
		const data = (call.data ?? {}) as Record<string, unknown>;
		const targetId =
			(data.reminder_id ?? data.task_id ?? data.memory_id ?? data.id ?? null) as
				| string
				| null;
		await getDb()
			.insert(auditLogs)
			.values({
				userId,
				// The assistant acted on the user's behalf, and the log should say so
				// rather than implying they operated a screen.
				actorType: 'agent',
				actorId: 'nova',
				action: entry.action,
				targetType: entry.targetType,
				targetId: targetId ? String(targetId) : null,
				outcome: 'success',
				details: { tool: call.name, summary: call.summary },
			});
	} catch (error) {
		logger.warn({ err: error, tool: call.name }, 'could not record assistant action in history');
	}
}

/**
 * Runs one tool and records it in the user's history when it succeeded.
 *
 * The recording lives here rather than in [executeToolUses] because this is the
 * only funnel every path shares: the realtime voice loop
 * (`realtime/tool-loop.ts`) calls this directly, so a hook on the batch function
 * never fired for a spoken command. Measured on the device: "Remind me to buy
 * milk" created the reminder and left no history row.
 */
export async function executeAssistantTool(
	userId: string,
	toolUse: ToolUseBlock,
	options: ExecuteToolOptions = {},
): Promise<ExecutedToolCall> {
	const call = await runAssistantTool(userId, toolUse, options);
	if (call.ok) await recordHistory(userId, call);
	return call;
}

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
 * The user-facing sentence for a tool that did not do what was asked.
 *
 * Deliberately not `ExecutedToolCall.summary`/`.error`. Those are written for
 * the *model* and several of them carry instructions meant for it alone — "Use
 * the id shown beside the reminder in the list you were given", "Recompute the
 * date from the current time given in your instructions", "Tell them that, and
 * do not claim the memory was saved". Reaching the user they read as nonsense,
 * and pasting them next to a success is how the loop produced
 * *"Done — Reminder set … That didn't work: create_reminder failed (…)"*.
 *
 * What is left is the fact: this action did not happen. The specific reason is
 * still relayed by the model in the ordinary case, from the tool result.
 */
const FAILURE_PHRASE: Record<string, string> = {
	create_reminder: 'The reminder was not created',
	update_reminder: 'The reminder was not changed',
	cancel_reminder: 'The reminder was not cancelled',
	create_task: 'The task was not added',
	complete_task: 'The task was not marked as done',
	reopen_task: 'The task was not reopened',
	save_memory: 'Nothing was saved to memory',
	forget_memory: 'Nothing was deleted from memory',
	resolve_follow_up: 'Your answer was not recorded',
};

function failurePhrase(name: string): string {
	return `${FAILURE_PHRASE[name] ?? 'That action did not go through'}.`;
}

/**
 * Acknowledgement built from what the tools actually did — never from the
 * model's prose, which is exactly the difference between a report and a guess.
 *
 * Used when the loop cap is reached (so the model never saw the results and its
 * narration is not an outcome) and when the model's final text claims a write
 * that failed. A turn that both succeeded and failed states both, side by side,
 * rather than dressing the failure up as part of a success. Repeated identical
 * failures are named once — the model retrying the same refused call must not
 * turn the reply into a stutter.
 */
export function toolSummaryText(calls: ExecutedToolCall[]): string {
	if (!calls.length) return "I wasn't able to complete that.";
	const done = calls.filter((c) => c.ok);
	const failedCalls = calls.filter((c) => !c.ok);
	const successes = done.map((c) => c.summary).join(' ');
	const failures = [...new Set(failedCalls.map((c) => failurePhrase(c.name)))].join(' ');

	// No "Done —" prefix when part of the turn failed: it is the one word that
	// makes a half-failure read as a whole success.
	if (!failedCalls.length) return `Done — ${successes}`;
	if (!done.length) return `That didn't work. ${failures}`;
	return `${successes} That didn't work: ${failures}`;
}
