/**
 * NOVA API — Memories CRUD with cursor-based pagination and full validation.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { memories } from '@nova/database';
import { eq, desc, and, sql, gt, lt, asc } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import {
	CreateMemorySchema,
	UpdateMemorySchema,
	MemorySearchSchema,
	MemoryListQuerySchema,
	parseCursorPagination,
	type CursorPaginationInput,
} from '../schemas/index.js';
import { decodeKeysetCursor, encodeKeysetCursor, keysetWhere } from '../utils/pagination.js';
// One domain function owns "save a memory" and "search memories". The route used to
// do both itself, which is what made `createMemory`'s embedding hook unreachable.
import { createMemory, memoryContentMatches } from '../services/memory.js';

const router: ReturnType<typeof Router> = Router();

// ─── /memories ───────────────────────────────────────────────────────────────

router.get('/', authenticate, validate(MemoryListQuerySchema, 'query'), async (req: AuthenticatedRequest, res, next) => {
	try {
		// `validatedQuery`, not `parseCursorPagination`. The schema-validated object holds
		// the filters this route declares; `parseCursorPagination` in `schemas/index.ts`
		// reads `req.query` directly and returns only `cursor`/`limit`/`direction`, so
		// `category`, `visibility` and `status` were accepted and then silently discarded —
		// `GET /memories?category=contact` returned every category.
		const validatedQuery = (req as unknown as Record<string, unknown>).validatedQuery as
			| z.infer<typeof MemoryListQuerySchema>
			| undefined;
		const q = validatedQuery ?? (parseCursorPagination(req) as z.infer<typeof MemoryListQuerySchema>);
		const db = getDb();
		const userId = req.user!.id;

		const whereClauses = [eq(memories.userId, userId)];
		if (q.category) whereClauses.push(eq(memories.category, q.category));
		if (q.visibility) whereClauses.push(eq(memories.visibility, q.visibility));
		if (q.status) whereClauses.push(eq(memories.status, q.status));

		// `?search=` was documented by the mobile client and silently dropped by
		// this schema — zod strips unknown keys — so the app's memory search box
		// returned the whole unfiltered list. The list owns the filter now, and the
		// term is escaped so `%`/`_` are literal characters rather than wildcards.
		const searchTerm = q.search?.trim();
		if (searchTerm) whereClauses.push(memoryContentMatches(searchTerm));

		// The cursor clause has to be pushed **before** `where` is built. It used to be
		// pushed after, so `and(...whereClauses)` had already been evaluated without it
		// and the cursor was ignored entirely: page two came back identical to page one,
		// and a client following `nextCursor` looped forever.
		const cursorColumn = memories.id;
		if (q.cursor) {
			let cursor;
			try {
				cursor = decodeKeysetCursor(q.cursor);
			} catch {
				throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
			}
			whereClauses.push(keysetWhere(memories.createdAt, cursorColumn, cursor, q.direction));
		}

		const where = and(...whereClauses);

		const [countRow] = await db.select({ count: sql<number>`count(*)` })
			.from(memories)
			.where(where);
		const total = Number(countRow?.count ?? 0);

		const orderBy = q.direction === 'backward' ? asc(memories.createdAt) : desc(memories.createdAt);
		const rows = await db.select().from(memories)
			.where(where)
			.orderBy(orderBy)
			.limit(q.limit + 1);

		const hasMore = rows.length > q.limit;
		const pageData = hasMore ? rows.slice(0, q.limit) : rows;
		const last = pageData[pageData.length - 1];
		const first = pageData[0];

		res.status(200).json({
			success: true,
			data: {
				memories: pageData,
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

router.post('/', authenticate, validate(CreateMemorySchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof CreateMemorySchema>;
		const userId = req.user!.id;

		// Routed through the domain service rather than inserting here. This route
		// wrote its own row, so `createMemory` — the only caller of `storeEmbedding`
		// — was unreachable dead code on the app's real write path, and no memory
		// ever got an embedding. `createMemory` also owns the "Save memories"
		// privacy check, so the duplicate check that used to live here is gone
		// rather than merely moved; it throws the same 409/MEMORY_SAVING_DISABLED.
		const memory = await createMemory({
			userId,
			category: body.category,
			content: body.content,
			sourceType: body.sourceType,
			visibility: body.visibility,
			sensitivity: body.sensitivity,
			importance: body.importance,
			confidence: body.confidence,
			sourceIds: body.sourceIds,
			normalizedFacts: body.normalizedFacts,
		});

		logger.info({ memoryId: memory.id, userId, category: body.category }, 'Memory created');
		res.status(201).json({ success: true, data: memory });
	} catch (err) { next(err); }
});

router.get('/search', authenticate, validate(MemorySearchSchema, 'query'), async (req: AuthenticatedRequest, res, next) => {
	try {
		const q = (req as any).validatedQuery as z.infer<typeof MemorySearchSchema>;
		const db = getDb();
		const userId = req.user!.id;

		// The term is trimmed, rejected when empty, and escaped before it becomes a
		// pattern. `%${q.query}%` passed the raw value through, so `?query=%`
		// matched every memory the user owned (an unbounded sequential scan whose
		// result set had nothing to do with the search) and `?query=_` matched any
		// single character.
		const searchTerm = q.query.trim();
		if (!searchTerm) {
			throw new HttpError(400, 'The search query must contain at least one non-whitespace character', 'INVALID_SEARCH_TERM');
		}

		const whereClauses = [
			eq(memories.userId, userId),
			memoryContentMatches(searchTerm),
		];
		if (q.category) whereClauses.push(eq(memories.category, q.category));
		if (q.visibility) whereClauses.push(eq(memories.visibility, q.visibility));
		if (q.minConfidence !== undefined) whereClauses.push(sql`${memories.confidence} >= ${q.minConfidence}`);
		if (q.status) whereClauses.push(eq(memories.status, q.status));

		const where = and(...whereClauses);

		const [countRow] = await db.select({ count: sql<number>`count(*)` })
			.from(memories)
			.where(where);
		const total = Number(countRow?.count ?? 0);

		const rows = await db.select().from(memories)
			.where(where)
			.orderBy(desc(memories.createdAt))
			.limit(q.limit)
			.offset(q.offset);

		res.status(200).json({
			success: true,
			data: {
				memories: rows,
				pagination: {
					limit: q.limit,
					offset: q.offset,
					total,
					totalPages: Math.ceil(total / q.limit) || 1,
				},
			},
		});
	} catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const { id } = req.params;
		const idSchema = z.object({ id: z.string().uuid() });
		const parsed = idSchema.safeParse({ id });
		if (!parsed.success) {
			throw new HttpError(400, 'Invalid memory ID format', 'INVALID_ID');
		}

		const db = getDb();
		const [memory] = await db.select().from(memories)
			.where(and(eq(memories.id, parsed.data.id), eq(memories.userId, req.user!.id)))
			.limit(1);
		if (!memory) {
			throw new HttpError(404, 'Memory not found', 'NOT_FOUND');
		}
		res.status(200).json({ success: true, data: memory });
	} catch (err) { next(err); }
});

router.patch('/:id', authenticate, validate(UpdateMemorySchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const { id } = req.params;
		const idSchema = z.object({ id: z.string().uuid() });
		const parsed = idSchema.safeParse({ id });
		if (!parsed.success) {
			throw new HttpError(400, 'Invalid memory ID format', 'INVALID_ID');
		}

		const body = (req as any).validatedBody as z.infer<typeof UpdateMemorySchema>;
		const db = getDb();

		const [existing] = await db.select().from(memories)
			.where(and(eq(memories.id, parsed.data.id), eq(memories.userId, req.user!.id)))
			.limit(1);
		if (!existing) {
			throw new HttpError(404, 'Memory not found', 'NOT_FOUND');
		}

		const [updated] = await db.update(memories)
			.set({
				...(body.content !== undefined && { content: body.content }),
				...(body.category !== undefined && { category: body.category }),
				...(body.visibility !== undefined && { visibility: body.visibility }),
				...(body.sensitivity !== undefined && { sensitivity: body.sensitivity }),
				...(body.importance !== undefined && { importance: body.importance }),
				...(body.confidence !== undefined && { confidence: body.confidence }),
				...(body.status !== undefined && { status: body.status }),
				...(body.normalizedFacts !== undefined && { normalizedFacts: body.normalizedFacts }),
				updatedAt: new Date(),
			})
			.where(eq(memories.id, parsed.data.id))
			.returning();

		res.status(200).json({ success: true, data: updated });
	} catch (err) { next(err); }
});

router.delete('/:id', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const { id } = req.params;
		const idSchema = z.object({ id: z.string().uuid() });
		const parsed = idSchema.safeParse({ id });
		if (!parsed.success) {
			throw new HttpError(400, 'Invalid memory ID format', 'INVALID_ID');
		}

		const db = getDb();
		const [existing] = await db.select().from(memories)
			.where(and(eq(memories.id, parsed.data.id), eq(memories.userId, req.user!.id)))
			.limit(1);
		if (!existing) {
			throw new HttpError(404, 'Memory not found', 'NOT_FOUND');
		}

		await db.delete(memories).where(eq(memories.id, parsed.data.id));
		res.status(204).send();
	} catch (err) { next(err); }
});

export { router as memoriesRoutes };
