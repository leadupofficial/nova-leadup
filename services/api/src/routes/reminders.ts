/**
 * NOVA API — Reminders CRUD, backed by the `reminders` pgTable.
 *
 * Replaces the inline echo stub that previously lived in `server.ts`. The table
 * (`packages/database/src/schema.ts`, `reminders`) is:
 *
 *   id, user_id, title, trigger_at, timezone, repeat_rule,
 *   notification_channel (jsonb), linked_task_id, linked_contact_id,
 *   source_audit, dismissed, triggered_at, created_at
 *
 * List pagination follows the same cursor convention as `/tasks`, `/memories`
 * and `/conversations`: cursor over `id`, ordered by creation time.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { reminders } from '@nova/database';
import { eq, desc, and, gte, lte, sql, gt, lt, asc } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import {
	CreateReminderSchema,
	UpdateReminderSchema,
	ReminderListQuerySchema,
	parseCursorPagination,
	decodeCursor,
	encodeCursor,
	type CursorPaginationInput,
} from '../schemas/index.js';

const router: ReturnType<typeof Router> = Router();

type Reminder = typeof reminders.$inferSelect;

const IdSchema = z.object({ id: z.string().uuid() });

function parseId(raw: string): string {
	const parsed = IdSchema.safeParse({ id: raw });
	if (!parsed.success) {
		throw new HttpError(400, 'Invalid reminder ID format', 'INVALID_ID');
	}
	return parsed.data.id;
}

// ─── /reminders ──────────────────────────────────────────────────────────────

router.get('/', authenticate, validate(ReminderListQuerySchema, 'query'), async (req: AuthenticatedRequest, res, next) => {
	try {
		// `parseCursorPagination` only understands cursor/limit/direction; the
		// filters below live on the validated query produced by `validate()`.
		const validatedQuery = (req as unknown as { validatedQuery?: z.infer<typeof ReminderListQuerySchema> }).validatedQuery;
		const q = validatedQuery ?? (parseCursorPagination(req) as z.infer<typeof ReminderListQuerySchema>);
		const db = getDb();
		const userId = req.user!.id;

		const whereClauses = [eq(reminders.userId, userId)];
		if (q.dismissed !== undefined) whereClauses.push(eq(reminders.dismissed, q.dismissed));
		if (q.from) whereClauses.push(gte(reminders.triggerAt, q.from));
		if (q.to) whereClauses.push(lte(reminders.triggerAt, q.to));

		const cursorColumn = reminders.id;
		if (q.cursor) {
			const decoded = decodeCursor(q.cursor);
			whereClauses.push(q.direction === 'backward' ? lt(cursorColumn, decoded) : gt(cursorColumn, decoded));
		}

		const where = and(...whereClauses);

		const [countRow] = await db.select({ count: sql<number>`count(*)` })
			.from(reminders)
			.where(where);
		const total = Number(countRow?.count ?? 0);

		const orderBy = q.direction === 'backward' ? asc(reminders.createdAt) : desc(reminders.createdAt);
		const rows = await db.select().from(reminders)
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
				reminders: pageData,
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

router.post('/', authenticate, validate(CreateReminderSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof CreateReminderSchema>;
		const db = getDb();
		const userId = req.user!.id;

		// The schema refine guarantees one of the aliases is present.
		const triggerAt = body.triggerAt ?? body.dueAt;
		if (!triggerAt) {
			throw new HttpError(400, 'triggerAt is required', 'VALIDATION_ERROR');
		}

		const [reminder]: Reminder[] = await db.insert(reminders).values({
			userId,
			title: body.title,
			triggerAt,
			timezone: body.timezone ?? 'Asia/Kolkata',
			repeatRule: body.repeatRule ?? null,
			notificationChannel: body.notificationChannel ?? ['push'],
			linkedTaskId: body.linkedTaskId ?? null,
			linkedContactId: body.linkedContactId ?? null,
			sourceAudit: body.sourceAudit ?? null,
			dismissed: false,
			createdAt: new Date(),
		}).returning();

		logger.info({ reminderId: reminder.id, userId, triggerAt }, 'Reminder created');
		res.status(201).json({ success: true, data: reminder });
	} catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const id = parseId(req.params.id);
		const db = getDb();

		const [reminder] = await db.select().from(reminders)
			.where(and(eq(reminders.id, id), eq(reminders.userId, req.user!.id)))
			.limit(1);
		if (!reminder) {
			throw new HttpError(404, 'Reminder not found', 'NOT_FOUND');
		}

		res.status(200).json({ success: true, data: reminder });
	} catch (err) { next(err); }
});

router.patch('/:id', authenticate, validate(UpdateReminderSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const id = parseId(req.params.id);
		const body = (req as any).validatedBody as z.infer<typeof UpdateReminderSchema>;
		const db = getDb();

		const [existing] = await db.select().from(reminders)
			.where(and(eq(reminders.id, id), eq(reminders.userId, req.user!.id)))
			.limit(1);
		if (!existing) {
			throw new HttpError(404, 'Reminder not found', 'NOT_FOUND');
		}

		const updateData: Record<string, unknown> = {};
		if (body.title !== undefined) updateData.title = body.title;
		if (body.triggerAt !== undefined) updateData.triggerAt = body.triggerAt;
		if (body.timezone !== undefined) updateData.timezone = body.timezone;
		if (body.repeatRule !== undefined) updateData.repeatRule = body.repeatRule;
		if (body.notificationChannel !== undefined) updateData.notificationChannel = body.notificationChannel;
		if (body.linkedTaskId !== undefined) updateData.linkedTaskId = body.linkedTaskId;
		if (body.linkedContactId !== undefined) updateData.linkedContactId = body.linkedContactId;
		if (body.sourceAudit !== undefined) updateData.sourceAudit = body.sourceAudit;
		if (body.dismissed !== undefined) updateData.dismissed = body.dismissed;

		// `reminders` has no updated_at column, so an empty patch is a no-op rather
		// than an invalid `SET` with no assignments.
		if (Object.keys(updateData).length === 0) {
			res.status(200).json({ success: true, data: existing });
			return;
		}

		const [updated]: Reminder[] = await db.update(reminders)
			.set(updateData)
			.where(and(eq(reminders.id, id), eq(reminders.userId, req.user!.id)))
			.returning();

		res.status(200).json({ success: true, data: updated });
	} catch (err) { next(err); }
});

router.delete('/:id', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const id = parseId(req.params.id);
		const db = getDb();

		const [existing] = await db.select().from(reminders)
			.where(and(eq(reminders.id, id), eq(reminders.userId, req.user!.id)))
			.limit(1);
		if (!existing) {
			throw new HttpError(404, 'Reminder not found', 'NOT_FOUND');
		}

		await db.delete(reminders).where(and(eq(reminders.id, id), eq(reminders.userId, req.user!.id)));
		res.status(204).send();
	} catch (err) { next(err); }
});

export { router as remindersRoutes };
