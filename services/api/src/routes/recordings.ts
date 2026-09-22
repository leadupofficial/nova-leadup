/**
 * NOVA API — Audio recordings, transcripts and summaries.
 *
 * Backed by `audio_recordings`, `transcripts`, `transcript_segments` and
 * `recording_summaries` (packages/database/src/schema.ts). Every statement is
 * scoped to `req.user!.id`; a row that exists but belongs to another user is
 * reported as 404, never 403, so the endpoint never confirms another user's
 * recordings.
 *
 * ## The pipeline these routes drive
 *
 * `POST /` creates the row; the rest of the capture pipeline — the raw audio
 * upload, the asynchronous processing request and the capability report — lives
 * in `routes/recordings-capture.ts`, and the work itself in
 * `services/recording-pipeline.ts`. The `status` column those routes write is
 * the honest lifecycle the client polls.
 *
 * List pagination follows the `/tasks`, `/reminders` and `/conversations`
 * convention: cursor over `id`, ordered by creation time, `limit + 1` to detect
 * `hasMore`.
 */
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import {
	audioRecordings,
	transcripts,
	transcriptSegments,
	recordingSummaries,
} from '@nova/database';
import { eq, desc, and, isNull, sql, gt, lt, asc } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import {
	USAGE_METRICS,
	getQuotaStore,
	recordUsage,
	requireEntitlement,
} from '../entitlements/index.js';
import {
	CreateRecordingSchema,
	UpdateRecordingSchema,
	RecordingListQuerySchema,
	parseCursorPagination,
} from '../schemas/index.js';
import { recordingCaptureRoutes } from './recordings-capture.js';
import { parseCursor, parseRecordingId as parseId, RECORDING_COLUMNS } from './recordings-shared.js';
import { decodeKeysetCursor, encodeKeysetCursor, keysetWhere } from '../utils/pagination.js';


const router: ReturnType<typeof Router> = Router();

/**
 * Transcript segments `GET /:id` will return in one response.
 *
 * The route selected every segment for the transcript with no bound. A long
 * meeting produces thousands of rows — a four-hour recording at the pipeline's
 * ~40-word segments is well past this — and all of them went into a single
 * response body, with no way for the client to tell whether it had received the
 * whole transcript. The query now asks for one more than the cap, so the response
 * can say honestly that it truncated instead of silently dropping rows.
 *
 * The constant is not a client contract: `segmentsTruncated` is.
 */
export const MAX_SEGMENTS_PER_RESPONSE = 500;

// The capture half (capabilities, audio upload, async processing) is registered
// first so its literal `/capabilities` path is matched before the `/:id`
// parameter route below, which would otherwise treat it as an id.
router.use('/', recordingCaptureRoutes);

// ─── /recordings ─────────────────────────────────────────────────────────────

router.get('/', authenticate, validate(RecordingListQuerySchema, 'query'), async (req: AuthenticatedRequest, res, next) => {
	try {
		// `parseCursorPagination` understands only cursor/limit/direction; the
		// validated query is authoritative once `validate()` has run.
		const validatedQuery = (req as unknown as { validatedQuery?: z.infer<typeof RecordingListQuerySchema> }).validatedQuery;
		const q = validatedQuery ?? (parseCursorPagination(req) as z.infer<typeof RecordingListQuerySchema>);
		const db = getDb();
		const userId = req.user!.id;

		// Soft-deleted rows are never listed.
		const whereClauses = [eq(audioRecordings.userId, userId), isNull(audioRecordings.deletedAt)];

		if (q.cursor) {
			// Keyset on `(created_at, id)`. This filtered on `id` while ordering by
			// `created_at`: with UUID keys that is not a keyset, and walking the list
			// skipped and duplicated rows (measured: 7 recordings returned 8 rows, 6
			// unique). `parseCursor` validated the shape, but the shape was the wrong one.
			let cursor;
			try {
				cursor = decodeKeysetCursor(q.cursor);
			} catch {
				throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
			}
			whereClauses.push(keysetWhere(audioRecordings.createdAt, audioRecordings.id, cursor, q.direction));
		}

		const where = and(...whereClauses);

		const [countRow] = await db.select({ count: sql<number>`count(*)` })
			.from(audioRecordings)
			.where(where);
		const total = Number(countRow?.count ?? 0);

		const orderBy = q.direction === 'backward' ? asc(audioRecordings.createdAt) : desc(audioRecordings.createdAt);
		const rows = await db.select(RECORDING_COLUMNS).from(audioRecordings)
			.where(where)
			.orderBy(orderBy)
			.limit(q.limit + 1); // +1 to detect hasMore

		const hasMore = rows.length > q.limit;
		const pageData = hasMore ? rows.slice(0, q.limit) : rows;
		const last = pageData[pageData.length - 1];
		const first = pageData[0];

		res.status(200).json({
			success: true,
			data: {
				recordings: pageData,
				pagination: {
					nextCursor: hasMore && last ? encodeKeysetCursor(last.createdAt, last.id) : null,
					prevCursor: first ? encodeKeysetCursor(first.createdAt, first.id) : null,
					hasMore,
					limit: q.limit,
					total,
				},
			},
		});
	} catch (err) { next(err); }
});

/**
 * Recording creation is entitlement-gated on `recording_seconds`.
 *
 * The gate is server-side and reads only the caller's plan and current-period
 * meter; the model is never involved. The *amount* metered is the client-reported
 * `durationSeconds`, because the audio has not been uploaded yet at this point
 * (the capture is still running) — the row is created first so the client has an
 * id to upload against. `POST /:id/audio` replaces the placeholder `storage_key`
 * with the real object key once the bytes are stored, and reports the true byte
 * count; the enforcement decision here is unaffected, because the gate asks
 * whether any allowance remains, so an under-reported duration makes the meter
 * optimistic but cannot unlock a plan whose allowance is already spent.
 */
router.post(
	'/',
	authenticate,
	requireEntitlement(getQuotaStore, USAGE_METRICS.recordingSeconds),
	validate(CreateRecordingSchema),
	async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof CreateRecordingSchema>;
		const db = getDb();
		const userId = req.user!.id;
		const now = new Date();

		const [recording] = await db.insert(audioRecordings).values({
			userId,
			title: body.title,
			language: body.language ?? null,
			participants: body.participants ?? [],
			status: 'recording',
			// `storage_key` is NOT NULL with no default, and at this moment the
			// capture is still running so no object exists yet. The placeholder is
			// scoped to its owner and is replaced by the real key in
			// `POST /:id/audio`; it is never treated as evidence of stored audio
			// (see `recordedAudioIsPresent`).
			storageKey: body.storageKey ?? `recordings/${userId}/${randomUUID()}`,
			durationSeconds: body.durationSeconds ?? null,
			consentRecorded: body.consentRecorded ?? false,
			createdAt: now,
			updatedAt: now,
		}).returning();

		// Meter what was consumed. Fire-and-forget: metering never fails the write
		// it measures (`recordUsage` swallows and logs).
		if (typeof body.durationSeconds === 'number') {
			void recordUsage(userId, USAGE_METRICS.recordingSeconds, body.durationSeconds);
		}

		logger.info({ recordingId: recording.id, userId }, 'Recording created');
		res.status(201).json({ success: true, data: recording });
	} catch (err) { next(err); }
	},
);


router.get('/:id/summary', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const id = parseId(req.params.id);
		const db = getDb();

		// Ownership is checked through the recording, because the summary row
		// itself carries no user_id.
		const [recording] = await db.select({ id: audioRecordings.id })
			.from(audioRecordings)
			.where(and(
				eq(audioRecordings.id, id),
				eq(audioRecordings.userId, req.user!.id),
				isNull(audioRecordings.deletedAt),
			))
			.limit(1);
		if (!recording) {
			throw new HttpError(404, 'Recording not found', 'NOT_FOUND');
		}

		const [summary] = await db.select().from(recordingSummaries)
			.where(eq(recordingSummaries.recordingId, id))
			.limit(1);
		if (!summary) {
			throw new HttpError(404, 'Summary not found', 'NOT_FOUND');
		}

		res.status(200).json({ success: true, data: summary });
	} catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const id = parseId(req.params.id);
		const db = getDb();
		const userId = req.user!.id;

		const [recording] = await db.select(RECORDING_COLUMNS).from(audioRecordings)
			.where(and(
				eq(audioRecordings.id, id),
				eq(audioRecordings.userId, userId),
				isNull(audioRecordings.deletedAt),
			))
			.limit(1);
		if (!recording) {
			throw new HttpError(404, 'Recording not found', 'NOT_FOUND');
		}

		const [transcript] = await db.select().from(transcripts)
			.where(eq(transcripts.recordingId, id))
			.limit(1);
		const [summary] = await db.select().from(recordingSummaries)
			.where(eq(recordingSummaries.recordingId, id))
			.limit(1);

		// Segments are the transcript's own boundaries, as the provider reported
		// them. `speakerIndex` is always 0 — there is no diarisation here — so a
		// client must not read it as a speaker number.
		//
		// Bounded (see MAX_SEGMENTS_PER_RESPONSE): one extra row is requested purely
		// to detect truncation, so the response can say `segmentsTruncated: true`
		// rather than returning a silently incomplete transcript.
		const segmentRows = transcript
			? await db.select().from(transcriptSegments)
				.where(eq(transcriptSegments.transcriptId, transcript.id))
				.orderBy(asc(transcriptSegments.startMs))
				.limit(MAX_SEGMENTS_PER_RESPONSE + 1)
			: [];
		const segmentsTruncated = segmentRows.length > MAX_SEGMENTS_PER_RESPONSE;
		const segments = segmentsTruncated ? segmentRows.slice(0, MAX_SEGMENTS_PER_RESPONSE) : segmentRows;

		res.status(200).json({
			success: true,
			data: {
				recording,
				transcript: transcript ?? null,
				summary: summary ?? null,
				segments,
				// False — not absent — when there is nothing to truncate, so a client
				// never has to distinguish "complete" from "the server did not say".
				segmentsTruncated,
			},
		});
	} catch (err) { next(err); }
});

router.patch('/:id', authenticate, validate(UpdateRecordingSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const id = parseId(req.params.id);
		const body = (req as any).validatedBody as z.infer<typeof UpdateRecordingSchema>;
		const db = getDb();
		const userId = req.user!.id;

		const [existing] = await db.select().from(audioRecordings)
			.where(and(
				eq(audioRecordings.id, id),
				eq(audioRecordings.userId, userId),
				isNull(audioRecordings.deletedAt),
			))
			.limit(1);
		if (!existing) {
			throw new HttpError(404, 'Recording not found', 'NOT_FOUND');
		}

		const now = new Date();
		const updateData: Record<string, unknown> = { updatedAt: now };
		if (body.title !== undefined) updateData.title = body.title;
		if (body.durationSeconds !== undefined) updateData.durationSeconds = body.durationSeconds;
		if (body.status !== undefined) updateData.status = body.status;
		if (body.consentRecorded !== undefined) updateData.consentRecorded = body.consentRecorded;
		// The Recording screen flips status to `completed` when capture stops.
		if (body.status === 'completed') updateData.completedAt = now;

		const [updated] = await db.update(audioRecordings)
			.set(updateData)
			.where(and(eq(audioRecordings.id, id), eq(audioRecordings.userId, userId)))
			.returning();

		res.status(200).json({ success: true, data: updated });
	} catch (err) { next(err); }
});

router.delete('/:id', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const id = parseId(req.params.id);
		const db = getDb();
		const now = new Date();

		// Soft delete. The conditional update both scopes the row to the caller
		// and makes "already deleted" and "not yours" indistinguishable as 404.
		const [deleted] = await db.update(audioRecordings)
			.set({ deletedAt: now, updatedAt: now })
			.where(and(
				eq(audioRecordings.id, id),
				eq(audioRecordings.userId, req.user!.id),
				isNull(audioRecordings.deletedAt),
			))
			.returning({ id: audioRecordings.id });
		if (!deleted) {
			throw new HttpError(404, 'Recording not found', 'NOT_FOUND');
		}

		res.status(204).send();
	} catch (err) { next(err); }
});

export { router as recordingsRoutes };
