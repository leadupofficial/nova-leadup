/**
 * NOVA API — the proactive follow-up engine (§18).
 *
 * A sweep that notices an unfinished task, a reminder whose time passed, or a
 * reminder the user keeps pushing back, and raises **at most one** follow-up per
 * item — through the notification transport the app already has, phrased so the
 * user can act on it.
 *
 * It follows the recording reaper's structure exactly, because that is the
 * established shape for scheduled work here: an interval job, a named constant for
 * the cadence, a `start*`/`stop*` pair, an `unref()`'d timer, one entry in
 * `server.ts`, and not started under test.
 *
 * ## What it refuses to do
 *
 *  * **Send anything when there is nothing to send.** No candidate means no message
 *    and no notification row. Silence is a first-class outcome.
 *  * **Name a row that is not there.** The candidate is chosen from a snapshot and
 *    then re-checked against that same snapshot, and the composed sentence is put
 *    through the briefing's own grounding guard before delivery.
 *  * **Call a model.** The sentence is composed from the row. There is nothing to
 *    hallucinate, the feature costs nothing to run, and it cannot depend on LLM
 *    credit — which is also why no test here mocks an AI call.
 *  * **Nag.** The candidate list is filtered by the planner's per-item, interval,
 *    daily-cap and quiet-hours rules, all of which live in `services/follow-up.ts`
 *    and are tested without a database.
 *  * **Take the API down.** A failing sweep is logged and returned, exactly as the
 *    reaper's is.
 */
import { and, eq, gte, inArray } from 'drizzle-orm';
import { reminders, tasks } from '@nova/database';
import type { getDb } from '../db/connection.js';
import { notificationService } from '../services/notification.service.js';
import { buildUserContext, type UserContextFacts } from '../services/user-context.js';
import { guardBriefingText } from '../services/briefing.js';
import { logger } from '../utils/logger.js';
import { proactiveGate as sharedProactiveGate } from '../admin/enforcement.js';
import {
	FOLLOW_UP_INTERVAL_MS,
	isQuietHours,
	namesARealRow,
	planFollowUp,
	renderFollowUp,
	type FollowUpCandidate,
	type FollowUpHistoryEntry,
} from '../services/follow-up.js';
import {
	followUpHistorySince,
	getFollowUpPermission,
	readFollowUpHistory,
	readPostponementCounts,
	writeFollowUpDecision,
} from '../services/follow-up-state.js';

type Db = ReturnType<typeof getDb>;

/** Users considered per sweep. The remainder are picked up by the next pass. */
const MAX_USERS_PER_RUN = 200;

/** Open-item rows scanned to find those users. A ceiling, not a target. */
const MAX_ITEM_ROWS = 2000;

/** `notifications.title` / `.body` ceilings, matching the notification route. */
const MAX_TITLE_CHARS = 500;
const MAX_BODY_CHARS = 5000;

export interface FollowUpEngineResult {
	/** Users with at least one open item that the sweep looked at. */
	examinedUsers: number;
	/** Follow-ups delivered. Never more than `MAX_USERS_PER_RUN × FOLLOW_UPS_PER_RUN`. */
	raised: number;
	/** Why nothing was raised, counted by reason. */
	suppressed: Record<string, number>;
	/** Set when the sweep declined to run at all. */
	skipReason: string | null;
}

/**
 * The users worth looking at: anyone with an open task or an undismissed reminder
 * inside the lookback window. A user with neither cannot have a candidate, so
 * reading their snapshot would be wasted work — and reading *every* user would make
 * the sweep scale with the account count instead of with the outstanding work.
 */
async function selectCandidateUsers(db: Db, now: Date): Promise<string[]> {
	const since = followUpHistorySince(now);
	const [taskRows, reminderRows] = await Promise.all([
		db
			.select({ userId: tasks.userId })
			.from(tasks)
			.where(inArray(tasks.status, ['pending', 'in_progress']))
			.limit(MAX_ITEM_ROWS),
		db
			.select({ userId: reminders.userId })
			.from(reminders)
			.where(and(eq(reminders.dismissed, false), gte(reminders.triggerAt, since)))
			.limit(MAX_ITEM_ROWS),
	]);

	const users = new Set<string>();
	for (const row of [...taskRows, ...reminderRows]) {
		if (typeof row.userId === 'string' && row.userId) users.add(row.userId);
		if (users.size >= MAX_USERS_PER_RUN) break;
	}
	return [...users].slice(0, MAX_USERS_PER_RUN);
}

/** One follow-up, delivered and recorded. Throws so the caller can count it. */
async function raiseFollowUp(
	db: Db,
	userId: string,
	candidate: FollowUpCandidate,
	rendered: { title: string; body: string; message: string },
	now: Date,
): Promise<void> {
	// The decision row is written after the notification: if delivery throws, nothing
	// claims the user was told, so the next sweep tries again rather than silently
	// dropping the item for its whole epoch.
	await notificationService.create({
		userId,
		type: 'follow_up',
		title: rendered.title.slice(0, MAX_TITLE_CHARS),
		body: rendered.body.slice(0, MAX_BODY_CHARS),
		category: 'follow_up',
		actionUrl: null,
		metadata: {
			kind: 'follow_up',
			itemType: candidate.itemType,
			itemId: candidate.itemId,
			reason: candidate.reason,
			epoch: candidate.epoch,
		},
	});

	await writeFollowUpDecision(db, {
		userId,
		action: 'follow_up_raised',
		itemType: candidate.itemType,
		itemId: candidate.itemId,
		epoch: candidate.epoch,
		reason: candidate.reason,
		occurredAt: now,
	});
}

/**
 * Builds the follow-up for one user, or explains why not.
 *
 * Exported so a caller that already has the snapshot and the trail (a test, or a
 * future "check now" endpoint) can compose without re-reading either.
 */
export function composeFollowUpForSnapshot(args: {
	facts: UserContextFacts;
	history: readonly FollowUpHistoryEntry[];
	now: Date;
	allowed: boolean;
	blockedBy: string | null;
	postponements?: ReadonlyMap<string, number>;
}):
	| { candidate: FollowUpCandidate; rendered: { title: string; body: string; message: string } }
	| { suppressed: string } {
	const plan = planFollowUp({
		facts: args.facts,
		now: args.now,
		allowed: args.allowed,
		blockedBy: args.blockedBy,
		history: args.history,
		...(args.postponements ? { postponements: args.postponements } : {}),
	});
	if (!plan.followUp) return { suppressed: plan.suppressed ?? 'nothing-due' };

	// Belt and braces against naming something that is not there: the candidate came
	// from this snapshot, and it must still be in it.
	if (!namesARealRow(plan.followUp, args.facts)) return { suppressed: 'item-not-in-snapshot' };

	const rendered = renderFollowUp(plan.followUp);
	if (!rendered) return { suppressed: 'nothing-to-say' };

	// The briefing's own anti-fabrication guard. The sentence is composed from a real
	// row, so this should always pass; it is here so that a future edit which starts
	// generating prose cannot deliver ungrounded text by accident.
	if (!guardBriefingText(rendered.message, args.facts).ok) return { suppressed: 'ungrounded-text' };

	return { candidate: plan.followUp, rendered };
}

async function runFollowUpForUser(
	db: Db,
	userId: string,
	now: Date,
): Promise<{ raised: boolean; suppressed: string | null }> {
	const context = await buildUserContext(userId, {}, now);
	const permission = await getFollowUpPermission(db, userId);

	// Both records of a push-back are read together: the audit trail the engine
	// wrote, and the `reminder_events` journal the database trigger fills. The
	// planner takes the larger of the two per reminder.
	let history: readonly FollowUpHistoryEntry[] = [];
	let postponements: ReadonlyMap<string, number> = new Map();
	if (permission.allowed) {
		[history, postponements] = await Promise.all([
			readFollowUpHistory(db, userId, now),
			readPostponementCounts(db, userId, now),
		]);
	}

	const composed = composeFollowUpForSnapshot({
		facts: context.facts,
		history,
		now,
		allowed: permission.allowed,
		blockedBy: permission.blockedBy,
		postponements,
	});
	if ('suppressed' in composed) return { raised: false, suppressed: composed.suppressed };

	await raiseFollowUp(db, userId, composed.candidate, composed.rendered, now);
	logger.info(
		{
			metric: 'follow_up_raised',
			userId,
			itemType: composed.candidate.itemType,
			itemId: composed.candidate.itemId,
			reason: composed.candidate.reason,
		},
		'Proactive follow-up raised',
	);
	return { raised: true, suppressed: null };
}

/**
 * One pass. Never throws: a broken sweep must not take the API down.
 */
export async function runFollowUpEngine(
	db: Db,
	options: { now?: Date; gate?: () => Promise<{ allowed: boolean; reason: string | null }> } = {},
): Promise<FollowUpEngineResult> {
	const now = options.now ?? new Date();
	const result: FollowUpEngineResult = {
		examinedUsers: 0,
		raised: 0,
		suppressed: {},
		skipReason: null,
	};

	// Operator kill switches and configuration, checked before any read.
	//
	// `CONTROL_BACKGROUND_JOBS_ENABLED` and `CONTROL_PROACTIVE_ENABLED` are the emergency
	// switches an operator throws when NOVA must stop reaching out — during an incident, or
	// while a bad prompt is being fixed. `PROACTIVE_ASSISTANT_ENABLED` is the ordinary
	// configuration key. Before this check existed, all three were cosmetic on the server: the
	// console could report them off while this sweep kept sending follow-ups, which is the
	// worst possible failure for a control plane, because the operator believes they have
	// stopped the behaviour and has not.
	//
	// A no-op when every switch is on, so the normal path pays nothing but one cached read.
	// Injectable, following the same pattern as `deleteObject` and `requeue` on the other
	// engines: the default is the real gate, and a caller (a test, or a backfill that must run
	// regardless of the switch) can supply its own decision.
	const gate = await (options.gate ?? sharedProactiveGate)();
	if (!gate.allowed) {
		result.skipReason = gate.reason;
		return result;
	}

	// Quiet hours, checked before any read. There is nothing to decide at 03:00, so
	// the sweep does not even touch the database.
	if (isQuietHours(now)) {
		result.skipReason = 'quiet-hours';
		return result;
	}

	let userIds: string[];
	try {
		userIds = await selectCandidateUsers(db, now);
	} catch (error) {
		logger.error({ err: error }, 'Follow-up engine: finding candidate users failed');
		result.skipReason = 'scan-failed';
		return result;
	}

	for (const userId of userIds) {
		result.examinedUsers += 1;
		let outcome: { raised: boolean; suppressed: string | null };
		try {
			outcome = await runFollowUpForUser(db, userId, now);
		} catch (error) {
			// One user's failure is not the sweep's failure, and a failed read must not
			// be recorded as "nothing to do" — the next pass retries.
			logger.error({ err: error, userId }, 'Follow-up engine: one user failed; continuing');
			continue;
		}
		if (outcome.raised) {
			result.raised += 1;
		} else if (outcome.suppressed) {
			result.suppressed[outcome.suppressed] = (result.suppressed[outcome.suppressed] ?? 0) + 1;
		}
	}

	if (result.raised > 0) {
		logger.info(result, 'Follow-up engine completed');
	}
	return result;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic sweep. Called once from the API's boot path, and not under
 * test, so a suite cannot race a background timer against its own fixtures.
 *
 * The first pass is deferred rather than run inline, and `unref()` keeps the timer
 * from holding the process open during a graceful shutdown — the same choices the
 * reaper makes, for the same reasons.
 */
export function startFollowUpEngine(getDbInstance: () => Db): void {
	if (timer) return;
	timer = setInterval(() => {
		void runFollowUpEngine(getDbInstance()).catch((error) => {
			logger.error({ err: error }, 'Follow-up engine threw');
		});
	}, FOLLOW_UP_INTERVAL_MS);
	timer.unref?.();
}

/** Exposed for tests and for a graceful shutdown hook. */
export function stopFollowUpEngine(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}
