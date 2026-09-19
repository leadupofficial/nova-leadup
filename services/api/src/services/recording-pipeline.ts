/**
 * NOVA API — the meeting transcription and summarisation pipeline.
 *
 * ## The shape of the work
 *
 * Master document §4.1 makes meeting capture **asynchronous**: the client stops
 * recording, uploads, and walks away; the transcript and summary appear later.
 * So this module is a job, not a request handler:
 *
 *  1. `transcribing` — read the stored audio and hand it to the provider that
 *     `transcribeAudioForLanguage` routes to for the recording's language.
 *  2. persist — write `transcripts` and, when the provider returned word
 *     timing, `transcript_segments` with the provider's own boundaries.
 *  3. `summarising` — `summariseTranscript` produces decisions, action items
 *     with an owner and a due date, and contacts; a transcript that carries no
 *     speech yields an honest "nothing was said" summary and no model call.
 *  4. persist the `recording_summaries` row and mark the recording `completed`.
 *
 * ## The lifecycle is honest, not decorative
 *
 * `audio_recordings.status` moves `recording → uploaded → processing →
 * completed | failed` and every transition is written before the next stage
 * starts, so a client polling the detail route sees the real stage. A failure
 * that could not produce a transcript leaves the row at `failed`; it never
 * leaves it at `completed` with an empty summary, and it never invents one.
 *
 * ## What is not built
 *
 * There is no durable queue. The job runs in the API process after the response
 * is sent (`enqueueRecordingProcessing`), which is correct for the single API
 * instance this deployment runs and is why an in-process in-flight set is used
 * to stop two uploads racing the same recording. A restart mid-job leaves the
 * row at `processing` — the truth — rather than silently completing it. Moving
 * this onto a real queue is a change to the runner, not to the stages.
 *
 * ## Diarisation
 *
 * Not available, and not simulated. Every segment carries `speakerIndex: 0`,
 * which means *unattributed* — the one audio stream NOVA actually holds — and
 * never "speaker one". `audio_recordings.participants` is left as the client
 * created it, because a speaker count that no provider produced would be
 * exactly the fabrication this pipeline exists to avoid.
 */
import { and, eq } from 'drizzle-orm';
import { audioRecordings, transcripts, recordingSummaries, transcriptSegments } from '@nova/database';
import { getDb } from '../db/connection.js';
import { getAudio } from './audio-storage.js';
import { transcribeAudioForLanguage, type TranscribedWord } from './ai.js';
import {
	summariseTranscript,
	type MeetingSummaryDraft,
	type MeetingSummarySource,
} from './meeting-summary.js';
import { logger } from '../utils/logger.js';

/** The honest lifecycle of one recording. */
export const RECORDING_STATUS = {
	/** Capture is in progress on the device. */
	recording: 'recording',
	/** Audio is in object storage and waiting to be processed. */
	uploaded: 'uploaded',
	/** Transcription and summarisation are running. */
	processing: 'processing',
	/** Transcript and summary were written. */
	completed: 'completed',
	/** The pipeline could not finish; the reason is in the logs. */
	failed: 'failed',
} as const;

export type RecordingStatus = (typeof RECORDING_STATUS)[keyof typeof RECORDING_STATUS];

/** Gap that ends a segment even without sentence punctuation, in seconds. */
const SEGMENT_GAP_SECONDS = 2;
/** Safety ceiling on words in one segment, for providers that never punctuate. */
const SEGMENT_MAX_WORDS = 40;

export interface TranscriptSegmentInput {
	speakerIndex: number;
	startMs: number;
	endMs: number;
	text: string;
	/** 0–100, as the column stores it. */
	confidence: number | null;
}

const SENTENCE_END = /[.!?।]$/;

/**
 * Groups provider word timings into segments.
 *
 * A segment ends at sentence punctuation, at a pause longer than
 * [SEGMENT_GAP_SECONDS], or at [SEGMENT_MAX_WORDS]. Every boundary and every
 * timestamp here comes from the provider; nothing is interpolated, and
 * `speakerIndex` is always 0 because this deployment has no diarisation.
 */
export function segmentFromWords(words: TranscribedWord[]): TranscriptSegmentInput[] {
	const segments: TranscriptSegmentInput[] = [];
	let current: TranscribedWord[] = [];

	const flush = (): void => {
		if (!current.length) return;
		const confidence =
			current.reduce((sum, w) => sum + (Number.isFinite(w.confidence) ? w.confidence : 0), 0) /
			current.length;
		segments.push({
			speakerIndex: 0,
			startMs: Math.max(0, Math.round(current[0].startSeconds * 1000)),
			endMs: Math.max(0, Math.round(current[current.length - 1].endSeconds * 1000)),
			text: current.map((w) => w.word).join(' ').replace(/\s+([.,!?;:])/g, '$1').trim(),
			confidence: Math.round(confidence * 100),
		});
		current = [];
	};

	for (let index = 0; index < words.length; index++) {
		const word = words[index];
		current.push(word);
		const next = index + 1 < words.length ? words[index + 1] : null;
		const endsSentence = SENTENCE_END.test(word.word);
		const longPause = next !== null && next.startSeconds - word.endSeconds > SEGMENT_GAP_SECONDS;
		if (endsSentence || longPause || current.length >= SEGMENT_MAX_WORDS) flush();
	}
	flush();
	return segments;
}

/**
 * The single segment used when the provider returned no word timing.
 *
 * Its boundaries span the recording because that is the only true statement
 * available: the words came from somewhere inside this audio, and NOVA cannot
 * say where. It is deliberately one segment rather than several evenly spaced
 * ones, which would be invented timing.
 */
export function wholeRecordingSegment(
	text: string,
	durationSeconds: number | null,
): TranscriptSegmentInput[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	return [
		{
			speakerIndex: 0,
			startMs: 0,
			endMs: Math.max(0, Math.round((durationSeconds ?? 0) * 1000)),
			text: trimmed,
			confidence: null,
		},
	];
}

export interface PipelineResult {
	recordingId: string;
	status: RecordingStatus;
	transcriptChars: number;
	segments: number;
	summarySource: MeetingSummarySource | null;
	provider: string | null;
	guardRejection: string | null;
	/** Set when the run ended at `failed`; the same text is logged. */
	failureReason: string | null;
}

/** Recordings currently being processed, so two requests cannot race one row. */
const inFlight = new Set<string>();

/** The speech-to-text step, as `transcribeAudioForLanguage` satisfies it. */
export type TranscribeFn = (
	audio: Buffer,
	language: string,
) => Promise<{
	transcript: string;
	confidence: number;
	language: string;
	provider: string;
	words?: TranscribedWord[];
}>;

export interface PipelineOptions {
	/**
	 * Replaces the transcription step.
	 *
	 * The default is `transcribeAudioForLanguage` — the same provider routing the
	 * voice path uses, so there is one STT configuration in this codebase. The
	 * seam exists because the shared test bootstrap imports the server (and so
	 * this module) before any test file runs, which makes a module mock
	 * ineffective: without it the pipeline could only be tested against a live
	 * provider.
	 */
	transcriber?: TranscribeFn;
	/** Clock override, so a test can pin the resolved due dates. */
	now?: () => Date;
}

/** Test seam: forget which recordings are mid-run. */
export function resetPipelineState(): void {
	inFlight.clear();
}

async function setStatus(
	recordingId: string,
	userId: string,
	status: RecordingStatus,
	extra: Record<string, unknown> = {},
): Promise<void> {
	const now = new Date();
	await getDb()
		.update(audioRecordings)
		.set({ status, updatedAt: now, ...extra })
		.where(and(eq(audioRecordings.id, recordingId), eq(audioRecordings.userId, userId)));
}

async function fail(
	recordingId: string,
	userId: string,
	reason: string,
	err?: unknown,
): Promise<PipelineResult> {
	await setStatus(recordingId, userId, RECORDING_STATUS.failed);
	logger.error({ err, recordingId, reason }, 'Recording pipeline failed');
	return {
		recordingId,
		status: RECORDING_STATUS.failed,
		transcriptChars: 0,
		segments: 0,
		summarySource: null,
		provider: null,
		guardRejection: null,
		failureReason: reason,
	};
}

/**
 * Runs the whole pipeline for one recording.
 *
 * Called by the route after it has persisted `processing`, and after the
 * response has been sent. It never throws: the caller is a fire-and-forget
 * enqueue, and a rejected promise there would be an unhandled rejection rather
 * than a row the user can see.
 */
export async function runRecordingPipeline(
	recordingId: string,
	userId: string,
	options: PipelineOptions = {},
): Promise<PipelineResult> {
	if (inFlight.has(recordingId)) {
		logger.warn({ recordingId }, 'Recording pipeline already running; ignoring the duplicate request');
		return {
			recordingId,
			status: RECORDING_STATUS.processing,
			transcriptChars: 0,
			segments: 0,
			summarySource: null,
			provider: null,
			guardRejection: null,
			failureReason: null,
		};
	}
	inFlight.add(recordingId);

	try {
		const db = getDb();
		const [recording] = await db
			.select()
			.from(audioRecordings)
			.where(and(eq(audioRecordings.id, recordingId), eq(audioRecordings.userId, userId)))
			.limit(1);

		if (!recording) {
			logger.warn({ recordingId, userId }, 'Recording pipeline ran for a missing recording');
			return {
				recordingId,
				status: RECORDING_STATUS.failed,
				transcriptChars: 0,
				segments: 0,
				summarySource: null,
				provider: null,
				guardRejection: null,
				failureReason: 'recording-not-found',
			};
		}

		await setStatus(recordingId, userId, RECORDING_STATUS.processing);

		// ── 1. Read the audio back out of object storage ──────────────────────
		let audio: Buffer;
		try {
			audio = await getAudio(recording.storageKey);
		} catch (err) {
			return fail(recordingId, userId, 'audio-unreadable', err);
		}
		if (audio.length === 0) return fail(recordingId, userId, 'audio-empty');

		// ── 2. Transcribe ────────────────────────────────────────────────────
		const language = (recording.language ?? 'en').trim() || 'en';
		const transcribe = options.transcriber ?? transcribeAudioForLanguage;
		let transcription: Awaited<ReturnType<TranscribeFn>>;
		try {
			transcription = await transcribe(audio, language);
		} catch (err) {
			return fail(recordingId, userId, 'transcription-failed', err);
		}

		const text = (transcription.transcript ?? '').trim();
		const segments = transcription.words?.length
			? segmentFromWords(transcription.words)
			: wholeRecordingSegment(text, recording.durationSeconds);

		// ── 3. Persist the transcript ────────────────────────────────────────
		// The unique index on `transcripts.recording_id` makes a re-run an
		// update, and the segments cascade with the old row.
		await db.delete(transcripts).where(eq(transcripts.recordingId, recordingId));
		await db.delete(recordingSummaries).where(eq(recordingSummaries.recordingId, recordingId));

		const [transcript] = await db
			.insert(transcripts)
			.values({
				recordingId,
				fullText: text,
				language: transcription.language ?? language,
			})
			.returning();

		if (segments.length && transcript?.id) {
			await db.insert(transcriptSegments).values(
				segments.map((segment) => ({ ...segment, transcriptId: transcript.id })),
			);
		}

		// ── 4. Summarise ─────────────────────────────────────────────────────
		const summary = await summariseTranscript(text, {
			language: transcription.language ?? language,
			...(options.now ? { now: options.now() } : {}),
		});
		const draft: MeetingSummaryDraft = summary.draft;

		await db.insert(recordingSummaries).values({
			recordingId,
			transcriptId: transcript?.id ?? null,
			summary: draft.summary,
			decisions: draft.decisions,
			actionItems: draft.actionItems,
			extractedContacts: draft.contacts,
		});

		// ── 5. Complete ──────────────────────────────────────────────────────
		await setStatus(recordingId, userId, RECORDING_STATUS.completed, { completedAt: new Date() });

		logger.info(
			{
				metric: 'recording_pipeline_completed',
				recordingId,
				userId,
				provider: transcription.provider,
				transcriptChars: text.length,
				segments: segments.length,
				summarySource: summary.source,
				decisions: draft.decisions.length,
				actionItems: draft.actionItems.length,
			},
			'Recording pipeline completed',
		);

		return {
			recordingId,
			status: RECORDING_STATUS.completed,
			transcriptChars: text.length,
			segments: segments.length,
			summarySource: summary.source,
			provider: transcription.provider,
			guardRejection: summary.guardRejection,
			failureReason: null,
		};
	} catch (err) {
		return fail(recordingId, userId, 'pipeline-error', err);
	} finally {
		inFlight.delete(recordingId);
	}
}

/**
 * Starts the pipeline without waiting for it.
 *
 * The route has already written `processing` and answered 202 by the time this
 * runs, so a slow provider costs the client nothing. The `catch` is load-bearing:
 * [runRecordingPipeline] is written not to throw, and a throw here would be an
 * unhandled rejection that takes the process down over one bad recording.
 */
export function enqueueRecordingProcessing(recordingId: string, userId: string): void {
	setImmediate(() => {
		void runRecordingPipeline(recordingId, userId).catch((err) => {
			logger.error({ err, recordingId }, 'Recording pipeline crashed outside its own error handling');
		});
	});
}
