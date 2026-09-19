/**
 * NOVA API — Tasks CRUD with cursor-based pagination and full validation.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { tasks } from '@nova/database';
import { eq, desc, and, sql, gt, lt, asc } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import {
	CreateTaskSchema,
	UpdateTaskSchema,
	TaskListQuerySchema,
	parseCursorPagination,
	decodeCursor,
	encodeCursor,
	type CursorPaginationInput,
} from '../schemas/index.js';

const router: ReturnType<typeof Router> = Router();

const TaskStatus = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);

// ─── /tasks ──────────────────────────────────────────────────────────────────

router.get('/', authenticate, validate(TaskListQuerySchema, 'query'), async (req: AuthenticatedRequest, res, next) => {
	try {
		// `parseCursorPagination` understands only cursor/limit/direction; the
		// validated query is authoritative once `validate()` has run, so the
		// `status`/`priority` filters are actually read rather than ignored.
		const validatedQuery = (req as unknown as { validatedQuery?: z.infer<typeof TaskListQuerySchema> }).validatedQuery;
		const q = validatedQuery ?? (parseCursorPagination(req) as z.infer<typeof TaskListQuerySchema>);
		const db = getDb();
		const userId = req.user!.id;

		const whereClauses = [eq(tasks.userId, userId)];
		if (q.status) whereClauses.push(eq(tasks.status, q.status));
		if (q.priority) whereClauses.push(eq(tasks.priority, q.priority));

		const cursorColumn = tasks.id;

		// Add cursor condition
		if (q.cursor) {
			const decoded = decodeCursor(q.cursor);
			const cursorWhere = q.direction === 'backward'
				? lt(cursorColumn, decoded)
				: gt(cursorColumn, decoded);
			whereClauses.push(cursorWhere);
		}

		const where = and(...whereClauses);

		// Get total count
		const [countRow] = await db.select({ count: sql<number>`count(*)` })
			.from(tasks)
			.where(where);
		const total = Number(countRow?.count ?? 0);

		// Fetch with cursor
		const orderBy = q.direction === 'backward' ? asc(tasks.createdAt) : desc(tasks.createdAt);
		const rows = await db.select().from(tasks)
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
				tasks: pageData,
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

router.post('/', authenticate, validate(CreateTaskSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof CreateTaskSchema>;
		const db = getDb();
		const userId = req.user!.id;
		const now = new Date();

		const [task] = await db.insert(tasks).values({
			userId,
			title: body.title,
			description: body.description ?? null,
			priority: body.priority,
			dueAt: body.dueAt ?? null,
			tags: body.tags ?? [],
			source: 'manual',
			status: body.status ?? 'pending',
			createdAt: now,
			updatedAt: now,
		}).returning();

		logger.info({ taskId: task.id, userId }, 'Task created');
		res.status(201).json({ success: true, data: task });
	} catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const { id } = req.params;
		const idSchema = z.object({ id: z.string().uuid() });
		const parsed = idSchema.safeParse({ id });
		if (!parsed.success) {
			throw new HttpError(400, 'Invalid task ID format', 'INVALID_ID');
		}

		const db = getDb();
		const [task] = await db.select().from(tasks)
			.where(and(eq(tasks.id, parsed.data.id), eq(tasks.userId, req.user!.id)))
			.limit(1);
		if (!task) {
			throw new HttpError(404, 'Task not found', 'NOT_FOUND');
		}
		res.status(200).json({ success: true, data: task });
	} catch (err) { next(err); }
});

router.patch('/:id', authenticate, validate(UpdateTaskSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const { id } = req.params;
		const idSchema = z.object({ id: z.string().uuid() });
		const parsed = idSchema.safeParse({ id });
		if (!parsed.success) {
			throw new HttpError(400, 'Invalid task ID format', 'INVALID_ID');
		}

		const body = (req as any).validatedBody as z.infer<typeof UpdateTaskSchema>;
		const db = getDb();

		const [existing] = await db.select().from(tasks)
			.where(and(eq(tasks.id, parsed.data.id), eq(tasks.userId, req.user!.id)))
			.limit(1);
		if (!existing) {
			throw new HttpError(404, 'Task not found', 'NOT_FOUND');
		}

		const updateData: Record<string, unknown> = { updatedAt: new Date() };
		if (body.title !== undefined) updateData.title = body.title;
		if (body.description !== undefined) updateData.description = body.description;
		if (body.status !== undefined) updateData.status = body.status;
		if (body.priority !== undefined) updateData.priority = body.priority;
		if (body.dueAt !== undefined) updateData.dueAt = body.dueAt;
		if (body.tags !== undefined) updateData.tags = body.tags;
		if (body.assigneeId !== undefined) updateData.assigneeId = body.assigneeId;

		const [updated] = await db.update(tasks)
			.set(updateData)
			.where(and(eq(tasks.id, parsed.data.id), eq(tasks.userId, req.user!.id)))
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
			throw new HttpError(400, 'Invalid task ID format', 'INVALID_ID');
		}

		const db = getDb();
		const [existing] = await db.select().from(tasks)
			.where(and(eq(tasks.id, parsed.data.id), eq(tasks.userId, req.user!.id)))
			.limit(1);
		if (!existing) {
			throw new HttpError(404, 'Task not found', 'NOT_FOUND');
		}

		await db.delete(tasks).where(and(eq(tasks.id, parsed.data.id), eq(tasks.userId, req.user!.id)));
		res.status(204).send();
	} catch (err) { next(err); }
});

export { router as tasksRoutes };
