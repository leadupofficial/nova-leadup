/**
 * NOVA API — Memories CRUD with cursor-based pagination and full validation.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { memories } from '@nova/database';
import { eq, desc, and, sql, gt, lt, asc, ilike, or } from 'drizzle-orm';
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
	decodeCursor,
	encodeCursor,
	type CursorPaginationInput,
} from '../schemas/index.js';

const router: ReturnType<typeof Router> = Router();

// ─── /memories ───────────────────────────────────────────────────────────────

router.get('/', authenticate, validate(MemoryListQuerySchema, 'query'), async (req: AuthenticatedRequest, res, next) => {
	try {
		const q = parseCursorPagination(req) as z.infer<typeof MemoryListQuerySchema>;
		const db = getDb();
		const userId = req.user!.id;

		const whereClauses = [eq(memories.userId, userId)];
		if (q.category) whereClauses.push(eq(memories.category, q.category));
		if (q.visibility) whereClauses.push(eq(memories.visibility, q.visibility));
		if (q.status) whereClauses.push(eq(memories.status, q.status));

		const where = and(...whereClauses);
		const cursorColumn = memories.id;

		if (q.cursor) {
			const decoded = decodeCursor(q.cursor);
			const cursorWhere = q.direction === 'backward'
				? lt(cursorColumn, decoded)
				: gt(cursorColumn, decoded);
			whereClauses.push(cursorWhere);
		}

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
		const lastId = pageData[pageData.length - 1]?.id;
		const firstId = pageData[0]?.id;

		res.status(200).json({
			success: true,
			data: {
				memories: pageData,
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

router.post('/', authenticate, validate(CreateMemorySchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof CreateMemorySchema>;
		const db = getDb();
		const userId = req.user!.id;
		const now = new Date();

		const [memory] = await db.insert(memories).values({
			userId,
			content: body.content,
			category: body.category,
			sourceType: body.sourceType,
			visibility: body.visibility,
			sensitivity: body.sensitivity,
			importance: body.importance,
			confidence: body.confidence,
			sourceIds: body.sourceIds ?? [],
			normalizedFacts: body.normalizedFacts ?? {},
			status: 'proposed',
			createdAt: now,
			updatedAt: now,
		}).returning();

		logger.info({ memoryId: memory.id, userId, category: body.category }, 'Memory created');
		res.status(201).json({ success: true, data: memory });
	} catch (err) { next(err); }
});

router.get('/search', authenticate, validate(MemorySearchSchema, 'query'), async (req: AuthenticatedRequest, res, next) => {
	try {
		const q = (req as any).validatedQuery as z.infer<typeof MemorySearchSchema>;
		const db = getDb();
		const userId = req.user!.id;

		const searchTerm = `%${q.query}%`;
		const whereClauses = [
			eq(memories.userId, userId),
			or(ilike(memories.content, searchTerm)),
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
