/**
 * NOVA API — the meeting-summary guard and composer.
 *
 * The thing being proved here is not that a summary is produced — it is that a
 * summary **cannot invent a meeting**. Three layers, each exercised without a
 * database and without a provider:
 *
 *  1. `isMeaningfulTranscript` refuses silence, so an empty transcript never
 *     reaches the model at all.
 *  2. `guardMeetingSummary` refuses a model draft that names a person, states a
 *     number or quotes a deadline the transcript does not contain.
 *  3. `summariseTranscript` falls back to an **extractive** rendering, which is
 *     built out of the transcript's own sentences and therefore cannot
 *     introduce a fact.
 *
 * The pipeline that calls all of this, and its HTTP surface, are covered by
 * `recording-pipeline.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import './setup.js';

import { chatCompletion } from '../services/ai.js';
import {
	NO_SPEECH_SUMMARY_TEXT,
	attachDueDates,
	groundedMeetingSummary,
	guardMeetingSummary,
	isMeaningfulTranscript,
	parseSummaryDraft,
	resolveDueDate,
	summariseTranscript,
	type MeetingSummaryDraft,
} from '../services/meeting-summary.js';
import { segmentFromWords, wholeRecordingSegment } from '../services/recording-pipeline.js';

beforeEach(() => {
	vi.mocked(chatCompletion).mockReset();
});

// ─── 1. There has to be something to summarise ───────────────────────────────

describe('isMeaningfulTranscript', () => {
	it('refuses an empty transcript', () => {
		expect(isMeaningfulTranscript('').ok).toBe(false);
	});

	it('refuses whitespace and provider non-speech markers', () => {
		expect(isMeaningfulTranscript('   \n  ').reason).toBe('empty');
		expect(isMeaningfulTranscript('[BLANK_AUDIO]').reason).toBe('empty');
		expect(isMeaningfulTranscript('(inaudible)\n[Music]').reason).toBe('empty');
	});

	it('refuses a couple of stray words that could not contain a decision', () => {
		expect(isMeaningfulTranscript('you').reason).toBe('too-short');
		expect(isMeaningfulTranscript('thank you').ok).toBe(false);
	});

	it('accepts a real sentence', () => {
		expect(isMeaningfulTranscript('We decided to ship the quote on Friday.').ok).toBe(true);
	});
});

describe('summariseTranscript — a transcript with no speech', () => {
	it('says so and never asks the model', async () => {
		const result = await summariseTranscript('   \n[BLANK_AUDIO]');

		expect(result.source).toBe('no-speech');
		expect(result.draft.summary).toBe(NO_SPEECH_SUMMARY_TEXT);
		expect(result.draft.decisions).toEqual([]);
		expect(result.draft.actionItems).toEqual([]);
		expect(result.draft.contacts).toEqual([]);
		expect(
			chatCompletion,
			'an empty transcript is exactly the prompt that makes a model invent a meeting',
		).not.toHaveBeenCalled();
	});
});

// ─── 2. The guard ────────────────────────────────────────────────────────────

const TRANSCRIPT = [
	'The client wants the revised quote by Friday.',
	'We agreed to drop the onboarding fee.',
	'Ravi will send the updated deck by Monday.',
	'You can reach Priya on priya@example.com.',
].join(' ');

const GROUNDED_DRAFT: MeetingSummaryDraft = {
	summary: 'The client asked for a revised quote and the team agreed to drop the onboarding fee.',
	decisions: ['Drop the onboarding fee'],
	actionItems: [
		{ text: 'Send the updated deck', owner: 'Ravi', dueDate: 'by Friday', dueDateIso: null },
	],
	contacts: [{ name: 'Priya', detail: 'priya@example.com', source: 'model' }],
};

describe('guardMeetingSummary', () => {
	it('accepts a draft whose every name, number and deadline is in the transcript', () => {
		expect(guardMeetingSummary(GROUNDED_DRAFT, TRANSCRIPT)).toEqual({ ok: true });
	});

	it('refuses an invented person', () => {
		const verdict = guardMeetingSummary(
			{ ...GROUNDED_DRAFT, decisions: ['Meera approved the budget'] },
			TRANSCRIPT,
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('ungrounded-name');
	});

	it('refuses an invented number', () => {
		const verdict = guardMeetingSummary(
			{ ...GROUNDED_DRAFT, summary: 'The client asked for a 15% discount.' },
			TRANSCRIPT,
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('ungrounded-number');
	});

	it('refuses an action item owner the transcript never names', () => {
		// Lower-case on purpose: a capitalised invented name is caught earlier by
		// the proper-noun rule, and this test is about the owner rule itself.
		const verdict = guardMeetingSummary(
			{
				...GROUNDED_DRAFT,
				actionItems: [{ text: 'Send the deck', owner: 'suresh', dueDate: null, dueDateIso: null }],
			},
			TRANSCRIPT,
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('ungrounded-owner');
	});

	it('refuses an invented capitalised name before it ever reaches the owner rule', () => {
		const verdict = guardMeetingSummary(
			{
				...GROUNDED_DRAFT,
				actionItems: [{ text: 'Send the deck', owner: 'Suresh', dueDate: null, dueDateIso: null }],
			},
			TRANSCRIPT,
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain('ungrounded-name');
	});

	it('refuses a due date that was computed rather than quoted', () => {
		const verdict = guardMeetingSummary(
			{
				...GROUNDED_DRAFT,
				actionItems: [
					{ text: 'Send the deck', owner: 'Ravi', dueDate: 'by 2026-09-25', dueDateIso: null },
				],
			},
			TRANSCRIPT,
		);
		// Two rules catch this independently: the invented digit run, and the
		// fact that the phrase appears nowhere in the transcript.
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toMatch(/ungrounded-(number|due-date)/);
	});

	it('refuses a URL and an emoji', () => {
		expect(
			guardMeetingSummary({ ...GROUNDED_DRAFT, decisions: ['See https://x.test'] }, TRANSCRIPT).reason,
		).toBe('url');
		expect(
			guardMeetingSummary({ ...GROUNDED_DRAFT, decisions: ['Ship it 🚀'] }, TRANSCRIPT).reason,
		).toBe('emoji');
	});

	it('refuses an empty summary', () => {
		expect(guardMeetingSummary({ ...GROUNDED_DRAFT, summary: '  ' }, TRANSCRIPT).reason).toBe(
			'empty-summary',
		);
	});
});

describe('groundedMeetingSummary — the extractive fallback', () => {
	it('quotes the transcript rather than paraphrasing it', () => {
		const draft = groundedMeetingSummary(TRANSCRIPT);

		for (const decision of draft.decisions) expect(TRANSCRIPT).toContain(decision);
		for (const item of draft.actionItems) expect(TRANSCRIPT).toContain(item.text);
		for (const contact of draft.contacts) expect(TRANSCRIPT).toContain(contact.detail);
	});

	it('finds the decision, the owner and the deadline that are actually stated', () => {
		const draft = groundedMeetingSummary(TRANSCRIPT);

		expect(draft.decisions.join(' ')).toContain('agreed to drop the onboarding fee');
		const deck = draft.actionItems.find((item) => item.text.includes('updated deck'));
		expect(deck?.owner).toBe('Ravi');
		expect(deck?.dueDate).toBe('by monday');
	});

	it('leaves the owner null rather than guessing one', () => {
		const draft = groundedMeetingSummary('The team will prepare the invoice next week.');
		expect(draft.actionItems).toHaveLength(1);
		expect(draft.actionItems[0].owner).toBeNull();
	});

	it('still produces quotable units when the provider gave no punctuation', () => {
		// Deepgram returns an unpunctuated run of words unless punctuation is
		// requested; one 60-word "sentence" would make every cue match the whole
		// transcript, so long runs are cut into word-bounded chunks.
		const run = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ') + ' we will send the deck';
		const draft = groundedMeetingSummary(run);

		expect(draft.actionItems.length).toBeGreaterThan(0);
		for (const item of draft.actionItems) {
			expect(item.text.split(' ').length).toBeLessThanOrEqual(25);
			expect(run).toContain(item.text);
		}
	});

	it('treats an ordinary capitalised word as prose, not as an invented name', () => {
		// "Key takeaways" and "Several decisions" are headings and quantifiers,
		// not people; rejecting them would have thrown away a perfectly grounded
		// draft, which is what happened before the shared vocabulary existed.
		expect(
			guardMeetingSummary(
				{ ...GROUNDED_DRAFT, summary: 'Key takeaways. Several decisions were made.' },
				TRANSCRIPT,
			),
		).toEqual({ ok: true });
	});

	it('never reads a pronoun as an action item owner', () => {
		const draft = groundedMeetingSummary('We will drop the onboarding fee.');
		expect(draft.actionItems).toHaveLength(1);
		expect(draft.actionItems[0].owner).toBeNull();

		const named = groundedMeetingSummary('Ravi will send the deck.');
		expect(named.actionItems[0].owner).toBe('Ravi');
	});

	it('picks up only contacts that are literally in the transcript', () => {
		const draft = groundedMeetingSummary(TRANSCRIPT);
		expect(draft.contacts.map((c) => c.detail)).toContain('priya@example.com');
		expect(groundedMeetingSummary('We talked about a phone number for a while.').contacts).toEqual([]);
	});
});

describe('summariseTranscript — the model path', () => {
	const completion = (content: string) => ({
		content,
		model: 'claude-sonnet-4-20250514',
		usage: { inputTokens: 10, outputTokens: 20 },
		blocks: [{ type: 'text' as const, text: content }],
		stopReason: 'end_turn',
		toolUses: [],
	});

	it('accepts a grounded draft and resolves the quoted deadline', async () => {
		vi.mocked(chatCompletion).mockResolvedValue(completion(JSON.stringify(GROUNDED_DRAFT)) as never);

		const result = await summariseTranscript(TRANSCRIPT, { now: new Date('2026-09-23T09:00:00Z') });

		expect(result.source).toBe('model');
		expect(result.guardRejection).toBeNull();
		expect(result.draft.actionItems[0].owner).toBe('Ravi');
		// "by Friday", spoken on a Wednesday, is that week's Friday.
		expect(result.draft.actionItems[0].dueDateIso).toBe('2026-09-25');
	});

	it('throws the whole draft away when it invents a decision, and extracts instead', async () => {
		vi.mocked(chatCompletion).mockResolvedValue(
			completion(JSON.stringify({ ...GROUNDED_DRAFT, decisions: ['Meera approved the budget'] })) as never,
		);

		const result = await summariseTranscript(TRANSCRIPT);

		expect(result.source).toBe('grounded');
		expect(result.guardRejection).toContain('ungrounded-name');
		expect(JSON.stringify(result.draft)).not.toContain('Meera');
		expect(result.draft.decisions.join(' ')).toContain('agreed to drop the onboarding fee');
	});

	it('falls back to extraction when the provider fails', async () => {
		vi.mocked(chatCompletion).mockRejectedValue(new Error('provider exploded'));

		const result = await summariseTranscript(TRANSCRIPT);

		expect(result.source).toBe('grounded');
		expect(result.guardRejection).toBe('model-unavailable');
		expect(result.draft.summary.length).toBeGreaterThan(0);
	});

	it('falls back to extraction when the reply is not JSON', async () => {
		vi.mocked(chatCompletion).mockResolvedValue(completion('Sure! Here is a summary.') as never);
		expect((await summariseTranscript(TRANSCRIPT)).guardRejection).toBe('unparseable');
	});
});

describe('parseSummaryDraft', () => {
	it('tolerates a code fence and drops unusable entries', () => {
		const draft = parseSummaryDraft(
			'```json\n{"summary":"s","decisions":["a",5],"actionItems":[{"text":"t","owner":null,"dueDate":"by Friday"}],"contacts":[]}\n```',
		);
		expect(draft?.decisions).toEqual(['a']);
		expect(draft?.actionItems).toEqual([
			{ text: 't', owner: null, dueDate: 'by Friday', dueDateIso: null },
		]);
	});

	it('returns null when there is no object at all', () => {
		expect(parseSummaryDraft('no json here')).toBeNull();
	});
});

describe('resolveDueDate', () => {
	const now = new Date('2026-09-23T09:00:00Z'); // a Wednesday

	it('resolves only phrases it recognises, and nothing else', () => {
		expect(resolveDueDate('by Friday', now)).toBe('2026-09-25');
		expect(resolveDueDate('tomorrow', now)).toBe('2026-09-24');
		expect(resolveDueDate('by next week', now)).toBe('2026-09-25');
		expect(resolveDueDate('sometime soonish', now)).toBeNull();
	});

	it('resolves the extracted phrase without inventing one', () => {
		const item = attachDueDates(groundedMeetingSummary(TRANSCRIPT), now).actionItems.find((a) =>
			a.text.includes('updated deck'),
		);
		expect(item?.dueDateIso).toBe('2026-09-28'); // "by monday" from a Wednesday
	});
});

// ─── 3. Segments ─────────────────────────────────────────────────────────────

describe('segmentFromWords', () => {
	it('uses the provider boundaries and never invents a speaker', () => {
		const segments = segmentFromWords([
			{ word: 'Hello', startSeconds: 0, endSeconds: 0.5, confidence: 0.9 },
			{ word: 'there.', startSeconds: 0.5, endSeconds: 1, confidence: 0.9 },
			{ word: 'Second', startSeconds: 5, endSeconds: 5.5, confidence: 0.8 },
		]);

		expect(segments).toHaveLength(2);
		expect(segments[0]).toMatchObject({ speakerIndex: 0, startMs: 0, endMs: 1000, text: 'Hello there.' });
		expect(segments[1].startMs).toBe(5000);
		expect(segments.every((s) => s.speakerIndex === 0)).toBe(true);
	});

	it('falls back to one segment spanning the recording when the provider gave no timing', () => {
		const segments = wholeRecordingSegment('hello world', 42);
		expect(segments).toEqual([
			{ speakerIndex: 0, startMs: 0, endMs: 42000, text: 'hello world', confidence: null },
		]);
		expect(wholeRecordingSegment('   ', 42)).toEqual([]);
	});
});
