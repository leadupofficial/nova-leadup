/**
 * NOVA API — date and timezone handling for the assistant's write tools.
 *
 * The model produces date-times as text. Two things have to be true before
 * those strings touch the database:
 *
 *   1. A value with no UTC offset ("2026-09-19T17:00:00") must be read in the
 *      *user's* timezone, not the server's. `new Date("...")` silently uses the
 *      server locale, so a naive value is resolved here instead.
 *   2. The result must be a real instant. Anything unparseable is rejected, and
 *      the caller turns that into a tool error rather than a bad row.
 */
import { USER_TIMEZONE } from './user-context.js';

export { USER_TIMEZONE };

/** `Z`, `+05:30`, `+0530` — the string already carries its own offset. */
const EXPLICIT_OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/** `2026-09-19`, `2026-09-19 17:00`, `2026-09-19T17:00:00` — a wall clock. */
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/;

/**
 * Only unambiguous aliases. Everything else must be a real IANA zone name —
 * "BST" and "CST" are deliberately absent because they mean different things
 * in different places, and guessing would silently move a reminder.
 */
const TIMEZONE_ALIASES: Record<string, string> = {
	ist: 'Asia/Kolkata',
	'asia/calcutta': 'Asia/Kolkata',
	utc: 'UTC',
	gmt: 'UTC',
};

/** Returns the canonical zone name, or null when the zone is not recognised. */
export function normalizeTimeZone(timeZone: string): string | null {
	const value = timeZone.trim();
	const aliased = TIMEZONE_ALIASES[value.toLowerCase()] ?? value;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: aliased });
		return aliased;
	} catch {
		return null;
	}
}

/** The zone's UTC offset, in ms, at the given instant. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour12: false,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(new Date(epochMs));
	const read = (type: string): number => {
		const part = parts.find((p) => p.type === type);
		return part ? Number(part.value) : 0;
	};
	const asUtc = Date.UTC(
		read('year'),
		read('month') - 1,
		read('day'),
		read('hour') % 24, // some ICU builds render midnight as "24"
		read('minute'),
		read('second'),
	);
	return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * A wall-clock time in `timeZone` as a real instant.
 *
 * Two passes: guess with the offset at the guessed instant, then re-read the
 * offset at the corrected instant. That is what makes zones with daylight
 * saving resolve correctly (a naive "09:00" in New York is 13:00 UTC in July
 * and 14:00 UTC in January).
 */
function wallClockToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	timeZone: string,
): Date {
	const guess = Date.UTC(year, month - 1, day, hour, minute, second);
	const firstOffset = zoneOffsetMs(guess, timeZone);
	const settledOffset = zoneOffsetMs(guess - firstOffset, timeZone);
	return new Date(guess - settledOffset);
}

/**
 * Parses a date-time the model produced.
 *
 * An explicit offset (`+05:30`, `Z`) is honoured exactly as given. A naive wall
 * clock is resolved in `timeZone`. A bare date resolves to midnight local to
 * that zone. Returns null when the value is not a date at all.
 */
export function parseDateTime(value: string, timeZone: string): Date | null {
	const raw = value.trim();
	if (!raw) return null;

	if (EXPLICIT_OFFSET_RE.test(raw)) {
		const withOffset = new Date(raw);
		return Number.isNaN(withOffset.getTime()) ? null : withOffset;
	}

	const wallClock = WALL_CLOCK_RE.exec(raw);
	if (wallClock) {
		const [, year, month, day, hour, minute, second] = wallClock;
		return wallClockToUtc(
			Number(year),
			Number(month),
			Number(day),
			Number(hour ?? 0),
			Number(minute ?? 0),
			Number(second ?? 0),
			timeZone,
		);
	}

	const fallback = new Date(raw);
	return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Renders an instant in a zone, matching the grounding block's format.
 *
 * The year is included on purpose. Without it this rendered "Mon 21 Sept,
 * 02:54 pm", and a model asked to correct a past reminder read that as *some*
 * 21 September — it retried with another 2025 date every time and the turn
 * ended with the loop capped. A wall-clock time the model is told to recompute
 * from is only usable if the year is in it.
 */
export function formatInZone(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone,
		weekday: 'short',
		day: '2-digit',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: true,
	}).format(date);
}
