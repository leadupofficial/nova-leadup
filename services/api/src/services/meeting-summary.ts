/**
 * NOVA API — the meeting summariser (master document §5.12).
 *
 * A recording becomes a summary, a list of decisions, action items that carry a
 * due date and an owner, and the contacts the conversation mentioned. The
 * columns already exist (`recording_summaries.summary`, `.decisions`,
 * `.action_items`, `.extracted_contacts`) and nothing had ever written them.
 *
 * ## Nothing may be fabricated
 *
 * A meeting summary is the most dangerous thing this system can hallucinate: an
 * action item the user never agreed to is worse than no summary at all, and a
 * decision attributed to the wrong person is worse still. The discipline is the
 * one `briefing.ts` established, applied to a document instead of a monologue:
 *
 *  1. **A transcript that says nothing produces a summary that says so.** When
 *     the speech-to-text provider returns silence, a bracketed marker, or two
 *     stray words, `isMeaningfulTranscript` refuses it and the model is **never
 *     consulted** — the same early return the briefing uses for an empty day.
 *     An empty transcript is exactly the prompt that makes a language model
 *     produce a plausible meeting.
 *
 *  2. **Every model draft passes `guardMeetingSummary`.** Every capitalised word
 *     must be ordinary English or appear in the transcript; every digit run must
 *     appear in the transcript; an action item's owner must appear verbatim in
 *     the transcript; and its due date must be a phrase copied out of the
 *     transcript rather than computed. A rejected draft is discarded wholesale.
 *
 *  3. **The fallback is extractive, so it cannot invent by construction.** See
 *     `meeting-summary-guard.ts`, which owns both the guard and the fallback.
 *
 * ## What is deliberately absent
 *
 * `MEETING_SUMMARY_CAPABILITIES.diarisation` is false. Speaker separation is a
 * separately billed provider capability that this deployment does not call, so
 * no speaker count, no per-speaker percentage and no `speakerIndex` above 0 is
 * ever produced. §5.11's mockup shows "Participants: 3 detected" with
 * percentages; those numbers would have to be invented here, so they are not
 * shown.
 */
import { getLanguageByCode } from '@nova/shared-types';
import { chatCompletion, getAnthropicHttpConfig } from './ai.js';
import {
	attachDueDates,
	collapseWhitespace,
	groundedMeetingSummary,
	guardMeetingSummary,
	isMeaningfulTranscript,
} from './meeting-summary-guard.js';
import { logger } from '../utils/logger.js';

// The guard and the extractive fallback live in their own module so neither file
// grows past what a reviewer will read in one sitting. Re-exported here so
// `services/meeting-summary.js` keeps one public surface.
export {
	MIN_TRANSCRIPT_CHARS,
	MIN_TRANSCRIPT_WORDS,
	MAX_EXTRACTIVE_UNIT_WORDS,
	attachDueDates,
	groundedMeetingSummary,
	guardMeetingSummary,
	isMeaningfulTranscript,
	resolveDueDate,
	type GuardOptions,
	type GuardVerdict,
} from './meeting-summary-guard.js';

/** What the meeting pipeline can and cannot do, stated rather than implied. */
export const MEETING_SUMMARY_CAPABILITIES = Object.freeze({
	/** §4.1: post-hoc, not live. There is no in-meeting transcription. */
	transcription: 'async' as const,
	liveTranscription: false,
	/** A separately billed provider feature this deployment does not call. */
	diarisation: false,
	speakerCounts: false,
	decisions: true,
	actionItems: true,
	contacts: true,
});

export const MEETING_SUMMARY_TEMPERATURE = 0.2;
export const MEETING_SUMMARY_MAX_TOKENS = 1500;

/**
 * The honest text written when the provider heard nothing.
 *
 * It is a *summary row* rather than a missing row on purpose: "we transcribed
 * this and there was no speech" is information, and `GET /recordings/:id/summary`
 * should be able to return it. The mobile screen renders it as-is.
 */
export const NO_SPEECH_SUMMARY_TEXT =
	'No speech was detected in this recording, so there is nothing to summarise. The audio was captured, but no words could be transcribed from it.';

export interface MeetingActionItem {
	/** The task, in the transcript's own words wherever possible. */
	text: string;
	/** A person named in the transcript, or null when nobody was named. */
	owner: string | null;
	/** The deadline phrase exactly as it was spoken, or null. */
	dueDate: string | null;
	/** `dueDate` resolved to a calendar day when it can be, else null. */
	dueDateIso: string | null;
}

export interface MeetingContact {
	name: string | null;
	/** The email, number or role, verbatim from the transcript. */
	detail: string;
	source: 'transcript' | 'model';
}

export interface MeetingSummaryDraft {
	summary: string;
	decisions: string[];
	actionItems: MeetingActionItem[];
	contacts: MeetingContact[];
}

export type MeetingSummarySource = 'model' | 'grounded' | 'no-speech';

export interface MeetingSummaryResult {
	draft: MeetingSummaryDraft;
	/**
	 * `model` when a Sonnet draft survived the guard, `grounded` when the
	 * extractive rendering was used instead, `no-speech` when there was nothing
	 * to summarise and the model was never asked.
	 */
	source: MeetingSummarySource;
	/** Which rule refused a model draft, when one was refused. */
	guardRejection: string | null;
	model: string | null;
	language: string;
	transcriptChars: number;
}


// ─── Composition ────────────────────────────────────────────────────────────

const SUMMARY_PERSONA = [
	'You extract a structured summary from ONE meeting transcript.',
	'The transcript is the entire universe of this task.',
	'Never invent a person, company, product, number, amount, date or decision that is not in the transcript.',
	'Every name you write must be spelled exactly as it appears in the transcript.',
].join(' ');

const SUMMARY_REQUEST = [
	'Return ONLY a JSON object, with no commentary and no markdown fence, in exactly this shape:',
	'{"summary":"...","decisions":["..."],"actionItems":[{"text":"...","owner":"..."|null,"dueDate":"..."|null}],"contacts":[{"name":"..."|null,"detail":"..."}]}',
	'Rules:',
	'- summary: two to four sentences describing what the conversation was about and what came out of it.',
	'- decisions: only what the participants actually decided or agreed. An empty list is a valid and common answer.',
	'- actionItems: only tasks someone in the transcript took on. `owner` is a person named in the transcript, spelled exactly as there; use null when nobody was named.',
	'- dueDate: the deadline phrase copied VERBATIM from the transcript, e.g. "by Friday". Never compute or reformat a date. Use null when no deadline was stated.',
	'- contacts: only people, email addresses or phone numbers that appear in the transcript.',
	'- If the transcript is too thin to summarise, return an empty summary with empty lists. Do not pad it.',
].join('\n');

/** Pulls the first JSON object out of a model reply, tolerating a code fence. */
export function parseSummaryDraft(content: string): MeetingSummaryDraft | null {
	const start = content.indexOf('{');
	const end = content.lastIndexOf('}');
	if (start < 0 || end <= start) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(content.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const raw = parsed as Record<string, unknown>;

	const asString = (value: unknown): string => (typeof value === 'string' ? collapseWhitespace(value) : '');
	const asStringOrNull = (value: unknown): string | null => asString(value) || null;
	const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

	const draft: MeetingSummaryDraft = {
		summary: asString(raw.summary),
		decisions: asArray(raw.decisions).map(asString).filter(Boolean),
		actionItems: asArray(raw.actionItems)
			.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
			.map((item) => ({
				text: asString(item.text),
				owner: asStringOrNull(item.owner),
				dueDate: asStringOrNull(item.dueDate),
				dueDateIso: null,
			}))
			.filter((item) => item.text.length > 0),
		contacts: asArray(raw.contacts)
			.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
			.map((item) => ({
				name: asStringOrNull(item.name),
				detail: asString(item.detail) || asString(item.name),
				source: 'model' as const,
			}))
			.filter((contact) => contact.detail.length > 0),
	};
	return draft;
}


export interface SummariseOptions {
	language?: string;
	now?: Date;
	/** Overridable so a test can pin the tier without an environment. */
	model?: string;
}

/**
 * Composes the summary for one transcript.
 *
 * Order of events, and why: the transcript is judged meaningful **first**. When
 * it is not, the answer is produced without calling the model at all, because an
 * empty transcript is precisely the prompt that makes a language model invent a
 * meeting. Only then is a draft requested, and a draft that fails the guard is
 * replaced whole by the extractive rendering.
 */
export async function summariseTranscript(
	transcript: string,
	options: SummariseOptions = {},
): Promise<MeetingSummaryResult> {
	const language = (options.language ?? 'en').trim() || 'en';
	const now = options.now ?? new Date();
	const base = { language, transcriptChars: transcript.trim().length };

	const verdict = isMeaningfulTranscript(transcript);
	if (!verdict.ok) {
		logger.info(
			{ metric: 'meeting_summary_composed', reason: verdict.reason, transcriptChars: base.transcriptChars },
			'Transcript carries no speech; not asking the model',
		);
		return {
			...base,
			draft: { summary: NO_SPEECH_SUMMARY_TEXT, decisions: [], actionItems: [], contacts: [] },
			source: 'no-speech',
			guardRejection: null,
			model: null,
		};
	}

	const grounded = (guardRejection: string | null, model: string | null): MeetingSummaryResult => ({
		...base,
		draft: attachDueDates(groundedMeetingSummary(transcript), now),
		source: 'grounded',
		guardRejection,
		model,
	});

	const languageInfo = getLanguageByCode(language);
	const systemPrompt = [
		SUMMARY_PERSONA,
		languageInfo?.name ? `Write every field in ${languageInfo.name}.` : '',
	].filter(Boolean).join(' ');

	let content = '';
	let model: string | null = null;
	try {
		const completion = await chatCompletion(
			[{ role: 'user', content: `${SUMMARY_REQUEST}\n\nTRANSCRIPT:\n${transcript}` }],
			{
				model: options.model ?? getAnthropicHttpConfig().model,
				maxTokens: MEETING_SUMMARY_MAX_TOKENS,
				temperature: MEETING_SUMMARY_TEMPERATURE,
				systemPrompt,
			},
		);
		model = completion.model;
		content = completion.content;
	} catch (err) {
		logger.warn({ err }, 'Summary model call failed; using the extractive summary');
		return grounded('model-unavailable', null);
	}

	const draft = parseSummaryDraft(content);
	if (!draft) return grounded('unparseable', model);

	const guardVerdict = guardMeetingSummary(draft, transcript);
	if (!guardVerdict.ok) {
		const reason = guardVerdict.reason ?? 'rejected';
		logger.warn({ model, reason }, 'Summary draft rejected as ungrounded; using the extractive summary');
		return grounded(reason, model);
	}

	logger.info(
		{
			metric: 'meeting_summary_composed',
			source: 'model',
			model,
			transcriptChars: base.transcriptChars,
			decisions: draft.decisions.length,
			actionItems: draft.actionItems.length,
		},
		'Meeting summary composed',
	);

	return { ...base, draft: attachDueDates(draft, now), source: 'model', guardRejection: null, model };
}
