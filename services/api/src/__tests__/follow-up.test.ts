/**
 * NOVA API — the follow-up policy, without a database.
 *
 * Every limit that makes this feature safe to ship is a pure function, so all of
 * them are pinned here: which rows are candidates, one follow-up per item state,
 * the minimum interval, the daily cap, quiet hours, snooze, dismissal, and the
 * user's own switches. `follow-up-engine.test.ts` then proves the job wires those
 * rules to real rows.
 *
 * The last block is the anti-fabrication half: every sentence the engine can
 * compose is run through the briefing's own grounding guard, and a follow-up is
 * asserted to name an id that is genuinely in the snapshot it was built from.
 */
import { describe, expect, it } from 'vitest';
import './setup.js';

import {
	classifyFacts,
	type MemoryFact,
	type ReminderFact,
	type TaskFact,
	type UserContextFacts,
} from '../services/user-context.js';
import {
	FOLLOW_UP_DAILY_CAP,
	FOLLOW_UP_MIN_INTERVAL_MS,
	FOLLOW_UP_QUESTION,
	followUpCandidates,
	followUpDay,
	isQuietHours,
	lastRaise,
	namesARealRow,
	planFollowUp,
	pushedBackCount,
	raisedOnDay,
	renderFollowUp,
	type FollowUpHistoryEntry,
	type FollowUpReason,
} from '../services/follow-up.js';
import { guardBriefingText } from '../services/briefing.js';

/** 10:00 in Asia/Kolkata — inside the allowed window, so nothing is quiet. */
const NOW = new Date('2026-09-18T04:30:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const TASK_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_TASK_ID = 'aaaaaaaa-2222-4222-8222-222222222222';
const REMINDER_ID = 'bbbbbbbb-1111-4111-8111-111111111111';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function task(overrides: Partial<TaskFact> = {}): TaskFact {
	return {
		id: TASK_ID,
		title: 'Send the ABC proposal',
		status: 'pending',
		dueAt: null,
		createdAt: new Date(NOW.getTime() - 10 * DAY),
		completedAt: null,
		...overrides,
	};
}

function reminder(overrides: Partial<ReminderFact> = {}): ReminderFact {
	return {
		id: REMINDER_ID,
		title: 'Call the bank',
		triggerAt: new Date(NOW.getTime() - 2 * HOUR),
		dismissed: false,
		...overrides,
	};
}

/** A snapshot classified exactly the way `buildUserContext` classifies one. */
function snapshot(
	tasks: TaskFact[] = [],
	reminders: ReminderFact[] = [],
	memories: MemoryFact[] = [],
): UserContextFacts {
	const facts: UserContextFacts = {
		tasks,
		overdueTasks: [],
		dueTodayTasks: [],
		laterTasks: [],
		undatedTasks: [],
		reminders,
		upcomingReminders: [],
		pastReminders: [],
		nextReminder: null,
		memories,
	};
	return classifyFacts(facts, NOW);
}

function raised(
	itemId: string,
	epoch: string,
	occurredAt: Date,
	itemType: 'task' | 'reminder' = 'task',
): FollowUpHistoryEntry {
	return { action: 'follow_up_raised', itemType, itemId, epoch, occurredAt, snoozeUntil: null };
}

function plan(
	facts: UserContextFacts,
	history: FollowUpHistoryEntry[] = [],
	options: {
		now?: Date;
		allowed?: boolean;
		blockedBy?: string | null;
		postponements?: ReadonlyMap<string, number>;
	} = {},
) {
	return planFollowUp({
		facts,
		now: options.now ?? NOW,
		allowed: options.allowed ?? true,
		blockedBy: options.blockedBy ?? null,
		history,
		...(options.postponements ? { postponements: options.postponements } : {}),
	});
}

// ─── Quiet hours ────────────────────────────────────────────────────────────

describe('quiet hours', () => {
	it('is quiet overnight and awake through the working day', () => {
		// 02:30, 07:59 and 22:30 local are quiet; 08:00 and 20:59 are not.
		expect(isQuietHours(new Date('2026-09-18T21:00:00.000Z'))).toBe(true); // 02:30 IST
		expect(isQuietHours(new Date('2026-09-18T02:29:00.000Z'))).toBe(true); // 07:59 IST
		expect(isQuietHours(new Date('2026-09-18T16:59:00.000Z'))).toBe(true); // 22:29 IST
		expect(isQuietHours(new Date('2026-09-18T02:30:00.000Z'))).toBe(false); // 08:00 IST
		expect(isQuietHours(new Date('2026-09-18T15:29:00.000Z'))).toBe(false); // 20:59 IST
	});

	it('buckets the day in the user timezone, not the server one', () => {
		// 20:00 UTC is already the next day in Asia/Kolkata.
		expect(followUpDay(new Date('2026-09-18T20:00:00.000Z'))).toBe('2026-09-19');
		expect(followUpDay(NOW)).toBe('2026-09-18');
	});
});

// ─── What is a candidate ────────────────────────────────────────────────────

describe('followUpCandidates', () => {
	it('raises an overdue task once its grace has passed', () => {
		const facts = snapshot([task({ dueAt: new Date(NOW.getTime() - DAY) })]);
		const candidates = followUpCandidates(facts, NOW);

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({ itemType: 'task', itemId: TASK_ID, reason: 'task-overdue' });
	});

	it('leaves a task alone in the hour after it was due', () => {
		// Due ten minutes ago. True, and useless to say.
		const facts = snapshot([task({ dueAt: new Date(NOW.getTime() - 10 * 60 * 1000) })]);
		expect(followUpCandidates(facts, NOW)).toHaveLength(0);
	});

	it('raises a task due later today', () => {
		const facts = snapshot([task({ dueAt: new Date('2026-09-18T14:00:00.000Z') })]);
		expect(followUpCandidates(facts, NOW)[0]).toMatchObject({ reason: 'task-due-today' });
	});

	it('raises an undated task that has sat pending for days, and not a fresh one', () => {
		const stale = snapshot([task({ createdAt: new Date(NOW.getTime() - 4 * DAY) })]);
		expect(followUpCandidates(stale, NOW)[0]).toMatchObject({ reason: 'task-stale' });

		const fresh = snapshot([task({ createdAt: new Date(NOW.getTime() - HOUR) })]);
		expect(followUpCandidates(fresh, NOW)).toHaveLength(0);
	});

	it('raises a reminder whose time passed and was never dismissed', () => {
		const facts = snapshot([], [reminder({ triggerAt: new Date(NOW.getTime() - 2 * HOUR) })]);
		expect(followUpCandidates(facts, NOW)[0]).toMatchObject({
			itemType: 'reminder',
			reason: 'reminder-missed',
		});
	});

	it('never raises a completed task, however overdue it is', () => {
		// The defensive half of the rule: `buildUserContext` filters by status, but the
		// engine re-checks, so a driver or a hand-built fact cannot slip one through.
		const completed = snapshot([
			task({ status: 'completed', completedAt: new Date(NOW.getTime() - DAY), dueAt: new Date(NOW.getTime() - 5 * DAY) }),
		]);
		expect(followUpCandidates(completed, NOW)).toHaveLength(0);

		// A row that is still `pending` but carries a completion stamp is finished too.
		const inconsistent = snapshot([
			task({ status: 'pending', completedAt: new Date(NOW.getTime() - DAY), dueAt: new Date(NOW.getTime() - 5 * DAY) }),
		]);
		expect(followUpCandidates(inconsistent, NOW)).toHaveLength(0);
	});

	it('never raises a dismissed reminder', () => {
		const facts = snapshot([], [reminder({ dismissed: true })]);
		expect(followUpCandidates(facts, NOW)).toHaveLength(0);
	});

	it('counts only a push-back it actually watched, and only later times', () => {
		const current = new Date(NOW.getTime() + 2 * DAY).toISOString();
		const history = [
			raised(REMINDER_ID, new Date(NOW.getTime() - 3 * DAY).toISOString(), new Date(NOW.getTime() - 6 * DAY), 'reminder'),
			raised(REMINDER_ID, new Date(NOW.getTime() - 1 * DAY).toISOString(), new Date(NOW.getTime() - 4 * DAY), 'reminder'),
			// A time *before* the current one is not a postponement of it.
			raised(REMINDER_ID, new Date(NOW.getTime() + 9 * DAY).toISOString(), new Date(NOW.getTime() - 2 * DAY), 'reminder'),
			// Another item's history is not this item's.
			raised(OTHER_TASK_ID, new Date(NOW.getTime() - 9 * DAY).toISOString(), new Date(NOW.getTime() - 2 * DAY)),
		];

		expect(pushedBackCount(REMINDER_ID, current, history)).toBe(2);
	});

	it('raises a reminder pushed back more than once even though it is not yet due', () => {
		const facts = snapshot([], [reminder({ triggerAt: new Date(NOW.getTime() + 2 * DAY) })]);
		const earlier = (daysAgo: number, target: number): FollowUpHistoryEntry =>
			raised(
				REMINDER_ID,
				new Date(NOW.getTime() + target * DAY).toISOString(),
				new Date(NOW.getTime() - daysAgo * DAY),
				'reminder',
			);

		// One push-back is not "more than once" — a single reschedule is ordinary.
		expect(followUpCandidates(facts, NOW, [earlier(6, -1)])).toHaveLength(0);
		// Two are.
		const candidates = followUpCandidates(facts, NOW, [earlier(6, -1), earlier(4, 0)]);
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.reason).toBe('reminder-rescheduled');
	});
});

// ─── The postponement journal ───────────────────────────────────────────────

describe('the postponement journal', () => {
	/** A reminder still in the future, so only the push-back rule can raise it. */
	const future = (): UserContextFacts =>
		snapshot([], [reminder({ triggerAt: new Date(NOW.getTime() + 2 * DAY) })]);

	it('raises a reminder the journal shows was pushed back twice, with no witnessed history', () => {
		// Before this, the engine could only count a push-back it had itself watched,
		// so a reminder the user moved twice before NOVA ever mentioned it was
		// invisible — the exact case the rule exists for.
		const candidates = followUpCandidates(future(), NOW, [], new Map([[REMINDER_ID, 2]]));

		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			itemType: 'reminder',
			itemId: REMINDER_ID,
			reason: 'reminder-rescheduled',
		});
	});

	it('does not raise a reminder the journal shows was pushed back once', () => {
		// "More than once" means two. A single reschedule is ordinary.
		expect(followUpCandidates(future(), NOW, [], new Map([[REMINDER_ID, 1]]))).toHaveLength(0);
	});

	it('takes the journal count as a floor, never lowering what NOVA witnessed itself', () => {
		const current = new Date(NOW.getTime() + 2 * DAY).toISOString();
		const witnessed = [
			raised(
				REMINDER_ID,
				new Date(NOW.getTime() + DAY).toISOString(),
				new Date(NOW.getTime() - 4 * DAY),
				'reminder',
			),
		];

		expect(pushedBackCount(REMINDER_ID, current, witnessed)).toBe(1);
		// The journal starts at migration 0004, so a reminder postponed before the
		// trigger existed must not lose the count the trail already knew about.
		expect(pushedBackCount(REMINDER_ID, current, witnessed, new Map([[REMINDER_ID, 0]]))).toBe(1);
		expect(pushedBackCount(REMINDER_ID, current, witnessed, new Map())).toBe(1);
		// A journal that knows about more is believed.
		expect(pushedBackCount(REMINDER_ID, current, witnessed, new Map([[REMINDER_ID, 3]]))).toBe(3);
	});

	it('uses the journalled count for the decision, not just for the helper', () => {
		const result = plan(future(), [], { postponements: new Map([[REMINDER_ID, 2]]) });
		expect(result.followUp?.reason).toBe('reminder-rescheduled');
		// Nothing journalled and nothing witnessed: no candidate at all.
		expect(plan(future(), [], { postponements: new Map() }).followUp).toBeNull();
	});
});

// ─── The limits ─────────────────────────────────────────────────────────────

describe('planFollowUp', () => {
	const overdue = (): UserContextFacts =>
		snapshot([task({ dueAt: new Date(NOW.getTime() - DAY) })]);

	it('raises exactly one follow-up for a user with nothing held back', () => {
		const result = plan(overdue());
		expect(result.followUp).not.toBeNull();
		expect(result.followUp?.itemId).toBe(TASK_ID);
		expect(result.suppressed).toBeNull();
	});

	it('says nothing at all when nothing is overdue or pending', () => {
		const facts = snapshot([task({ dueAt: new Date(NOW.getTime() + 3 * DAY) })]);
		const result = plan(facts);
		expect(result.followUp).toBeNull();
		expect(result.suppressed).toBe('nothing-due');
	});

	it('never raises the same item twice for the same state', () => {
		const facts = overdue();
		const candidate = followUpCandidates(facts, NOW)[0]!;
		const history = [raised(TASK_ID, candidate.epoch, new Date(NOW.getTime() - 10 * HOUR))];
		expect(plan(facts, history).suppressed).toBe('already-followed-up');
	});

	it('allows one new follow-up once the item itself has changed', () => {
		const facts = overdue();
		const candidate = followUpCandidates(facts, NOW)[0]!;
		const history = [raised(TASK_ID, 'some-older-state', new Date(NOW.getTime() - 10 * HOUR))];
		expect(plan(facts, history).followUp?.itemId).toBe(TASK_ID);
	});

	it('holds the minimum interval between two follow-ups', () => {
		const facts = overdue();
		// One raise an hour ago, for a different item: the interval, not the cap.
		const history = [raised(OTHER_TASK_ID, 'other-epoch', new Date(NOW.getTime() - HOUR))];
		expect(plan(facts, history).suppressed).toBe('min-interval');

		// Once the interval has passed — still the same local day, so the cap allows
		// it — the same item is raised.
		const later = new Date(NOW.getTime() + FOLLOW_UP_MIN_INTERVAL_MS + HOUR);
		expect(plan(facts, history, { now: later }).followUp?.itemId).toBe(TASK_ID);
	});

	it('holds the daily cap, and counts the day in the user timezone', () => {
		const facts = overdue();
		const history = [
			raised(OTHER_TASK_ID, 'e1', new Date(NOW.getTime() - 5 * HOUR)),
			raised(OTHER_TASK_ID, 'e2', new Date(NOW.getTime() - 3 * HOUR)),
		];
		expect(FOLLOW_UP_DAILY_CAP).toBe(2);
		expect(raisedOnDay(history, NOW)).toBe(2);
		expect(plan(facts, history).suppressed).toBe('daily-cap');

		// The same two raises counted against the previous local day: the cap has
		// reset, and only the minimum interval was ever in the way.
		expect(raisedOnDay(history, new Date(NOW.getTime() - DAY))).toBe(0);
		expect(plan(facts, history, { now: new Date(NOW.getTime() + DAY) }).suppressed).toBeNull();
	});

	it('is quiet overnight even with an item waiting', () => {
		const facts = overdue();
		const result = plan(facts, [], { now: new Date('2026-09-18T17:00:00.000Z') }); // 22:30 IST
		expect(result.followUp).toBeNull();
		expect(result.suppressed).toBe('quiet-hours');
	});

	it('obeys a snooze until it lapses, then asks once', () => {
		const facts = overdue();
		const candidate = followUpCandidates(facts, NOW)[0]!;
		const snoozed: FollowUpHistoryEntry = {
			action: 'follow_up_snoozed',
			itemType: 'task',
			itemId: TASK_ID,
			epoch: candidate.epoch,
			occurredAt: NOW,
			snoozeUntil: new Date(NOW.getTime() + 2 * HOUR),
		};

		expect(plan(facts, [snoozed]).suppressed).toBe('already-followed-up');
		expect(plan(facts, [snoozed], { now: new Date(NOW.getTime() + 3 * HOUR) }).followUp?.itemId)
			.toBe(TASK_ID);
	});

	it('obeys "leave it" for the state the user answered about', () => {
		const facts = overdue();
		const candidate = followUpCandidates(facts, NOW)[0]!;
		const dismissed: FollowUpHistoryEntry = {
			action: 'follow_up_dismissed',
			itemType: 'task',
			itemId: TASK_ID,
			epoch: candidate.epoch,
			occurredAt: NOW,
			snoozeUntil: null,
		};

		expect(plan(facts, [dismissed]).suppressed).toBe('already-followed-up');
		expect(plan(facts, [dismissed], { now: new Date(NOW.getTime() + 3 * DAY) }).suppressed)
			.toBe('already-followed-up');
	});

	it('sends nothing when the user has switched it off', () => {
		const result = plan(overdue(), [], { allowed: false, blockedBy: 'notifications-off' });
		expect(result.followUp).toBeNull();
		expect(result.suppressed).toBe('notifications-off');
	});

	it('reports the most recent raise', () => {
		const history = [
			raised(OTHER_TASK_ID, 'e1', new Date(NOW.getTime() - 10 * HOUR)),
			raised(OTHER_TASK_ID, 'e2', new Date(NOW.getTime() - 2 * HOUR)),
		];
		expect(lastRaise(history)?.epoch).toBe('e2');
		expect(lastRaise([])).toBeNull();
	});
});

// ─── Nothing is invented ────────────────────────────────────────────────────

describe('the composed follow-up', () => {
	const cases: { reason: FollowUpReason; facts: UserContextFacts }[] = [
		{ reason: 'task-overdue', facts: snapshot([task({ dueAt: new Date(NOW.getTime() - DAY) })]) },
		{ reason: 'task-due-today', facts: snapshot([task({ dueAt: new Date('2026-09-18T14:00:00.000Z') })]) },
		{ reason: 'task-stale', facts: snapshot([task({ createdAt: new Date(NOW.getTime() - 4 * DAY) })]) },
		{
			reason: 'reminder-missed',
			facts: snapshot([], [reminder({ triggerAt: new Date(NOW.getTime() - 2 * HOUR) })]),
		},
	];

	it.each(cases)('passes the briefing grounding guard ($reason)', ({ reason, facts }) => {
		const candidate = followUpCandidates(facts, NOW).find((c) => c.reason === reason);
		expect(candidate, `no candidate produced for ${reason}`).toBeDefined();

		const rendered = renderFollowUp(candidate!);
		expect(rendered).not.toBeNull();
		// The same guard the daily briefing draft must survive. The sentence is built
		// from the row, so this is a self-check rather than a filter — and it is the
		// assertion that fails the moment someone starts generating prose here.
		expect(guardBriefingText(rendered!.message, facts).ok).toBe(true);
		expect(rendered!.body).toBe(FOLLOW_UP_QUESTION);
		// It names the row it is about, and nothing else.
		const itemTitle = candidate!.itemType === 'task' ? 'Send the ABC proposal' : 'Call the bank';
		expect(rendered!.message).toContain(itemTitle);
	});

	it('also survives the guard for a rescheduled reminder', () => {
		const facts = snapshot([], [reminder({ triggerAt: new Date(NOW.getTime() + 2 * DAY) })]);
		const history = [
			raised(REMINDER_ID, new Date(NOW.getTime() - 1 * DAY).toISOString(), new Date(NOW.getTime() - 6 * DAY), 'reminder'),
			raised(REMINDER_ID, new Date(NOW.getTime() + 1 * DAY).toISOString(), new Date(NOW.getTime() - 4 * DAY), 'reminder'),
		];
		const candidate = followUpCandidates(facts, NOW, history)[0]!;
		expect(candidate.reason).toBe('reminder-rescheduled');
		const rendered = renderFollowUp(candidate)!;
		expect(guardBriefingText(rendered.message, facts).ok).toBe(true);
	});

	it('names a row that is really in the snapshot, and refuses one that is not', () => {
		const facts = snapshot([task({ dueAt: new Date(NOW.getTime() - DAY) })]);
		const candidate = followUpCandidates(facts, NOW)[0]!;
		expect(namesARealRow(candidate, facts)).toBe(true);
		expect(namesARealRow({ ...candidate, itemId: 'not-a-row' }, facts)).toBe(false);
		// An id that exists, but as a reminder rather than the task claimed.
		expect(
			namesARealRow({ ...candidate, itemType: 'reminder', itemId: TASK_ID }, snapshot([], [reminder()])),
		).toBe(false);
	});

	it('declines to say anything when the title sanitises away', () => {
		// A title that is only an emoji leaves nothing honest to say.
		expect(renderFollowUp({ ...followUpCandidates(snapshot([task({ dueAt: new Date(NOW.getTime() - DAY) })]), NOW)[0]!, title: '🎉' }))
			.toBeNull();
	});
});
