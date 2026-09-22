/**
 * NOVA API — the recording lifecycle reaper (R-05, R-10, R-09).
 *
 * ## The states this exists for
 *
 * `enqueueRecordingProcessing` runs the transcription pipeline in-process, after
 * the response has been sent, with no durable queue. Three non-terminal states
 * therefore have no owner once the process or the client that created them goes
 * away:
 *
 *  * `processing` — the API process died mid-run. The retention sweep selects by
 *    age alone, so nothing retried the row, and the audio was eventually deleted
 *    by the retention window with no transcript ever produced (R-05).
 *  * `uploaded` — the client died between `POST /:id/audio` and
 *    `POST /:id/process`, which it calls as a separate request. Nothing
 *    server-side adopted the row (R-10).
 *  * `recording` — the client died mid-capture and nothing ever closed the row
 *    (R-09).
 *
 * ## What it does instead of a queue
 *
 * The durable state is the row itself: `status` plus `updated_at`, which every
 * pipeline transition stamps. A restarted process can therefore derive from the
 * database exactly what was in flight when it died. This sweep runs on a timer
 * and, for each row whose state has not moved inside its deadline, either
 * re-enqueues the pipeline (when the audio is still in object storage) or closes
 * the row at `failed` — a terminal status the client already polls and renders.
 *
 * That is not a queue, and it does not try to be one: it has no ordering, no
 * back-pressure and no cross-process ownership. What it does guarantee for the
 * single API instance this deployment runs is the property that was missing —
 * no recording can sit in `processing`/`uploaded`/`recording` indefinitely, and
 * no audio can be swept while its row still claims to be working on it.
 *
 * ## Conservative by construction
 *
 *  * a row this process is already running is never re-enqueued
 *    (`isPipelineInFlight`), so a slow transcription is not restarted underneath
 *    itself;
 *  * re-enqueue happens only when the stored object is confirmed present —
 *    otherwise the row is closed rather than queued into a run whose only
 *    possible outcome is `audio-unreadable`;
 *  * the database read is wrapped: a failing sweep logs and returns, because a
 *    background job must not take the API down;
 *  * terminal rows (`completed`, `failed`) are never touched, however old.
 */
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { audioRecordings } from '@nova/database';
import type { getDb } from '../db/connection.js';
import { audioExists } from '../services/audio-storage.js';
import {
	RECORDING_STATUS,
	enqueueRecordingProcessing,
	failStuckRecording,
	isPipelineInFlight,
} from '../services/recording-pipeline.js';
import { logger } from '../utils/logger.js';
import { backgroundJobsGate } from '../admin/enforcement.js';

type Db = ReturnType<typeof getDb>;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How long a state may stand still before it is considered abandoned.
 *
 * `processing` is the longest because it covers a real transcription of a long
 * meeting — the pipeline stamps `updated_at` when the run starts and not again
 * until it finishes, so this is a ceiling on one run, not on one provider call.
 */
export const REAPER_DEADLINES = {
	recording: 24 * HOUR_MS,
	uploaded: 15 * MINUTE_MS,
	processing: 60 * MINUTE_MS,
} as const;

export type ReapableStatus = keyof typeof REAPER_DEADLINES;

const REAPABLE_STATUSES: ReapableStatus[] = ['recording', 'uploaded', 'processing'];

/** Rows considered per run. The remainder are picked up by the next pass. */
const MAX_ROWS_PER_RUN = 100;

export interface RecordingReaperResult {
	/** Rows the query returned as candidates. */
	examined: number;
	/** Rows handed back to the pipeline. */
	requeued: number;
	/** Rows closed at `failed` because nothing could be recovered. */
	failed: number;
	/** Candidates left alone because this process is already running them. */
	skipped: number;
}

export interface RecordingReaperOptions {
	now?: Date;
	/** Starts another attempt. Defaults to `enqueueRecordingProcessing`. */
	requeue?: (recordingId: string, userId: string) => void;
	/**
	 * Operator-control decision. Defaults to the real `backgroundJobsGate`; injectable so a test
	 * can assert the engine honours the decision, and so a deliberate manual backfill can run
	 * while the sweep is switched off.
	 */
	gate?: () => Promise<{ allowed: boolean; reason: string | null }>;
	/** Whether the stored audio is still there. Defaults to `audioExists`. */
	audioPresent?: (storageKey: string) => Promise<boolean>;
}

/** Whether `status` is a state the reaper owns. */
export function isReapableStatus(status: string): status is ReapableStatus {
	return (REAPABLE_STATUSES as string[]).includes(status);
}

/**
 * The decision rule, pure and without a database.
 *
 * A terminal status is never stale — re-opening `completed` or `failed` would be
 * the reaper inventing work nobody asked for — and a missing/unparseable
 * timestamp is left alone rather than guessed at.
 */
export function isStaleForReaper(
	status: string,
	updatedAt: Date | string | null | undefined,
	now: Date,
): boolean {
	if (!isReapableStatus(status)) return false;
	if (updatedAt === null || updatedAt === undefined) return false;
	const at = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
	if (Number.isNaN(at.getTime())) return false;
	return now.getTime() - at.getTime() > REAPER_DEADLINES[status];
}

/** One candidate row, as the sweep reads it. */
interface StuckRow {
	id: string;
	userId: string;
	status: string;
	storageKey: string;
	updatedAt: Date;
}

/**
 * Runs one pass. Never throws: a failed sweep is logged and reported, because a
 * broken recovery job must not take the API down.
 */
export async function runRecordingReaper(
	db: Db,
	options: RecordingReaperOptions = {},
): Promise<RecordingReaperResult> {
	const now = options.now ?? new Date();
	const requeue = options.requeue ?? enqueueRecordingProcessing;
	const audioPresent = options.audioPresent ?? audioExists;
	const result: RecordingReaperResult = { examined: 0, requeued: 0, failed: 0, skipped: 0 };

	// Operator kill switch. The reaper requeues stuck recordings and closes rows, so pausing it
	// leaves work queued for when the switch is restored rather than losing it.
	const gate = await (options.gate ?? backgroundJobsGate)();
	if (!gate.allowed) {
		logger.warn({ reason: gate.reason }, 'Recording reaper skipped: background jobs are disabled');
		return result;
	}

	const cutoffFor = (status: ReapableStatus): Date =>
		new Date(now.getTime() - REAPER_DEADLINES[status]);

	let candidates: StuckRow[];
	try {
		candidates = await db
			.select({
				id: audioRecordings.id,
				userId: audioRecordings.userId,
				status: audioRecordings.status,
				storageKey: audioRecordings.storageKey,
				updatedAt: audioRecordings.updatedAt,
			})
			.from(audioRecordings)
			.where(
				and(
					// A soft-deleted row is the user's own deletion; it is not recovered.
					isNull(audioRecordings.deletedAt),
					or(
						and(
							eq(audioRecordings.status, RECORDING_STATUS.recording),
							lt(audioRecordings.updatedAt, cutoffFor('recording')),
						),
						and(
							eq(audioRecordings.status, RECORDING_STATUS.uploaded),
							lt(audioRecordings.updatedAt, cutoffFor('uploaded')),
						),
						and(
							eq(audioRecordings.status, RECORDING_STATUS.processing),
							lt(audioRecordings.updatedAt, cutoffFor('processing')),
						),
					),
				),
			)
			.limit(MAX_ROWS_PER_RUN);
	} catch (error) {
		logger.error({ err: error }, 'Recording reaper: the scan failed');
		return result;
	}

	result.examined = candidates.length;

	for (const row of candidates) {
		// The SQL predicate above is the real filter. This is the same rule applied
		// again so that a row which changed between the read and this loop — and any
		// driver that ignores `where` — cannot be acted on.
		if (!isStaleForReaper(row.status, row.updatedAt, now)) continue;

		if (row.status === RECORDING_STATUS.recording) {
			// Capture never produced audio, so there is nothing to transcribe and
			// nothing to upload against. Close it rather than leaving it live forever.
			await closeAtFailed(row, 'capture-abandoned', result);
			continue;
		}

		if (isPipelineInFlight(row.id)) {
			result.skipped += 1;
			logger.warn(
				{ recordingId: row.id, status: row.status },
				'Recording reaper: this process is already running the recording; leaving it alone',
			);
			continue;
		}

		let present = false;
		try {
			present = await audioPresent(row.storageKey);
		} catch (error) {
			present = false;
			logger.error(
				{ err: error, recordingId: row.id },
				'Recording reaper: the storage check threw; treating the audio as absent',
			);
		}

		if (!present) {
			// Re-enqueueing this would only produce `audio-unreadable`. Say so now,
			// with a status the client can see.
			await closeAtFailed(
				row,
				row.status === RECORDING_STATUS.uploaded
					? 'audio-missing-after-upload'
					: 'audio-missing-while-processing',
				result,
			);
			continue;
		}

		try {
			requeue(row.id, row.userId);
			result.requeued += 1;
			logger.warn(
				{ recordingId: row.id, userId: row.userId, status: row.status },
				'Recording reaper: re-enqueued a recording whose run never finished',
			);
		} catch (error) {
			result.skipped += 1;
			logger.error(
				{ err: error, recordingId: row.id },
				'Recording reaper: could not re-enqueue the recording',
			);
		}
	}

	if (result.requeued > 0 || result.failed > 0 || result.skipped > 0) {
		logger.info(result, 'Recording reaper completed');
	}

	return result;
}

/**
 * Closes one row at `failed` through the pipeline's own failure path, so the
 * "Save recordings" promise is honoured exactly as it is for a run that fails by
 * itself (see `fail()` in `services/recording-pipeline.ts`).
 */
async function closeAtFailed(
	row: StuckRow,
	reason: string,
	result: RecordingReaperResult,
): Promise<void> {
	try {
		await failStuckRecording(row.id, row.userId, reason);
		result.failed += 1;
	} catch (error) {
		result.skipped += 1;
		logger.error(
			{ err: error, recordingId: row.id, reason },
			'Recording reaper: could not close the recording',
		);
	}
}

/**
 * How often the sweep runs once started. Short relative to the deadlines: the
 * point is that a stranded recording is adopted soon after the client dies, not
 * that the sweep is cheap.
 */
const REAPER_INTERVAL_MS = 5 * MINUTE_MS;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic sweep. Called once from the API's boot path, and not under
 * test, so a suite cannot race a background timer against its own fixtures.
 *
 * The first pass is deferred rather than run inline, so a slow storage backend
 * cannot delay the server from accepting requests. `unref()` keeps the timer from
 * holding the process open during a graceful shutdown.
 */
export function startRecordingReaper(getDbInstance: () => Db): void {
	if (timer) return;
	timer = setInterval(() => {
		void runRecordingReaper(getDbInstance()).catch((error) => {
			logger.error({ err: error }, 'Recording reaper threw');
		});
	}, REAPER_INTERVAL_MS);
	timer.unref?.();
}

/** Exposed for tests and for a graceful shutdown hook. */
export function stopRecordingReaper(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}
