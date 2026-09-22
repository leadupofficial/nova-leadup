/**
 * NOVA — Admin operations routes.
 *
 * The "what is NOVA actually doing for this user" surface: conversations, tasks,
 * reminders and their revision history, memory, proactive activity, background jobs,
 * notifications and realtime connections.
 *
 * Two conventions throughout:
 *
 * - **List endpoints are server-paginated and server-filtered.** Nothing loads a
 *   production table into the browser; `pageSize` is capped by the schema.
 * - **Where a signal does not exist, the response says so.** Reminder execution
 *   history, proactive trigger reasons and realtime connection counts are three
 *   areas where the platform has a table but no writer, and the payload carries a
 *   `note` explaining that rather than returning an empty array that reads as
 *   "nothing happened".
 */

import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Permission } from '../../admin/permissions.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
	conversations,
	conversationMessages,
	tasks,
	reminders,
	reminderEvents,
	memories,
	notifications,
	toolExecutions,
	jobExecutions,
} from '@nova/database';
import { getDb, getDbPool } from '../../db/connection.js';
import { retryJob } from '../../jobs/queue.js';
import { JOB_QUEUE_TIMING, workerStatus } from '../../jobs/worker.js';
import { HttpError } from '../../middleware/error-handler.js';
import { validate } from '../../middleware/validate.js';
import { type AdminRequest, adminGate, holdsPermission, requirePermission } from '../../admin/access.js';
import { auditedOperation, recordAdminAction, actorFromRequest } from '../../admin/audit.js';

const router: ReturnType<typeof Router> = Router();
router.use(adminGate);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string | undefined): value is string {
	return typeof value === 'string' && UUID_PATTERN.test(value);
}

const PageSchema = z.object({
	page: z.coerce.number().int().positive().default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ─── Conversations ───────────────────────────────────────────────────────────

const ConversationQuerySchema = PageSchema.extend({
	userId: z.string().uuid().optional(),
	mode: z.enum(['voice', 'text', 'all']).default('all'),
	search: z.string().max(200).optional(),
	from: z.string().datetime().optional(),
	to: z.string().datetime().optional(),
	minMessages: z.coerce.number().int().min(0).optional(),
});

/**
 * `GET /admin/conversations`
 *
 * Metadata only — no message text. Reading content is a separate permission and a
 * separate, audited call, so an operator with `conversations.read` can find the
 * conversation they need without seeing what was said.
 */
router.get(
	'/conversations',
	requirePermission('conversations.read'),
	validate(ConversationQuerySchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: z.infer<typeof ConversationQuerySchema> }).validatedQuery;
			const pool = getDbPool();
			const offset = (q.page - 1) * q.pageSize;

			const conditions: string[] = [];
			const params: unknown[] = [];
			if (q.userId) {
				params.push(q.userId);
				conditions.push(`c.user_id = $${params.length}`);
			}
			if (q.mode !== 'all') {
				params.push(q.mode);
				conditions.push(`c.mode = $${params.length}`);
			}
			if (q.search) {
				params.push(`%${q.search.toLowerCase()}%`);
				conditions.push(`lower(coalesce(c.title, '')) LIKE $${params.length}`);
			}
			if (q.from) {
				params.push(q.from);
				conditions.push(`c.created_at >= $${params.length}`);
			}
			if (q.to) {
				params.push(q.to);
				conditions.push(`c.created_at <= $${params.length}`);
			}

			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

			const countResult = await pool.query<{ total: string }>(
				`SELECT count(*)::int AS total FROM conversations c ${where}`,
				params,
			);
			const totalItems = Number(countResult.rows[0]?.total ?? 0);

			const rows = await pool.query(
				`SELECT c.id, c.user_id, u.email AS user_email, u.name AS user_name,
				        c.title, c.mode, c.created_at, c.updated_at, c.ended_at,
				        count(m.id)::int AS messages,
				        count(m.id) FILTER (WHERE m.role = 'user')::int AS user_messages,
				        count(m.id) FILTER (WHERE m.role = 'assistant')::int AS assistant_messages,
				        array_remove(array_agg(DISTINCT m.model), NULL) AS models,
				        COALESCE(SUM(
				          COALESCE((m.token_usage->>'inputTokens')::bigint, 0) +
				          COALESCE((m.token_usage->>'outputTokens')::bigint, 0)
				        ), 0)::bigint AS tokens,
				        max(m.created_at) AS last_message_at
				 FROM conversations c
				 LEFT JOIN conversation_messages m ON m.conversation_id = c.id
				 LEFT JOIN users u ON u.id = c.user_id
				 ${where}
				 GROUP BY c.id, u.email, u.name
				 ${q.minMessages !== undefined ? `HAVING count(m.id) >= ${q.minMessages}` : ''}
				 ORDER BY c.created_at DESC
				 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
				[...params, q.pageSize, offset],
			);

			// The title is summarised from what was said, so it is content, not metadata.
			const gated = contentGate(req, 'conversations.content_read', rows.rows, ['title']);

			res.json({
				success: true,
				data: {
					data: gated.rows.map((row) => ({
						id: row.id,
						userId: row.user_id,
						userEmail: row.user_email,
						userName: row.user_name,
						title: row.title,
						mode: row.mode,
						messages: Number(row.messages),
						userMessages: Number(row.user_messages),
						assistantMessages: Number(row.assistant_messages),
						models: row.models ?? [],
						tokens: Number(row.tokens),
						createdAt: (row.created_at as Date).toISOString(),
						updatedAt: (row.updated_at as Date).toISOString(),
						endedAt: row.ended_at ? (row.ended_at as Date).toISOString() : null,
						lastMessageAt: row.last_message_at ? (row.last_message_at as Date).toISOString() : null,
					})),
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
					contentRedacted: gated.contentRedacted,
					contentPermission: gated.contentPermission,
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

/**
 * Redacts end-user *content* from an Assistant list response unless the caller holds the
 * matching `*.content_read` permission.
 *
 * Conversations already worked this way (`conversations.read` lists shape,
 * `conversations.content_read` reads what was said). Tasks, reminders and memory did not, and
 * the gap was not theoretical: `ANALYTICS_ADMIN` is described in this platform's own role table
 * as "metrics and cost, no personal data", and it could read every user's task title and
 * description. `conversations.read` is documented as "no message text" while its list endpoint
 * returned the conversation title, which is generated from that text.
 *
 * The gate runs at the response rather than in the SQL so that the rows, the counts and the
 * pagination are identical with or without content permission. An operator without it still
 * sees that a reminder exists, when it fires, whether it failed, and who it belongs to — they
 * just do not see what the user wrote. `contentRedacted` lets the console say that out loud
 * instead of rendering an empty cell that reads as missing data.
 */
function contentGate<T extends Record<string, unknown>>(
	req: AdminRequest,
	permission: Permission,
	rows: T[],
	fields: Array<keyof T & string>,
): { rows: T[]; contentRedacted: boolean; contentPermission: Permission } {
	if (holdsPermission(req, permission)) {
		return { rows, contentRedacted: false, contentPermission: permission };
	}
	return {
		rows: rows.map((row) => {
			const copy: Record<string, unknown> = { ...row };
			for (const field of fields) copy[field] = null;
			return copy as T;
		}),
		contentRedacted: true,
		contentPermission: permission,
	};
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

const TaskQuerySchema = PageSchema.extend({
	userId: z.string().uuid().optional(),
	status: z.string().max(50).optional(),
	priority: z.string().max(50).optional(),
	overdue: z.coerce.boolean().optional(),
	search: z.string().max(200).optional(),
});

router.get(
	'/tasks',
	requirePermission('tasks.read'),
	validate(TaskQuerySchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: z.infer<typeof TaskQuerySchema> }).validatedQuery;
			const pool = getDbPool();
			const offset = (q.page - 1) * q.pageSize;

			const conditions: string[] = [];
			const params: unknown[] = [];
			if (q.userId) {
				params.push(q.userId);
				conditions.push(`t.user_id = $${params.length}`);
			}
			if (q.status) {
				params.push(q.status);
				conditions.push(`t.status = $${params.length}`);
			}
			if (q.priority) {
				params.push(q.priority);
				conditions.push(`t.priority = $${params.length}`);
			}
			if (q.overdue) {
				conditions.push(`t.status <> 'completed' AND t.due_at IS NOT NULL AND t.due_at < now()`);
			}
			if (q.search) {
				params.push(`%${q.search.toLowerCase()}%`);
				conditions.push(`lower(t.title) LIKE $${params.length}`);
			}

			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

			const countResult = await pool.query<{ total: string }>(
				`SELECT count(*)::int AS total FROM tasks t ${where}`,
				params,
			);
			const totalItems = Number(countResult.rows[0]?.total ?? 0);

			const rows = await pool.query(
				`SELECT t.id, t.user_id, u.email AS user_email, t.title, t.description, t.status,
				        t.priority, t.due_at, t.completed_at, t.source, t.tags, t.created_at,
				        CASE WHEN t.status <> 'completed' AND t.due_at IS NOT NULL AND t.due_at < now()
				             THEN true ELSE false END AS overdue,
				        (SELECT count(*)::int FROM reminders r WHERE r.linked_task_id = t.id) AS linked_reminders
				 FROM tasks t LEFT JOIN users u ON u.id = t.user_id
				 ${where}
				 ORDER BY t.created_at DESC
				 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
				[...params, q.pageSize, offset],
			);

			const gated = contentGate(req, 'tasks.content_read', rows.rows, ['title', 'description']);

			res.json({
				success: true,
				data: {
					data: gated.rows,
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
					contentRedacted: gated.contentRedacted,
					contentPermission: gated.contentPermission,
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

const TaskUpdateSchema = z
	.object({
		status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
		priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
		dueAt: z.string().datetime().nullable().optional(),
		reason: z.string().max(500).optional(),
	})
	.strict();

router.patch(
	'/tasks/:id',
	requirePermission('tasks.manage'),
	validate(TaskUpdateSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id } = req.params;
			if (!isUuid(id)) throw new HttpError(400, 'Invalid task id', 'BAD_REQUEST');
			const body = (req as unknown as { validatedBody: z.infer<typeof TaskUpdateSchema> }).validatedBody;
			const { reason, ...changes } = body;

			if (Object.keys(changes).length === 0) throw new HttpError(400, 'No changes supplied', 'BAD_REQUEST');

			const db = getDb();
			const [before] = await db
				.select({ id: tasks.id, status: tasks.status, priority: tasks.priority, dueAt: tasks.dueAt })
				.from(tasks)
				.where(eq(tasks.id, id))
				.limit(1);
			if (!before) throw new HttpError(404, 'Task not found', 'NOT_FOUND');

			const updated = await auditedOperation({
				req,
				action: 'task.update',
				permission: 'tasks.manage',
				targetType: 'task',
				targetId: id,
				reason: reason ?? null,
				before,
				run: async () => {
					const [row] = await db
						.update(tasks)
						.set({
							...(changes.status ? { status: changes.status } : {}),
							...(changes.priority ? { priority: changes.priority } : {}),
							...(changes.dueAt !== undefined
								? { dueAt: changes.dueAt ? new Date(changes.dueAt) : null }
								: {}),
							...(changes.status === 'completed' ? { completedAt: new Date() } : {}),
							updatedAt: new Date(),
						})
						.where(eq(tasks.id, id))
						.returning();
					return row;
				},
			});

			res.json({ success: true, data: updated });
		} catch (error) {
			next(error);
		}
	},
);

// ─── Reminders ───────────────────────────────────────────────────────────────

const ReminderQuerySchema = PageSchema.extend({
	userId: z.string().uuid().optional(),
	state: z.enum(['upcoming', 'overdue', 'acknowledged', 'dismissed', 'all']).default('all'),
	search: z.string().max(200).optional(),
});

/**
 * `GET /admin/reminders`
 *
 * Three independent facts about a reminder are reported, and conflating them is the
 * mistake this endpoint is written to avoid:
 *
 *  - **overdue** — `trigger_at <= now() AND NOT dismissed`. The reminder's time has
 *    passed. Nothing is claimed about whether anyone saw it.
 *  - **acknowledged** — `triggered_at IS NOT NULL`. The user *opened the notification*.
 *    Written by `POST /reminders/:id/acknowledge`, which the app calls on a tap, and
 *    journalled by the `reminders_triggered_change` trigger (migration 0010). The OS
 *    fires the alarm with the app closed, so the firing instant is not observable
 *    server-side; a tap is. `acknowledged`, not `delivered`.
 *  - **dismissed** — the user's own cancel flag.
 *
 * A reminder can be overdue and unacknowledged (the common case, and the one the
 * follow-up engine acts on), or acknowledged while still in the future if the user
 * opened a notification early. The response states the distinction once rather than
 * per row.
 */
router.get(
	'/reminders',
	requirePermission('reminders.read'),
	validate(ReminderQuerySchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: z.infer<typeof ReminderQuerySchema> }).validatedQuery;
			const pool = getDbPool();
			const offset = (q.page - 1) * q.pageSize;

			const conditions: string[] = [];
			const params: unknown[] = [];
			if (q.userId) {
				params.push(q.userId);
				conditions.push(`r.user_id = $${params.length}`);
			}
			if (q.state === 'upcoming') conditions.push(`NOT r.dismissed AND r.trigger_at > now()`);
			if (q.state === 'overdue') conditions.push(`NOT r.dismissed AND r.trigger_at <= now()`);
			if (q.state === 'dismissed') conditions.push(`r.dismissed`);
			if (q.state === 'acknowledged') conditions.push(`r.triggered_at IS NOT NULL`);
			if (q.search) {
				params.push(`%${q.search.toLowerCase()}%`);
				conditions.push(`lower(r.title) LIKE $${params.length}`);
			}

			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

			const countResult = await pool.query<{ total: string }>(
				`SELECT count(*)::int AS total FROM reminders r ${where}`,
				params,
			);
			const totalItems = Number(countResult.rows[0]?.total ?? 0);

			const rows = await pool.query(
				`SELECT r.id, r.user_id, u.email AS user_email, r.title, r.trigger_at, r.timezone,
				        r.repeat_rule, r.notification_channel, r.dismissed, r.triggered_at,
				        r.linked_task_id, r.created_at,
				        CASE WHEN NOT r.dismissed AND r.trigger_at <= now() THEN true ELSE false END AS overdue,
				        (SELECT count(*)::int FROM reminder_events e WHERE e.reminder_id = r.id) AS revisions,
				        (SELECT max(e.occurred_at) FROM reminder_events e WHERE e.reminder_id = r.id) AS last_revision_at
				 FROM reminders r LEFT JOIN users u ON u.id = r.user_id
				 ${where}
				 ORDER BY r.trigger_at DESC
				 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
				[...params, q.pageSize, offset],
			);

			const gated = contentGate(req, 'reminders.content_read', rows.rows, ['title']);

			res.json({
				success: true,
				data: {
					data: gated.rows,
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
					contentRedacted: gated.contentRedacted,
					contentPermission: gated.contentPermission,
					note:
						'"overdue" means the trigger time has passed and the reminder is not dismissed. "acknowledged" means the user opened the notification, which is the only delivery signal the platform offers: the OS fires the alarm with the app closed, so a firing is not visible here. An overdue reminder that is not acknowledged is the case the follow-up engine acts on.',
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

const ReminderUpdateSchema = z
	.object({
		triggerAt: z.string().datetime().optional(),
		dismissed: z.boolean().optional(),
		title: z.string().min(1).max(500).optional(),
		reason: z.string().max(500).optional(),
	})
	.strict();

router.patch(
	'/reminders/:id',
	requirePermission('reminders.manage'),
	validate(ReminderUpdateSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id } = req.params;
			if (!isUuid(id)) throw new HttpError(400, 'Invalid reminder id', 'BAD_REQUEST');
			const body = (req as unknown as { validatedBody: z.infer<typeof ReminderUpdateSchema> }).validatedBody;
			const { reason, ...changes } = body;
			if (Object.keys(changes).length === 0) throw new HttpError(400, 'No changes supplied', 'BAD_REQUEST');

			const db = getDb();
			const [before] = await db
				.select({
					id: reminders.id,
					title: reminders.title,
					triggerAt: reminders.triggerAt,
					dismissed: reminders.dismissed,
				})
				.from(reminders)
				.where(eq(reminders.id, id))
				.limit(1);
			if (!before) throw new HttpError(404, 'Reminder not found', 'NOT_FOUND');

			const updated = await auditedOperation({
				req,
				action: 'reminder.update',
				permission: 'reminders.manage',
				targetType: 'reminder',
				targetId: id,
				reason: reason ?? null,
				before: { ...before, triggerAt: before.triggerAt.toISOString() },
				run: async () => {
					const [row] = await db
						.update(reminders)
						.set({
							...(changes.title ? { title: changes.title } : {}),
							...(changes.triggerAt ? { triggerAt: new Date(changes.triggerAt) } : {}),
							...(changes.dismissed !== undefined ? { dismissed: changes.dismissed } : {}),
						})
						.where(eq(reminders.id, id))
						.returning();
					return row;
				},
			});

			// The `reminders_trigger_at_change` trigger journaled any time movement, so
			// read the revision the database just wrote rather than trusting the caller.
			const revisions = await db
				.select()
				.from(reminderEvents)
				.where(eq(reminderEvents.reminderId, id))
				.orderBy(desc(reminderEvents.occurredAt))
				.limit(1);

			res.json({
				success: true,
				data: {
					reminder: updated,
					latestRevision: revisions[0] ?? null,
					propagation:
						changes.triggerAt || changes.dismissed !== undefined
							? 'The mobile client reconciles its scheduled alarms on the next fetch or app resume; the OS alarm is not changed in real time.'
							: null,
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

// ─── Memory ──────────────────────────────────────────────────────────────────

const MemoryQuerySchema = PageSchema.extend({
	userId: z.string().uuid().optional(),
	category: z.string().max(50).optional(),
	minImportance: z.coerce.number().min(0).max(1).optional(),
});

router.get(
	'/memory',
	requirePermission('memory.read'),
	validate(MemoryQuerySchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: z.infer<typeof MemoryQuerySchema> }).validatedQuery;
			const pool = getDbPool();
			const offset = (q.page - 1) * q.pageSize;

			const conditions: string[] = [];
			const params: unknown[] = [];
			if (q.userId) {
				params.push(q.userId);
				conditions.push(`m.user_id = $${params.length}`);
			}
			if (q.category) {
				params.push(q.category);
				conditions.push(`m.category = $${params.length}`);
			}
			if (q.minImportance !== undefined) {
				params.push(q.minImportance);
				conditions.push(`m.importance >= $${params.length}`);
			}
			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

			const countResult = await pool.query<{ total: string }>(
				`SELECT count(*)::int AS total FROM memories m ${where}`,
				params,
			);
			const totalItems = Number(countResult.rows[0]?.total ?? 0);

			const rows = await pool.query(
				`SELECT m.id, m.user_id, u.email AS user_email, m.content, m.category, m.importance,
				        m.normalized_facts, m.source_type, m.created_at, m.updated_at
				 FROM memories m LEFT JOIN users u ON u.id = m.user_id
				 ${where}
				 ORDER BY m.created_at DESC
				 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
				[...params, q.pageSize, offset],
			);

			// Memory content is personal data; reading it is audited like conversation content.
			await recordAdminAction({
				actor: actorFromRequest(req),
				action: 'memory.list',
				permission: 'memory.read',
				targetType: 'memory',
				targetId: q.userId ?? 'all',
				outcome: 'success',
				after: { returned: rows.rows.length, filter: q.userId ?? 'unfiltered' },
			});

			const gated = contentGate(req, 'memory.content_read', rows.rows, ['content']);

			res.json({
				success: true,
				data: {
					data: gated.rows,
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
					contentRedacted: gated.contentRedacted,
					contentPermission: gated.contentPermission,
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

router.delete(
	'/memory/:id',
	requirePermission('memory.manage'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id } = req.params;
			if (!isUuid(id)) throw new HttpError(400, 'Invalid memory id', 'BAD_REQUEST');

			const db = getDb();
			const [before] = await db
				.select({ id: memories.id, userId: memories.userId, category: memories.category })
				.from(memories)
				.where(eq(memories.id, id))
				.limit(1);
			if (!before) throw new HttpError(404, 'Memory entry not found', 'NOT_FOUND');

			await auditedOperation({
				req,
				action: 'memory.delete',
				permission: 'memory.manage',
				targetType: 'memory',
				targetId: id,
				before,
				run: async () => {
					await db.delete(memories).where(eq(memories.id, id));
					return { deleted: true };
				},
			});

			res.json({ success: true, data: { deleted: true } });
		} catch (error) {
			next(error);
		}
	},
);

// ─── Proactive activity ──────────────────────────────────────────────────────

/**
 * `GET /admin/proactive`
 *
 * There is no `proactive_events` table, so this reconstructs what is knowable:
 * notifications of proactive-shaped types, and the follow-up engine's logs. It is
 * explicit that "why did NOVA decide this" is not answerable yet — that reasoning is
 * not persisted anywhere.
 */
router.get(
	'/proactive',
	requirePermission('proactive.read'),
	validate(PageSchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: z.infer<typeof PageSchema> }).validatedQuery;
			const pool = getDbPool();
			const offset = (q.page - 1) * q.pageSize;

			// Notification `type` is free text; these are the values the notification
			// service writes for assistant-initiated contact.
			const proactiveTypes = ['follow_up', 'reminder', 'proactive', 'briefing', 'nudge'];

			const countResult = await pool.query<{ total: string }>(
				`SELECT count(*)::int AS total FROM notifications WHERE type = ANY($1)`,
				[proactiveTypes],
			);
			const totalItems = Number(countResult.rows[0]?.total ?? 0);

			const rows = await pool.query(
				`SELECT n.id, n.user_id, u.email AS user_email, n.type, n.title, n.body,
				        n.read, n.read_at, n.occurred_at
				 FROM notifications n LEFT JOIN users u ON u.id = n.user_id
				 WHERE n.type = ANY($1)
				 ORDER BY n.occurred_at DESC
				 LIMIT $2 OFFSET $3`,
				[proactiveTypes, q.pageSize, offset],
			);

			const byType = await pool.query(
				`SELECT type, count(*)::int AS count, count(*) FILTER (WHERE read)::int AS read
				 FROM notifications WHERE type = ANY($1) GROUP BY type ORDER BY count DESC`,
				[proactiveTypes],
			);

			res.json({
				success: true,
				data: {
					events: rows.rows,
					byType: byType.rows,
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
					limitations: [
						'There is no proactive-event table, so a proactive interaction is only observable if it produced a notification. A proactive turn that failed before delivery leaves no trace.',
						'The trigger reason and the context NOVA used to decide to act are not persisted, so "why did NOVA reach out" cannot be answered from stored data.',
						'Delivery and dismissal are approximated by the notification row\'s `read` / `read_at`, which reflects the user opening it in the app.',
					],
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

// ─── Background jobs ─────────────────────────────────────────────────────────

const JobQuerySchema = PageSchema.extend({
	status: z.enum(['queued', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled']).optional(),
	jobName: z.string().max(100).optional(),
	userId: z.string().uuid().optional(),
});

router.get(
	'/jobs',
	requirePermission('jobs.read'),
	validate(JobQuerySchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: z.infer<typeof JobQuerySchema> }).validatedQuery;
			const offset = (q.page - 1) * q.pageSize;
			const pool = getDbPool();

			const conditions: string[] = [];
			const params: unknown[] = [];
			if (q.status) {
				params.push(q.status);
				conditions.push(`j.status = $${params.length}`);
			}
			if (q.jobName) {
				params.push(`%${q.jobName.toLowerCase()}%`);
				conditions.push(`lower(j.job_name) LIKE $${params.length}`);
			}
			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

			const [totals, rows, worker] = await Promise.all([
				pool.query<{ total: string }>(`SELECT count(*)::int AS total FROM job_executions j ${where}`, params),
				pool.query(
					`SELECT j.id, j.job_name, j.queue_name, j.worker_id, j.status, j.user_id, u.email AS user_email,
					        j.related_type, j.related_id, j.attempt, j.max_attempts, j.error_message,
					        j.duration_ms, j.request_id, j.started_at, j.finished_at, j.run_at, j.enqueued_by,
					        j.created_at
					 FROM job_executions j
					 LEFT JOIN users u ON u.id = j.user_id
					 ${where}
					 ORDER BY j.created_at DESC
					 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
					[...params, q.pageSize, offset],
				),
				workerStatus(),
			]);

			// The per-job rollup the page has always rendered. It was dropped when this route was
			// rewritten for the queue and the page silently lost a section — the fields are restored
			// rather than the page being trimmed to match, because the rollup is what tells an operator
			// which job is failing repeatedly.
			const rollup = await pool.query<{
				job_name: string;
				total: string;
				failed: string;
				dead_letter: string;
				running: string;
				avg_duration_ms: string | null;
				last_run_at: Date | null;
			}>(
				`SELECT job_name,
				        count(*)::int AS total,
				        count(*) FILTER (WHERE status = 'failed')::int AS failed,
				        count(*) FILTER (WHERE status = 'dead_letter')::int AS dead_letter,
				        count(*) FILTER (WHERE status = 'running')::int AS running,
				        avg(duration_ms)::numeric(10,1) AS avg_duration_ms,
				        max(coalesce(finished_at, started_at)) AS last_run_at
				 FROM job_executions
				 GROUP BY job_name
				 ORDER BY job_name`,
			);

			const totalItems = Number(totals.rows[0]?.total ?? 0);
			res.json({
				success: true,
				data: {
					data: rows.rows,
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
					byJob: rollup.rows.map((row) => ({
						job_name: row.job_name,
						total: Number(row.total),
						failed: Number(row.failed),
						dead_letter: Number(row.dead_letter),
						running: Number(row.running),
						avg_duration_ms: row.avg_duration_ms === null ? null : Number(row.avg_duration_ms),
						last_run_at: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
					})),
					/**
					 * The scheduled inventory.
					 *
					 * This used to list the in-process engines started by `server.ts` and state that they
					 * wrote no execution rows — which was the reason the history table could be empty. The
					 * queue worker is now the thing that runs on a schedule, and its handlers are the list,
					 * read from the worker itself rather than hardcoded here.
					 */
					scheduled: [
						{
							name: 'job-queue worker',
							kind: 'queue',
							startedBy: 'src/jobs/worker.ts → startJobWorker()',
							description: `Claims one due job per tick (${JOB_QUEUE_TIMING.TICK_MS / 1000}s) with FOR UPDATE SKIP LOCKED. Every job below runs through it.`,
							interval: `${JOB_QUEUE_TIMING.TICK_MS / 1000}s`,
						},
						...worker.handlers.map((name) => ({
							name,
							kind: 'handler',
							startedBy: 'registered by registerDefaultHandlers()',
							description:
								name === 'providers.health_check'
									? 'Runs every connectivity test and records the result in provider_health_checks.'
									: 'Deletes log rows past their retention window.',
							interval: `${JOB_QUEUE_TIMING.SCHEDULE_MS / 60_000}m`,
						})),
					],
					note: worker.running
						? `A worker is running on this replica as "${worker.workerId}". Jobs are claimed by whichever replica gets there first, so a second replica needs no coordination.`
						: 'No queue worker is running on this replica, so queued jobs will wait. They are durable: nothing is lost by a restart, and the first replica to start will claim them.',
					// The queue's own state, so an operator can tell "nothing has run" from "no worker".
					worker: {
						id: worker.workerId,
						running: worker.running,
						handlers: worker.handlers,
						byStatus: worker.queue.byStatus,
						oldestQueuedSeconds: worker.queue.oldestQueuedSeconds,
						reclaimable: worker.queue.reclaimable,
					},
					notes: [
						'Jobs are claimed with FOR UPDATE SKIP LOCKED, so the same row cannot run twice even with several replicas; no broker is involved.',
						'A worker that stops reporting has its running job returned to the queue without spending an attempt — the work was interrupted, not failed.',
						'Retrying from this console resets the attempt count, because it starts the work again rather than adding an attempt to a budget that is already spent.',
					],
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

/**
 * A retry carries a reason.
 *
 * Same rule the other privileged actions follow: re-running work an operator cannot explain afterwards
 * is the case the audit log exists for. This declaration was accidentally removed when the listing
 * route above was rewritten — the route kept compiling against nothing, which the type checker caught.
 */
const JobActionSchema = z.object({
	reason: z.string().min(3).max(500),
});

router.post(
	'/jobs/:id/retry',
	requirePermission('jobs.manage'),
	validate(JobActionSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id } = req.params;
			if (!isUuid(id)) throw new HttpError(400, 'Invalid job id', 'BAD_REQUEST');
			const body = (req as unknown as { validatedBody: z.infer<typeof JobActionSchema> }).validatedBody;

			const db = getDb();
			const [job] = await db.select().from(jobExecutions).where(eq(jobExecutions.id, id)).limit(1);
			if (!job) throw new HttpError(404, 'Job execution not found', 'NOT_FOUND');

			await auditedOperation({
				req,
				action: 'job.retry_requested',
				permission: 'jobs.manage',
				targetType: 'job_execution',
				targetId: id,
				reason: body.reason,
				run: async () => ({ jobName: job.jobName, previousStatus: job.status }),
			});

			// A real retry. The row is reset to `queued` with its attempt count restored, so the worker
			// picks it up on its next tick on whichever replica claims it first.
			const outcome = await retryJob(id);
			if (!outcome.ok) {
				throw new HttpError(
					409,
					outcome.reason === 'not-found'
						? 'That job no longer exists.'
						: `"${job.jobName}" is still ${job.status}, so there is nothing to retry. Waiting for a queued or running job to finish is not a retry — it is a duplicate.`,
					outcome.reason === 'not-found' ? 'JOB_NOT_FOUND' : 'JOB_IN_FLIGHT',
				);
			}

			// The response this route never needed before.
			//
			// Its previous body ended in a `throw HttpError(501)`, so the handler **always** produced a
			// response by throwing. Replacing the throw with a working retry left every path falling
			// through with no `res` call: the retry happened, and the client waited until it timed out
			// with no log line and no status. Found by a curl that reported `000` while the database
			// showed the side effect had landed.
			res.json({
				success: true,
				data: {
					id: outcome.job.id,
					jobName: outcome.job.job_name,
					status: outcome.job.status,
					attempt: outcome.job.attempt,
					maxAttempts: outcome.job.max_attempts,
					// The worker claims on its next tick, so the operator is told what to expect rather
					// than being left to refresh.
					note: 'Queued. The worker claims it on its next tick (a few seconds) on whichever replica gets there first.',
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

// ─── Tool executions ─────────────────────────────────────────────────────────

router.get(
	'/tool-executions',
	requirePermission('jobs.read'),
	validate(PageSchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: z.infer<typeof PageSchema> }).validatedQuery;
			const offset = (q.page - 1) * q.pageSize;
			const db = getDb();

			const total = await db.select({ count: sql<number>`count(*)::int` }).from(toolExecutions);
			const totalItems = Number(total[0]?.count ?? 0);

			const rows = await getDbPool().query(
				`SELECT t.id, t.user_id, u.email AS user_email, d.name AS tool_name, t.success,
				        t.error_code, t.error_message, t.duration_ms, t.request_id, t.created_at
				 FROM tool_executions t
				 LEFT JOIN users u ON u.id = t.user_id
				 LEFT JOIN tool_definitions d ON d.id = t.tool_id
				 ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`,
				[q.pageSize, offset],
			);

			res.json({
				success: true,
				data: {
					data: rows.rows,
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

// ─── Notifications ───────────────────────────────────────────────────────────

const NotificationQuerySchema = PageSchema.extend({
	userId: z.string().uuid().optional(),
	type: z.string().max(100).optional(),
	read: z.coerce.boolean().optional(),
});

router.get(
	'/notifications',
	requirePermission('notifications.read'),
	validate(NotificationQuerySchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: z.infer<typeof NotificationQuerySchema> }).validatedQuery;
			const pool = getDbPool();
			const offset = (q.page - 1) * q.pageSize;

			const conditions: string[] = [];
			const params: unknown[] = [];
			if (q.userId) {
				params.push(q.userId);
				conditions.push(`n.user_id = $${params.length}`);
			}
			if (q.type) {
				params.push(q.type);
				conditions.push(`n.type = $${params.length}`);
			}
			if (q.read !== undefined) {
				params.push(q.read);
				conditions.push(`n.read = $${params.length}`);
			}
			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

			const countResult = await pool.query<{ total: string }>(
				`SELECT count(*)::int AS total FROM notifications n ${where}`,
				params,
			);
			const totalItems = Number(countResult.rows[0]?.total ?? 0);

			const rows = await pool.query(
				`SELECT n.id, n.user_id, u.email AS user_email, n.type, n.title, n.body, n.payload,
				        n.read, n.read_at, n.occurred_at
				 FROM notifications n LEFT JOIN users u ON u.id = n.user_id
				 ${where}
				 ORDER BY n.occurred_at DESC
				 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
				[...params, q.pageSize, offset],
			);

			const breakdown = await pool.query(
				`SELECT type,
				        count(*)::int AS total,
				        count(*) FILTER (WHERE read)::int AS read_count
				 FROM notifications GROUP BY type ORDER BY total DESC LIMIT 25`,
			);

			res.json({
				success: true,
				data: {
					data: rows.rows,
					byType: breakdown.rows,
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
					limitations: [
						'There is no push-delivery record. The in-app `notifications` row is written when a notification is created, not when it reaches a device, so delivery and failure counts are not available.',
						'The mobile app has no FCM integration, so a server-initiated push cannot be delivered at all today; these rows are read by the app when it next opens.',
					],
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

// ─── Realtime ────────────────────────────────────────────────────────────────

/**
 * `GET /admin/realtime`
 *
 * Connection state is in-process memory in the realtime gateway. An API replica
 * cannot enumerate another replica's sockets, so this reports what it can prove
 * (that the gateway is enabled, and what the local process holds) and states the
 * limitation.
 */
router.get(
	'/realtime',
	requirePermission('realtime.read'),
	async (_req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { getRuntimeControls } = await import('../../admin/control.js');
			const controls = await getRuntimeControls();

			let localSessions: number | null = null;
			try {
				const { getActiveRealtimeSessionCount } = await import('../../realtime/index.js');
				localSessions = getActiveRealtimeSessionCount();
			} catch {
				localSessions = null;
			}

			res.json({
				success: true,
				data: {
					realtimeEnabled: controls.realtimeEnabled,
					voiceEnabled: controls.voiceEnabled,
					localSessions,
					limitations: [
						'Active connections live in the memory of whichever gateway replica accepted them. A count from this process covers only this process.',
						'There is no connection-rate, disconnect-rate or message-rate metric: nothing increments a counter per connection event.',
						'Cross-replica totals need Redis pub/sub or a shared registry, neither of which is wired up.',
					],
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

// ─── Dashboard-level reminder/task aggregates used by the ops landing page ───

router.get(
	'/operations/summary',
	requirePermission('tasks.read'),
	async (_req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const pool = getDbPool();
			const tasksByStatus = await pool.query(
				`SELECT status, count(*)::int AS count FROM tasks GROUP BY status ORDER BY count DESC`,
			);
			const remindersByState = await pool.query(`
				SELECT
					count(*) FILTER (WHERE NOT dismissed AND trigger_at > now())::int AS upcoming,
					count(*) FILTER (WHERE NOT dismissed AND trigger_at <= now())::int AS overdue,
					count(*) FILTER (WHERE dismissed)::int AS dismissed,
					count(*)::int AS total
				FROM reminders`);
			const memoryByType = await pool.query(
				`SELECT category, count(*)::int AS count FROM memories GROUP BY category ORDER BY count DESC`,
			);

			res.json({
				success: true,
				data: {
					tasksByStatus: tasksByStatus.rows,
					reminders: remindersByState.rows[0] ?? null,
					memoryByType: memoryByType.rows,
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

export default router;
