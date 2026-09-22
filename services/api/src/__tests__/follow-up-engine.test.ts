/**
 * NOVA API — the proactive follow-up engine, end to end over real rows.
 *
 * `follow-up.test.ts` pins the rules. This file proves the *job*: that it finds the
 * rows, delivers through the existing notification transport, records what it did,
 * and then refuses to repeat itself on the next pass. It also covers the answers —
 * dismissal and snooze — through the same `resolve_follow_up` path the assistant
 * calls, because a follow-up engine with no way to be told "leave it" is the nagging
 * half of the feature.
 *
 * The database is `makeFilteringDb`, the in-memory Drizzle double that evaluates
 * `WHERE` the way PostgreSQL would (see `helpers/tool-db.ts`). That matters here: the
 * shared double in `setup.ts` ignores `where` entirely, so with it a *dismissed*
 * reminder would still come back from `buildUserContext` and the "leaves it alone"
 * assertions below would pass while proving nothing.
 *
 * No test makes a model call. The follow-up sentence is composed from the row, so
 * there is nothing to mock — which is also why the feature works with no LLM credit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';

import { getDb } from '../db/connection.js';
import { notificationService } from '../services/notification.service.js';
import { runFollowUpEngine } from '../jobs/follow-up-engine.js';
import { recordFollowUpDecision } from '../services/follow-up-state.js';
import { executeToolUses } from '../services/assistant-tool-executor.js';
import { makeFilteringDb, type Row } from './helpers/tool-db.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333';
const TASK_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const REMINDER_ID = 'bbbbbbbb-1111-4111-8111-111111111111';

/** 10:00 in Asia/Kolkata — inside the allowed window. */
const NOW = new Date('2026-09-18T04:30:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** An open task that went past its deadline yesterday. */
function overdueTask(overrides: Row = {}): Row {
	return {
		id: TASK_ID,
		userId: USER_ID,
		title: 'Send the ABC proposal',
		status: 'pending',
		dueAt: new Date(NOW.getTime() - DAY),
		completedAt: null,
		createdAt: new Date(NOW.getTime() - 4 * DAY),
		...overrides,
	};
}

function reminderRow(overrides: Row = {}): Row {
	return {
		id: REMINDER_ID,
		userId: USER_ID,
		title: 'Call the bank',
		triggerAt: new Date(NOW.getTime() - 2 * HOUR),
		dismissed: false,
		createdAt: new Date(NOW.getTime() - 3 * DAY),
		...overrides,
	};
}

/** One raise already recorded for the user, as the engine writes them. */
function raisedRow(itemId: string, epoch: string, occurredAt: Date, itemType = 'task'): Row {
	return {
		id: `log-${itemId}-${occurredAt.getTime()}`,
		userId: USER_ID,
		actorType: 'system',
		action: 'follow_up_raised',
		targetType: itemType,
		targetId: itemId,
		outcome: 'success',
		details: { kind: 'follow_up', itemType, itemId, epoch },
		occurredAt,
	};
}

function harness(seed: Record<string, Row[]> = {}): {
	db: ReturnType<typeof getDb>;
	store: Record<string, Row[]>;
	run: (now?: Date) => ReturnType<typeof runFollowUpEngine>;
} {
	const { db, store } = makeFilteringDb({
		tasks: [],
		reminders: [],
		audit_logs: [],
		...seed,
	});
	vi.mocked(getDb).mockReturnValue(db);
	return { db, store, run: (now = NOW) => runFollowUpEngine(db, { now }) };
}

/** The verdicts the engine reaches, as `{ reason: count }`. */
function reasons(result: { suppressed: Record<string, number> }): Record<string, number> {
	return result.suppressed;
}

let createNotification: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	createNotification = vi
		.spyOn(notificationService, 'create')
		.mockResolvedValue({ id: 'notification-1' } as never);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ─── The six tests the feature exists for ───────────────────────────────────

describe('runFollowUpEngine', () => {
	it('raises exactly one follow-up for an overdue task, and names the real row', async () => {
		const { store, run } = harness({ tasks: [overdueTask()] });

		const result = await run();

		expect(result.raised).toBe(1);
		expect(createNotification).toHaveBeenCalledTimes(1);
		const payload = createNotification.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload.userId).toBe(USER_ID);
		expect(String(payload.title)).toContain('Send the ABC proposal');
		expect(String(payload.body)).toContain('leave it as is');
		// Delivered on the transport that already exists, tagged so a client can tell
		// it apart from an ordinary notification.
		expect(payload.type).toBe('follow_up');
		expect(payload.metadata).toMatchObject({ itemType: 'task', itemId: TASK_ID });

		// And recorded, so the next pass knows it has spoken.
		const log = store.audit_logs ?? [];
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({
			userId: USER_ID,
			action: 'follow_up_raised',
			targetId: TASK_ID,
			actorType: 'system',
		});
	});

	it('never raises the same item twice when the job runs again', async () => {
		const { run } = harness({ tasks: [overdueTask()] });

		const first = await run();
		const second = await run();

		expect(first.raised).toBe(1);
		expect(second.raised).toBe(0);
		expect(reasons(second)['already-followed-up']).toBe(1);
		// The dedupe: two passes, one notification, however many sweeps run.
		expect(createNotification).toHaveBeenCalledTimes(1);
	});

	it('says nothing about a completed task or a dismissed reminder', async () => {
		// A finished task is not even a candidate: the row scan skips it, so the sweep
		// never looks at the user at all.
		const completed = harness({
			tasks: [overdueTask({ status: 'completed', completedAt: new Date(NOW.getTime() - HOUR) })],
		});
		const completedResult = await completed.run();
		expect(completedResult.raised).toBe(0);
		expect(completedResult.examinedUsers).toBe(0);

		// A dismissed reminder is excluded by the same scan.
		const dismissed = harness({ reminders: [reminderRow({ dismissed: true })] });
		const dismissedResult = await dismissed.run();
		expect(dismissedResult.raised).toBe(0);
		expect(dismissedResult.examinedUsers).toBe(0);

		expect(createNotification).not.toHaveBeenCalled();
	});

	it('still refuses to name a task that is open but already stamped finished', async () => {
		// `status` still says pending — an inconsistent row. The sweep finds the user,
		// and the planner's own re-check refuses to call the task unfinished. This is
		// the defence the recording reaper uses too: the query is the real filter, and
		// the same rule is applied again to what came back.
		const { run } = harness({
			tasks: [overdueTask({ status: 'pending', completedAt: new Date(NOW.getTime() - HOUR) })],
		});

		const result = await run();
		expect(result.examinedUsers).toBe(1);
		expect(result.raised).toBe(0);
		expect(reasons(result)['nothing-due']).toBe(1);
		expect(createNotification).not.toHaveBeenCalled();
	});

	it('stays silent during quiet hours, without touching the database', async () => {
		const { store, run } = harness({ tasks: [overdueTask()] });

		// 22:30 in Asia/Kolkata.
		const result = await run(new Date('2026-09-18T17:00:00.000Z'));

		expect(result.skipReason).toBe('quiet-hours');
		expect(result.raised).toBe(0);
		expect(result.examinedUsers).toBe(0);
		expect(store.audit_logs).toHaveLength(0);
		expect(createNotification).not.toHaveBeenCalled();
	});

	it('stops at the daily cap even with another item waiting, and with the interval clear', async () => {
		const { run } = harness({
			tasks: [overdueTask()],
			// Two raises already made today, the last one five hours ago — so the
			// minimum interval has passed and the cap is the only thing holding.
			audit_logs: [
				raisedRow('other-1', 'e1', new Date(NOW.getTime() - 6 * HOUR)),
				raisedRow('other-2', 'e2', new Date(NOW.getTime() - 5 * HOUR)),
			],
		});

		const result = await run();

		expect(result.raised).toBe(0);
		expect(reasons(result)['daily-cap']).toBe(1);
		expect(createNotification).not.toHaveBeenCalled();
	});

	it('sends nothing at all for a user with nothing overdue', async () => {
		const { store, run } = harness({
			tasks: [overdueTask({ dueAt: new Date(NOW.getTime() + 3 * DAY), createdAt: new Date(NOW.getTime() - 3 * DAY) })],
			reminders: [reminderRow({ triggerAt: new Date(NOW.getTime() + 5 * DAY) })],
		});

		const result = await run();

		expect(result.raised).toBe(0);
		expect(reasons(result)['nothing-due']).toBe(1);
		expect(store.audit_logs).toHaveLength(0);
		expect(createNotification).not.toHaveBeenCalled();
	});

	it('holds the minimum interval between two follow-ups', async () => {
		const { run } = harness({
			tasks: [overdueTask()],
			audit_logs: [raisedRow('other-1', 'e1', new Date(NOW.getTime() - HOUR))],
		});

		const result = await run();
		expect(result.raised).toBe(0);
		expect(reasons(result)['min-interval']).toBe(1);
	});

	it('classifies against the sweep’s own clock, not the wall clock', async () => {
		// A sweep can be handed a `now` — a replay, a backfill, or a test. The snapshot must be
		// classified against *that* instant. Against the wall clock this task is still a day
		// away, so it lands among the later tasks and no rule ever sees it.
		//
		// **Anchored to `NOW`, not to `Date.now()`.** This test previously derived its sweep
		// instant from the wall clock (`Date.now() + 3 * DAY`), which preserves the current
		// time of day — and `isQuietHours` returns before the database is read when the user's
		// local hour is >= 21 or < 8. So the test failed every night between 21:00 and 08:00
		// IST with `raised: 0` and `skipReason: "quiet-hours"`, which reads as a broken engine
		// rather than a test that depends on when it is run.
		//
		// `NOW` is 10:00 in Asia/Kolkata. The offset here lands the sweep at 09:30 IST, inside
		// the allowed window, so the assertion is about clock handling and not about the hour.
		const sweepNow = new Date(NOW.getTime() + 2 * DAY - 30 * 60 * 1000);
		const { run } = harness({
			tasks: [
				overdueTask({
					dueAt: new Date(NOW.getTime() + DAY),
					createdAt: new Date(NOW.getTime() - 2 * DAY),
				}),
			],
		});

		expect((await run(sweepNow)).raised).toBe(1);
	});
});

// ─── The user's switches ────────────────────────────────────────────────────

describe('the switches that turn it off', () => {
	it('suppresses when every notification channel is off', async () => {
		const { run } = harness({
			tasks: [overdueTask()],
			notification_preferences: [
				{ userId: USER_ID, push: false, email: false, sms: false, inApp: false },
			],
		});

		const result = await run();
		expect(result.raised).toBe(0);
		expect(reasons(result)['notifications-off']).toBe(1);
		expect(createNotification).not.toHaveBeenCalled();
	});

	it('suppresses when cloud processing is switched off', async () => {
		const { run } = harness({
			tasks: [overdueTask()],
			privacy_preferences: [
				{
					userId: USER_ID,
					saveConversations: true,
					saveRecordings: true,
					saveTranscripts: true,
					saveMemories: true,
					cloudProcessing: false,
					localProcessing: false,
				},
			],
		});

		const result = await run();
		expect(result.raised).toBe(0);
		expect(reasons(result)['cloud-processing-off']).toBe(1);
	});

	it('suppresses in companion mode sleep, but not in the default passive mode', async () => {
		const asleep = harness({
			tasks: [overdueTask()],
			companion_configs: [{ userId: USER_ID, companionMode: 'sleep' }],
		});
		const asleepResult = await asleep.run();
		expect(asleepResult.raised).toBe(0);
		expect(reasons(asleepResult)['companion-sleep']).toBe(1);

		// `passive` is the schema default. Gating on it would ship a feature that never
		// runs for anyone who never opened the setting, so it must still raise here.
		const passive = harness({
			tasks: [overdueTask()],
			companion_configs: [{ userId: USER_ID, companionMode: 'passive' }],
		});
		expect((await passive.run()).raised).toBe(1);
	});

	it('still raises for a user with no preference rows at all', async () => {
		const { run } = harness({ tasks: [overdueTask()] });
		expect((await run()).raised).toBe(1);
	});
});

// ─── Answering the follow-up ────────────────────────────────────────────────

describe('answering', () => {
	it('records "leave it" and then leaves the item alone', async () => {
		const { db, run } = harness({ tasks: [overdueTask()] });

		const recorded = await recordFollowUpDecision(db, {
			userId: USER_ID,
			itemType: 'task',
			itemId: TASK_ID,
			decision: 'leave',
			now: NOW,
		});
		expect(recorded.recorded).toBe(true);
		expect(recorded.epoch).not.toBeNull();

		const first = await run();
		const muchLater = await run(new Date(NOW.getTime() + 3 * DAY));
		expect(first.raised).toBe(0);
		expect(muchLater.raised).toBe(0);
		expect(reasons(muchLater)['already-followed-up']).toBe(1);
	});

	it('records a snooze, stays quiet, and asks again once it lapses', async () => {
		const { db, run } = harness({ tasks: [overdueTask()] });

		const snoozed = await recordFollowUpDecision(db, {
			userId: USER_ID,
			itemType: 'task',
			itemId: TASK_ID,
			decision: 'snooze',
			snoozeMinutes: 120,
			now: NOW,
		});
		expect(snoozed.snoozeUntil?.getTime()).toBe(NOW.getTime() + 2 * HOUR);

		expect((await run()).raised).toBe(0);
		// 13:00 local, an hour after the snooze lapsed and well past the interval.
		const later = await run(new Date(NOW.getTime() + 3 * HOUR));
		expect(later.raised).toBe(1);
	});

	it('dismisses the reminder itself when the user says leave it', async () => {
		const { db, store } = harness({ reminders: [reminderRow()] });

		const recorded = await recordFollowUpDecision(db, {
			userId: USER_ID,
			itemType: 'reminder',
			itemId: REMINDER_ID,
			decision: 'leave',
			now: NOW,
		});

		expect(recorded.recorded).toBe(true);
		expect(recorded.dismissedReminder).toBe(true);
		// The column that already means this, rather than a new one.
		expect(store.reminders?.[0]?.dismissed).toBe(true);
	});

	it('records nothing for an item on somebody else’s account', async () => {
		const { db, store } = harness({ tasks: [overdueTask()] });

		const recorded = await recordFollowUpDecision(db, {
			userId: OTHER_USER_ID,
			itemType: 'task',
			itemId: TASK_ID,
			decision: 'leave',
			now: NOW,
		});

		expect(recorded.recorded).toBe(false);
		expect(recorded.reason).toBe('not-found');
		expect(store.audit_logs).toHaveLength(0);
	});

	it('is reachable by the assistant, so "leave it" can be said out loud', async () => {
		const { store } = harness({ tasks: [overdueTask()], reminders: [reminderRow()] });

		const [call] = await executeToolUses(USER_ID, [
			{
				id: 'tool-use-1',
				name: 'resolve_follow_up',
				input: { item_type: 'task', item_id: TASK_ID, decision: 'leave' },
			},
		]);

		expect(call?.ok).toBe(true);
		expect(call?.data).toMatchObject({ answered: true, decision: 'leave' });
		expect(store.audit_logs?.[0]).toMatchObject({ action: 'follow_up_dismissed', targetId: TASK_ID });

		// And the same tool refuses an id that is not this user's.
		const [foreign] = await executeToolUses(USER_ID, [
			{
				id: 'tool-use-2',
				name: 'resolve_follow_up',
				input: { item_type: 'reminder', item_id: 'not-a-row-on-this-account', decision: 'snooze' },
			},
		]);
		expect(foreign?.ok).toBe(false);
	});
});

// ─── The scan itself ────────────────────────────────────────────────────────

describe('the sweep', () => {
	it('raises for a reminder whose time passed and was never dismissed', async () => {
		const { store, run } = harness({ reminders: [reminderRow()] });

		const result = await run();

		expect(result.raised).toBe(1);
		const payload = createNotification.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(String(payload.title)).toContain('Call the bank');
		expect(store.audit_logs?.[0]).toMatchObject({
			action: 'follow_up_raised',
			targetType: 'reminder',
			targetId: REMINDER_ID,
		});
	});

	it('scans the users with open items, and says nothing to a user without one', async () => {
		const { run } = harness({
			tasks: [
				overdueTask(),
				overdueTask({ id: 'task-of-someone-else', userId: OTHER_USER_ID, title: 'Somebody else’s proposal' }),
			],
		});

		const result = await run();
		expect(result.examinedUsers).toBe(2);
		// Each account is written to about its own row — one message each, and never a
		// message about a row that is not theirs.
		expect(createNotification).toHaveBeenCalledTimes(2);
		const userIds = createNotification.mock.calls.map((c) => (c[0] as { userId: string }).userId);
		expect(new Set(userIds)).toEqual(new Set([USER_ID, OTHER_USER_ID]));
	});

	it('leaves an account with no open items entirely alone', async () => {
		const { store, run } = harness({
			tasks: [overdueTask({ userId: OTHER_USER_ID, status: 'completed', completedAt: NOW })],
			reminders: [reminderRow({ userId: OTHER_USER_ID, dismissed: true })],
		});

		const result = await run();
		expect(result.examinedUsers).toBe(0);
		expect(store.audit_logs).toHaveLength(0);
		expect(createNotification).not.toHaveBeenCalled();
	});
});

// ─── The postponement journal the trigger fills ─────────────────────────────

/** One `reminder_events` row, shaped the way the trigger writes it. */
function journalRow(event: string, occurredAt: Date, overrides: Row = {}): Row {
	return {
		id: `event-${event}-${occurredAt.getTime()}`,
		reminderId: REMINDER_ID,
		userId: USER_ID,
		event,
		fromTriggerAt: new Date(occurredAt.getTime() - DAY),
		toTriggerAt: new Date(occurredAt.getTime() - DAY + HOUR),
		occurredAt,
		...overrides,
	};
}

describe('the postponement journal', () => {
	/** Still two days out, so the only rule that can raise it is the push-back one. */
	const pushedBack = (): Row => reminderRow({ triggerAt: new Date(NOW.getTime() + 2 * DAY) });

	it('raises a reminder the journal shows was postponed twice', async () => {
		// The journal is written by the database trigger, never by application code —
		// inserting here would double-count. This asserts the engine *reads* it: two
		// rows are two postponements with no witnessed history at all.
		const { run } = harness({
			reminders: [pushedBack()],
			reminder_events: [
				journalRow('postponed', new Date(NOW.getTime() - 5 * DAY)),
				journalRow('postponed', new Date(NOW.getTime() - 2 * DAY)),
			],
		});

		const result = await run();

		expect(result.raised).toBe(1);
		const payload = createNotification.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(payload.metadata).toMatchObject({
			itemType: 'reminder',
			itemId: REMINDER_ID,
			reason: 'reminder-rescheduled',
		});
	});

	it('does not count a time moved earlier — that is not avoidance', async () => {
		const { run } = harness({
			reminders: [pushedBack()],
			reminder_events: [
				journalRow('rescheduled_earlier', new Date(NOW.getTime() - 5 * DAY)),
				journalRow('rescheduled_earlier', new Date(NOW.getTime() - 2 * DAY)),
			],
		});

		const result = await run();

		expect(result.raised).toBe(0);
		expect(createNotification).not.toHaveBeenCalled();
	});

	it('counts zero for a reminder whose only edit was its title', async () => {
		// A title change never touches `trigger_at`, so the trigger writes no row —
		// there is nothing in the journal to count, and the rule stays silent.
		const { run } = harness({
			reminders: [reminderRow({ title: 'Call the bank about the loan', triggerAt: new Date(NOW.getTime() + 2 * DAY) })],
			reminder_events: [],
		});

		expect((await run()).raised).toBe(0);
		expect(createNotification).not.toHaveBeenCalled();
	});

	it('ignores another account’s journal rows', async () => {
		const { run } = harness({
			reminders: [pushedBack()],
			reminder_events: [
				journalRow('postponed', new Date(NOW.getTime() - 5 * DAY), { userId: OTHER_USER_ID }),
				journalRow('postponed', new Date(NOW.getTime() - 2 * DAY), { userId: OTHER_USER_ID }),
			],
		});

		expect((await run()).raised).toBe(0);
	});

	it('ignores postponements older than the lookback window', async () => {
		const stale = new Date(NOW.getTime() - 40 * DAY);
		const { run } = harness({
			reminders: [pushedBack()],
			reminder_events: [journalRow('postponed', stale), journalRow('postponed', stale)],
		});

		expect((await run()).raised).toBe(0);
	});
});
