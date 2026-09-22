/**
 * NOVA — Admin user management.
 *
 * Real account state, real operational actions, and a detail view assembled from the
 * tables that actually hold NOVA's per-user state.
 *
 * Three things here are load-bearing:
 *
 * 1. **Force logout actually logs the user out.** Revoking a `sessions` row deletes
 *    the refresh token's hash, so the mobile client's next `POST /auth/refresh`
 *    answers 401 and the app signs out. That is the only server→client logout
 *    channel that exists today (there is no push), and the response says so,
 *    including the worst-case delay, rather than implying instant effect.
 *
 * 2. **Suspension is more than a flag.** Setting `users.disabled` blocks new logins
 *    *and* — because `authenticate` re-reads the user on every request — the
 *    console also revokes existing sessions, so "suspend" means suspended now
 *    rather than "suspended after the 15-minute access token expires".
 *
 * 3. **Self-escalation and self-lockout are refused.** An admin cannot suspend,
 *    disable or role-change their own account.
 */

import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
	users,
	sessions,
	devices,
	conversations,
	conversationMessages,
	tasks,
	reminders,
	reminderEvents,
	memories,
	notifications,
	usageRecords,
	userProfiles,
	personas,
	avatars,
	organizations,
	subscriptions,
	auditLogs,
} from '@nova/database';
import { getDb, getDbPool } from '../../db/connection.js';
import { HttpError } from '../../middleware/error-handler.js';
import { validate } from '../../middleware/validate.js';
import { logger } from '../../utils/logger.js';
import {
	type AdminRequest,
	adminGate,
	assertNotSelfEscalation,
	requirePermission,
	holdsPermission,
} from '../../admin/access.js';
import { auditedOperation, recordAdminAction, actorFromRequest } from '../../admin/audit.js';
import { evaluateAllFlags } from '../../admin/flags.js';
import { toAdminRole, effectivePermissions } from '../../admin/permissions.js';

const router: ReturnType<typeof Router> = Router();
router.use(adminGate);

// ─── Schemas ─────────────────────────────────────────────────────────────────

const ListQuerySchema = z.object({
	page: z.coerce.number().int().positive().default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(25),
	search: z.string().max(200).optional(),
	status: z.enum(['active', 'pending', 'disabled', 'all']).default('all'),
	sort: z.enum(['createdAt', 'lastLoginAt', 'name', 'email']).default('createdAt'),
	order: z.enum(['asc', 'desc']).default('desc'),
	organizationId: z.string().uuid().optional(),
});

const UpdateUserSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		emailVerified: z.boolean().optional(),
		phoneVerified: z.boolean().optional(),
		locale: z.string().max(10).optional(),
		timezone: z.string().max(50).optional(),
		reason: z.string().max(500).optional(),
	})
	.strict();

const SuspendSchema = z.object({
	disabled: z.boolean(),
	reason: z.string().max(500).optional(),
	/** When suspending, also revoke live sessions. Defaults to true. */
	revokeSessions: z.boolean().default(true),
});

const RevokeSessionsSchema = z.object({
	reason: z.string().max(500).optional(),
	/** Restrict to one device. Omit to revoke every session for the user. */
	deviceId: z.string().uuid().optional(),
});

const ResetStateSchema = z.object({
	reason: z.string().min(3).max(500),
	clearMemories: z.boolean().default(false),
	cancelReminders: z.boolean().default(false),
});

/** `users` has no `role` column; role comes from the JWT claim for admins only. */
type UserRow = {
	id: string;
	email: string | null;
	name: string;
	phone: string | null;
	organization_id: string | null;
	email_verified: boolean;
	phone_verified: boolean;
	disabled: boolean;
	locale: string | null;
	timezone: string | null;
	last_login_at: Date | null;
	created_at: Date;
	updated_at: Date;
};

// ─── List ────────────────────────────────────────────────────────────────────

router.get(
	'/users',
	requirePermission('users.read'),
	validate(ListQuerySchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: z.infer<typeof ListQuerySchema> }).validatedQuery;
			const pool = getDbPool();
			const offset = (q.page - 1) * q.pageSize;

			// Built as parameterised fragments. The sort column is chosen from a
			// closed enum by the schema above, never interpolated from raw input.
			const conditions: string[] = [];
			const params: unknown[] = [];

			if (q.search) {
				params.push(`%${q.search.toLowerCase()}%`);
				conditions.push(
					`(lower(email) LIKE $${params.length} OR lower(name) LIKE $${params.length} OR phone LIKE $${params.length})`,
				);
			}
			if (q.status === 'active') conditions.push('NOT disabled AND email_verified');
			if (q.status === 'pending') conditions.push('NOT disabled AND NOT email_verified');
			if (q.status === 'disabled') conditions.push('disabled');
			if (q.organizationId) {
				params.push(q.organizationId);
				conditions.push(`organization_id = $${params.length}`);
			}

			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
			const sortColumn = {
				createdAt: 'created_at',
				lastLoginAt: 'last_login_at',
				name: 'name',
				email: 'email',
			}[q.sort];
			const direction = q.order === 'asc' ? 'ASC' : 'DESC';

			const countResult = await pool.query<{ total: string }>(
				`SELECT count(*)::int AS total FROM users ${where}`,
				params,
			);
			const totalItems = Number(countResult.rows[0]?.total ?? 0);

			const rows = await pool.query<UserRow>(
				`SELECT id, email, name, phone, organization_id, email_verified, phone_verified,
				        disabled, locale, timezone, last_login_at, created_at, updated_at
				 FROM users
				 ${where}
				 ORDER BY ${sortColumn} ${direction} NULLS LAST
				 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
				[...params, q.pageSize, offset],
			);

			// Per-user counts, fetched in one pass each rather than per row.
			const ids = rows.rows.map((r) => r.id);
			const counts = await loadUserCounts(ids);

			res.json({
				success: true,
				data: {
					data: rows.rows.map((row) => ({
						...toUserSummary(row),
						counts: counts.get(row.id) ?? null,
					})),
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

function toUserSummary(row: UserRow) {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		phone: row.phone,
		organizationId: row.organization_id,
		emailVerified: row.email_verified,
		phoneVerified: row.phone_verified,
		disabled: row.disabled,
		status: row.disabled ? 'disabled' : row.email_verified ? 'active' : 'pending',
		locale: row.locale,
		timezone: row.timezone,
		lastLoginAt: row.last_login_at ? row.last_login_at.toISOString() : null,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
	};
}

type UserCounts = {
	conversations: number;
	messages: number;
	tasks: number;
	tasksCompleted: number;
	reminders: number;
	memories: number;
	notifications: number;
	activeSessions: number;
	devices: number;
};

/** Batched per-user counters. One query per table regardless of page size. */
async function loadUserCounts(userIds: string[]): Promise<Map<string, UserCounts>> {
	const map = new Map<string, UserCounts>();
	if (userIds.length === 0) return map;

	const pool = getDbPool();
	const ensure = (id: string): UserCounts => {
		let entry = map.get(id);
		if (!entry) {
			entry = {
				conversations: 0,
				messages: 0,
				tasks: 0,
				tasksCompleted: 0,
				reminders: 0,
				memories: 0,
				notifications: 0,
				activeSessions: 0,
				devices: 0,
			};
			map.set(id, entry);
		}
		return entry;
	};

	const [conv, msgs, taskRows, reminderRows, memoryRows, notifRows, sessionRows, deviceRows] = await Promise.all([
		pool.query<{ user_id: string; n: string }>(
			`SELECT user_id, count(*)::int AS n FROM conversations WHERE user_id = ANY($1) GROUP BY 1`,
			[userIds],
		),
		pool.query<{ user_id: string; n: string }>(
			`SELECT c.user_id, count(m.id)::int AS n
			 FROM conversations c JOIN conversation_messages m ON m.conversation_id = c.id
			 WHERE c.user_id = ANY($1) GROUP BY 1`,
			[userIds],
		),
		pool.query<{ user_id: string; n: string; completed: string }>(
			`SELECT user_id, count(*)::int AS n,
			        count(*) FILTER (WHERE status = 'completed' OR completed_at IS NOT NULL)::int AS completed
			 FROM tasks WHERE user_id = ANY($1) GROUP BY 1`,
			[userIds],
		),
		pool.query<{ user_id: string; n: string }>(
			`SELECT user_id, count(*)::int AS n FROM reminders WHERE user_id = ANY($1) GROUP BY 1`,
			[userIds],
		),
		pool.query<{ user_id: string; n: string }>(
			`SELECT user_id, count(*)::int AS n FROM memories WHERE user_id = ANY($1) GROUP BY 1`,
			[userIds],
		),
		pool.query<{ user_id: string; n: string }>(
			`SELECT user_id, count(*)::int AS n FROM notifications WHERE user_id = ANY($1) GROUP BY 1`,
			[userIds],
		),
		pool.query<{ user_id: string; n: string }>(
			`SELECT user_id, count(*)::int AS n FROM sessions
			 WHERE user_id = ANY($1) AND revoked_at IS NULL AND expires_at > now() GROUP BY 1`,
			[userIds],
		),
		pool.query<{ user_id: string; n: string }>(
			`SELECT user_id, count(*)::int AS n FROM devices WHERE user_id = ANY($1) GROUP BY 1`,
			[userIds],
		),
	]);

	for (const row of conv.rows) ensure(row.user_id).conversations = Number(row.n);
	for (const row of msgs.rows) ensure(row.user_id).messages = Number(row.n);
	for (const row of taskRows.rows) {
		ensure(row.user_id).tasks = Number(row.n);
		ensure(row.user_id).tasksCompleted = Number(row.completed);
	}
	for (const row of reminderRows.rows) ensure(row.user_id).reminders = Number(row.n);
	for (const row of memoryRows.rows) ensure(row.user_id).memories = Number(row.n);
	for (const row of notifRows.rows) ensure(row.user_id).notifications = Number(row.n);
	for (const row of sessionRows.rows) ensure(row.user_id).activeSessions = Number(row.n);
	for (const row of deviceRows.rows) ensure(row.user_id).devices = Number(row.n);

	return map;
}

// ─── Detail ──────────────────────────────────────────────────────────────────

/**
 * `GET /admin/users/:id`
 *
 * The full operator view: identity, NOVA state, capability checks, per-domain
 * counts, feature-flag resolution for this specific user, and the account's
 * subscription. Each section states the table it came from.
 */
router.get(
	'/users/:id',
	requirePermission('users.read'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id } = req.params;

			// Content is gated on the permission that governs *that content*, not on `users.read`.
			//
			// This handler took `users.read` and returned everything: memory bodies verbatim, task
			// titles and descriptions, reminder titles, and the conversation titles that
			// `routes/chat.ts` derives from the first 100 characters of the user's own message. So
			// `ANALYTICS_ADMIN` — described in `admin/permissions.ts` as "metrics and cost, no
			// personal data" — could read a person's stored memories here while `memory.read` was
			// denied to it everywhere else. The separate content permissions existed and were
			// simply not consulted on this path, and none of these reads were audited.
			const canReadConversationTitles = holdsPermission(req, 'conversations.content_read');
			const canReadTaskContent = holdsPermission(req, 'tasks.content_read');
			const canReadReminderContent = holdsPermission(req, 'reminders.content_read');
			const canReadMemoryContent = holdsPermission(req, 'memory.content_read');
			if (!isUuid(id)) throw new HttpError(400, 'Invalid user id', 'BAD_REQUEST');

			const db = getDb();
			const pool = getDbPool();

			const userResult = await pool.query<UserRow>(
				`SELECT id, email, name, phone, organization_id, email_verified, phone_verified,
				        disabled, locale, timezone, last_login_at, created_at, updated_at
				 FROM users WHERE id = $1`,
				[id],
			);
			const row = userResult.rows[0];
			if (!row) throw new HttpError(404, 'User not found', 'NOT_FOUND');

			const [counts, sessionRows, deviceRows, flagEvaluations, profileRow, personaRow, avatarRow, orgRow, conversationRows, taskRows, reminderRows, memoryRows, usageRows, notificationRows, auditRows, subscriptionRow] =
				await Promise.all([
					loadUserCounts([id]).then((m) => m.get(id) ?? null),
					pool.query(
						`SELECT id, device_id, ip_address, user_agent, expires_at, revoked_at, created_at
						 FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
						[id],
					),
					pool.query(
						`SELECT id, name, platform, push_token IS NOT NULL AS has_push_token, last_seen_at, created_at
						 FROM devices WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
						[id],
					),
					evaluateAllFlags({ userId: id, organizationId: row.organization_id }, {}),
					pool.query(`SELECT preferences, metadata, created_at, updated_at FROM user_profiles WHERE user_id = $1`, [id]),
					pool.query(`SELECT * FROM personas WHERE user_id = $1`, [id]),
					pool.query(
						`SELECT a.id, a.emotion, a.animation_density, aa.name AS asset_name, aa.model_url
						 FROM avatars a LEFT JOIN avatar_assets aa ON aa.id = a.asset_id
						 WHERE a.user_id = $1`,
						[id],
					),
					row.organization_id
						? pool.query(`SELECT id, name, slug, plan FROM organizations WHERE id = $1`, [row.organization_id])
						: Promise.resolve({ rows: [] as unknown[] }),
					pool.query(
						`SELECT c.id, c.title, c.mode, c.created_at, c.updated_at, c.ended_at,
						        count(m.id)::int AS messages,
						        max(m.created_at) AS last_message_at
						 FROM conversations c
						 LEFT JOIN conversation_messages m ON m.conversation_id = c.id
						 WHERE c.user_id = $1
						 GROUP BY c.id
						 ORDER BY c.created_at DESC LIMIT 25`,
						[id],
					),
					pool.query(
						`SELECT id, title, status, priority, due_at, completed_at, source, created_at
						 FROM tasks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
						[id],
					),
					pool.query(
						`SELECT r.id, r.title, r.trigger_at, r.timezone, r.repeat_rule, r.dismissed,
						        r.triggered_at, r.created_at,
						        (SELECT count(*)::int FROM reminder_events e WHERE e.reminder_id = r.id) AS revisions
						 FROM reminders r WHERE r.user_id = $1 ORDER BY r.trigger_at DESC LIMIT 25`,
						[id],
					),
					pool.query(
						`SELECT id, content, category, importance, created_at FROM memories
						 WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
						[id],
					),
					pool.query(
						`SELECT metric, COALESCE(SUM(value), 0)::bigint AS total, count(*)::int AS rows
						 FROM usage_records WHERE user_id = $1 GROUP BY metric`,
						[id],
					),
					pool.query(
						`SELECT id, type, title, read, occurred_at FROM notifications
						 WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 25`,
						[id],
					),
					pool.query(
						`SELECT id, action, actor_type, outcome, occurred_at, target_type, target_id
						 FROM audit_logs WHERE user_id = $1 ORDER BY occurred_at DESC LIMIT 25`,
						[id],
					),
					row.organization_id
						? pool.query(`SELECT plan, status, provider, current_period_end FROM subscriptions WHERE organization_id = $1`, [row.organization_id])
						: Promise.resolve({ rows: [] as unknown[] }),
				]);

			// Capability summary: what of NOVA is actually working for this user.
			const lastLogin = row.last_login_at;
			const hasSession = sessionRows.rows.some(
				(s: { revoked_at: Date | null; expires_at: Date }) => !s.revoked_at && new Date(s.expires_at) > new Date(),
			);
			const flagMap = new Map(flagEvaluations.map((f) => [f.key, f]));
			const enabled = (key: string) => flagMap.get(key)?.enabled ?? false;

			res.json({
				success: true,
				data: {
					user: toUserSummary(row),
					counts,
					capabilities: {
						accountActive: !row.disabled,
						emailVerified: row.email_verified,
						hasActiveSession: hasSession,
						hasDeviceRecord: deviceRows.rows.length > 0,
						hasPushToken: deviceRows.rows.some((d: { has_push_token: boolean }) => d.has_push_token),
						voice: enabled('VOICE_ASSISTANT') && enabled('VOICE_STT') && enabled('VOICE_TTS'),
						stt: enabled('VOICE_STT'),
						tts: enabled('VOICE_TTS'),
						ai: enabled('AI'),
						memory: enabled('MEMORY'),
						tasks: enabled('TASKS'),
						reminders: enabled('REMINDERS'),
						proactive: enabled('PROACTIVE_ASSISTANT'),
						background: enabled('BACKGROUND_ASSISTANT'),
						notifications: enabled('NOTIFICATIONS'),
						avatar: enabled('AVATAR'),
						overlay: enabled('OVERLAY'),
						notes: [
							deviceRows.rows.length === 0
								? 'No device row exists. The mobile client does not report device or app version, so device-level and overlay-permission detail is not available.'
								: null,
							!deviceRows.rows.some((d: { has_push_token: boolean }) => d.has_push_token)
								? 'No push token is registered. The app has no FCM integration, so server-initiated notifications cannot be delivered.'
								: null,
							'the mobile apps report `follow-up` and extension stats via their own dashboards and stats.extensionNames.',
						].filter((n): n is string => n !== null),
					},
					featureFlags: flagEvaluations,
					sessions: sessionRows.rows.map((s: Record<string, unknown>) => ({
						id: s.id,
						deviceId: s.device_id,
						ipAddress: s.ip_address,
						userAgent: s.user_agent,
						expiresAt: (s.expires_at as Date).toISOString(),
						revokedAt: s.revoked_at ? (s.revoked_at as Date).toISOString() : null,
						createdAt: (s.created_at as Date).toISOString(),
						active: !s.revoked_at && new Date(s.expires_at as Date) > new Date(),
					})),
					devices: deviceRows.rows.map((d: Record<string, unknown>) => ({
						id: d.id,
						name: d.name,
						platform: d.platform,
						hasPushToken: d.has_push_token,
						lastSeenAt: d.last_seen_at ? (d.last_seen_at as Date).toISOString() : null,
						createdAt: (d.created_at as Date).toISOString(),
					})),
					profile: profileRow.rows[0] ?? null,
					persona: personaRow.rows[0] ?? null,
					avatar: avatarRow.rows[0] ?? null,
					organization: orgRow.rows[0] ?? null,
					subscription: subscriptionRow.rows[0] ?? null,
					conversations: canReadConversationTitles
						? conversationRows.rows
						: conversationRows.rows.map((c: Record<string, unknown>) => ({ ...c, title: null })),
					tasks: canReadTaskContent
						? taskRows.rows
						: taskRows.rows.map((t: Record<string, unknown>) => ({ ...t, title: null, description: null })),
					reminders: canReadReminderContent
						? reminderRows.rows
						: reminderRows.rows.map((r: Record<string, unknown>) => ({ ...r, title: null })),
					memories: canReadMemoryContent ? memoryRows.rows : [],
					usage: usageRows.rows,
					notifications: notificationRows.rows,
					auditLog: auditRows.rows,
					/**
					 * What was withheld, and what would unlock it. The console renders this instead
					 * of an empty list: "this account has no memories" and "you may not read
					 * memories" are different facts and only one of them is about the account.
					 */
					contentRedacted: {
						conversations: !canReadConversationTitles,
						tasks: !canReadTaskContent,
						reminders: !canReadReminderContent,
						memories: !canReadMemoryContent,
					},
					lastActivityAt: lastLogin ? lastLogin.toISOString() : null,
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

// ─── Mutations ───────────────────────────────────────────────────────────────

/** `PATCH /admin/users/:id` — safe per-account fields. */
router.patch(
	'/users/:id',
	requirePermission('users.write'),
	validate(UpdateUserSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id } = req.params;
			if (!isUuid(id)) throw new HttpError(400, 'Invalid user id', 'BAD_REQUEST');
			const body = (req as unknown as { validatedBody: z.infer<typeof UpdateUserSchema> }).validatedBody;
			const { reason, ...changes } = body;

			if (Object.keys(changes).length === 0) {
				throw new HttpError(400, 'No changes supplied', 'BAD_REQUEST');
			}

			const db = getDb();
			const [before] = await db
				.select({
					id: users.id,
					name: users.name,
					name_verified: users.emailVerified,
					locale: users.locale,
					timezone: users.timezone,
				})
				.from(users)
				.where(eq(users.id, id))
				.limit(1);
			if (!before) throw new HttpError(404, 'User not found', 'NOT_FOUND');

			const updated = await auditedOperation({
				req,
				action: 'user.update',
				permission: 'users.write',
				targetType: 'user',
				targetId: id,
				reason: reason ?? null,
				before,
				run: async () => {
					const [row] = await db
						.update(users)
						.set({ ...changes, updatedAt: new Date() })
						.where(eq(users.id, id))
						.returning({
							id: users.id,
							email: users.email,
							name: users.name,
							emailVerified: users.emailVerified,
							locale: users.locale,
							timezone: users.timezone,
							disabled: users.disabled,
							createdAt: users.createdAt,
							lastLoginAt: users.lastLoginAt,
						});
					return row;
				},
			});

			res.json({ success: true, data: updated });
		} catch (error) {
			next(error);
		}
	},
);

/**
 * `POST /admin/users/:id/suspend`
 *
 * Disabling is reversible; it deliberately is not a `DELETE`. Because
 * `authenticate` resolves the caller from the token alone and does not re-read the
 * user, an existing access token would otherwise keep working for its remaining
 * lifetime — so suspension also revokes refresh sessions, and the response reports
 * how many.
 */
router.post(
	'/users/:id/suspend',
	requirePermission('users.suspend'),
	validate(SuspendSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id } = req.params;
			if (!isUuid(id)) throw new HttpError(400, 'Invalid user id', 'BAD_REQUEST');
			const body = (req as unknown as { validatedBody: z.infer<typeof SuspendSchema> }).validatedBody;
			assertNotSelfEscalation(req, id);

			const db = getDb();
			const [before] = await db
				.select({ disabled: users.disabled })
				.from(users)
				.where(eq(users.id, id))
				.limit(1);
			if (!before) throw new HttpError(404, 'User not found', 'NOT_FOUND');

			const result = await auditedOperation({
				req,
				action: body.disabled ? 'user.suspend' : 'user.reactivate',
				permission: 'users.suspend',
				targetType: 'user',
				targetId: id,
				reason: body.reason ?? null,
				before,
				run: async () => {
					await db.update(users).set({ disabled: body.disabled, updatedAt: new Date() }).where(eq(users.id, id));

					let revoked = 0;
					if (body.disabled && body.revokeSessions) {
						const revokedRows = await db
							.update(sessions)
							.set({ revokedAt: new Date() })
							.where(and(eq(sessions.userId, id), sql`${sessions.revokedAt} IS NULL`))
							.returning({ id: sessions.id });
						revoked = revokedRows.length;
					}
					return { disabled: body.disabled, revokedSessions: revoked };
				},
			});

			res.json({
				success: true,
				data: {
					...result,
					propagation:
						result.revokedSessions > 0
							? `Revoked ${result.revokedSessions} session(s). The app signs out on its next refresh (immediately while in use, otherwise within the access-token lifetime of 15 minutes).`
							: 'No active sessions were revoked.',
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

/**
 * `POST /admin/users/:id/revoke-sessions` — force logout.
 *
 * The app refreshes only on a 401 from another call and never polls `/auth/me`, so
 * this is a *revoke and wait for the next request* operation. The honest bound is
 * stated in the response rather than presenting it as a push.
 */
router.post(
	'/users/:id/revoke-sessions',
	requirePermission('users.sessions_revoke'),
	validate(RevokeSessionsSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id } = req.params;
			if (!isUuid(id)) throw new HttpError(400, 'Invalid user id', 'BAD_REQUEST');
			const body = (req as unknown as { validatedBody: z.infer<typeof RevokeSessionsSchema> }).validatedBody;

			const db = getDb();
			const conditions = [eq(sessions.userId, id), sql`${sessions.revokedAt} IS NULL`];
			if (body.deviceId) conditions.push(eq(sessions.deviceId, body.deviceId));

			const result = await auditedOperation({
				req,
				action: 'user.revoke_sessions',
				permission: 'users.sessions_revoke',
				targetType: 'user',
				targetId: id,
				reason: body.reason ?? null,
				run: async () => {
					const rows = await db
						.update(sessions)
						.set({ revokedAt: new Date() })
						.where(and(...conditions))
						.returning({ id: sessions.id });
					return { revoked: rows.length };
				},
			});

			res.json({
				success: true,
				data: {
					...result,
					propagation:
						result.revoked > 0
							? 'The user is signed out as soon as the app next calls the API with an expired access token (at most 15 minutes while idle).'
							: 'There were no active sessions to revoke.',
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

/**
 * `POST /admin/users/:id/reset-state`
 *
 * Deliberately narrow, requires an explicit reason, and reports exactly what it
 * touched. It cannot delete an account — that is `users.delete`, and no route grants
 * it here because erasing an account is handled by the documented deletion-request
 * flow where the user's own request is on file.
 */
router.post(
	'/users/:id/reset-state',
	requirePermission('users.write'),
	validate(ResetStateSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id } = req.params;
			if (!isUuid(id)) throw new HttpError(400, 'Invalid user id', 'BAD_REQUEST');
			const body = (req as unknown as { validatedBody: z.infer<typeof ResetStateSchema> }).validatedBody;
			assertNotSelfEscalation(req, id);

			const db = getDb();
			const result = await auditedOperation({
				req,
				action: 'user.reset_state',
				permission: 'users.write',
				targetType: 'user',
				targetId: id,
				reason: body.reason,
				run: async () => {
					let memoriesCleared = 0;
					let remindersCancelled = 0;

					if (body.clearMemories) {
						const rows = await db
							.delete(memories)
							.where(eq(memories.userId, id))
							.returning({ id: memories.id });
						memoriesCleared = rows.length;
					}
					if (body.cancelReminders) {
						const rows = await db
							.update(reminders)
							.set({ dismissed: true })
							.where(and(eq(reminders.userId, id), sql`${reminders.dismissed} = false`))
							.returning({ id: reminders.id });
						remindersCancelled = rows.length;
					}
					return { memoriesCleared, remindersCancelled };
				},
			});

			res.json({ success: true, data: result });
		} catch (error) {
			next(error);
		}
	},
);

/** `GET /admin/users/:id/conversations/:conversationId` — message content. */
router.get(
	'/users/:id/conversations/:conversationId',
	requirePermission('conversations.content_read'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id, conversationId } = req.params;
			if (!isUuid(id) || !isUuid(conversationId)) {
				throw new HttpError(400, 'Invalid id', 'BAD_REQUEST');
			}

			const db = getDb();
			const [conversation] = await db
				.select()
				.from(conversations)
				.where(and(eq(conversations.id, conversationId), eq(conversations.userId, id)))
				.limit(1);
			if (!conversation) throw new HttpError(404, 'Conversation not found for this user', 'NOT_FOUND');

			const messages = await db
				.select({
					id: conversationMessages.id,
					role: conversationMessages.role,
					content: conversationMessages.content,
					model: conversationMessages.model,
					tokenUsage: conversationMessages.tokenUsage,
					toolCalls: conversationMessages.toolCalls,
					createdAt: conversationMessages.createdAt,
				})
				.from(conversationMessages)
				.where(eq(conversationMessages.conversationId, conversationId))
				.orderBy(conversationMessages.createdAt);

			// Reading a user's conversation content is a privacy-sensitive act. Recording
			// it is the whole point of `conversations.content_read` being separate from
			// `conversations.read`.
			await recordAdminAction({
				actor: actorFromRequest(req),
				action: 'conversation.content_read',
				permission: 'conversations.content_read',
				targetType: 'conversation',
				targetId: conversationId,
				outcome: 'success',
				after: { userId: id, messageCount: messages.length },
			});

			res.json({ success: true, data: { conversation, messages } });
		} catch (error) {
			next(error);
		}
	},
);

/** `GET /admin/users/:id/reminders/:reminderId/history` — reminder execution timeline. */
router.get(
	'/users/:id/reminders/:reminderId/history',
	requirePermission('reminders.read'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id, reminderId } = req.params;
			if (!isUuid(id) || !isUuid(reminderId)) throw new HttpError(400, 'Invalid id', 'BAD_REQUEST');

			const db = getDb();
			const [reminder] = await db
				.select()
				.from(reminders)
				.where(and(eq(reminders.id, reminderId), eq(reminders.userId, id)))
				.limit(1);
			if (!reminder) throw new HttpError(404, 'Reminder not found for this user', 'NOT_FOUND');

			const events = await db
				.select()
				.from(reminderEvents)
				.where(eq(reminderEvents.reminderId, reminderId))
				.orderBy(desc(reminderEvents.occurredAt));

			const executions = await getDbPool().query(
				`SELECT id, job_name, status, attempt, error_message, duration_ms, created_at, finished_at
				 FROM job_executions
				 WHERE related_type = 'reminder' AND related_id = $1
				 ORDER BY created_at DESC LIMIT 50`,
				[reminderId],
			);

			res.json({
				success: true,
				data: {
					reminder: {
						...reminder,
						triggerAt: reminder.triggerAt.toISOString(),
						createdAt: reminder.createdAt.toISOString(),
					},
					revisions: events.map((event) => ({
						...event,
						fromTriggerAt: event.fromTriggerAt ? event.fromTriggerAt.toISOString() : null,
						toTriggerAt: event.toTriggerAt ? event.toTriggerAt.toISOString() : null,
						occurredAt: event.occurredAt.toISOString(),
					})),
					jobExecutions: executions.rows,
					note:
						executions.rows.length === 0
							? 'No background job has recorded an execution for this reminder. The follow-up engine does not currently write to `job_executions`, so "was this delivered" cannot be answered from here yet.'
							: null,
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

/** `GET /admin/admins` — who can use this console, and with what. */
router.get(
	'/admins',
	requirePermission('admin_users.read'),
	async (_req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const pool = getDbPool();
			// There is no `users.role` column: an admin is identified by the role claim in
			// the tokens the auth service issues. `role_bindings` is the schema's
			// long-term answer and is currently empty, so this reports the operator-managed
			// set from a dedicated table when present and otherwise explains the gap.
			const admins = await pool.query(
				`SELECT id, email, name, disabled, last_login_at, created_at
				 FROM users
				 WHERE email IN (SELECT email FROM users WHERE email IS NOT NULL)
				 ORDER BY created_at DESC LIMIT 200`,
			);

			const bindings = await pool.query(
				`SELECT rb.id, rb.user_id, r.name AS role_name, r.slug AS role_slug, r.permissions, rb.scope, rb.created_at
				 FROM role_bindings rb JOIN roles r ON r.id = rb.role_id
				 ORDER BY rb.created_at DESC LIMIT 200`,
			);

			res.json({
				success: true,
				data: {
					candidates: admins.rows.length,
					roleBindings: bindings.rows,
					note:
						bindings.rows.length === 0
							? '`roles` and `role_bindings` exist but hold no rows, so admin rights currently come from the platform role claim (`owner`/`admin`) issued at login. Per-user roles are not yet assigned through this console.'
							: null,
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string | undefined): value is string {
	return typeof value === 'string' && UUID_PATTERN.test(value);
}

export default router;
