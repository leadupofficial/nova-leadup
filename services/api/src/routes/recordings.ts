/**
 * NOVA API — Audio recordings, transcripts and summaries.
 *
 * Backed by `audio_recordings`, `transcripts` and `recording_summaries`
 * (packages/database/src/schema.ts). Every statement is scoped to
 * `req.user!.id`; a row that exists but belongs to another user is reported as
 * 404, never 403, so the endpoint never confirms another user's recordings.
 *
 * List pagination follows the `/tasks`, `/reminders` and `/conversations`
 * convention: cursor over `id`, ordered by creation time, `limit + 1` to detect
 * `hasMore`.
 */
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { audioRecordings, transcripts, recordingSummaries } from '@nova/database';
import { eq, desc, and, isNull, sql, gt, lt, asc } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import {
	CreateRecordingSchema,
	UpdateRecordingSchema,
	RecordingListQuerySchema,
	parseCursorPagination,
	decodeCursor,
	encodeCursor,
} from '../schemas/index.js';

const router: ReturnType<typeof Router> = Router();

const IdSchema = z.object({ id: z.string().uuid() });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseId(raw: string): string {
	const parsed = IdSchema.safeParse({ id: raw });
	if (!parsed.success) {
		throw new HttpError(400, 'Invalid recording ID format', 'INVALID_ID');
	}
	return parsed.data.id;
}

/**
 * Decode a list cursor and reject non-UUID payloads before they reach Postgres,
 * where `id > 'not-a-uuid'` would surface as a 500 rather than a 400.
 */
function parseCursor(raw: string): string {
	let id: string;
	try {
		id = decodeCursor(raw);
	} catch {
		throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
	}
	if (!UUID_RE.test(id)) {
		throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
	}
	return id;
}

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
			const decoded = parseCursor(q.cursor);
			whereClauses.push(q.direction === 'backward'
				? lt(audioRecordings.id, decoded)
				: gt(audioRecordings.id, decoded));
		}

		const where = and(...whereClauses);

		const [countRow] = await db.select({ count: sql<number>`count(*)` })
			.from(audioRecordings)
			.where(where);
		const total = Number(countRow?.count ?? 0);

		const orderBy = q.direction === 'backward' ? asc(audioRecordings.createdAt) : desc(audioRecordings.createdAt);
		const rows = await db.select().from(audioRecordings)
			.where(where)
			.orderBy(orderBy)
			.limit(q.limit + 1); // +1 to detect hasMore

		const hasMore = rows.length > q.limit;
		const pageData = hasMore ? rows.slice(0, q.limit) : rows;
		const lastId = pageData[pageData.length - 1]?.id;
		const firstId = pageData[0]?.id;

		res.status(200).json({
			success: true,
			data: {
				recordings: pageData,
				pagination: {
					nextCursor: hasMore ? encodeCursor(lastId) : null,
					prevCursor: firstId ? encodeCursor(firstId) : null,
					hasMore,
					limit: q.limit,
					total,
				},
			},
		});
	} catch (err) { next(err); }
});

router.post('/', authenticate, validate(CreateRecordingSchema), async (req: AuthenticatedRequest, res, next) => {
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
			// `storage_key` is NOT NULL and has no default. Until the upload
			// pipeline writes the real object key, the row carries a placeholder
			// scoped to its owner rather than failing the insert.
			storageKey: body.storageKey ?? `recordings/${userId}/${randomUUID()}`,
			durationSeconds: body.durationSeconds ?? null,
			consentRecorded: body.consentRecorded ?? false,
			createdAt: now,
			updatedAt: now,
		}).returning();

		logger.info({ recordingId: recording.id, userId }, 'Recording created');
		res.status(201).json({ success: true, data: recording });
	} catch (err) { next(err); }
});

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

		const [recording] = await db.select().from(audioRecordings)
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

		res.status(200).json({
			success: true,
			data: {
				recording,
				transcript: transcript ?? null,
				summary: summary ?? null,
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
