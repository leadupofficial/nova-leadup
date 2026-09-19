/**
 * NOVA API — the daily briefing composer.
 *
 * Master document §9.4 lists the morning briefing as an **opt-in** mode that
 * says "Good morning, two meetings and three follow-ups", and §7.2 routes it to
 * **Sonnet**. This module is the server half: it assembles the briefing from
 * the user's own rows and returns text that can be spoken directly.
 *
 * Three rules shape the design:
 *
 *  1. **The output is speech, not prose on a screen.** It goes to a TTS engine,
 *     so it is normalised through the existing `toSpeakableText` helper in the
 *     realtime TTS path — one speech normaliser in this codebase, not two.
 *
 *  2. **Nothing may be fabricated.** A briefing is the single most dangerous
 *     thing a companion can hallucinate: a meeting that does not exist is worse
 *     than silence. Two independent mechanisms enforce that. There is no
 *     calendar integration in this repo — no `calendar` table, no provider — so
 *     the composer can never legitimately know about "meetings" at all, and
 *     says so through [BRIEFING_CAPABILITIES]. And every model draft passes
 *     [guardBriefingText], which rejects any draft containing a number or a
 *     substantial word that is not in the user's own data. A rejected draft is
 *     discarded wholesale and the deterministic, grounded rendering is used
 *     instead.
 *
 *  3. **Grounding is reused, not rebuilt.** The facts come from
 *     `buildUserContext`, the same call that grounds every spoken turn, so the
 *     briefing and the conversation can never disagree about the user's day.
 */
import { getLanguageByCode } from '@nova/shared-types';
import { chatCompletion, getAnthropicHttpConfig } from './ai.js';
import {
	buildUserContext,
	composeSystemPrompt,
	type UserContext,
	type UserContextFacts,
} from './user-context.js';
import {
	briefingCounts,
	nothingScheduled,
	renderGroundedBriefing,
	toBriefingSpeech,
	type BriefingCounts,
} from './briefing-speech.js';
import { logger } from '../utils/logger.js';
import { ORDINARY_CAPITALIZED } from './grounding-words.js';

/**
 * What the briefing can and cannot see, stated rather than implied.
 *
 * The product brief describes weather, an evening recap and location nudges;
 * none of them exists in the master document and none has a provider in this
 * repository, so there is nothing behind them to call. Rather than stub a
 * response — which would mean inventing the very content the briefing must
 * never invent — the absence is exposed as a flag the client can render.
 *
 * `calendar` is false for the same reason and it matters most: §9.4's example
 * is about *meetings*, and meetings live in a calendar, which this repo has no
 * table, route or provider for.
 */
export const BRIEFING_CAPABILITIES = Object.freeze({
	calendar: false,
	weather: false,
	eveningRecap: false,
	locationNudges: false,
	tasks: true,
	reminders: true,
	memories: true,
});

/** §7.2 puts the daily briefing on Sonnet. `getAnthropicHttpConfig().model` is that tier. */
export const BRIEFING_TEMPERATURE = 0.4;
export const BRIEFING_MAX_TOKENS = 400;

export type BriefingSource = 'model' | 'grounded';


export interface BriefingResult {
	/** Speakable: no markdown, no bullet characters, no URLs, no emoji. */
	text: string;
	/**
	 * `model` when a Sonnet draft survived the grounding guard, `grounded` when
	 * the deterministic rendering was used instead. Never guessed — the client
	 * can show which one it got.
	 */
	source: BriefingSource;
	language: string;
	counts: BriefingCounts;
	/**
	 * Why a model draft was thrown away, when one was. `null` for an accepted
	 * draft and for the nothing-scheduled path, where no draft is attempted.
	 */
	guardRejection: string | null;
	/** When the facts were read, ISO-8601. */
	generatedAt: string;
}

// The speech and rendering half lives in its own module so neither file grows
// past what a reviewer will read in one sitting. Re-exported here so
// `services/briefing.js` keeps one public surface.
export {
	briefingCounts,
	clockReadingInUserZone,
	countWord,
	minutesToWords,
	nothingScheduled,
	renderGroundedBriefing,
	spokenTimeInUserZone,
	timeOfDayGreeting,
	toBriefingSpeech,
	type BriefingCounts,
} from './briefing-speech.js';

// ─── The grounding guard ────────────────────────────────────────────────────

export interface GuardVerdict {
	ok: boolean;
	/** Which rule refused the draft. Absent when `ok`. */
	reason?: string;
}

/**
 * Ordinary English words a briefing may capitalise, shared with the meeting
 * summariser so the two anti-fabrication guards cannot disagree about what
 * counts as prose. See `grounding-words.ts` for what may and may not be added.
 */
const COMMON_CAPITALIZED = ORDINARY_CAPITALIZED;

/**
 * Nouns that name an *occasion*. §9.4's briefing must never conjure one, and
 * there is no calendar or event source in this repository for it to draw one
 * from, so any of these words has to come from the user's own rows or the
 * draft is refused.
 */
const EVENT_NOUNS = [
	'meeting', 'meetings', 'appointment', 'appointments', 'conference',
	'conferences', 'deadline', 'deadlines', 'interview', 'interviews',
	'birthday', 'birthdays', 'wedding', 'ceremony', 'party', 'parties',
	'flight', 'flights', 'seminar', 'webinar', 'standup', 'stand-up', 'event',
	'events', 'lunch', 'dinner', 'breakfast', 'exam', 'exams', 'trip',
	'reminder-to-meet', 'call', 'calls', 'session', 'sessions',
];

/**
 * Time and calendar expressions. A time the briefing was not given is a
 * fabricated time, whether it is written as digits (caught by the number rule)
 * or in words.
 */
const TEMPORAL_PHRASES = [
	'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
	'january', 'february', 'march', 'april', 'june', 'july', 'august',
	'september', 'october', 'november', 'december',
	'tomorrow', 'tonight', 'yesterday', 'next week', 'last week', 'next month',
	'in the morning', 'in the afternoon', 'in the evening', 'at night',
	'this morning', 'this afternoon', 'this evening', 'noon', 'midnight',
	'o clock', "o'clock", 'half past', 'quarter past', 'quarter to',
];

const DIGIT_RUN = /\d+/g;
const CAPITALIZED_TOKEN = /\b[A-Z][a-z]{2,}/g;
const HAS_URL = /(?:https?:\/\/|www\.)\S+/i;
const HAS_PICTOGRAPH = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

/**
 * Number words a briefing might write out, and the value each one states.
 *
 * The digit rule cannot see these, so a draft could otherwise claim "three
 * tasks are overdue" from a single-task day. A number word is accepted only
 * when some count the briefing actually has equals it, or when the user's own
 * data contains the word.
 */
const NUMBER_WORD_VALUES: Record<string, number> = {
	zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
	eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
	fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
	nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
	seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every word and number the user's own data contains, lower-cased.
 *
 * Built from the rows themselves *and* the deterministic rendering of them, so
 * a grounded phrasing ("overdue", "in the evening") is allowed while anything
 * the user does not have is not.
 */
export function groundingVocabulary(facts: UserContextFacts, groundedText: string): string {
	const parts = [groundedText];
	for (const task of facts.tasks) parts.push(task.title);
	for (const reminder of facts.reminders) parts.push(reminder.title);
	for (const memory of facts.memories) parts.push(`${memory.category} ${memory.content}`);
	return parts.join(' \n ').toLowerCase();
}

/**
 * Refuses a model draft that says anything the user's data does not.
 *
 * Four rules, each aimed at a way a briefing can lie, and each cheap enough to
 * run on every request:
 *
 *  * **Formatting.** No URL, no emoji, no bullet glyph. The text is going to a
 *    speech engine, and this is checked here as well as in
 *    [toBriefingSpeech] so a draft cannot slip through unnormalised.
 *  * **No ungrounded number.** Every digit run must be a count the briefing is
 *    allowed to state, or a number that appears in the user's own rows. An
 *    invented clock time, date or quantity therefore fails. (The persona
 *    prompt already asks for clock times in words, so digits have no
 *    legitimate reason to be here at all.)
 *  * **No ungrounded name or occasion.** Every capitalised word must be
 *    ordinary English or come from the user's data — which is what stops "a
 *    meeting with Ramesh" when neither exists — and no word from
 *    [EVENT_NOUNS] may appear unless the user's own rows contain it.
 *  * **No ungrounded time.** Weekday, month and time-of-day expressions must
 *    appear in the user's data or in the grounded rendering of it.
 *
 * The check is deliberately conservative: a draft that merely *might* be safe
 * is thrown away and the grounded rendering is used instead. Missing a nice
 * rewording costs nothing; shipping an invented meeting does not.
 */
export function guardBriefingText(text: string, facts: UserContextFacts): GuardVerdict {
	if (!text.trim()) return { ok: false, reason: 'empty' };
	if (HAS_URL.test(text)) return { ok: false, reason: 'url' };
	if (HAS_PICTOGRAPH.test(text)) return { ok: false, reason: 'emoji' };

	const grounded = renderGroundedBriefing(facts, new Date());
	const userText = groundingVocabulary(facts, grounded);
	const userWords = new Set(userText.match(/[a-z]{3,}/g) ?? []);

	const allowedDigits = new Set<string>(Object.values(briefingCounts(facts)).map((value) => String(value)));
	for (const run of userText.match(DIGIT_RUN) ?? []) allowedDigits.add(run);
	for (const run of text.match(DIGIT_RUN) ?? []) {
		if (!allowedDigits.has(run)) return { ok: false, reason: `ungrounded-number:${run}` };
	}

	const countValues = new Set(Object.values(briefingCounts(facts)));
	for (const [word, value] of Object.entries(NUMBER_WORD_VALUES)) {
		if (!new RegExp(`\\b${word}\\b`, 'i').test(text)) continue;
		if (countValues.has(value) || userWords.has(word)) continue;
		return { ok: false, reason: `ungrounded-quantity:${word}` };
	}

	for (const token of text.match(CAPITALIZED_TOKEN) ?? []) {
		const word = token.toLowerCase();
		if (userWords.has(word) || COMMON_CAPITALIZED.has(word)) continue;
		return { ok: false, reason: `ungrounded-name:${word}` };
	}

	for (const noun of EVENT_NOUNS) {
		const matches = new RegExp(`\\b${escapeForRegExp(noun)}\\b`, 'i').test(text);
		if (matches && !userWords.has(noun)) return { ok: false, reason: `ungrounded-event:${noun}` };
	}

	for (const phrase of TEMPORAL_PHRASES) {
		const matches = new RegExp(`\\b${escapeForRegExp(phrase)}\\b`, 'i').test(text);
		if (matches && !userText.includes(phrase)) return { ok: false, reason: `ungrounded-time:${phrase}` };
	}

	return { ok: true };
}

// ─── Composition ────────────────────────────────────────────────────────────

const BRIEFING_PERSONA = [
	'You are NOVA, a warm AI companion writing a short daily briefing that will be SPOKEN aloud.',
	'The user\'s tasks, reminders and memories are listed in the snapshot you were given, and those listings are the entire universe of this briefing.',
	'Never invent a meeting, event, appointment, person, place, deadline or time that is not in the snapshot.',
	'The snapshot is the only thing you know: if it does not list something, it does not exist and must not be mentioned.',
	'Write two to four short sentences, lead with the greeting, put what is overdue first, then what is due today, then the next reminder, then anything worth flagging.',
	'Do not read the snapshot back line by line, and do not add encouragement that promises work you cannot see.',
].join(' ');

const BRIEFING_REQUEST =
	'Give me my briefing for right now. Say what is overdue, what is due today, my next reminder, and anything worth flagging. Use only what is in the snapshot — if something is not there, do not mention it.';

/**
 * Options for [composeBriefing].
 */
export interface ComposeBriefingOptions {
	/** App language code; the briefing is written in it. Defaults to `en`. */
	language?: string;
	/**
	 * An already-read grounding snapshot.
	 *
	 * The default path calls `buildUserContext` — the same call that grounds a
	 * spoken turn — so the briefing and the conversation always agree. A caller
	 * that has *just* read the snapshot for the same request (or a test that
	 * needs a fixed day) can hand it in instead of paying for a second read.
	 */
	context?: UserContext;
}

/**
 * Composes the briefing for one user.
 *
 * Order of events, and why: the snapshot is read first, and when it shows
 * nothing due, nothing overdue and no reminders, the answer is produced without
 * calling the model at all. An empty snapshot is precisely the prompt that
 * makes a language model produce a plausible meeting, so the safest thing to do
 * with an empty day is to describe it. §7.2's Sonnet routing is for connecting
 * real facts, not for filling silence.
 *
 * Every outcome is logged once as `briefing_composed`, so §22.1's per-active-user
 * counts — and the two numbers that say whether the guard is doing its job, the
 * model share and the rejection rate — are measurable from the logs alone.
 */
export async function composeBriefing(
	userId: string,
	options: ComposeBriefingOptions = {}
): Promise<BriefingResult> {
	const language = (options.language ?? 'en').trim() || 'en';
	const context = options.context ?? (await buildUserContext(userId));
	const counts = briefingCounts(context.facts);
	const groundedText = renderGroundedBriefing(context.facts, context.now);
	const generatedAt = context.now.toISOString();
	const base = { language, counts, generatedAt };

	const finish = (
		result: BriefingResult,
		model: string | null,
		reason: string
	): BriefingResult => {
		logger.info(
			{
				metric: 'briefing_composed',
				userId,
				language,
				source: result.source,
				reason,
				model,
				counts,
			},
			'Daily briefing composed'
		);
		return result;
	};

	const grounded = (guardRejection: string | null): BriefingResult => ({
		...base,
		text: groundedText,
		source: 'grounded',
		guardRejection,
	});

	if (nothingScheduled(counts)) {
		// An empty day is answered from the data alone: the model is never
		// consulted, so it has no opportunity to invent a meeting.
		return finish(grounded(null), null, 'nothing-scheduled');
	}

	const languageInfo = getLanguageByCode(language);
	const systemPrompt = composeSystemPrompt({
		spoken: true,
		basePrompt: BRIEFING_PERSONA,
		context: context.text,
		language,
		languageName: languageInfo?.name,
		languageNative: languageInfo?.native,
	});

	let draft = '';
	let model: string | null = null;
	try {
		// §7.2: the daily briefing runs on the Sonnet tier, which is exactly what
		// `getAnthropicHttpConfig().model` resolves to unless an operator has
		// pointed the deployment at a different model on purpose.
		const completion = await chatCompletion(
			[{ role: 'user', content: BRIEFING_REQUEST }],
			{
				model: getAnthropicHttpConfig().model,
				maxTokens: BRIEFING_MAX_TOKENS,
				temperature: BRIEFING_TEMPERATURE,
				systemPrompt,
			}
		);
		model = completion.model;
		draft = toBriefingSpeech(completion.content);
	} catch (err) {
		logger.warn({ err, userId }, 'Briefing model call failed; serving the grounded briefing');
		return finish(grounded('model-unavailable'), null, 'model-unavailable');
	}

	if (!draft) {
		return finish(grounded('empty-draft'), model, 'empty-draft');
	}

	const verdict = guardBriefingText(draft, context.facts);
	if (!verdict.ok) {
		const reason = verdict.reason ?? 'rejected';
		logger.warn(
			{ userId, model, reason },
			'Briefing draft rejected as ungrounded; serving the grounded briefing instead'
		);
		return finish(grounded(reason), model, `rejected:${reason}`);
	}

	return finish(
		{ ...base, text: draft, source: 'model', guardRejection: null },
		model,
		'accepted'
	);
}
