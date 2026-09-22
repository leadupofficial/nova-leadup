/**
 * NOVA API — the follow-up policy (§18, the proactive follow-up engine).
 *
 * The product brief names a proactive follow-up engine as a major production
 * requirement. Until this module existed, the only scheduled work in the API was
 * the retention sweep and the recording reaper, so a user could say "I'll send the
 * proposal tonight", never do it, and NOVA would never mention it again. Nothing
 * noticed an unfinished task, a reminder whose time had passed, or a reminder the
 * user kept pushing back.
 *
 * ## Why the rules live here and not in the job
 *
 * Every decision that makes the feature safe is *pure*: which rows are candidates,
 * whether the user is inside quiet hours, whether the daily cap or the minimum
 * interval has been reached, whether this item has already been followed up or was
 * dismissed or snoozed. None of it needs a database, so all of it is testable
 * without one — the same split `classifyFacts` and `isStaleForReaper` already use.
 * `jobs/follow-up-engine.ts` is then a thin IO shell over this.
 *
 * ## Not nagging is the hard part
 *
 * A companion that asks about the same four tasks every hour is worse than one that
 * says nothing. Five independent limits are enforced, and each is checked in this
 * file so a reader can see them together:
 *
 *  * **one follow-up per item per state** — a raise recorded against the item's
 *    current epoch suppresses every later raise for that epoch;
 *  * **a minimum interval** between any two follow-ups for the same user;
 *  * **a daily cap**, counted in the user's own timezone so it resets at their
 *    midnight and not the server's;
 *  * **quiet hours**, also in the user's timezone;
 *  * **snooze and dismissal**, which are the user's own answers and outrank all
 *    four of the above.
 *
 * ## Never inventing content
 *
 * The follow-up text is composed deterministically from a real row — no model call,
 * so there is nothing to hallucinate and the feature works with no LLM credit. The
 * engine additionally re-checks that the item it names is still in the same snapshot
 * it was chosen from, and runs the briefing's own grounding guard over the composed
 * sentence before delivering it. A follow-up that names an item names a real row, or
 * it is not sent.
 */
import {
	isoDateInUserZone,
	type TaskFact,
	type UserContextFacts,
} from './user-context.js';
import { clockReadingInUserZone } from './briefing-speech.js';

// ─── The limits ─────────────────────────────────────────────────────────────

/** How often the sweep runs. Well under the minimum interval; see below. */
export const FOLLOW_UP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The shortest gap between two follow-ups for the same user.
 *
 * Combined with [FOLLOW_UP_DAILY_CAP] this bounds a day at two nudges, at least
 * four hours apart. Four hours, not twelve, is deliberate: it is short enough that
 * the daily cap is the limit a user actually meets, which is the one they can
 * reason about ("NOVA asks at most twice a day").
 */
export const FOLLOW_UP_MIN_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Follow-ups per user per local day. Counted in the user's timezone. */
export const FOLLOW_UP_DAILY_CAP = 2;

/** At most one follow-up is raised per sweep, however many items are waiting. */
export const FOLLOW_UPS_PER_RUN = 1;

/**
 * Quiet hours, in the user's timezone: 21:00 through 07:59 local.
 *
 * A proactive nudge is only useful when it can be acted on, and a phone that lights
 * up at 02:00 about an unfinished task is the behaviour that gets a companion
 * uninstalled. The window is [start, 24) ∪ [0, end).
 */
export const FOLLOW_UP_QUIET_START_HOUR = 21;
export const FOLLOW_UP_QUIET_END_HOUR = 8;

/**
 * How long past a deadline an item is left alone before it is mentioned.
 *
 * Without this, a task due at 17:00 and a clock reading 17:00:01 is "overdue" — true,
 * and useless to say. The grace is what makes the follow-up about a real gap between
 * plan and progress rather than about the second hand.
 */
export const FOLLOW_UP_GRACE_MS = 60 * 60 * 1000;

/** How long an undated task may sit at `pending` before it is worth asking about. */
export const FOLLOW_UP_STALE_PENDING_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * How many observed push-backs make a reminder worth challenging.
 *
 * "More than once", so two. See [pushedBackCount] for what NOVA is willing to count
 * as a push-back, and why it will not guess at the rest.
 */
export const FOLLOW_UP_POSTPONEMENTS_BEFORE_ASKING = 2;

/** How far back the decision trail is read. Matches the reminder lookback window. */
export const FOLLOW_UP_HISTORY_DAYS = 30;

/** Alerting actions the engine writes into `audit_logs`. */
export const FOLLOW_UP_ACTIONS = [
	'follow_up_raised',
	'follow_up_dismissed',
	'follow_up_snoozed',
] as const;

export type FollowUpAction = (typeof FOLLOW_UP_ACTIONS)[number];

// ─── Shapes ─────────────────────────────────────────────────────────────────

export type FollowUpItemType = 'task' | 'reminder';

/**
 * Why an item is being raised. Each one has its own sentence, so the user is told
 * what NOVA actually observed rather than a generic "you have unfinished things".
 */
export type FollowUpReason =
	| 'task-overdue'
	| 'task-due-today'
	| 'task-stale'
	| 'reminder-missed'
	| 'reminder-rescheduled';

export interface FollowUpCandidate {
	itemType: FollowUpItemType;
	itemId: string;
	title: string;
	reason: FollowUpReason;
	/**
	 * The item's own state, as a string. Any change to the state a follow-up was
	 * about — a new due date, a status change, a new reminder time — produces a new
	 * epoch, and one new follow-up is allowed for it. This is what stops a single
	 * unresolved item from being raised forever while still letting a genuinely
	 * rescheduled commitment be mentioned again.
	 */
	epoch: string;
	/** Whole days the item has been waiting, for the phrasing. */
	waitedDays: number;
}

/** One decision the engine has already recorded, as the planner reads it back. */
export interface FollowUpHistoryEntry {
	action: FollowUpAction;
	itemType: FollowUpItemType;
	itemId: string;
	epoch: string;
	occurredAt: Date;
	/** Only meaningful for a snooze: when it lapses. */
	snoozeUntil: Date | null;
}

export interface FollowUpPlanInput {
	facts: UserContextFacts;
	now: Date;
	/** False when the user's own switches forbid a proactive message. */
	allowed: boolean;
	/** Why not, when `allowed` is false. Echoed into the plan. */
	blockedBy: string | null;
	history: readonly FollowUpHistoryEntry[];
	/**
	 * Postponements read from `reminder_events`, by reminder id. Omitted (or empty)
	 * leaves the rule on the witnessed-history record alone.
	 */
	postponements?: ReadonlyMap<string, number>;
}

export interface FollowUpPlan {
	/** The single follow-up to raise, or null. */
	followUp: FollowUpCandidate | null;
	/** Machine-readable reason nothing was raised. Null when something was. */
	suppressed: string | null;
	/** How many items were candidates before the per-item limits were applied. */
	considered: number;
}

// ─── The clock, in the user's timezone ──────────────────────────────────────

/** True during the user's quiet hours. See [FOLLOW_UP_QUIET_START_HOUR]. */
export function isQuietHours(now: Date): boolean {
	const { hour } = clockReadingInUserZone(now);
	return hour >= FOLLOW_UP_QUIET_START_HOUR || hour < FOLLOW_UP_QUIET_END_HOUR;
}

/** `YYYY-MM-DD` in the user's timezone, used to bucket a day for the cap. */
export function followUpDay(now: Date): string {
	return isoDateInUserZone(now);
}

// ─── Candidate detection ────────────────────────────────────────────────────

function daysBetween(from: Date, to: Date): number {
	return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * A task is only ever a candidate while it is genuinely open.
 *
 * `buildUserContext` already filters on `status`, but the engine applies the rule
 * again here — the same defence the recording reaper uses against a driver that
 * ignores `where`. A completed task must never be named as unfinished.
 */
function isOpenTask(task: TaskFact): boolean {
	if (task.completedAt) return false;
	return task.status === 'pending' || task.status === 'in_progress';
}

/** The task's state, as a comparable string. */
export function taskEpoch(task: TaskFact): string {
	return `${task.dueAt ? task.dueAt.toISOString() : 'none'}|${task.status}`;
}

/** The reminder's state, as a comparable string. */
export function reminderEpoch(triggerAt: Date): string {
	return triggerAt.toISOString();
}

/**
 * How many times this reminder's time has been pushed back.
 *
 * There are two records of a push-back and the answer is the larger of them.
 *
 *  * `postponements` — rows in `reminder_events`, written by the database trigger
 *    on every `trigger_at` move. This is the real count, and it does not depend on
 *    NOVA having said anything at the time (see
 *    `follow-up-state.ts#readPostponementCounts`). `rescheduled_earlier` is not
 *    counted: moving a reminder *sooner* is not avoidance.
 *  * `history` — the engine's own audit trail, which is all there was before the
 *    journal existed. It can only count a push-back NOVA witnessed: a raise
 *    recorded for this reminder at an *earlier* time while the reminder now sits
 *    at a *later* one.
 *
 * The witness count is a floor rather than a replacement, because the journal only
 * starts at migration 0004: a reminder postponed before the trigger was installed
 * must not silently lose the count the trail already knew about. A journal count
 * that is lower (or absent) therefore never lowers the answer, and one that is
 * higher is believed.
 */
export function pushedBackCount(
	itemId: string,
	currentEpoch: string,
	history: readonly FollowUpHistoryEntry[],
	postponements?: ReadonlyMap<string, number>,
): number {
	const earlier = new Set<string>();
	for (const entry of history) {
		if (entry.action !== 'follow_up_raised') continue;
		if (entry.itemType !== 'reminder' || entry.itemId !== itemId) continue;
		if (entry.epoch < currentEpoch) earlier.add(entry.epoch);
	}
	const journalled = postponements?.get(itemId) ?? 0;
	return Math.max(journalled, earlier.size);
}

/**
 * Every item worth a follow-up, most urgent first.
 *
 * Overdue tasks, then tasks due today, then tasks that have sat undated and pending
 * for days, then reminders whose time passed and were never dismissed, then
 * reminders the user has pushed back more than once. The order is the order the
 * planner picks from, so a user with a week of backlog is asked about the thing they
 * most recently committed to.
 */
export function followUpCandidates(
	facts: UserContextFacts,
	now: Date,
	history: readonly FollowUpHistoryEntry[] = [],
	postponements?: ReadonlyMap<string, number>,
): FollowUpCandidate[] {
	const out: FollowUpCandidate[] = [];
	const seen = new Set<string>();
	const claim = (candidate: FollowUpCandidate): void => {
		const key = `${candidate.itemType}:${candidate.itemId}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(candidate);
	};

	for (const task of facts.overdueTasks) {
		if (!isOpenTask(task) || !task.dueAt) continue;
		if (now.getTime() - task.dueAt.getTime() < FOLLOW_UP_GRACE_MS) continue;
		claim({
			itemType: 'task',
			itemId: task.id,
			title: task.title,
			reason: 'task-overdue',
			epoch: taskEpoch(task),
			waitedDays: daysBetween(task.dueAt, now),
		});
	}

	for (const task of facts.dueTodayTasks) {
		if (!isOpenTask(task)) continue;
		claim({
			itemType: 'task',
			itemId: task.id,
			title: task.title,
			reason: 'task-due-today',
			epoch: taskEpoch(task),
			waitedDays: 0,
		});
	}

	for (const task of facts.undatedTasks) {
		if (!isOpenTask(task) || !task.createdAt) continue;
		// A missing `createdAt` means the age is unknowable, so the rule does not
		// apply — the conservative direction, and the same one the reaper takes with
		// an unparseable timestamp.
		if (now.getTime() - task.createdAt.getTime() < FOLLOW_UP_STALE_PENDING_MS) continue;
		claim({
			itemType: 'task',
			itemId: task.id,
			title: task.title,
			reason: 'task-stale',
			epoch: taskEpoch(task),
			waitedDays: daysBetween(task.createdAt, now),
		});
	}

	for (const reminder of facts.pastReminders) {
		if (reminder.dismissed === true) continue;
		if (now.getTime() - reminder.triggerAt.getTime() < FOLLOW_UP_GRACE_MS) continue;
		claim({
			itemType: 'reminder',
			itemId: reminder.id,
			title: reminder.title,
			reason: 'reminder-missed',
			epoch: reminderEpoch(reminder.triggerAt),
			waitedDays: daysBetween(reminder.triggerAt, now),
		});
	}

	// Pushed back more than once. Only reached for a reminder that is *not* already
	// overdue — a missed reminder is the more urgent and more accurate thing to say —
	// so this is the case the other rules cannot see: the user keeps moving a
	// reminder forward, and never lets it arrive.
	for (const reminder of facts.reminders) {
		if (reminder.dismissed === true) continue;
		if (seen.has(`reminder:${reminder.id}`)) continue;
		const epoch = reminderEpoch(reminder.triggerAt);
		if (
			pushedBackCount(reminder.id, epoch, history, postponements) <
			FOLLOW_UP_POSTPONEMENTS_BEFORE_ASKING
		) {
			continue;
		}
		claim({
			itemType: 'reminder',
			itemId: reminder.id,
			title: reminder.title,
			reason: 'reminder-rescheduled',
			epoch,
			waitedDays: 0,
		});
	}

	return out;
}

// ─── The per-item limits ────────────────────────────────────────────────────

/**
 * Whether the user has already answered for this item, or been asked about it.
 *
 * A snooze outranks everything and lapses on the clock. A raise and a dismissal are
 * both scoped to the epoch: "leave it as is" is an answer about *this* state of the
 * item, so a task whose due date the user later moves is a new commitment and may be
 * raised once more — while an item nobody has touched is never raised twice.
 */
export function itemAlreadyAnswered(
	candidate: FollowUpCandidate,
	history: readonly FollowUpHistoryEntry[],
	now: Date,
): boolean {
	for (const entry of history) {
		if (entry.itemType !== candidate.itemType || entry.itemId !== candidate.itemId) continue;
		if (entry.action === 'follow_up_dismissed' && entry.epoch === candidate.epoch) return true;
		if (entry.action === 'follow_up_snoozed') {
			if (!entry.snoozeUntil || entry.snoozeUntil.getTime() > now.getTime()) return true;
			continue;
		}
		if (entry.action === 'follow_up_raised' && entry.epoch === candidate.epoch) return true;
	}
	return false;
}

/** How many follow-ups were raised for this user on the local day `now` falls in. */
export function raisedOnDay(history: readonly FollowUpHistoryEntry[], now: Date): number {
	const day = followUpDay(now);
	return history.filter(
		(entry) => entry.action === 'follow_up_raised' && followUpDay(entry.occurredAt) === day,
	).length;
}

/** The most recent raise, or null. */
export function lastRaise(
	history: readonly FollowUpHistoryEntry[],
): FollowUpHistoryEntry | null {
	let latest: FollowUpHistoryEntry | null = null;
	for (const entry of history) {
		if (entry.action !== 'follow_up_raised') continue;
		if (!latest || entry.occurredAt.getTime() > latest.occurredAt.getTime()) latest = entry;
	}
	return latest;
}

// ─── The decision ───────────────────────────────────────────────────────────

/**
 * The whole rule, in one place and without a database.
 *
 * Order matters, and it is the order a reader would defend out loud: the user's
 * switches first (turn the feature off and nothing else is even considered), then
 * whether there is anything to say at all, then quiet hours, then whether this
 * particular item has already been answered, then the daily cap, then the minimum
 * interval. The cap is checked before the interval so that "you have had your two
 * for today" is the reason reported when both apply — the one a user can act on.
 */
export function planFollowUp(input: FollowUpPlanInput): FollowUpPlan {
	const { facts, now, allowed, blockedBy, history, postponements } = input;

	if (!allowed) {
		return { followUp: null, suppressed: blockedBy ?? 'not-allowed', considered: 0 };
	}

	const candidates = followUpCandidates(facts, now, history, postponements);
	if (!candidates.length) {
		return { followUp: null, suppressed: 'nothing-due', considered: 0 };
	}

	if (isQuietHours(now)) {
		return { followUp: null, suppressed: 'quiet-hours', considered: candidates.length };
	}

	const open = candidates.filter((candidate) => !itemAlreadyAnswered(candidate, history, now));
	if (!open.length) {
		return {
			followUp: null,
			suppressed: 'already-followed-up',
			considered: candidates.length,
		};
	}

	if (raisedOnDay(history, now) >= FOLLOW_UP_DAILY_CAP) {
		return { followUp: null, suppressed: 'daily-cap', considered: candidates.length };
	}

	const previous = lastRaise(history);
	if (previous && now.getTime() - previous.occurredAt.getTime() < FOLLOW_UP_MIN_INTERVAL_MS) {
		return { followUp: null, suppressed: 'min-interval', considered: candidates.length };
	}

	// At most one, never a batch. A single actionable question is answered; a list of
	// four is scrolled past.
	const [chosen] = open.slice(0, FOLLOW_UPS_PER_RUN);
	return { followUp: chosen ?? null, suppressed: null, considered: candidates.length };
}

// ─── Phrasing ───────────────────────────────────────────────────────────────

// The composed sentence lives in its own module so neither file grows past what a
// reviewer reads in one sitting — the same split `briefing.ts` and
// `briefing-speech.ts` already use, for the same reason.
export {
	FOLLOW_UP_QUESTION,
	namesARealRow,
	renderFollowUp,
	type RenderedFollowUp,
} from './follow-up-speech.js';
