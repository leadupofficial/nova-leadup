/**
 * NOVA API — the stored repeat rule and when it next comes due.
 *
 * §14 of the acceptance criteria requires "Remind me every Monday" to work, and
 * the model used to refuse it: *"I can only set it for a specific date and time
 * rather than a recurring schedule."* `reminders.repeat_rule` existed as a column
 * and the REST route accepted it, but nothing read it, so the honest answer was
 * the one the model gave.
 *
 * This file pins the two halves that are easy to get wrong and invisible in a
 * manual test: the **grammar** (a rule is either exactly one of three forms or it
 * is refused, with a message the model can act on) and the **arithmetic** —
 * month ends, a weekly rule across a month boundary, wall-clock times preserved
 * across a DST change, and the strict "after" boundary.
 *
 * IST is a trap here and is deliberately not the only zone under test: it has no
 * DST and a :30 offset, so code that adds 24 hours per "day" and code that adds
 * one calendar day agree, and code that ignores offsets by an hour still looks
 * right at :00. Europe/London and a 00:30 local time are what separate them.
 */
import { describe, expect, it } from 'vitest';
import {
	MAX_REPEAT_INTERVAL,
	describeRepeatRule,
	formatRepeatRule,
	nextOccurrence,
	parseRepeatRule,
} from '../services/reminder-recurrence.js';

/** Parses a rule the test knows is valid, failing loudly if it is not. */
function rule(text: string) {
	const parsed = parseRepeatRule(text);
	if (!parsed.ok) throw new Error(`fixture rule ${text} did not parse: ${parsed.error}`);
	return parsed.rule;
}

/** The next occurrence after [after] for [text], as an ISO instant. */
function next(text: string, start: string, after: string, timezone = 'Asia/Kolkata'): string {
	return nextOccurrence(rule(text), new Date(start), new Date(after), timezone).toISOString();
}

describe('parseRepeatRule — exactly one of three forms, or a clear refusal', () => {
	it.each([
		['FREQ=DAILY', { frequency: 'DAILY', interval: 1 }],
		['FREQ=WEEKLY;BYDAY=MO', { frequency: 'WEEKLY', interval: 1, byDay: 'MO' }],
		['FREQ=MONTHLY;BYMONTHDAY=15', { frequency: 'MONTHLY', interval: 1, byMonthDay: 15 }],
		['FREQ=WEEKLY;INTERVAL=2;BYDAY=SU', { frequency: 'WEEKLY', interval: 2, byDay: 'SU' }],
		['FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1', { frequency: 'MONTHLY', interval: 3, byMonthDay: 1 }],
	])('accepts %s', (text, expected) => {
		const parsed = parseRepeatRule(text);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.rule).toMatchObject(expected);
	});

	it('accepts lower case and normalises it to the canonical spelling', () => {
		// The model is not a formatter. Rejecting `freq=weekly;byday=mo` would be a
		// refusal about punctuation, and the stored rule is rewritten canonically
		// before it reaches the column, so nothing downstream has to care.
		const parsed = parseRepeatRule('freq=weekly;byday=mo');
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(formatRepeatRule(parsed.rule)).toBe('FREQ=WEEKLY;BYDAY=MO');
	});

	it('drops the redundant INTERVAL=1 when it writes the rule back out', () => {
		const parsed = parseRepeatRule('FREQ=DAILY;INTERVAL=1');
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.rule.interval).toBe(1);
		expect(formatRepeatRule(parsed.rule)).toBe('FREQ=DAILY');
	});

	it.each([
		['', /empty|missing/i],
		['   ', /empty|missing/i],
		['DAILY', /FREQ/i],
		['FREQ=', /FREQ/i],
		['FREQ=YEARLY', /DAILY|WEEKLY|MONTHLY/],
		['FREQ=HOURLY', /DAILY|WEEKLY|MONTHLY/],
		// A weekly rule that names no weekday cannot be resolved to an instant.
		['FREQ=WEEKLY', /BYDAY/i],
		// A daily rule that names one is a contradiction, not a stronger rule.
		['FREQ=DAILY;BYDAY=MO', /BYDAY/i],
		['FREQ=MONTHLY', /BYMONTHDAY/i],
		['FREQ=MONTHLY;BYMONTHDAY=0', /BYMONTHDAY/i],
		['FREQ=MONTHLY;BYMONTHDAY=32', /BYMONTHDAY/i],
		['FREQ=MONTHLY;BYMONTHDAY=abc', /BYMONTHDAY/i],
		['FREQ=WEEKLY;BYDAY=XX', /BYDAY/i],
		['FREQ=WEEKLY;BYDAY=MONDAY', /BYDAY/i],
		['FREQ=DAILY;INTERVAL=0', /INTERVAL/i],
		['FREQ=DAILY;INTERVAL=-1', /INTERVAL/i],
		['FREQ=DAILY;INTERVAL=1.5', /INTERVAL/i],
		[`FREQ=DAILY;INTERVAL=${MAX_REPEAT_INTERVAL + 1}`, /INTERVAL/i],
		// Duplicated parts are ambiguous: which one wins is a guess.
		['FREQ=DAILY;FREQ=WEEKLY', /more than once/i],
		['FREQ=DAILY;INTERVAL=2;INTERVAL=3', /more than once/i],
		// The RFC 5545 prefix is not part of this vocabulary.
		['RRULE:FREQ=DAILY', /FREQ/i],
		['FREQ=DAILY;COUNT=5', /COUNT|unexpected/i],
	])('refuses %j with a message that names the offending part', (text, pattern) => {
		const parsed = parseRepeatRule(text);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toMatch(pattern);
	});

	it('refuses a rule too long to be one of the three forms', () => {
		const parsed = parseRepeatRule(`FREQ=DAILY;INTERVAL=${'1'.repeat(200)}`);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.error).toMatch(/long|length|120/i);
	});
});

describe('describeRepeatRule — the words the confirmation says out loud', () => {
	it.each([
		['FREQ=DAILY', 'every day'],
		['FREQ=DAILY;INTERVAL=3', 'every 3 days'],
		['FREQ=WEEKLY;BYDAY=MO', 'every Monday'],
		['FREQ=WEEKLY;INTERVAL=2;BYDAY=SU', 'every 2 weeks on Sunday'],
		['FREQ=MONTHLY;BYMONTHDAY=1', 'every month on the 1st'],
		['FREQ=MONTHLY;BYMONTHDAY=15', 'every month on the 15th'],
		['FREQ=MONTHLY;BYMONTHDAY=22', 'every month on the 22nd'],
		['FREQ=MONTHLY;BYMONTHDAY=31', 'every month on the 31st'],
		['FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=31', 'every 3 months on the 31st'],
	])('%s reads as "%s"', (text, words) => {
		expect(describeRepeatRule(rule(text))).toBe(words);
	});
});

describe('nextOccurrence — the instant a rule next comes due', () => {
	it('advances a daily rule to the same wall-clock time tomorrow (IST, +05:30)', () => {
		// 09:00 in Asia/Kolkata is 03:30Z. A :30 offset is what stops "add 24
		// hours" from being indistinguishable from "add a calendar day".
		expect(
			next('FREQ=DAILY', '2026-03-02T03:30:00.000Z', '2026-03-02T03:30:00.000Z'),
		).toBe('2026-03-03T03:30:00.000Z');
	});

	it('is strictly after: a rule landing exactly on `after` advances', () => {
		// The defect this guards: returning `after` itself means a reminder that
		// fires at 09:00 is rescheduled to 09:00 — i.e. armed in the past — and the
		// chain stops.
		expect(
			next('FREQ=DAILY', '2026-03-02T03:30:00.000Z', '2026-03-02T03:30:00.000Z'),
		).toBe('2026-03-03T03:30:00.000Z');
	});

	it('is strictly after: one millisecond before the first occurrence returns it', () => {
		expect(
			next('FREQ=DAILY', '2026-03-02T03:30:00.000Z', '2026-03-02T03:29:59.999Z'),
		).toBe('2026-03-02T03:30:00.000Z');
	});

	it('returns the start itself when asked for the next one before it begins', () => {
		expect(
			next('FREQ=WEEKLY;BYDAY=MO', '2026-03-02T03:30:00.000Z', '2026-02-20T00:00:00.000Z'),
		).toBe('2026-03-02T03:30:00.000Z');
	});

	it('skips whole intervals rather than stepping one day at a time', () => {
		// every 3 days from Mon 5 Jan 09:00 IST: Tue 6 Jan is not one.
		expect(
			next('FREQ=DAILY;INTERVAL=3', '2026-01-05T03:30:00.000Z', '2026-01-06T00:00:00.000Z'),
		).toBe('2026-01-08T03:30:00.000Z');
	});

	it('keeps the wall clock across a DST change (Europe/London)', () => {
		// 2026-03-29 is the last Sunday of March: the UK moves to BST and the local
		// offset goes +00:00 → +01:00. A 09:00 reminder stays at 09:00 local, so its
		// UTC instant moves by an hour. Adding 86_400_000 ms would fire it at 10:00.
		expect(
			next('FREQ=DAILY', '2026-03-27T09:00:00.000Z', '2026-03-28T09:00:00.000Z', 'Europe/London'),
		).toBe('2026-03-29T08:00:00.000Z');
		// And the day after the change is 09:00 BST again — 08:00Z.
		expect(
			next('FREQ=DAILY', '2026-03-27T09:00:00.000Z', '2026-03-29T08:00:00.000Z', 'Europe/London'),
		).toBe('2026-03-30T08:00:00.000Z');
	});

	it('handles a rule at 00:30 local without drifting to the previous day', () => {
		const start = '2026-01-05T19:00:00.000Z'; // Tue 6 Jan 00:30 IST
		expect(next('FREQ=DAILY', start, start)).toBe('2026-01-06T19:00:00.000Z');
	});

	it('moves a weekly rule to the next week, across a month boundary', () => {
		// Mon 26 Jan 2026 → Mon 2 Feb 2026.
		expect(
			next('FREQ=WEEKLY;BYDAY=MO', '2026-01-26T03:30:00.000Z', '2026-01-27T00:00:00.000Z'),
		).toBe('2026-02-02T03:30:00.000Z');
	});

	it('holds a weekly rule at its weekday, not at "seven days later"', () => {
		// Asked on Tuesday for the Monday just gone, the next Monday is six days
		// away, not seven — "every Monday" is a weekday, not an interval.
		expect(
			next('FREQ=WEEKLY;BYDAY=MO', '2026-03-02T03:30:00.000Z', '2026-03-03T00:00:00.000Z'),
		).toBe('2026-03-09T03:30:00.000Z');
	});

	it('honours a two-week interval anchored at the first occurrence', () => {
		expect(
			next('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', '2026-01-05T03:30:00.000Z', '2026-01-06T00:00:00.000Z'),
		).toBe('2026-01-19T03:30:00.000Z');
		// And the week in between is not an occurrence.
		expect(
			next('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', '2026-01-05T03:30:00.000Z', '2026-01-12T00:00:00.000Z'),
		).toBe('2026-01-19T03:30:00.000Z');
	});

	it('moves a monthly rule to the same day of the next month', () => {
		expect(
			next('FREQ=MONTHLY;BYMONTHDAY=15', '2026-01-15T03:30:00.000Z', '2026-01-20T00:00:00.000Z'),
		).toBe('2026-02-15T03:30:00.000Z');
	});

	it('skips February for a monthly rule on the 31st', () => {
		// The decision, and the reason for it: the phone arms the repeat through
		// Android's `DAY_OF_MONTH_AND_TIME` component, which walks forward a day at a
		// time until the day-of-month matches — so the device itself skips a month
		// that has no 31st. Clamping this function to 28 February would make the
		// server's answer disagree with the alarm actually armed on the phone, and
		// invent an occurrence the user never gets.
		expect(
			next('FREQ=MONTHLY;BYMONTHDAY=31', '2026-01-31T03:30:00.000Z', '2026-02-01T00:00:00.000Z'),
		).toBe('2026-03-31T03:30:00.000Z');
	});

	it('skips February for a monthly rule on the 29th in a non-leap year', () => {
		expect(
			next('FREQ=MONTHLY;BYMONTHDAY=29', '2027-01-29T03:30:00.000Z', '2027-02-01T00:00:00.000Z'),
		).toBe('2027-03-29T03:30:00.000Z');
	});

	it('keeps a monthly rule on the 29th in a leap year', () => {
		// 2028 is a leap year, so February has a 29th and nothing is skipped.
		expect(
			next('FREQ=MONTHLY;BYMONTHDAY=29', '2028-01-29T03:30:00.000Z', '2028-02-01T00:00:00.000Z'),
		).toBe('2028-02-29T03:30:00.000Z');
	});

	it('honours a monthly interval across a year boundary', () => {
		expect(
			next('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10', '2026-10-10T03:30:00.000Z', '2026-11-01T00:00:00.000Z'),
		).toBe('2027-01-10T03:30:00.000Z');
	});

	it("resolves the recurrence in the reminder's own zone, not the server's", () => {
		// One instant, one rule, two zones — and a different next occurrence, because
		// "Tuesday" is a wall-clock fact. 2026-01-05T18:30Z is Tuesday 00:00 in
		// Asia/Kolkata and Monday 13:30 in New York, so the next Tuesday after it is
		// a week away in one zone and tomorrow in the other.
		const start = '2026-01-05T18:30:00.000Z';
		expect(next('FREQ=DAILY', start, start, 'Asia/Kolkata')).toBe('2026-01-06T18:30:00.000Z');
		expect(next('FREQ=DAILY', start, start, 'America/New_York')).toBe('2026-01-06T18:30:00.000Z');
		expect(next('FREQ=WEEKLY;BYDAY=TU', start, start, 'Asia/Kolkata')).toBe(
			'2026-01-12T18:30:00.000Z',
		);
		expect(next('FREQ=WEEKLY;BYDAY=TU', start, start, 'America/New_York')).toBe(
			'2026-01-06T18:30:00.000Z',
		);
	});
});
