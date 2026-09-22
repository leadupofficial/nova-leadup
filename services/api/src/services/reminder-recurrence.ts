/**
 * NOVA API — how a repeating reminder is written down, and when it next comes due.
 *
 * §14 of the acceptance criteria requires "Remind me every Monday" to work. The
 * column for it (`reminders.repeat_rule`) and the REST schema accepting it both
 * existed; nothing read either, the assistant had no field for it, and the
 * executor wrote `null` on every insert. This module is the missing half: one
 * definition of the stored format, one parser that refuses anything else, and one
 * pure function that says when the rule next fires.
 *
 * ## The stored format
 *
 * A rule is a **subset of an iCalendar RRULE**: `FREQ` plus optional `INTERVAL`,
 * and exactly one of `BYDAY` (a single weekday) or `BYMONTHDAY` (a day of the
 * month), in that order when it is written back out:
 *
 *     FREQ=DAILY
 *     FREQ=DAILY;INTERVAL=3
 *     FREQ=WEEKLY;BYDAY=MO
 *     FREQ=WEEKLY;INTERVAL=2;BYDAY=SU
 *     FREQ=MONTHLY;BYMONTHDAY=15
 *     FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1
 *
 * RRULE was chosen over an invented syntax because it is already one, widely
 * documented, single-line and free text — and `repeat_rule` is a `text` column in
 * a row whose other consumers (the REST route, the mobile client) only ever store
 * and forward it. Parsing is case-insensitive on the keys and the values so
 * `freq=weekly;byday=mo` is accepted, and the value stored is always the
 * canonical uppercase spelling above. Everything else is refused with a message
 * that names the part that was wrong: an uninterpretable rule stored in the
 * column is worse than a refusal, because the phone would arm nothing and say
 * nothing.
 *
 * It is deliberately **not** a conforming RRULE implementation, and the two
 * deviations are the ones a reader would otherwise assume the other way:
 *
 *  * only a *single* `BYDAY` weekday is accepted (`BYDAY=MO,WE` is refused), and
 *    there is no `BYSETPOS`, so "the last Friday" is not expressible;
 *  * `BYMONTHDAY=31` does not fire in a month that has no 31st. RFC 5545 skips
 *    such months and so does this — see [nextOccurrence] for why the alternative
 *    (clamping to the last day of a short month) would put this function at odds
 *    with the alarm the phone actually arms.
 *
 * ## Why the arithmetic is not `start + n × 86_400_000`
 *
 * "Every Monday" is a wall-clock promise, and calendars are not arithmetic. A day
 * is 23 or 25 hours long across a DST change, February has 28 or 29 days, and a
 * :30 offset (Asia/Kolkata, the default user zone here) hides an off-by-30-minutes
 * bug behind any assertion written at :00. Every candidate below is therefore
 * built as a **wall-clock date and time in the reminder's own zone** and only then
 * converted to an instant, which is what keeps 09:00 meaning 09:00 to the person
 * who asked for it.
 */

/** The three frequencies this vocabulary covers. */
export type RepeatFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

/** The two-letter weekday codes RRULE uses, in RRULE's own order. */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * The longest interval a rule may name.
 *
 * A year of weeks, which is already a strange way to say "yearly" — the point of
 * the ceiling is that `INTERVAL=10000` is a typo or a probe, not a request, and it
 * must not become a row that never fires.
 */
export const MAX_REPEAT_INTERVAL = 52;

/** Matches the `.max()` on the tool's own schema, so the two cannot drift. */
export const MAX_REPEAT_RULE_LENGTH = 120;

/** The accepted forms, quoted in every refusal so the model can retry unaided. */
export const REPEAT_RULE_FORMS =
	'"FREQ=DAILY", "FREQ=WEEKLY;BYDAY=MO" or "FREQ=MONTHLY;BYMONTHDAY=15"';

/** A parsed rule. `interval` is always ≥ 1; exactly one selector is present. */
export interface ReminderRecurrence {
	readonly frequency: RepeatFrequency;
	readonly interval: number;
	/** Required by WEEKLY, absent otherwise. */
	readonly byDay?: Weekday;
	/** Required by MONTHLY (1–31), absent otherwise. */
	readonly byMonthDay?: number;
}

/** Either a rule or the reason it is not one. */
export type RepeatRuleParse =
	| { ok: true; rule: ReminderRecurrence }
	| { ok: false; error: string };

const ALLOWED_KEYS = 'FREQ, INTERVAL, BYDAY and BYMONTHDAY';

const FREQUENCIES: readonly RepeatFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY'];

/**
 * Reads [raw] as a recurrence, or explains why it is not one.
 *
 * The error text is written for the model, not for a log: it names the offending
 * part and the accepted forms so the retry is mechanical rather than a guess.
 */
export function parseRepeatRule(raw: string): RepeatRuleParse {
	if (typeof raw !== 'string' || !raw.trim()) {
		return { ok: false, error: 'the repeat rule is empty' };
	}
	const text = raw.trim();
	if (text.length > MAX_REPEAT_RULE_LENGTH) {
		return {
			ok: false,
			error: `the repeat rule is longer than ${MAX_REPEAT_RULE_LENGTH} characters`,
		};
	}

	const parts = new Map<string, string>();
	for (const chunk of text.split(';')) {
		const part = chunk.trim();
		if (!part) return { ok: false, error: 'the repeat rule has an empty part' };
		const equals = part.indexOf('=');
		if (equals < 0) {
			return { ok: false, error: `"${part}" is not a KEY=VALUE part — use one of ${REPEAT_RULE_FORMS}` };
		}
		const key = part.slice(0, equals).trim().toUpperCase();
		const value = part.slice(equals + 1).trim();
		if (parts.has(key)) {
			return { ok: false, error: `${key} appears more than once in the repeat rule` };
		}
		parts.set(key, value);
	}

	for (const key of parts.keys()) {
		if (!['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY'].includes(key)) {
			return { ok: false, error: `"${key}" is not part of a repeat rule — only ${ALLOWED_KEYS} may appear` };
		}
	}

	const rawFrequency = (parts.get('FREQ') ?? '').toUpperCase();
	if (!rawFrequency) {
		return { ok: false, error: `the repeat rule has no FREQ — use one of ${REPEAT_RULE_FORMS}` };
	}
	if (!FREQUENCIES.includes(rawFrequency as RepeatFrequency)) {
		return { ok: false, error: `FREQ=${rawFrequency} is not a frequency NOVA can repeat — use DAILY, WEEKLY or MONTHLY` };
	}
	const frequency = rawFrequency as RepeatFrequency;

	let interval = 1;
	const rawInterval = parts.get('INTERVAL');
	if (rawInterval !== undefined) {
		if (!/^\d+$/.test(rawInterval)) {
			return { ok: false, error: `INTERVAL=${rawInterval} is not a whole number of ${frequency === 'DAILY' ? 'days' : frequency === 'WEEKLY' ? 'weeks' : 'months'}` };
		}
		interval = Number(rawInterval);
		if (interval < 1 || interval > MAX_REPEAT_INTERVAL) {
			return { ok: false, error: `INTERVAL=${rawInterval} is outside the range 1–${MAX_REPEAT_INTERVAL}` };
		}
	}

	const rawByDay = parts.get('BYDAY');
	const rawByMonthDay = parts.get('BYMONTHDAY');

	if (frequency === 'WEEKLY') {
		if (rawByMonthDay !== undefined) {
			return { ok: false, error: 'BYMONTHDAY is not used by a WEEKLY rule — use BYDAY with one weekday' };
		}
		if (rawByDay === undefined) {
			return { ok: false, error: 'a WEEKLY rule needs BYDAY (MO, TU, WE, TH, FR, SA or SU) to say which weekday' };
		}
		const day = rawByDay.toUpperCase();
		if (!(WEEKDAYS as readonly string[]).includes(day)) {
			return { ok: false, error: `BYDAY=${rawByDay} is not a weekday — use one of ${WEEKDAYS.join(', ')}` };
		}
		return { ok: true, rule: { frequency, interval, byDay: day as Weekday } };
	}

	if (rawByDay !== undefined) {
		return { ok: false, error: `BYDAY is not used by a ${frequency} rule` };
	}

	if (frequency === 'MONTHLY') {
		if (rawByMonthDay === undefined) {
			return { ok: false, error: 'a MONTHLY rule needs BYMONTHDAY (1–31) to say which day of the month' };
		}
		if (!/^\d+$/.test(rawByMonthDay)) {
			return { ok: false, error: `BYMONTHDAY=${rawByMonthDay} is not a day of the month — use a number from 1 to 31` };
		}
		const day = Number(rawByMonthDay);
		if (day < 1 || day > 31) {
			return { ok: false, error: `BYMONTHDAY=${rawByMonthDay} is not a day of the month — use a number from 1 to 31` };
		}
		return { ok: true, rule: { frequency, interval, byMonthDay: day } };
	}

	return { ok: true, rule: { frequency, interval } };
}

/** The canonical spelling of [rule] — what is written to the column. */
export function formatRepeatRule(rule: ReminderRecurrence): string {
	const parts = [`FREQ=${rule.frequency}`];
	if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
	if (rule.byDay) parts.push(`BYDAY=${rule.byDay}`);
	if (rule.byMonthDay) parts.push(`BYMONTHDAY=${rule.byMonthDay}`);
	return parts.join(';');
}

/** True when a rule's day of the month does not exist in every month. */
export function monthlyDayIsSkippedSomeMonths(rule: ReminderRecurrence): boolean {
	// The 29th is missing only in a non-leap February; the 30th and 31st go more
	// often. Everything below is in every month of every year.
	return rule.frequency === 'MONTHLY' && (rule.byMonthDay ?? 0) >= 29;
}

// ─── Words, for the confirmation the user hears ──────────────────────

const WEEKDAY_NAMES: Record<Weekday, string> = {
	MO: 'Monday',
	TU: 'Tuesday',
	WE: 'Wednesday',
	TH: 'Thursday',
	FR: 'Friday',
	SA: 'Saturday',
	SU: 'Sunday',
};

function ordinal(value: number): string {
	const remainder = value % 100;
	if (remainder >= 11 && remainder <= 13) return `${value}th`;
	switch (value % 10) {
		case 1:
			return `${value}st`;
		case 2:
			return `${value}nd`;
		case 3:
			return `${value}rd`;
		default:
			return `${value}th`;
	}
}

/**
 * The recurrence in words — "every Monday", "every 3 days", "every month on the
 * 31st". It names the rule and nothing else: the sentence around it belongs to
 * the caller, which is where the date and the timezone already live.
 */
export function describeRepeatRule(rule: ReminderRecurrence): string {
	if (rule.frequency === 'DAILY') {
		return rule.interval === 1 ? 'every day' : `every ${rule.interval} days`;
	}
	if (rule.frequency === 'WEEKLY') {
		const day = WEEKDAY_NAMES[rule.byDay ?? 'MO'];
		return rule.interval === 1 ? `every ${day}` : `every ${rule.interval} weeks on ${day}`;
	}
	const day = ordinal(rule.byMonthDay ?? 1);
	return rule.interval === 1
		? `every month on the ${day}`
		: `every ${rule.interval} months on the ${day}`;
}

// ─── Wall-clock ⇄ instant in a named zone ────────────────────────────

/** Cached because constructing an `Intl.DateTimeFormat` is the expensive part. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	let formatter = zoneFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-US', {
			timeZone,
			// `hourCycle: 'h23'` rather than `hour12: false`: the latter is allowed to
			// render midnight as "24" on some ICU builds, which would silently move a
			// rule at 00:00 to the following day.
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
		zoneFormatters.set(timeZone, formatter);
	}
	return formatter;
}

interface ZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

/** The wall clock [instant] reads as in [timeZone]. */
function partsIn(timeZone: string, instant: Date): ZonedParts {
	const parts = formatterFor(timeZone).formatToParts(instant);
	const value = (type: string): number => {
		const part = parts.find((candidate) => candidate.type === type);
		return Number(part?.value ?? '0');
	};
	return {
		year: value('year'),
		month: value('month'),
		day: value('day'),
		hour: value('hour'),
		minute: value('minute'),
		second: value('second'),
	};
}

/** The zone's UTC offset, in minutes, at [instant]. */
function offsetMinutesAt(timeZone: string, instant: Date): number {
	const parts = partsIn(timeZone, instant);
	const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	// Rounded to the minute: every real zone offset is a whole number of them, and
	// rounding absorbs the milliseconds `instant` may carry.
	return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * The instant at which [timeZone]'s clock reads this wall-clock time.
 *
 * Solved rather than looked up: the offset that applies is the offset *at the
 * instant being constructed*, which is the thing being computed. One pass gets
 * the offset at the wall time read as UTC (correct except within one DST shift of
 * a transition), and a second pass corrects it. A wall time that a spring-forward
 * skipped does not exist; it resolves to the instant an hour later, which is what
 * a phone in that zone does with the same input.
 */
function instantFrom(
	timeZone: string,
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
): Date {
	const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
	const firstOffset = offsetMinutesAt(timeZone, new Date(asUtc));
	let timestamp = asUtc - firstOffset * 60_000;
	const settledOffset = offsetMinutesAt(timeZone, new Date(timestamp));
	if (settledOffset !== firstOffset) timestamp = asUtc - settledOffset * 60_000;
	return new Date(timestamp);
}

const MS_PER_DAY = 86_400_000;

/** Days since the epoch of a *calendar* date, as an integer. */
function dayNumber(year: number, month: number, day: number): number {
	return Math.round(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

function dateFromDayNumber(value: number): { year: number; month: number; day: number } {
	const date = new Date(value * MS_PER_DAY);
	return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** 0 = Sunday … 6 = Saturday, matching `Date#getUTCDay`. */
function weekdayOfDayNumber(value: number): number {
	return (((value + 4) % 7) + 7) % 7;
}

const WEEKDAY_INDICES: Record<Weekday, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Monday-based week index, which is what RRULE's implicit `WKST=MO` means. */
function weekIndexOfDayNumber(value: number): number {
	return Math.floor((value + 3) / 7);
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthIndexOf(year: number, month: number): number {
	return year * 12 + (month - 1);
}

function fromMonthIndexOf(value: number): { year: number; month: number } {
	return { year: Math.floor(value / 12), month: (value % 12) + 1 };
}

/**
 * The next instant [rule] comes due, strictly after [after].
 *
 * [start] is the reminder's own `trigger_at` — its first occurrence, and the
 * anchor every interval is counted from (an `INTERVAL=2` weekly rule repeats on
 * alternate weeks measured from the week `start` falls in, not from the epoch).
 * [timezone] is the reminder's stored zone, because "Monday" and "the 15th" are
 * wall-clock facts about a place.
 *
 * The result is strictly after [after]: a rule landing exactly on [after] has
 * already happened, and returning it would re-arm the alarm in the past and end
 * the chain after one occurrence. It is also never before [start]: an occurrence
 * earlier than the reminder's own first fire is not an occurrence of this
 * reminder.
 *
 * **A monthly rule on the 31st skips February.** RFC 5545 skips a month with no
 * such day, and so does this — not because the RFC settles it, but because the
 * phone is what actually fires, and the Android repeat component the client uses
 * (`DAY_OF_MONTH_AND_TIME`) walks forward a day at a time until the day-of-month
 * matches, skipping a short month on its own. Clamping here to 28 February would
 * make this function name an occurrence the device will never deliver. The same
 * is true of the 29th in a non-leap year and the 30th in February.
 *
 * @throws RangeError when [timezone] is not a valid IANA name. Callers validate
 *   it at the boundary (`normalizeTimeZone` in `./assistant-datetime.js`).
 * @throws Error when the rule can never be satisfied — an interval that lands on
 *   the same month every time and a day that month never has, such as
 *   `FREQ=MONTHLY;INTERVAL=12;BYMONTHDAY=31` anchored in February. The assistant
 *   never stores an interval (see `readRepeatRule`), and the one caller wraps this
 *   so a stored rule it cannot resolve costs a sentence, not a turn.
 */
export function nextOccurrence(
	rule: ReminderRecurrence,
	start: Date,
	after: Date,
	timezone: string,
): Date {
	const anchor = partsIn(timezone, start);
	const bound = partsIn(timezone, after);
	const startDay = dayNumber(anchor.year, anchor.month, anchor.day);
	const boundDay = dayNumber(bound.year, bound.month, bound.day);
	const afterMs = after.getTime();
	const startMs = start.getTime();

	const at = (day: number): Date => {
		const date = dateFromDayNumber(day);
		return instantFrom(timezone, date.year, date.month, date.day, anchor.hour, anchor.minute, anchor.second);
	};

	if (rule.frequency === 'DAILY') {
		const elapsedDays = boundDay - startDay;
		// Start from the last whole interval that could still be at or before
		// `after` instead of walking there a day at a time: an `INTERVAL=52` rule
		// must not cost 52 iterations, and a long-past trigger must not either.
		let step = elapsedDays > 0 ? Math.floor(elapsedDays / rule.interval) : 0;
		for (let attempt = 0; attempt < 4; attempt++, step++) {
			const candidate = at(startDay + step * rule.interval);
			if (candidate.getTime() > afterMs) return candidate;
		}
		throw new Error('unreachable: a daily rule always has a next occurrence');
	}

	const startMonth = monthIndexOf(anchor.year, anchor.month);
	const boundMonth = monthIndexOf(bound.year, bound.month);

	if (rule.frequency === 'WEEKLY') {
		const target = WEEKDAY_INDICES[rule.byDay ?? 'MO'];
		const firstWeek = weekIndexOfDayNumber(startDay);
		// The walk starts at whichever comes later — the bound or the reminder's own
		// first occurrence. Starting from the bound alone would step 7 days at a time
		// through however many weeks lie between a trigger set a year ahead and now,
		// and a "next occurrence" that gives up mid-walk is a repeat that never gets
		// armed.
		const from = Math.max(boundDay, startDay);
		// The first candidate day that is at or after `from` and carries the rule's
		// weekday…
		let day = from + ((target - weekdayOfDayNumber(from) + 7) % 7);
		// …advanced to a week the interval actually selects, counted from the week
		// the reminder started in.
		const offset = ((weekIndexOfDayNumber(day) - firstWeek) % rule.interval + rule.interval) % rule.interval;
		if (offset !== 0) day += 7 * (rule.interval - offset);

		for (let attempt = 0; attempt < 3; attempt++, day += 7 * rule.interval) {
			const candidate = at(day);
			const time = candidate.getTime();
			if (time > afterMs && time >= startMs) return candidate;
		}
		throw new Error('unreachable: a weekly rule always has a next occurrence');
	}

	const elapsedMonths = boundMonth - startMonth;
	let monthStep = elapsedMonths > 0 ? Math.floor(elapsedMonths / rule.interval) : 0;
	for (let attempt = 0; attempt < rule.interval + 3; attempt++, monthStep++) {
		const { year, month } = fromMonthIndexOf(startMonth + monthStep * rule.interval);
		const day = rule.byMonthDay ?? 1;
		if (day > daysInMonth(year, month)) continue;
		const candidate = instantFrom(timezone, year, month, day, anchor.hour, anchor.minute, anchor.second);
		const time = candidate.getTime();
		if (time > afterMs && time >= startMs) return candidate;
	}
	throw new Error('unreachable: a monthly rule always has a next occurrence');
}
