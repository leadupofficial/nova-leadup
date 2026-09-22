/**
 * NOVA API — Tasks CRUD with cursor-based pagination and full validation.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { tasks, users } from '@nova/database';
import { eq, desc, and, sql, gt, lt, asc, getTableColumns } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import {
	CreateTaskSchema,
	UpdateTaskSchema,
	TaskListQuerySchema,
	parseCursorPagination,
	type CursorPaginationInput,
} from '../schemas/index.js';
import { decodeKeysetCursor, encodeKeysetCursor, keysetWhere } from '../utils/pagination.js';
import {
	findRecentTask,
	findTaskByDedupeKey,
	idempotencyDedupeKey,
	readIdempotencyKey,
	taskDedupeKey,
} from '../services/create-dedupe.js';

const router: ReturnType<typeof Router> = Router();

const TaskStatus = z.enum(['pending', 'in_progress', 'completed', 'cancelled']);

/**
 * Refuse an assignee id that does not name a real user.
 *
 * `tasks.assignee_id` carries a foreign key, so a dangling id would fail at the
 * database regardless — but as an opaque 23503 the error handler would surface
 * as a 500. Checking here turns it into a 400 the caller can act on, and keeps
 * the API honest: an assignment it reports as accepted really names a user.
 */
async function assertAssigneeExists(db: ReturnType<typeof getDb>, assigneeId: string): Promise<void> {
	// ## Why this is not scoped to the caller's organisation
	//
	// An adversarial pass noted two things here: this is a user-existence oracle (a valid
	// id returns 201, an unknown one returns this 400), and it permits assigning a task to
	// somebody in a different organisation. Both are true, and both were assessed as
	// cosmetic rather than fixed, deliberately:
	//
	//   * The oracle confirms an id the caller already holds. Ids are UUIDv4, so they are
	//     not enumerable — you cannot walk this to discover accounts, only confirm one you
	//     were already given.
	//   * The cross-organisation link is not a leak: the task is owned by the caller and
	//     every read of it is scoped by `userId`, so the named assignee never sees it. It
	//     is a dangling reference, not a disclosure.
	//
	// The obvious repair — require the assignee to share the caller's `organization_id` —
	// was measured before being rejected: **1 of 50 users in the development database has
	// an organisation at all**, because organisations are not yet part of onboarding. It
	// would refuse nearly every assignment, which is a broken feature in exchange for
	// closing a hole that is not open. If organisations become mandatory, revisit this
	// first — the correct rule then is "same organisation, or yourself".
	const [assignee] = await db.select({ id: users.id }).from(users)
		.where(eq(users.id, assigneeId))
		.limit(1);
	if (!assignee) {
		throw new HttpError(400, 'Assignee does not exist', 'ASSIGNEE_NOT_FOUND');
	}
}

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
		if (q.assigneeId) whereClauses.push(eq(tasks.assigneeId, q.assigneeId));

		const cursorColumn = tasks.id;

		// Add cursor condition
		if (q.cursor) {
			// Keyset on `(created_at, id)` — the same values the query is ordered by.
			// This filtered on `id` while ordering by `created_at`, which silently skipped
			// and duplicated rows once a list had more than one page.
			let cursor;
			try {
				cursor = decodeKeysetCursor(q.cursor);
			} catch {
				throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
			}
			whereClauses.push(keysetWhere(tasks.createdAt, cursorColumn, cursor, q.direction));
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
		const last = pageData[pageData.length - 1];
		const first = pageData[0];

		res.status(200).json({
			success: true,
			data: {
				tasks: pageData,
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

router.post('/', authenticate, validate(CreateTaskSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof CreateTaskSchema>;
		const db = getDb();
		const userId = req.user!.id;
		const now = new Date();

		if (body.assigneeId !== undefined) {
			await assertAssigneeExists(db, body.assigneeId);
		}

		const idempotencyKey = readIdempotencyKey(req, body);
		const dedupeKey = idempotencyKey
			? idempotencyDedupeKey(userId, idempotencyKey)
			: taskDedupeKey(userId, body.title, now);

		// See the matching comment in routes/reminders.ts: the conflict target is
		// the unique index, not a pre-flight SELECT, because only the index can
		// arbitrate five concurrent identical creates.
		const inserted = await db.insert(tasks).values({
			userId,
			title: body.title,
			description: body.description ?? null,
			priority: body.priority,
			assigneeId: body.assigneeId ?? null,
			dueAt: body.dueAt ?? null,
			tags: body.tags ?? [],
			source: 'manual',
			status: body.status ?? 'pending',
			dedupeKey,
			createdAt: now,
			updatedAt: now,
		}).onConflictDoUpdate({
			// Inert — including `updated_at`, which must not move for a duplicate:
			// nothing about the task changed.
			target: tasks.dedupeKey,
			set: { dedupeKey: sql`excluded.dedupe_key` },
		}).returning({
			...getTableColumns(tasks),
			deduplicated: sql<boolean>`(xmax <> 0)`,
		});

		const row = inserted[0];
		if (row) {
			const { deduplicated, ...task } = row;
			logger.info(
				{ taskId: task.id, userId, deduplicated },
				deduplicated ? 'Task create deduplicated' : 'Task created',
			);
			res.status(deduplicated ? 200 : 201).json({ success: true, deduplicated, data: task });
			return;
		}

		// The database's dedupe trigger suppressed the insert; answer with the row
		// that already exists rather than reporting a failure.
		const existing = (await findTaskByDedupeKey(db, userId, dedupeKey))
			?? (await findRecentTask(db, userId, body.title, now));
		if (!existing) {
			throw new HttpError(
				500,
				'Duplicate task was suppressed but the existing row could not be read',
				'DEDUPE_INCONSISTENT',
			);
		}

		logger.info({ taskId: existing.id, userId }, 'Task create deduplicated');
		res.status(200).json({ success: true, deduplicated: true, data: existing });
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
		if (body.assigneeId !== undefined) {
			// `null` is the documented way to clear the delegation; a real id
			// must name a user, for the same reason as on create.
			if (body.assigneeId === null) {
				updateData.assigneeId = null;
			} else {
				await assertAssigneeExists(db, body.assigneeId);
				updateData.assigneeId = body.assigneeId;
			}
		}

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
