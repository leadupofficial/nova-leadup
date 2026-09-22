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
import { eq, desc, and, gte, lte, sql, gt, lt, asc, getTableColumns } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import {
	CreateReminderSchema,
	UpdateReminderSchema,
	ReminderListQuerySchema,
	parseCursorPagination,
	type CursorPaginationInput,
} from '../schemas/index.js';
import { decodeKeysetCursor, encodeKeysetCursor, keysetWhere } from '../utils/pagination.js';
import {
	findRecentReminder,
	findReminderByDedupeKey,
	idempotencyDedupeKey,
	readIdempotencyKey,
	reminderDedupeKey,
} from '../services/create-dedupe.js';

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
			// Keyset on `(created_at, id)` — see the same fix in tasks.ts.
			let cursor;
			try {
				cursor = decodeKeysetCursor(q.cursor);
			} catch {
				throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
			}
			whereClauses.push(keysetWhere(reminders.createdAt, cursorColumn, cursor, q.direction));
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
		const last = pageData[pageData.length - 1];
		const first = pageData[0];

		res.status(200).json({
			success: true,
			data: {
				reminders: pageData,
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

		const now = new Date();
		const idempotencyKey = readIdempotencyKey(req, body);
		const dedupeKey = idempotencyKey
			? idempotencyDedupeKey(userId, idempotencyKey)
			: reminderDedupeKey(userId, body.title, triggerAt, now);

		// `ON CONFLICT (dedupe_key)` rather than a SELECT followed by an INSERT.
		// Five concurrent identical requests all pass a pre-flight SELECT before
		// any of them commits, so that shape still files five reminders; here the
		// unique index picks the winner and the losers are handed its row.
		const inserted = await db.insert(reminders).values({
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
			dedupeKey,
			createdAt: now,
		}).onConflictDoUpdate({
			// A deliberately inert update: the point is to return the row that
			// already exists, not to change it. `trigger_at` in particular is not
			// touched — that would fire the postponement journal trigger in
			// `drizzle/0004_*.sql` and record a change the user never made.
			target: reminders.dedupeKey,
			set: { dedupeKey: sql`excluded.dedupe_key` },
		}).returning({
			...getTableColumns(reminders),
			// True when this statement updated a conflicting row instead of
			// inserting one — the caller can then tell a retry from a create.
			deduplicated: sql<boolean>`(xmax <> 0)`,
		});

		const row = inserted[0];
		if (row) {
			const { deduplicated, ...reminder } = row;
			logger.info(
				{ reminderId: reminder.id, userId, triggerAt, deduplicated },
				deduplicated ? 'Reminder create deduplicated' : 'Reminder created',
			);
			res.status(deduplicated ? 200 : 201).json({ success: true, deduplicated, data: reminder });
			return;
		}

		// No row returned means the database's dedupe trigger suppressed the
		// insert: the same reminder was filed inside the window. Answer with that
		// row — a retry is a success, and the caller can see it was absorbed.
		const existing = (await findReminderByDedupeKey(db, userId, dedupeKey))
			?? (await findRecentReminder(db, userId, body.title, triggerAt, now));
		if (!existing) {
			throw new HttpError(
				500,
				'Duplicate reminder was suppressed but the existing row could not be read',
				'DEDUPE_INCONSISTENT',
			);
		}

		logger.info({ reminderId: existing.id, userId, triggerAt }, 'Reminder create deduplicated');
		res.status(200).json({ success: true, deduplicated: true, data: existing });
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

/**
 * `POST /reminders/:id/acknowledge` — the app reporting that the user saw this reminder.
 *
 * ## Why this endpoint has to exist
 *
 * `reminders.triggered_at` was added with the table and **nothing ever wrote it**. The
 * consequence was not cosmetic: the Admin Control Center's "reminders executed" figure
 * could not be computed and reported NOT AVAILABLE, and the reminder revision history had
 * no "fired" step, so a reminder the user actually saw and one that quietly came due were
 * the same row. The column is the instrumentation; this is its writer.
 *
 * ## What it does and does not claim
 *
 * The alarm is armed by the OS (`flutter_local_notifications`), so it fires with the app
 * closed and the app cannot report the instant it fires. What *is* observable is the user
 * opening the notification, so that is what this records — and the field, the metric label
 * and the console copy all say "acknowledged" rather than "delivered". Claiming delivery
 * from a tap would overstate it; claiming nothing is why the column sat empty.
 *
 * `triggered_at` is set **only when it is still NULL**, matching the column's documented
 * meaning ("the first time it went off" — nothing server-side advances `trigger_at` for a
 * recurring reminder, the client re-arms from the rule). So this is idempotent: a second
 * acknowledgement is a 200 that reports it changed nothing, rather than a new timestamp
 * that would make the journal read as two deliveries.
 *
 * ## The journal row is written by a trigger, not by this handler
 *
 * `drizzle/0010_reminder_delivery.sql` installs `reminders_triggered_change`, which appends
 * a `reminder_events` row on the NULL → non-NULL transition. That mirrors the `trigger_at`
 * journal in 0004, which states plainly that application code must not also insert or every
 * change is counted twice. Do not add an insert here.
 */
router.post(
	'/:id/acknowledge',
	authenticate,
	validate(z.object({}).strict()),
	async (req: AuthenticatedRequest, res, next) => {
		try {
			const id = parseId(req.params.id);
			const db = getDb();
			const userId = req.user!.id;

			const [existing] = await db.select().from(reminders)
				.where(and(eq(reminders.id, id), eq(reminders.userId, userId)))
				.limit(1);
			if (!existing) {
				throw new HttpError(404, 'Reminder not found', 'NOT_FOUND');
			}

			if (existing.triggeredAt) {
				res.status(200).json({
					success: true,
					data: {
						id,
						triggeredAt: existing.triggeredAt.toISOString(),
						firstAcknowledgement: false,
						note:
							'This reminder was already acknowledged, so nothing changed. A repeat acknowledgement is not an error — a user can open the same notification twice.',
					},
				});
				return;
			}

			// The `triggered_at IS NULL` predicate repeats the check above inside the
			// statement, so two concurrent acknowledgements cannot both win: the loser
			// updates no rows and reports `firstAcknowledgement: false` instead of
			// overwriting the winner's timestamp.
			const updated = await db
				.update(reminders)
				.set({ triggeredAt: new Date() })
				.where(and(eq(reminders.id, id), eq(reminders.userId, userId), sql`${reminders.triggeredAt} IS NULL`))
				.returning();

			const row = updated[0];
			if (!row?.triggeredAt) {
				// Unreachable in practice: the row existed and its `triggered_at` was NULL a
				// moment ago, so either this request or a concurrent one set it. Reported as a
				// no-op rather than a 500, because "someone else already recorded it" is not
				// an error the client should retry.
				res.status(200).json({
					success: true,
					data: {
						id,
						triggeredAt: null,
						firstAcknowledgement: false,
						note: 'A concurrent acknowledgement won the race, so nothing changed here.',
					},
				});
				return;
			}

			res.status(200).json({
				success: true,
				data: {
					id,
					triggeredAt: row.triggeredAt.toISOString(),
					firstAcknowledgement: true,
					note:
						'Recorded as the first acknowledgement of this reminder. A recurring reminder counts once: the client re-arms each occurrence from the repeat rule, and nothing server-side advances `trigger_at`, so the server cannot distinguish the second firing from the first.',
				},
			});
		} catch (err) { next(err); }
	},
);

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
