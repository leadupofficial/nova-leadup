/**
 * NOVA API — the meeting-summary grounding guard and its extractive fallback.
 *
 * This is the half of the meeting summariser that decides what may be published
 * at all. It is deliberately separate from the composer in
 * `meeting-summary.ts`, which owns the model call and the persistence shape, so
 * that the safety rules can be read — and tested — without a provider, a
 * database or a network in the room. `briefing.ts` / `briefing-speech.ts` is the
 * same split for the daily briefing.
 *
 * Nothing here calls a model. `groundedMeetingSummary` is the fallback that runs
 * whenever the model's draft is refused or unavailable, and every string it
 * returns is a substring of the transcript or a phrase cut out of one, which is
 * why it cannot introduce a fact.
 */
import { ORDINARY_CAPITALIZED } from './grounding-words.js';
import type { MeetingActionItem, MeetingContact, MeetingSummaryDraft } from './meeting-summary.js';

export interface GuardVerdict {
	ok: boolean;
	/** Which rule refused the draft. Absent when `ok`. */
	reason?: string;
}


// ─── Is there anything to summarise at all? ─────────────────────────────────

/**
 * Markers speech-to-text engines emit for non-speech audio.
 *
 * Deepgram writes `[blank_audio]`; others use parenthesised `(inaudible)` or
 * `[Music]`. They are stripped before the length test so a transcript that is
 * nothing but markers is correctly read as empty.
 */
const NON_SPEECH_MARKER =
	/\[[^\]]{0,40}\]|\([^)]{0,40}\)|♪+|<[^>]{0,40}>/g;

/** Shortest transcript that could plausibly contain a decision. */
export const MIN_TRANSCRIPT_CHARS = 15;
export const MIN_TRANSCRIPT_WORDS = 4;

/**
 * True when [text] is speech a summary could honestly be built from.
 *
 * Deliberately conservative in the safe direction: a thin transcript is treated
 * as no transcript, which costs a summary, rather than being handed to a model
 * that would be asked to pad it out.
 */
export function isMeaningfulTranscript(text: string): GuardVerdict {
	const stripped = text.replace(NON_SPEECH_MARKER, ' ').trim();
	if (!stripped) return { ok: false, reason: 'empty' };

	// Letters in any script NOVA transcribes, so a Tamil-only transcript is not
	// rejected for having no Latin characters.
	const words = stripped.match(/[\p{L}\p{M}]{2,}/gu) ?? [];
	if (stripped.length < MIN_TRANSCRIPT_CHARS) return { ok: false, reason: 'too-short' };
	if (words.length < MIN_TRANSCRIPT_WORDS) return { ok: false, reason: 'too-few-words' };

	const letters = (stripped.match(/[\p{L}]/gu) ?? []).length;
	if (letters / stripped.length < 0.4) return { ok: false, reason: 'not-prose' };

	return { ok: true };
}

// ─── The grounding guard ────────────────────────────────────────────────────

/**
 * Ordinary English words a meeting summary may capitalise.
 *
 * The shared briefing vocabulary plus the words a *written* summary uses that a
 * spoken briefing does not — headings ("Action Items", "Key Takeaways"),
 * reporting verbs, quantifiers, and generic role or collective nouns ("the
 * team", "the client", "stakeholders"). Anything else capitalised that is
 * neither here nor in the transcript is treated as a name the model made up;
 * see `grounding-words.ts` for what may never be added to this list.
 *
 * The collective nouns are the one judgement call. "The Team will…" is generic
 * English, not a claim about a specific organisation, and refusing it (which is
 * what happened before they were listed) threw away entire grounded drafts. A
 * *specific* entity is still caught, because naming one requires a word that is
 * not on this list — "the Acme team" fails on "Acme".
 */
const COMMON_CAPITALIZED: ReadonlySet<string> = new Set([
	...ORDINARY_CAPITALIZED,
	'action', 'actions', 'agreed', 'agreement', 'also', 'although', 'aside',
	'attendees', 'budget', 'client', 'clients', 'closed', 'completed',
	'conclusion', 'contact', 'contacts', 'continued', 'customer', 'customers',
	'deadline', 'deadlines', 'discussion', 'discussions', 'each', 'everyone',
	'follow', 'followed', 'following', 'followup', 'further', 'group', 'groups',
	'highlights', 'however', 'item', 'items', 'key', 'leadership', 'main',
	'management', 'meeting', 'meetings', 'mentioned', 'minutes', 'note',
	'noted', 'notes', 'nothing', 'open', 'outcome', 'outcomes', 'overview',
	'owner', 'participants', 'pending', 'plan', 'points', 'raised', 'recap',
	'review', 'reviewed', 'scheduled', 'several', 'someone', 'stakeholder',
	'stakeholders', 'status', 'summarised', 'summarized', 'takeaway',
	'takeaways', 'team', 'teams', 'topics', 'unassigned', 'undated', 'update',
	'updates', 'various',
]);

/**
 * Pronouns and generic nouns that can never be an action item's owner.
 *
 * The extractive rule below reads "We will drop the fee" as a task with an
 * owner, and "We" is not a person. Excluding a leading ordinary word is the
 * difference between "unassigned" and a wrong name.
 */
function isLikelyOwnerName(word: string): boolean {
	return !COMMON_CAPITALIZED.has(word.toLowerCase());
}

const DIGIT_RUN = /\d+/g;
const CAPITALIZED_TOKEN = /\b[A-Z][a-z]{2,}/g;
const HAS_URL = /(?:https?:\/\/|www\.)\S+/i;
const HAS_PICTOGRAPH = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

export function collapseWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

/** Lower-cased, whitespace-collapsed transcript, for substring grounding tests. */
function groundingText(transcript: string): string {
	return collapseWhitespace(transcript).toLowerCase();
}

/** Every string a draft asks to be published, for the format and number rules. */
function draftStrings(draft: MeetingSummaryDraft): string[] {
	return [
		draft.summary,
		...draft.decisions,
		...draft.actionItems.flatMap((item) => [item.text, item.owner ?? '', item.dueDate ?? '']),
		...draft.contacts.flatMap((contact) => [contact.name ?? '', contact.detail]),
	];
}

export interface GuardOptions {
	/** Words from the transcript that are allowed to appear capitalised. */
	extraAllowedWords?: Iterable<string>;
}

/**
 * Refuses a model draft that says anything the transcript does not.
 *
 * See the module comment for the four rules and why each exists. The check is
 * deliberately conservative: a draft that merely *might* be safe is thrown away
 * and the extractive rendering is used instead. Missing a nice rewording costs
 * nothing; shipping an action item nobody agreed to does not.
 */
export function guardMeetingSummary(
	draft: MeetingSummaryDraft,
	transcript: string,
	options: GuardOptions = {},
): GuardVerdict {
	const groundedText = groundingText(transcript);
	const transcriptWords = new Set(groundedText.match(/[\p{L}\p{M}']{3,}/gu) ?? []);
	for (const word of options.extraAllowedWords ?? []) {
		transcriptWords.add(word.toLowerCase());
	}

	const strings = draftStrings(draft);
	if (!collapseWhitespace(draft.summary)) return { ok: false, reason: 'empty-summary' };

	for (const value of strings) {
		if (HAS_URL.test(value)) return { ok: false, reason: 'url' };
		if (HAS_PICTOGRAPH.test(value)) return { ok: false, reason: 'emoji' };
	}

	// Rule: no number the transcript does not contain. Done on the joined text
	// so a number split across a field boundary cannot slip through.
	const joined = strings.join(' \n ');
	const transcriptDigits = new Set(groundedText.match(DIGIT_RUN) ?? []);
	for (const run of joined.match(DIGIT_RUN) ?? []) {
		if (!transcriptDigits.has(run)) return { ok: false, reason: `ungrounded-number:${run}` };
	}

	// Rule: no name or organisation the transcript does not contain.
	for (const token of joined.match(CAPITALIZED_TOKEN) ?? []) {
		const word = token.toLowerCase();
		if (transcriptWords.has(word) || COMMON_CAPITALIZED.has(word)) continue;
		return { ok: false, reason: `ungrounded-name:${word}` };
	}

	// Rule: an owner must be someone the transcript actually names.
	for (const item of draft.actionItems) {
		if (!item.owner) continue;
		const owner = collapseWhitespace(item.owner).toLowerCase();
		if (!owner || !groundedText.includes(owner)) {
			return { ok: false, reason: `ungrounded-owner:${item.owner}` };
		}
	}

	// Rule: a due date is a phrase copied out of the transcript, never computed.
	for (const item of draft.actionItems) {
		if (!item.dueDate) continue;
		const phrase = collapseWhitespace(item.dueDate).toLowerCase();
		if (!phrase || !groundedText.includes(phrase)) {
			return { ok: false, reason: `ungrounded-due-date:${item.dueDate}` };
		}
	}

	return { ok: true };
}

// ─── The extractive fallback ────────────────────────────────────────────────

const SENTENCE_SPLIT = /(?<=[.!?।])\s+|\n+/;

/** Longest unit the extractive fallback will quote, in words. */
export const MAX_EXTRACTIVE_UNIT_WORDS = 25;

/**
 * Splits a transcript into quotable units.
 *
 * Sentence punctuation is used when the provider supplied it. When it did not —
 * a provider that returns an unpunctuated run of words, which is what Deepgram
 * does unless punctuation is requested — a single 500-word "sentence" would make
 * every cue match the entire transcript and produce useless output, so such a
 * run is cut into word-bounded chunks of [MAX_EXTRACTIVE_UNIT_WORDS]. A chunk is
 * still a substring of the transcript, so nothing here can introduce a fact.
 */
function sentencesOf(transcript: string): string[] {
	const units: string[] = [];
	for (const sentence of collapseWhitespace(transcript).split(SENTENCE_SPLIT)) {
		const trimmed = collapseWhitespace(sentence);
		if (!trimmed) continue;
		const words = trimmed.split(' ');
		if (words.length <= MAX_EXTRACTIVE_UNIT_WORDS) {
			units.push(trimmed);
			continue;
		}
		for (let start = 0; start < words.length; start += MAX_EXTRACTIVE_UNIT_WORDS) {
			units.push(words.slice(start, start + MAX_EXTRACTIVE_UNIT_WORDS).join(' '));
		}
	}
	return units;
}

/** Phrases that introduce a decision, verbatim in the transcript. */
const DECISION_CUES = [
	'we decided', 'we have decided', 'decided to', 'decision is', 'we agreed',
	'agreed to', 'we will go with', "we'll go with", 'finalised', 'finalized',
	'approved', 'settled on', 'conclusion is', 'it is decided',
];

/** Phrases that introduce something someone has to do. */
const ACTION_CUES = [
	'will send', 'will share', 'will prepare', 'will check', 'will follow',
	'will call', 'will draft', 'will review', 'will confirm', 'will update',
	'need to', 'needs to', "i'll", 'we will', 'we need', 'action item',
	'follow up', 'make sure', 'to do', 'take care of', 'get back to',
];

/** Deadline phrases, matched inside a sentence and quoted verbatim. */
const DUE_DATE_PHRASES = [
	'by monday', 'by tuesday', 'by wednesday', 'by thursday', 'by friday',
	'by saturday', 'by sunday', 'by tomorrow', 'by today', 'by tonight',
	'by next week', 'by end of week', 'by end of the week', 'by end of day',
	'by eod', 'before monday', 'before tuesday', 'before wednesday',
	'before thursday', 'before friday', 'next week', 'tomorrow', 'today',
	'end of week', 'end of the month',
];

const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
const CONTACT_CUE_RE =
	/\b(?:contact|call|reach|email|speak to|talk to|follow up with)\s+([A-Z][\p{L}'-]{1,20})/gu;

function firstSentenceMatching(sentences: string[], cues: string[]): string[] {
	const seen = new Set<string>();
	const matches: string[] = [];
	for (const sentence of sentences) {
		const lower = sentence.toLowerCase();
		if (!cues.some((cue) => lower.includes(cue))) continue;
		const key = lower;
		if (seen.has(key)) continue;
		seen.add(key);
		matches.push(sentence);
	}
	return matches;
}

/**
 * A person's name at the start of a task sentence, or null.
 *
 * Only a leading capitalised word that is followed by an action verb counts,
 * and a leading ordinary word ("We", "Please", "Several") is never a person.
 * This is the narrowest possible extraction: it cannot produce a name that is
 * not in the sentence, and it returns null (shown as "unassigned") rather than
 * guessing when the pattern does not fit.
 */
function ownerFromSentence(sentence: string): string | null {
	const match = /^([A-Z][\p{L}'-]{1,20})\s+(?:will|is going to|is to|to)\b/u.exec(sentence);
	if (!match || !isLikelyOwnerName(match[1])) return null;
	return match[1];
}

function dueDateFromSentence(sentence: string): string | null {
	const lower = sentence.toLowerCase();
	for (const phrase of DUE_DATE_PHRASES) {
		if (lower.includes(phrase)) return phrase;
	}
	const weekday = /\b(?:by|before|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.exec(lower);
	return weekday ? weekday[0] : null;
}

function contactsFromTranscript(transcript: string): MeetingContact[] {
	const contacts: MeetingContact[] = [];
	const push = (name: string | null, detail: string) => {
		if (contacts.some((c) => c.detail.toLowerCase() === detail.toLowerCase())) return;
		contacts.push({ name, detail, source: 'transcript' });
	};

	for (const match of transcript.match(EMAIL_RE) ?? []) push(null, match);
	for (const match of transcript.match(PHONE_RE) ?? []) {
		// A bare year or a two-digit quantity is not a phone number.
		if (match.replace(/\D/g, '').length >= 7) push(null, collapseWhitespace(match));
	}
	for (const match of transcript.matchAll(CONTACT_CUE_RE)) {
		// `match[0]` is the phrase itself ("reach Priya"), so a contact recorded
		// here is quoted from the transcript rather than described.
		push(match[1], collapseWhitespace(match[0]));
	}
	return contacts;
}

/**
 * Builds a summary out of the transcript's own sentences.
 *
 * Every string returned here is a substring of the transcript or a phrase cut
 * from one, so this function cannot introduce a fact — which is why it is what
 * runs whenever the model's draft is refused or unavailable.
 */
export function groundedMeetingSummary(transcript: string, maxSummaryChars = 700): MeetingSummaryDraft {
	const sentences = sentencesOf(transcript);
	const summarySource = sentences.slice(0, 3).join(' ');

	return {
		summary: summarySource.slice(0, maxSummaryChars).trim(),
		decisions: firstSentenceMatching(sentences, DECISION_CUES),
		actionItems: firstSentenceMatching(sentences, ACTION_CUES).map((text) => {
			const dueDate = dueDateFromSentence(text);
			return { text, owner: ownerFromSentence(text), dueDate, dueDateIso: null };
		}),
		contacts: contactsFromTranscript(transcript),
	};
}

// ─── Due-date resolution ────────────────────────────────────────────────────

const WEEKDAYS = [
	'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

function isoDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/**
 * Resolves a spoken deadline phrase to a calendar day, or null.
 *
 * The input is always a phrase taken verbatim from the transcript, so this can
 * only ever narrow a real statement — it can never create one. Anything it does
 * not recognise returns null and the phrase is stored unresolved, which the UI
 * renders as-is ("by Friday") rather than as an invented date.
 */
export function resolveDueDate(phrase: string, now: Date): string | null {
	const lower = collapseWhitespace(phrase).toLowerCase().replace(/^(by|before|on|due|latest by)\s+/, '');
	if (!lower) return null;

	const plusDays = (days: number): string => {
		const date = new Date(now.getTime());
		date.setUTCDate(date.getUTCDate() + days);
		return isoDay(date);
	};

	if (lower === 'today' || lower === 'tonight' || lower === 'end of day' || lower === 'eod') {
		return isoDay(now);
	}
	if (lower === 'tomorrow') return plusDays(1);
	if (lower === 'next week' || lower === 'end of week' || lower === 'end of the week') {
		// The coming Friday, which is the end of the working week in the markets
		// this product ships to.
		const current = now.getUTCDay();
		return plusDays(((5 - current) + 7) % 7 || 7);
	}
	if (lower === 'end of the month') {
		return isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
	}

	const weekdayIndex = WEEKDAYS.indexOf(lower);
	if (weekdayIndex >= 0) {
		const delta = ((weekdayIndex - now.getUTCDay()) + 7) % 7;
		return plusDays(delta === 0 ? 7 : delta);
	}

	const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lower);
	if (iso) return lower;

	const short = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(lower);
	if (short) {
		const year = short[3]
			? Number(short[3].length === 2 ? `20${short[3]}` : short[3])
			: now.getUTCFullYear();
		return isoDay(new Date(Date.UTC(year, Number(short[2]) - 1, Number(short[1]))));
	}

	return null;
}

/**
 * Fills in the resolved calendar day for every action item that carries a
 * spoken deadline phrase.
 *
 * Kept beside [resolveDueDate] so the one place that turns words into a date is
 * also the one place that decides a date is unknown.
 */
export function attachDueDates(draft: MeetingSummaryDraft, now: Date): MeetingSummaryDraft {
	return {
		...draft,
		actionItems: draft.actionItems.map((item) => ({
			...item,
			dueDateIso: item.dueDate ? resolveDueDate(item.dueDate, now) : null,
		})),
	};
}
