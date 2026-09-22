/**
 * NOVA API — a recurring reminder must not be described as a thing of the past.
 *
 * Nothing server-side advances `reminders.trigger_at`: the phone repeats the alarm
 * itself, so the column stays at the **first** occurrence for the life of the
 * reminder. The grounding block partitioned reminders on that column and rendered
 * it verbatim, with the result that every occurrence after the first was invisible
 * to the model — a weekly reminder that started last Monday was permanently in
 * `pastReminders`, where the briefing counts it as missed and the assistant
 * describes a perfectly live reminder as overdue. The stored `repeat_rule` was not
 * selected at all, so the model was never told the reminder repeats.
 *
 * These tests pin the two halves: the pure resolution of "when is this next due",
 * and the grounded block a model actually reads. The pure cases matter because
 * this runs in front of every turn and must never throw — a rule it cannot parse
 * costs a stale timestamp, not the whole grounding block.
 *
 * The shared mock in `./setup` returns fixed fixtures and ignores `where`, so the
 * pipeline's in-memory Drizzle look-alike (`makeDb`) is installed over `getDb`,
 * the same seam `user-context.test.ts` uses. `makeDb` returns rows verbatim and
 * ignores the `select({...})` projection, so the fixture keys are the destructured
 * names the query reads (`triggerAt`, `repeatRule`, `timezone`), not the column
 * names.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { getDb } from '../db/connection.js';
import { buildUserContext, resolvedReminderAt } from '../services/user-context.js';
import { makeDb } from './helpers/recording-fixtures.js';

afterEach(() => {
	vi.mocked(getDb).mockReset();
});

/** 09:00 IST on Monday 14 September 2026 — the first occurrence. */
const FIRST = new Date('2026-09-14T03:30:00.000Z');
/** 12:00 IST on Monday 21 September 2026 — a week later, so the first has fired. */
const NOW = new Date('2026-09-21T06:30:00.000Z');
/** The Monday after `NOW`. */
const EXPECTED_NEXT = '2026-09-28T03:30:00.000Z';

const WEEKLY = 'FREQ=WEEKLY;BYDAY=MO';
const ZONE = 'Asia/Kolkata';

describe('resolvedReminderAt — when the reminder is actually next due', () => {
	it('leaves a one-shot reminder exactly where it was stored', () => {
		const at = resolvedReminderAt({ triggerAt: FIRST, repeatRule: null, timezone: ZONE }, NOW);
		expect(at.toISOString()).toBe(FIRST.toISOString());
	});

	it('leaves a recurring reminder alone while its first occurrence is still ahead', () => {
		const at = resolvedReminderAt({ triggerAt: FIRST, repeatRule: WEEKLY, timezone: ZONE }, new Date('2026-09-07T00:00:00.000Z'));
		expect(at.toISOString()).toBe(FIRST.toISOString());
	});

	it('advances a weekly rule to its next occurrence once the stored time has passed', () => {
		const at = resolvedReminderAt({ triggerAt: FIRST, repeatRule: WEEKLY, timezone: ZONE }, NOW);
		expect(at.toISOString()).toBe(EXPECTED_NEXT);
	});

	it('never throws for a rule it cannot parse, and keeps the stored time instead', () => {
		// This runs in front of every turn, so a bad rule must cost a stale
		// timestamp rather than the whole grounding block.
		for (const bad of ['EVERY MONDAY', 'FREQ=WEEKLY;BYDAY=XX', 'nonsense', 'FREQ=MONTHLY;BYMONTHDAY=0']) {
			const at = resolvedReminderAt({ triggerAt: FIRST, repeatRule: bad, timezone: ZONE }, NOW);
			expect(at.toISOString(), `rule ${JSON.stringify(bad)}`).toBe(FIRST.toISOString());
		}
	});

	it('never throws for an unusable timezone either', () => {
		const at = resolvedReminderAt({ triggerAt: FIRST, repeatRule: WEEKLY, timezone: 'Not/AZone' }, NOW);
		expect(at.toISOString()).toBe(FIRST.toISOString());
	});

	it('falls back to the caller timezone when the row has none', () => {
		const at = resolvedReminderAt({ triggerAt: FIRST, repeatRule: WEEKLY }, NOW);
		expect(at.toISOString()).toBe(EXPECTED_NEXT);
	});
});

describe('buildUserContext — a live recurring reminder is upcoming, not missed', () => {
	const ROW = {
		id: 'rem-weekly',
		title: 'Standup with the team',
		triggerAt: FIRST,
		dismissed: false,
		repeatRule: WEEKLY,
		timezone: ZONE,
	};

	it('classifies it as upcoming and renders the next occurrence with the rule', async () => {
		vi.mocked(getDb).mockReturnValue(makeDb({ reminders: [ROW] }));

		const context = await buildUserContext('user-1', {}, NOW);

		expect(context.facts.pastReminders).toEqual([]);
		expect(context.facts.upcomingReminders.map((r) => r.id)).toEqual(['rem-weekly']);
		expect(context.facts.nextReminder?.id).toBe('rem-weekly');

		// The model must be able to see both *when* it is next due and that it repeats.
		expect(context.text).toContain('28 Sep');
		expect(context.text).not.toContain('14 Sep');
		expect(context.text).toContain('repeats');
		expect(context.text).toContain('Standup with the team');
	});

	it('still reports a genuinely missed one-shot reminder as missed', async () => {
		// The regression guard for the change: a one-shot reminder in the past must
		// keep landing in `pastReminders`, which is what the briefing counts.
		vi.mocked(getDb).mockReturnValue(
			makeDb({
				reminders: [{ id: 'rem-once', title: 'Pay the plumber', triggerAt: FIRST, dismissed: false, repeatRule: null, timezone: ZONE }],
			}),
		);

		const context = await buildUserContext('user-1', {}, NOW);

		expect(context.facts.pastReminders.map((r) => r.id)).toEqual(['rem-once']);
		expect(context.facts.upcomingReminders).toEqual([]);
		expect(context.text).toContain('14 Sep');
		expect(context.text).not.toContain('repeats');
	});
});
