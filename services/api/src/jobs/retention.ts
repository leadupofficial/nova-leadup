/**
 * Retention sweep — makes the app's "Auto-delete" control real.
 *
 * `privacy_preferences` has carried `auto_delete_recordings_days` (default 30) and
 * `auto_delete_transcripts_days` (default 7) since the schema was written, and
 * `me_page.dart` renders both as working controls under **Privacy controls →
 * Auto-delete**. Nothing ever read them. A user who chose "delete recordings after 30
 * days" was told their recordings would be purged and they never were — a privacy
 * promise the product did not keep, which is worse than the missing-feature claims
 * fixed elsewhere because the user is relying on it to *remove* data.
 *
 * This module is the missing reader. It deletes the object from storage first and only
 * then stamps `deleted_at`, so a storage failure leaves the row visible and still
 * eligible for the next sweep rather than orphaning an object with no row pointing at
 * it. Everything is scoped to one user's own preference, and `NULL` means "never" —
 * matching `_RetentionRow`'s contract in `me_page.dart`, where `null` renders "Never".
 *
 * Deliberately conservative:
 *  - only recordings that are not already soft-deleted are considered;
 *  - a user with no `privacy_preferences` row is skipped entirely rather than swept at
 *    the default, so an account that never opened Privacy controls is never touched;
 *  - the sweep is bounded per run so a single pass cannot hold a transaction open over
 *    an unbounded set.
 */
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import {
	audioRecordings,
	privacyPreferences,
	recordingSummaries,
	transcripts,
} from '@nova/database';
import type { getDb } from '../db/connection.js';
import { deleteAudio } from '../services/audio-storage.js';
import { logger } from '../utils/logger.js';
import { backgroundJobsGate } from '../admin/enforcement.js';

type Db = ReturnType<typeof getDb>;

/** Recordings considered per run. The remainder are picked up by the next sweep. */
const MAX_RECORDINGS_PER_RUN = 200;

/**
 * Transcripts considered per run. `transcripts` has no `deleted_at`; deleting the row
 * is the only way to remove it, and `transcript_segments` cascades from it.
 */
const MAX_TRANSCRIPTS_PER_RUN = 500;

export interface RetentionSweepResult {
	recordingsPurged: number;
	transcriptsPurged: number;
	storageFailures: number;
}

export interface RetentionSweepOptions {
	/**
	 * Removes the stored object. Injected so the sweep can be exercised without an
	 * object store, and so a test can assert the failure path — which is the behaviour
	 * that matters most here, because a storage outage must not silently delete the row
	 * while leaving the audio in place.
	 */
	deleteObject?: (storageKey: string) => Promise<boolean>;
	/**
	 * Operator-control decision. Defaults to the real `backgroundJobsGate`; injectable so a test
	 * can assert the engine honours the decision, and so a deliberate manual backfill can run
	 * while the sweep is switched off.
	 */
	gate?: () => Promise<{ allowed: boolean; reason: string | null }>;
	now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Runs one pass. Safe to call repeatedly; never throws — a failed sweep is logged and
 * reported, because a broken retention job must not take the API down.
 */
export async function runRetentionSweep(
	db: Db,
	options: RetentionSweepOptions = {},
): Promise<RetentionSweepResult> {
	const now = options.now ?? new Date();
	const deleteObject = options.deleteObject ?? deleteAudio;
	const result: RetentionSweepResult = {
		recordingsPurged: 0,
		transcriptsPurged: 0,
		storageFailures: 0,
	};

	// Operator kill switch, checked before any read. Retention deletes data irreversibly, so
	// "the console says background jobs are off but the sweep deleted rows anyway" is the most
	// damaging version of a cosmetic control. A no-op when the switch is on.
	const gate = await (options.gate ?? backgroundJobsGate)();
	if (!gate.allowed) {
		logger.warn({ reason: gate.reason }, 'Retention sweep skipped: background jobs are disabled');
		return result;
	}

	// ── 1. Recordings past their owner's window ────────────────────────────────
	try {
		const due = await db
			.select({
				id: audioRecordings.id,
				storageKey: audioRecordings.storageKey,
				userId: audioRecordings.userId,
				createdAt: audioRecordings.createdAt,
				days: privacyPreferences.autoDeleteRecordingsDays,
			})
			.from(audioRecordings)
			.innerJoin(privacyPreferences, eq(privacyPreferences.userId, audioRecordings.userId))
			.where(
				and(
					isNull(audioRecordings.deletedAt),
					sql`${privacyPreferences.autoDeleteRecordingsDays} IS NOT NULL`,
					sql`${audioRecordings.createdAt} < now() - (${privacyPreferences.autoDeleteRecordingsDays} * interval '1 day')`,
				),
			)
			.limit(MAX_RECORDINGS_PER_RUN);

		for (const row of due) {
			// **The real driver returns `false`; it does not throw.** `deleteAudio` →
			// `s3Driver.remove` catches every error and returns a boolean, and it also
			// returns `false` when object storage is not configured. An earlier version
			// of this sweep only caught a *throwing* deleter and ignored the return
			// value, so a failed purge was stamped `deleted_at` and counted as purged —
			// the audio was orphaned with no row pointing at it, which is the exact
			// outcome the comment below claims to prevent. The test that "proved" it
			// injected a throwing deleter, a path production cannot take.
			let removed = false;
			try {
				removed = await deleteObject(row.storageKey);
			} catch (error) {
				// Some drivers may still throw; treat it exactly like a `false`.
				logger.error(
					{ err: error, recordingId: row.id, userId: row.userId },
					'Retention sweep: the storage deleter threw',
				);
			}

			if (!removed) {
				// Leave the row alone: the next sweep retries, and an object with no row
				// is far harder to find than a row with no object.
				result.storageFailures += 1;
				logger.error(
					{ recordingId: row.id, userId: row.userId, storageKey: row.storageKey },
					'Retention sweep: could not delete the stored object; leaving the row for the next pass',
				);
				continue;
			}

			await db
				.update(audioRecordings)
				.set({ deletedAt: now, updatedAt: now })
				.where(and(eq(audioRecordings.id, row.id), isNull(audioRecordings.deletedAt)));

			result.recordingsPurged += 1;
		}
	} catch (error) {
		logger.error({ err: error }, 'Retention sweep: the recordings pass failed');
	}

	// ── 2. Transcripts past their owner's window ──────────────────────────────
	//
	// A transcript belongs to a recording, so the join reaches the owner through
	// `audio_recordings`. Windows are per-user, exactly as above.
	try {
		const due = await db
			.select({ id: transcripts.id, userId: audioRecordings.userId })
			.from(transcripts)
			.innerJoin(audioRecordings, eq(audioRecordings.id, transcripts.recordingId))
			.innerJoin(privacyPreferences, eq(privacyPreferences.userId, audioRecordings.userId))
			.where(
				and(
					sql`${privacyPreferences.autoDeleteTranscriptsDays} IS NOT NULL`,
					sql`${transcripts.createdAt} < now() - (${privacyPreferences.autoDeleteTranscriptsDays} * interval '1 day')`,
				),
			)
			.limit(MAX_TRANSCRIPTS_PER_RUN);

		if (due.length > 0) {
			const ids = sql.join(due.map((row) => sql`${row.id}`), sql`, `);

			// `recording_summaries.transcript_id` is **NO ACTION**, not CASCADE —
			// `schema.ts` declares no `onDelete` on it, and the database confirms
			// `confdeltype = 'a'`. Deleting a transcript that has a saved summary
			// therefore raised 23503, and because the transcripts delete is a single
			// statement the whole batch (up to 500) was rolled back and the failure
			// swallowed into a log line: the transcript pass purged essentially
			// nothing, silently, in the common case. The pipeline writes a summary
			// whenever `saveTranscripts` is on, which is the default. So the summaries
			// are removed first, by `recording_id`, which *is* the cascading column.
			await db.delete(recordingSummaries).where(
				sql`${recordingSummaries.recordingId} IN (
					SELECT ${transcripts.recordingId} FROM ${transcripts} WHERE ${transcripts.id} IN (${ids})
				)`,
			);

			// `transcript_segments` does cascade from `transcripts`.
			await db.delete(transcripts).where(sql`${transcripts.id} IN (${ids})`);
			result.transcriptsPurged = due.length;
		}
	} catch (error) {
		logger.error({ err: error }, 'Retention sweep: the transcripts pass failed');
	}

	if (result.recordingsPurged > 0 || result.transcriptsPurged > 0 || result.storageFailures > 0) {
		logger.info(result, 'Retention sweep completed');
	}

	return result;
}

/** How often the sweep runs once started. Retention is measured in days. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the hourly sweep. Called once from the API's boot path.
 *
 * The first pass is deferred rather than run inline so a slow storage backend cannot
 * delay the server from accepting requests. `unref()` keeps the timer from holding the
 * process open during a graceful shutdown or in tests.
 */
export function startRetentionSweep(getDbInstance: () => Db): void {
	if (timer) return;
	timer = setInterval(() => {
		void runRetentionSweep(getDbInstance()).catch((error) => {
			logger.error({ err: error }, 'Retention sweep threw');
		});
	}, SWEEP_INTERVAL_MS);
	timer.unref?.();
}

/** Exposed for tests and for a graceful shutdown hook. */
export function stopRetentionSweep(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

/**
 * True when a user's stored preference means "delete after `days` days".
 *
 * Exported so a test can pin the contract the UI depends on — `null` is "Never", not
 * "use the default" — without needing a database.
 */
export function isSweepable(days: number | null | undefined, ageMs: number): boolean {
	if (days === null || days === undefined) return false;
	return ageMs > days * DAY_MS;
}
