/**
 * NOVA API — turning a briefing into something a voice can read.
 *
 * Two jobs, both pure and both testable without a database:
 *
 *  1. **Normalisation.** Nothing reaches a speech engine except through
 *     [toBriefingSpeech], which delegates the markdown/whitespace handling to
 *     the realtime TTS path's own `toSpeakableText` and adds what a briefing
 *     needs on top: URLs, emoji and bullet glyphs.
 *  2. **The grounded rendering.** [renderGroundedBriefing] writes the briefing
 *     directly from the user's rows. Every sentence is a function of a fact, so
 *     it cannot describe something the user does not have — which is why it is
 *     both the fallback when a model draft is refused and the answer to an
 *     empty day.
 */
import { USER_TIMEZONE, type UserContextFacts } from './user-context.js';
import { toSpeakableText } from '../realtime/tts.js';

export interface BriefingCounts {
	overdue: number;
	dueToday: number;
	later: number;
	undated: number;
	upcomingReminders: number;
	missedReminders: number;
	memories: number;
}

// ─── Speech normalisation ───────────────────────────────────────────────────

const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/gi;
/** Emoji, pictographs, dingbats and the zero-width joiner that binds them. */
const PICTOGRAPH = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;
/** `toSpeakableText` strips `*`; these are the rest of the bullet family. */
const BULLET_CHARACTERS = /[•·▪▫◦‣⁃]/g;

/**
 * The one normaliser every briefing path goes through.
 *
 * It deliberately delegates the markdown/whitespace/clock handling to
 * `toSpeakableText` (the realtime TTS path's helper) so a briefing and a spoken
 * reply are cleaned up by the same rules, and adds only what a briefing needs
 * on top: URLs, emoji and bullet glyphs — none of which any speech engine
 * should be handed, and any of which can legitimately arrive from a task title
 * the user typed themselves.
 */
export function toBriefingSpeech(text: string): string {
	const flattened = text
		.replace(URL_LIKE, ' ')
		.replace(PICTOGRAPH, ' ')
		.replace(BULLET_CHARACTERS, ' ');
	return toSpeakableText(flattened);
}

// ─── Deterministic, grounded rendering ──────────────────────────────────────

const NUMBER_WORDS = [
	'zero', 'one', 'two', 'three', 'four', 'five', 'six',
	'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
];

const HOUR_WORDS = [
	'twelve', 'one', 'two', 'three', 'four', 'five',
	'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
];

const TENS_WORDS = [
	'', '', 'twenty', 'thirty', 'forty', 'fifty',
];

/** `3` → `three` for the counts a briefing ever states; digits beyond twelve. */
export function countWord(n: number): string {
	if (n >= 0 && n < NUMBER_WORDS.length) return NUMBER_WORDS[n];
	return String(n);
}

function plural(n: number, singular: string, pluralForm: string): string {
	return n === 1 ? singular : pluralForm;
}

/** 0-59 as words, so a clock time is never handed to TTS as digits. */
export function minutesToWords(minutes: number): string {
	if (minutes === 0) return '';
	if (minutes < 10) return NUMBER_WORDS[minutes];
	if (minutes < 20) return `e${NUMBER_WORDS[minutes].slice(1)}`;
	const tens = TENS_WORDS[Math.floor(minutes / 10)];
	const unit = minutes % 10;
	return unit === 0 ? tens : `${tens} ${NUMBER_WORDS[unit]}`;
}

interface ClockReading {
	hour: number;
	minute: number;
}

/** Reads a wall-clock time in the user's timezone, not the server's. */
export function clockReadingInUserZone(date: Date): ClockReading {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: USER_TIMEZONE,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(date);
	const read = (type: string): number =>
		Number(parts.find((p) => p.type === type)?.value ?? '0');
	return { hour: read('hour'), minute: read('minute') };
}

/** `7:30 pm` becomes "seven thirty in the evening" — a form every voice reads. */
export function spokenTimeInUserZone(date: Date): string {
	const { hour, minute } = clockReadingInUserZone(date);
	const words = minutesToWords(minute);
	const clock = `${HOUR_WORDS[hour % 12]}${words ? ` ${words}` : ''}`;
	const period =
		hour < 12 ? 'in the morning' : hour < 17 ? 'in the afternoon' : hour < 21 ? 'in the evening' : 'at night';
	return `${clock} ${period}`;
}

export function timeOfDayGreeting(now: Date): string {
	const { hour } = clockReadingInUserZone(now);
	if (hour < 12) return 'Good morning';
	if (hour < 17) return 'Good afternoon';
	return 'Good evening';
}

function titleList(titles: string[]): string {
	if (titles.length === 1) return titles[0];
	if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
	return `${titles.slice(0, -1).join(', ')}, and ${titles[titles.length - 1]}`;
}

/**
 * Upper-cases a sentence's first letter.
 *
 * Sentences that open with a count ("one task is overdue…") would otherwise
 * read as a continuation of the greeting once they are joined.
 */
function sentenceCase(sentence: string): string {
	return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function briefingCounts(facts: UserContextFacts): BriefingCounts {
	return {
		overdue: facts.overdueTasks.length,
		dueToday: facts.dueTodayTasks.length,
		later: facts.laterTasks.length,
		undated: facts.undatedTasks.length,
		upcomingReminders: facts.upcomingReminders.length,
		missedReminders: facts.pastReminders.length,
		memories: facts.memories.length,
	};
}

/** True when the user has nothing the briefing is about. */
export function nothingScheduled(counts: BriefingCounts): boolean {
	return counts.overdue === 0 && counts.dueToday === 0 && counts.upcomingReminders === 0;
}

/**
 * The briefing written only from the user's rows.
 *
 * Every sentence here is a direct function of a fact, so this rendering cannot
 * describe anything the user does not have. It is both the fallback when the
 * model is unavailable or its draft is rejected, and the "nothing scheduled"
 * answer — which is a first-class outcome, not an error.
 */
export function renderGroundedBriefing(facts: UserContextFacts, now: Date): string {
	const sentences: string[] = [`${timeOfDayGreeting(now)}.`];

	if (facts.overdueTasks.length) {
		const n = facts.overdueTasks.length;
		sentences.push(
			`${countWord(n)} ${plural(n, 'task is', 'tasks are')} overdue: ${titleList(facts.overdueTasks.map((t) => t.title))}.`
		);
	}

	if (facts.dueTodayTasks.length) {
		const n = facts.dueTodayTasks.length;
		sentences.push(
			`${countWord(n)} ${plural(n, 'task is', 'tasks are')} due today: ${titleList(facts.dueTodayTasks.map((t) => t.title))}.`
		);
	}

	const next = facts.nextReminder;
	if (next) {
		sentences.push(`Your next reminder is ${next.title} at ${spokenTimeInUserZone(next.triggerAt)}.`);
		const after = facts.upcomingReminders.length - 1;
		if (after > 0) {
			sentences.push(
				`You have ${countWord(after)} more ${plural(after, 'reminder', 'reminders')} after that.`
			);
		}
	}

	if (nothingScheduled(briefingCounts(facts))) {
		sentences.push('Nothing is due today, nothing is overdue, and you have no reminders coming up.');
	}

	if (facts.undatedTasks.length) {
		const n = facts.undatedTasks.length;
		sentences.push(
			`You also have ${countWord(n)} open ${plural(n, 'task', 'tasks')} with no due date: ${titleList(facts.undatedTasks.map((t) => t.title))}.`
		);
	}

	if (facts.pastReminders.length === 1) {
		const missed = facts.pastReminders[0];
		sentences.push(
			`Also worth flagging: ${missed.title} was scheduled for ${spokenTimeInUserZone(missed.triggerAt)} and has not been dismissed.`
		);
	} else if (facts.pastReminders.length > 1) {
		const n = facts.pastReminders.length;
		sentences.push(
			`Also worth flagging: ${countWord(n)} reminders went off earlier and ${plural(n, 'has', 'have')} not been dismissed: ${titleList(facts.pastReminders.map((r) => r.title))}.`
		);
	}

	return sentences.map(sentenceCase).join(' ');
}
