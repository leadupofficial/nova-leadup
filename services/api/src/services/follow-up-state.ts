/**
 * NOVA API — the follow-up engine's durable state.
 *
 * ## Where the state lives, and why there is no migration
 *
 * The engine needs four things persisted: that a follow-up was raised for an item,
 * that the user dismissed one, that the user snoozed one, and — separately — that a
 * reminder's time moved so a push-back can be counted. Every one of them is an event
 * with a timestamp, an actor and a subject, which is exactly what `audit_logs`
 * already is: `user_id`, `actor_type`, `action`, `target_type`, `target_id`,
 * `outcome`, `details` (jsonb) and an **indexed** `occurred_at`. It is the table the
 * user's own Activity Centre (`routes/activity.ts`) and the admin audit view already
 * read, so a follow-up is auditable by the person it happened to.
 *
 * That means this feature adds **no column and needs no schema change**. The item
 * state it reasons about is the user's own (`tasks.status`, `tasks.completed_at`,
 * `tasks.due_at`, `reminders.trigger_at`, `reminders.dismissed`), and the decisions
 * are rows in a table that exists.
 *
 * The delivery itself is a `notifications` row through the existing
 * `notificationService` — the same transport every other user-facing message uses.
 * No new channel is invented.
 *
 * ## The item id travels in `details`, not only in `target_id`
 *
 * `target_id` carries it, and so does `details.itemId`. The duplication is
 * deliberate: `details` is the value a replayed or migrated row is read from, and
 * reading the id out of one place only would silently stop matching items the day
 * `target_id` is reused for something else.
 */
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import {
	auditLogs,
	companionConfigs,
	notificationPreferences,
	reminderEvents,
	reminders,
	tasks,
} from '@nova/database';
import type { getDb } from '../db/connection.js';
import { getPrivacyPreferences } from './privacy-preferences.js';
import { logger } from '../utils/logger.js';
import {
	FOLLOW_UP_ACTIONS,
	FOLLOW_UP_HISTORY_DAYS,
	reminderEpoch,
	taskEpoch,
	type FollowUpAction,
	type FollowUpHistoryEntry,
	type FollowUpItemType,
} from './follow-up.js';

type Db = ReturnType<typeof getDb>;

/** Rows read back per user. The trail is small; this is a ceiling, not a target. */
const MAX_HISTORY_ROWS = 200;

/** What the engine writes into `audit_logs.details`. */
export interface FollowUpDetails {
	kind: 'follow_up';
	itemType: FollowUpItemType;
	itemId: string;
	epoch: string;
	reason?: string;
	snoozeUntil?: string;
}

function parseDetails(value: unknown): FollowUpDetails | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	if (raw.kind !== 'follow_up') return null;
	const itemType = raw.itemType;
	if (itemType !== 'task' && itemType !== 'reminder') return null;
	if (typeof raw.itemId !== 'string' || typeof raw.epoch !== 'string') return null;
	const details: FollowUpDetails = {
		kind: 'follow_up',
		itemType,
		itemId: raw.itemId,
		epoch: raw.epoch,
	};
	if (typeof raw.reason === 'string') details.reason = raw.reason;
	if (typeof raw.snoozeUntil === 'string') details.snoozeUntil = raw.snoozeUntil;
	return details;
}

function toDate(value: unknown): Date | null {
	if (value instanceof Date) return value;
	if (typeof value === 'string') {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}
	return null;
}

function isFollowUpAction(value: unknown): value is FollowUpAction {
	return (FOLLOW_UP_ACTIONS as readonly string[]).includes(value as string);
}

/** The earliest instant the trail is read from; matches the reminder lookback. */
export function followUpHistorySince(now: Date): Date {
	return new Date(now.getTime() - FOLLOW_UP_HISTORY_DAYS * 24 * 60 * 60 * 1000);
}

// ─── The postponement journal ───────────────────────────────────────────────

/**
 * `reminder_events.event` for "`trigger_at` moved later". The other value the
 * trigger writes is `rescheduled_earlier`.
 */
export const REMINDER_EVENT_POSTPONED = 'postponed';

/**
 * Journal rows read per user. A ceiling, not a target: the window is 30 days and
 * a person pushing back one reminder hundreds of times inside it is not a case
 * worth unbounded reads for. Hitting it under-counts, which suppresses rather
 * than spams.
 */
const MAX_POSTPONEMENT_ROWS = 500;

/**
 * How many times each of this user's reminders has been postponed, by reminder id.
 *
 * `reminders.trigger_at` moving later is journalled by the
 * `reminders_trigger_at_change` trigger installed in `drizzle/0004_*.sql`, not by
 * application code — every writer that updates the column (`PATCH /reminders/:id`
 * and the assistant's `update_reminder`) is a plain single-row `UPDATE` and is
 * captured automatically. So this is the real count, where the engine previously
 * could only count a push-back it had itself happened to observe through its own
 * audit trail. A reminder the user moved twice before NOVA ever mentioned it now
 * counts as two.
 *
 * `rescheduled_earlier` is deliberately **not** counted. Moving a reminder
 * *sooner* is the user choosing to act, which is the opposite of the avoidance
 * this rule exists to notice; the two events are distinct by name for exactly
 * that reason. Rows are read and counted here rather than aggregated in SQL so
 * the query stays a plain filtered read — the in-memory double used by the job's
 * tests honours `WHERE` but not `GROUP BY`, and a count that could only be
 * verified against a real server would not be verified at all.
 *
 * Never throws: a failed read returns no counts, which leaves the engine on the
 * witnessed-history path — the conservative direction, since a lower count
 * suppresses a follow-up rather than producing an extra one.
 */
export async function readPostponementCounts(
	db: Db,
	userId: string,
	now: Date,
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	try {
		const rows = await db
			.select({ reminderId: reminderEvents.reminderId })
			.from(reminderEvents)
			.where(
				and(
					eq(reminderEvents.userId, userId),
					eq(reminderEvents.event, REMINDER_EVENT_POSTPONED),
					gte(reminderEvents.occurredAt, followUpHistorySince(now)),
				),
			)
			.limit(MAX_POSTPONEMENT_ROWS);

		for (const row of rows) {
			const reminderId = row.reminderId;
			// A driver that ignores `where`, or a row written for another user, must not
			// be able to inflate the count and provoke a nudge.
			if (typeof reminderId !== 'string' || !reminderId) continue;
			counts.set(reminderId, (counts.get(reminderId) ?? 0) + 1);
		}
	} catch (error) {
		logger.error(
			{ err: error, userId },
			'Could not read the postponement journal; counting only the push-backs NOVA witnessed',
		);
	}
	return counts;
}

/**
 * Every follow-up decision already recorded for one user, newest first.
 *
 * The SQL predicate is the real filter. The same rule is applied again to every row
 * that comes back — the actor, the action and the parsed `details` are all
 * re-checked — so a driver that ignored `where`, or a row written for a different
 * feature that happens to share an action name, cannot make the engine believe it
 * has already spoken when it has not, or vice versa.
 *
 * Never throws: a failed read of the trail must not turn into a duplicate message,
 * so the caller treats "no history" as "nothing has been raised", which is the
 * conservative direction only because the per-item rule is epoch-scoped and the
 * caps are read from the same list. A read failure therefore suppresses rather than
 * spams — see `runFollowUpEngine`, which abandons the user for the pass.
 */
export async function readFollowUpHistory(
	db: Db,
	userId: string,
	now: Date,
): Promise<FollowUpHistoryEntry[]> {
	const rows = await db
		.select({
			userId: auditLogs.userId,
			action: auditLogs.action,
			targetType: auditLogs.targetType,
			targetId: auditLogs.targetId,
			details: auditLogs.details,
			occurredAt: auditLogs.occurredAt,
		})
		.from(auditLogs)
		.where(
			and(
				eq(auditLogs.userId, userId),
				inArray(auditLogs.action, [...FOLLOW_UP_ACTIONS]),
				gte(auditLogs.occurredAt, followUpHistorySince(now)),
			),
		)
		.orderBy(desc(auditLogs.occurredAt))
		.limit(MAX_HISTORY_ROWS);

	const entries: FollowUpHistoryEntry[] = [];
	for (const row of rows) {
		if (row.userId !== userId) continue;
		if (!isFollowUpAction(row.action)) continue;
		const details = parseDetails(row.details);
		if (!details) continue;
		if (row.targetType && row.targetType !== details.itemType) continue;
		if (row.targetId && row.targetId !== details.itemId) continue;
		const occurredAt = toDate(row.occurredAt);
		if (!occurredAt) continue;
		entries.push({
			action: row.action,
			itemType: details.itemType,
			itemId: details.itemId,
			epoch: details.epoch,
			occurredAt,
			snoozeUntil: details.snoozeUntil ? toDate(details.snoozeUntil) : null,
		});
	}

	// Newest first, restored here as well: `orderBy` is a hint a double may ignore,
	// and `lastRaise` reads the head of this list.
	entries.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
	return entries;
}

/** Appends one decision row and returns nothing. Throws on a write failure. */
export async function writeFollowUpDecision(
	db: Db,
	input: {
		userId: string;
		action: FollowUpAction;
		itemType: FollowUpItemType;
		itemId: string;
		epoch: string;
		reason?: string;
		snoozeUntil?: Date | null;
		occurredAt: Date;
	},
): Promise<void> {
	const details: FollowUpDetails = {
		kind: 'follow_up',
		itemType: input.itemType,
		itemId: input.itemId,
		epoch: input.epoch,
	};
	if (input.reason) details.reason = input.reason;
	if (input.snoozeUntil) details.snoozeUntil = input.snoozeUntil.toISOString();

	await db.insert(auditLogs).values({
		userId: input.userId,
		actorType: input.action === 'follow_up_raised' ? 'system' : 'user',
		actorId: input.userId,
		action: input.action,
		targetType: input.itemType,
		targetId: input.itemId,
		outcome: 'success',
		details,
		occurredAt: input.occurredAt,
	});
}

// ─── The user's own switches ────────────────────────────────────────────────

export interface FollowUpPermission {
	allowed: boolean;
	/** Machine-readable reason when `allowed` is false. */
	blockedBy: string | null;
}

/** Notification channels, defaulted the way `GET /settings/preferences` reports them. */
interface NotificationChannels {
	push: boolean;
	email: boolean;
	sms: boolean;
	inApp: boolean;
}

const DEFAULT_CHANNELS: NotificationChannels = {
	push: true,
	email: true,
	sms: false,
	inApp: true,
};

/**
 * Whether this user may be followed up at all.
 *
 * Three switches, each of which the app renders as a working control, and each of
 * which already exists:
 *
 *  * **Notifications**, all four channels off (`notification_preferences`) — there is
 *    no way to deliver the follow-up, so composing one would either drop it or route
 *    around the switch. It is not composed.
 *  * **Cloud processing off** (`privacy_preferences.cloudProcessing`) — this
 *    deployment has no on-device model, so a proactive message about the user's own
 *    rows is server-side processing by definition. Refusing to run it is the only
 *    honest reading of the switch, even though the API refuses to *store* `false`
 *    (see `processingUnsupported`), because a row written before that check existed —
 *    or by an operator — still has to be honoured.
 *  * **Companion mode `sleep`** (`companion_configs`) — the user has said NOVA should
 *    not be active. `passive` is the schema default and does *not* suppress the
 *    engine: gating on it would ship a feature that never runs for anybody who never
 *    opened the setting. `sleep` is an explicit instruction and is honoured.
 *
 * Never throws: a lookup failure allows the engine, and the delivery path applies the
 * same switches again through the notification service it already uses. Failing
 * closed here would silently disable the feature on a transient database blip, which
 * is the failure mode `privacy-preferences.ts` documents for the same reason.
 */
export async function getFollowUpPermission(
	db: Db,
	userId: string,
): Promise<FollowUpPermission> {
	const [privacy, channels, mode] = await Promise.all([
		getPrivacyPreferences(db, userId),
		readNotificationChannels(db, userId),
		readCompanionMode(db, userId),
	]);

	if (privacy.cloudProcessing === false) {
		return { allowed: false, blockedBy: 'cloud-processing-off' };
	}
	if (!channels.push && !channels.inApp && !channels.email && !channels.sms) {
		return { allowed: false, blockedBy: 'notifications-off' };
	}
	if (mode === 'sleep') {
		return { allowed: false, blockedBy: 'companion-sleep' };
	}
	return { allowed: true, blockedBy: null };
}

async function readNotificationChannels(db: Db, userId: string): Promise<NotificationChannels> {
	try {
		const [row] = await db
			.select({
				userId: notificationPreferences.userId,
				push: notificationPreferences.push,
				email: notificationPreferences.email,
				sms: notificationPreferences.sms,
				inApp: notificationPreferences.inApp,
			})
			.from(notificationPreferences)
			.where(eq(notificationPreferences.userId, userId))
			.limit(1);
		// A user with no row has never opened the toggles, so the column defaults
		// apply — the same reading `GET /settings/preferences` reports.
		if (!row || row.userId !== userId) return { ...DEFAULT_CHANNELS };
		return {
			push: row.push ?? DEFAULT_CHANNELS.push,
			email: row.email ?? DEFAULT_CHANNELS.email,
			sms: row.sms ?? DEFAULT_CHANNELS.sms,
			inApp: row.inApp ?? DEFAULT_CHANNELS.inApp,
		};
	} catch {
		return { ...DEFAULT_CHANNELS };
	}
}

async function readCompanionMode(db: Db, userId: string): Promise<string> {
	try {
		const [row] = await db
			.select({ userId: companionConfigs.userId, companionMode: companionConfigs.companionMode })
			.from(companionConfigs)
			.where(eq(companionConfigs.userId, userId))
			.limit(1);
		if (!row || row.userId !== userId) return 'passive';
		return row.companionMode ?? 'passive';
	} catch {
		return 'passive';
	}
}

// ─── The user's own answers ─────────────────────────────────────────────────

export type FollowUpDecision = 'leave' | 'snooze';

export const FOLLOW_UP_SNOOZE_DEFAULT_MINUTES = 24 * 60;
export const FOLLOW_UP_SNOOZE_MIN_MINUTES = 5;
export const FOLLOW_UP_SNOOZE_MAX_MINUTES = 7 * 24 * 60;

export interface RecordFollowUpDecisionInput {
	userId: string;
	itemType: FollowUpItemType;
	itemId: string;
	decision: FollowUpDecision;
	snoozeMinutes?: number | null;
	now?: Date;
}

export interface FollowUpDecisionResult {
	/** False when the item is not on this user's account, so nothing was written. */
	recorded: boolean;
	reason: string | null;
	itemType: FollowUpItemType | null;
	itemId: string | null;
	epoch: string | null;
	snoozeUntil: Date | null;
	/** Set when `leave` also dismissed a reminder, which is what the column means. */
	dismissedReminder: boolean;
}

function clampSnooze(minutes: number | null | undefined): number {
	const value = typeof minutes === 'number' && Number.isFinite(minutes)
		? Math.round(minutes)
		: FOLLOW_UP_SNOOZE_DEFAULT_MINUTES;
	return Math.min(FOLLOW_UP_SNOOZE_MAX_MINUTES, Math.max(FOLLOW_UP_SNOOZE_MIN_MINUTES, value));
}

/**
 * Records the user's answer so the engine stops.
 *
 * This is the whole of "be dismissible and snoozable": the answer is the smallest
 * possible piece of state — one row in a table that already exists — and the planner
 * reads it back as `follow_up_dismissed` / `follow_up_snoozed`.
 *
 * Ownership is checked here rather than by the caller. The item is looked up by
 * `(id, userId)` and nothing is written when that misses, so a tool call carrying
 * another account's id records nothing and says so.
 *
 * `leave` on a *reminder* additionally sets `reminders.dismissed`, which is the
 * column's entire meaning and the same state the reminder screen's own dismiss writes.
 * It is not a new concept invented for this feature. For a task there is nothing
 * equivalent to set: "leave it as is" is not completion, so the task stays exactly as
 * it is and only the engine's record changes — the engine stopping is the promise.
 */
export async function recordFollowUpDecision(
	db: Db,
	input: RecordFollowUpDecisionInput,
): Promise<FollowUpDecisionResult> {
	const now = input.now ?? new Date();
	const empty: FollowUpDecisionResult = {
		recorded: false,
		reason: 'not-found',
		itemType: null,
		itemId: null,
		epoch: null,
		snoozeUntil: null,
		dismissedReminder: false,
	};

	let epoch: string | null = null;
	if (input.itemType === 'task') {
		const [task] = await db
			.select({
				id: tasks.id,
				userId: tasks.userId,
				status: tasks.status,
				dueAt: tasks.dueAt,
				completedAt: tasks.completedAt,
			})
			.from(tasks)
			.where(and(eq(tasks.id, input.itemId), eq(tasks.userId, input.userId)))
			.limit(1);
		if (!task || task.userId !== input.userId || task.id !== input.itemId) return empty;
		epoch = taskEpoch({
			id: task.id,
			title: '',
			status: task.status,
			dueAt: toDate(task.dueAt),
			completedAt: toDate(task.completedAt),
		});
	} else {
		const [reminder] = await db
			.select({ id: reminders.id, userId: reminders.userId, triggerAt: reminders.triggerAt })
			.from(reminders)
			.where(and(eq(reminders.id, input.itemId), eq(reminders.userId, input.userId)))
			.limit(1);
		if (!reminder || reminder.userId !== input.userId || reminder.id !== input.itemId) return empty;
		const triggerAt = toDate(reminder.triggerAt);
		if (!triggerAt) return empty;
		epoch = reminderEpoch(triggerAt);
	}

	if (input.decision === 'leave') {
		let dismissedReminder = false;
		if (input.itemType === 'reminder') {
			await db
				.update(reminders)
				.set({ dismissed: true })
				.where(and(eq(reminders.id, input.itemId), eq(reminders.userId, input.userId)));
			dismissedReminder = true;
		}
		await writeFollowUpDecision(db, {
			userId: input.userId,
			action: 'follow_up_dismissed',
			itemType: input.itemType,
			itemId: input.itemId,
			epoch,
			occurredAt: now,
		});
		return {
			recorded: true,
			reason: null,
			itemType: input.itemType,
			itemId: input.itemId,
			epoch,
			snoozeUntil: null,
			dismissedReminder,
		};
	}

	const minutes = clampSnooze(input.snoozeMinutes);
	const snoozeUntil = new Date(now.getTime() + minutes * 60 * 1000);
	await writeFollowUpDecision(db, {
		userId: input.userId,
		action: 'follow_up_snoozed',
		itemType: input.itemType,
		itemId: input.itemId,
		epoch,
		snoozeUntil,
		occurredAt: now,
	});
	return {
		recorded: true,
		reason: null,
		itemType: input.itemType,
		itemId: input.itemId,
		epoch,
		snoozeUntil,
		dismissedReminder: false,
	};
}
