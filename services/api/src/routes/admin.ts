/**
 * NOVA API — Admin routes.
 *
 * Serves the admin panel at apps/admin with real database queries
 * via drizzle-orm. Protected by JWT auth + role guard.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import {
	users,
	organizations,
	auditLogs,
	incidentEvents,
	featureFlags,
	usageRecords,
} from '@nova/database';
import { eq, desc, sql, and, count, gte, inArray } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { actorFromRequest, recordAdminAction } from '../admin/audit.js';
import type { Permission } from '../admin/permissions.js';
import { HttpError } from '../middleware/error-handler.js';
import { validate } from '../middleware/validate.js';
import { logger } from '../utils/logger.js';

const router: ReturnType<typeof Router> = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAdmin(req: AuthenticatedRequest) {
	return req.user!;
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
	const u = (req as unknown as { user?: { id: string; email: string; role: string } }).user;
	if (!u || !['owner', 'admin'].includes(u.role)) {
		throw new HttpError(403, 'Forbidden — requires owner or admin role', 'FORBIDDEN');
	}
	next();
}

/**
 * Writes an admin audit row for a legacy `/admin` mutation.
 *
 * This surface predates the Control Center and wrote **no** audit rows at all: six mutations —
 * feature-flag create/update/delete, incident create and resolve, and the user patch — changed
 * production state with no record of who did it. That contradicts the rule that every privileged
 * action is auditable, and the gap was invisible because the console's own audit page reads
 * `admin_audit_logs`, which the legacy routes never wrote to.
 *
 * `recordAdminAction` normally takes its actor from `req.adminActor`, set by `resolveAdmin`. This
 * router never runs that (it gates on a role claim through `requireAdmin`), so the actor is built
 * from the authenticated user instead — which is why these rows can be added without restructuring
 * the router or changing what the mobile app sees.
 */
async function auditLegacy(
	req: Request,
	entry: {
		action: string;
		permission: Permission;
		targetType?: string;
		targetId?: string;
		after?: Record<string, unknown>;
		reason?: string;
	},
): Promise<void> {
	await recordAdminAction({
		actor: actorFromRequest(req),
		action: entry.action,
		permission: entry.permission,
		targetType: entry.targetType,
		targetId: entry.targetId,
		after: entry.after,
		reason: entry.reason,
		outcome: 'success',
	});
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const AdminListQuerySchema = z.object({
	page: z.coerce.number().int().positive().default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
	organizationId: z.string().uuid().optional(),
	search: z.string().max(200).optional(),
	action: z.string().max(100).optional(),
	severity: z.string().max(50).optional(),
	resolved: z.coerce.boolean().optional(),
});

const UpdateUserSchema = z.object({
	disabled: z.boolean().optional(),
	emailVerified: z.boolean().optional(),
	name: z.string().min(1).max(255).optional(),
});

const CreateFlagSchema = z.object({
	key: z.string().min(1).max(100),
	enabled: z.boolean().default(false),
	rolloutPercent: z.coerce.number().int().min(0).max(100).default(0),
	description: z.string().optional(),
});

const UpdateFlagSchema = z.object({
	enabled: z.boolean().optional(),
	rolloutPercent: z.coerce.number().int().min(0).max(100).optional(),
	description: z.string().optional(),
});

const CreateIncidentSchema = z.object({
	severity: z.enum(['critical', 'error', 'warning', 'info']),
	title: z.string().min(1).max(500),
	description: z.string().optional(),
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

router.get(
	'/dashboard',
	authenticate,
	requireAdmin,
	async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();

			const totalUsersRow = await db.select({ total: sql<number>`count(*)` }).from(users);
			const totalOrgsRow = await db.select({ total: sql<number>`count(*)` }).from(organizations);
			const totalIncidentsRow = await db.select({ total: sql<number>`count(*)` }).from(incidentEvents);
			const openIncidentsRow = await db
				.select({ total: sql<number>`count(*)` })
				.from(incidentEvents)
				.where(eq(incidentEvents.resolved, false));
			const totalFlagsRow = await db.select({ total: sql<number>`count(*)` }).from(featureFlags);

			res.json({
				success: true,
				data: {
					status: 'healthy',
					metrics: {
						totalUsers: Number(totalUsersRow[0]?.total ?? 0),
						totalOrganizations: Number(totalOrgsRow[0]?.total ?? 0),
						totalIncidents: Number(totalIncidentsRow[0]?.total ?? 0),
						openIncidents: Number(openIncidentsRow[0]?.total ?? 0),
						totalFeatureFlags: Number(totalFlagsRow[0]?.total ?? 0),
					},
					checks: [
						{ name: 'database', status: 'pass' },
						{ name: 'api', status: 'pass' },
					],
					timestamp: new Date().toISOString(),
				},
			});
		} catch (err) {
			next(err);
		}
	},
);

// ─── Users ────────────────────────────────────────────────────────────────────

router.get(
	'/users',
	authenticate,
	requireAdmin,
	validate(AdminListQuerySchema, 'query'),
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const q = (req as unknown as { validatedQuery: z.infer<typeof AdminListQuerySchema> }).validatedQuery;
			const offset = (q.page - 1) * q.pageSize;

			const whereConditions: any[] = [];
			if (q.organizationId) {
				whereConditions.push(eq(users.organizationId, q.organizationId));
			}
			if (q.search) {
				const searchLower = `%${q.search.toLowerCase()}%`;
				whereConditions.push(
					sql`LOWER(${users.email}) LIKE ${searchLower} OR LOWER(${users.name}) LIKE ${searchLower}`,
				);
			}
			const whereClause = whereConditions.length > 0 ? and(...whereConditions) : undefined;

			const totalRow = whereClause
				? await db.select({ total: sql<number>`count(*)` }).from(users).where(whereClause)
				: await db.select({ total: sql<number>`count(*)` }).from(users);
			const totalItems = Number(totalRow[0]?.total ?? 0);

			const baseQuery = db.select({
				id: users.id,
				email: users.email,
				name: users.name,
				phone: users.phone,
				role: sql<string>`'member'`,
				status: sql<string>`CASE WHEN ${users.disabled} THEN 'disabled' WHEN ${users.emailVerified} THEN 'active' ELSE 'pending' END`,
				disabled: users.disabled,
				emailVerified: users.emailVerified,
				createdAt: users.createdAt,
			})
			.from(users)
			.orderBy(desc(users.createdAt))
			.limit(q.pageSize)
			.offset(offset);

			const rows = whereClause ? await baseQuery.where(whereClause) : await baseQuery;

			const data = rows.map((r) => ({
				...r,
				createdAt: r.createdAt.toISOString(),
			}));

			res.json({
				success: true,
				data: {
					data,
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
				},
			});
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	'/users/:id',
	authenticate,
	requireAdmin,
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const { id } = req.params;

			const row = await db
				.select({
					id: users.id,
					email: users.email,
					name: users.name,
					phone: users.phone,
					role: sql<string>`'member'`,
					status: sql<string>`CASE WHEN ${users.disabled} THEN 'disabled' WHEN ${users.emailVerified} THEN 'active' ELSE 'pending' END`,
					disabled: users.disabled,
					emailVerified: users.emailVerified,
					createdAt: users.createdAt,
					updatedAt: users.updatedAt,
				})
				.from(users)
				.where(eq(users.id, id))
				.limit(1);

			if (!row.length) {
				throw new HttpError(404, 'User not found', 'NOT_FOUND');
			}

			res.json({
				success: true,
				data: {
					...row[0],
					createdAt: row[0].createdAt.toISOString(),
					updatedAt: row[0].updatedAt.toISOString(),
				},
			});
		} catch (err) {
			next(err);
		}
	},
);

router.patch(
	'/users/:id',
	authenticate,
	requireAdmin,
	validate(UpdateUserSchema),
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const { id } = req.params;
			const body = (req as unknown as { validatedBody: z.infer<typeof UpdateUserSchema> }).validatedBody;

			const [updated] = await db
				.update(users)
				.set({ ...body, updatedAt: new Date() })
				.where(eq(users.id, id))
				.returning({
					id: users.id,
					email: users.email,
					name: users.name,
					phone: users.phone,
					disabled: users.disabled,
					emailVerified: users.emailVerified,
					createdAt: users.createdAt,
					updatedAt: users.updatedAt,
				});

			if (!updated) {
				throw new HttpError(404, 'User not found', 'NOT_FOUND');
			}

			await auditLegacy(req, { action: 'user.update', permission: 'users.write', targetType: 'user', targetId: id, after: { ...body } });
			res.json({
				success: true,
				data: {
					...updated,
					role: 'member',
					status: updated.disabled ? 'disabled' : updated.emailVerified ? 'active' : 'pending',
					createdAt: updated.createdAt.toISOString(),
					updatedAt: updated.updatedAt.toISOString(),
				},
			});
		} catch (err) {
			next(err);
		}
	},
);

// ─── Organizations ────────────────────────────────────────────────────────────

router.get(
	'/organizations',
	authenticate,
	requireAdmin,
	validate(AdminListQuerySchema, 'query'),
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const q = (req as unknown as { validatedQuery: z.infer<typeof AdminListQuerySchema> }).validatedQuery;
			const offset = (q.page - 1) * q.pageSize;

			const totalRow = await db.select({ total: sql<number>`count(*)` }).from(organizations);
			const totalItems = Number(totalRow[0]?.total ?? 0);

			const orgs = await db
				.select({
					id: organizations.id,
					name: organizations.name,
					slug: organizations.slug,
					plan: organizations.plan,
					createdAt: organizations.createdAt,
				})
				.from(organizations)
				.orderBy(desc(organizations.createdAt))
				.limit(q.pageSize)
				.offset(offset);

			const orgIds = orgs.map((o) => o.id);
			const memberMap = new Map<string | null, number>();
			if (orgIds.length > 0) {
				const idsArray = orgIds.map((id) => id);
				const memberRows = await db
					.select({ organizationId: users.organizationId, members: sql<number>`count(*)` })
					.from(users)
					// `sql\`... = ANY(${array})\`` expands a JS array into a parameter list
				// and Postgres rejects it with "op ANY/ALL (array) requires array on
				// right side"; inArray emits a proper IN (...) clause.
				.where(inArray(users.organizationId, idsArray))
					.groupBy(users.organizationId);
				memberRows.forEach((m) => memberMap.set(m.organizationId, Number(m.members)));
			}

			const data = orgs.map((o) => ({
				id: o.id,
				name: o.name,
				slug: o.slug,
				plan: o.plan,
				members: memberMap.get(o.id) || 0,
				createdAt: o.createdAt.toISOString(),
			}));

			res.json({
				success: true,
				data: {
					data,
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
				},
			});
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	'/organizations/:id',
	authenticate,
	requireAdmin,
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const { id } = req.params;

			const [org] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);

			if (!org) {
				throw new HttpError(404, 'Organization not found', 'NOT_FOUND');
			}

			const memberRow = await db
				.select({ total: sql<number>`count(*)` })
				.from(users)
				.where(eq(users.organizationId, id));

			res.json({
				success: true,
				data: {
					...org,
					members: Number(memberRow[0]?.total ?? 0),
				},
			});
		} catch (err) {
			next(err);
		}
	},
);

// ─── Audit Logs ───────────────────────────────────────────────────────────────

router.get(
	'/audit-logs',
	authenticate,
	requireAdmin,
	validate(AdminListQuerySchema, 'query'),
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const q = (req as unknown as { validatedQuery: z.infer<typeof AdminListQuerySchema> }).validatedQuery;
			const offset = (q.page - 1) * q.pageSize;

			const conditions: any[] = [];
			if (q.action) {
				conditions.push(eq(auditLogs.action, q.action));
			}
			if (q.organizationId) {
				conditions.push(eq(auditLogs.tenantId, q.organizationId));
			}

			const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

			const totalRow = whereClause
				? await db.select({ total: sql<number>`count(*)` }).from(auditLogs).where(whereClause)
				: await db.select({ total: sql<number>`count(*)` }).from(auditLogs);
			const totalItems = Number(totalRow[0]?.total ?? 0);

			const baseQuery = db.select().from(auditLogs)
				.orderBy(desc(auditLogs.occurredAt))
				.limit(q.pageSize)
				.offset(offset);

			const logs = whereClause ? await baseQuery.where(whereClause) : await baseQuery;

			const data = logs.map((log) => ({
				id: log.id,
				action: log.action,
				actor: log.actorId || log.actorType || 'system',
				actorType: log.actorType,
				actorId: log.actorId,
				outcome: log.outcome,
				targetType: log.targetType,
				targetId: log.targetId,
				timestamp: log.occurredAt.toISOString(),
				occurredAt: log.occurredAt.toISOString(),
				data: log.details || {},
			}));

			res.json({
				success: true,
				data: {
					data,
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
				},
			});
		} catch (err) {
			next(err);
		}
	},
);

// ─── Feature Flags ────────────────────────────────────────────────────────────

router.get(
	'/feature-flags',
	authenticate,
	requireAdmin,
	async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const flags = await db.select().from(featureFlags).orderBy(featureFlags.key);

			const data = flags.map((f) => ({
				id: f.id,
				key: f.key,
				value: f.enabled,
				enabled: f.enabled,
				rolloutPercent: f.rolloutPercent ?? 0,
				description: f.description ?? undefined,
				updatedAt: f.updatedAt.toISOString(),
			}));

			res.json({ success: true, data });
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	'/feature-flags',
	authenticate,
	requireAdmin,
	validate(CreateFlagSchema),
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const body = (req as unknown as { validatedBody: z.infer<typeof CreateFlagSchema> }).validatedBody;

			const [flag] = await db
				.insert(featureFlags)
				.values({
					key: body.key,
					enabled: body.enabled,
					rolloutPercent: body.rolloutPercent,
					description: body.description ?? null,
				})
				.returning();

			await auditLegacy(req, { action: 'feature_flag.create', permission: 'feature_flags.write', targetType: 'feature_flag', targetId: String(flag?.id ?? body.key), after: { key: body.key, enabled: body.enabled } });
			res.status(201).json({
				success: true,
				data: {
					id: flag.id,
					key: flag.key,
					value: flag.enabled,
					enabled: flag.enabled,
					rolloutPercent: flag.rolloutPercent ?? 0,
					description: flag.description ?? undefined,
					updatedAt: flag.updatedAt.toISOString(),
				},
			});
		} catch (err: any) {
			if (err?.code === '23505') {
				return res.status(409).json({ success: false, error: 'Feature flag key already exists', code: 'DUPLICATE_KEY' });
			}
			next(err);
		}
	},
);

router.patch(
	'/feature-flags/:id',
	authenticate,
	requireAdmin,
	validate(UpdateFlagSchema),
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const { id } = req.params;
			const body = (req as unknown as { validatedBody: z.infer<typeof UpdateFlagSchema> }).validatedBody;

			const [flag] = await db
				.update(featureFlags)
				.set({ ...body, updatedAt: new Date() })
				.where(eq(featureFlags.id, id))
				.returning();

			if (!flag) {
				throw new HttpError(404, 'Feature flag not found', 'NOT_FOUND');
			}

			await auditLegacy(req, { action: 'feature_flag.update', permission: 'feature_flags.write', targetType: 'feature_flag', targetId: id, after: { ...body } });
			res.json({
				success: true,
				data: {
					id: flag.id,
					key: flag.key,
					value: flag.enabled,
					enabled: flag.enabled,
					rolloutPercent: flag.rolloutPercent ?? 0,
					description: flag.description ?? undefined,
					updatedAt: flag.updatedAt.toISOString(),
				},
			});
		} catch (err) {
			next(err);
		}
	},
);

router.delete(
	'/feature-flags/:id',
	authenticate,
	requireAdmin,
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const { id } = req.params;

			await db.delete(featureFlags).where(eq(featureFlags.id, id));

			await auditLegacy(req, { action: 'feature_flag.delete', permission: 'feature_flags.write', targetType: 'feature_flag', targetId: id });
			res.json({ success: true });
		} catch (err) {
			next(err);
		}
	},
);

// ─── Incidents ────────────────────────────────────────────────────────────────

router.get(
	'/incidents',
	authenticate,
	requireAdmin,
	validate(AdminListQuerySchema, 'query'),
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const q = (req as unknown as { validatedQuery: z.infer<typeof AdminListQuerySchema> }).validatedQuery;
			const offset = (q.page - 1) * q.pageSize;

			const conditions: any[] = [];
			if (q.organizationId) {
				conditions.push(eq(incidentEvents.organizationId, q.organizationId));
			}
			if (q.severity) {
				conditions.push(eq(incidentEvents.severity, q.severity));
			}
			if (q.resolved !== undefined) {
				conditions.push(eq(incidentEvents.resolved, q.resolved));
			}

			const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

			const totalRow = whereClause
				? await db.select({ total: sql<number>`count(*)` }).from(incidentEvents).where(whereClause)
				: await db.select({ total: sql<number>`count(*)` }).from(incidentEvents);
			const totalItems = Number(totalRow[0]?.total ?? 0);

			const baseQuery = db.select().from(incidentEvents)
				.orderBy(desc(incidentEvents.occurredAt))
				.limit(q.pageSize)
				.offset(offset);

			const incidents = whereClause ? await baseQuery.where(whereClause) : await baseQuery;

			const data = incidents.map((i) => ({
				id: i.id,
				severity: i.severity,
				message: i.title,
				description: i.description ?? undefined,
				title: i.title,
				resolved: i.resolved,
				occurredAt: i.occurredAt.toISOString(),
			}));

			res.json({
				success: true,
				data: {
					data,
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
				},
			});
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	'/incidents',
	authenticate,
	requireAdmin,
	validate(CreateIncidentSchema),
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const body = (req as unknown as { validatedBody: z.infer<typeof CreateIncidentSchema> }).validatedBody;

			const [incident] = await db
				.insert(incidentEvents)
				.values({
					organizationId: null,
					severity: body.severity,
					title: body.title,
					description: body.description ?? null,
					resolved: false,
					resolvedAt: null,
				})
				.returning();

			await auditLegacy(req, { action: 'incident.create', permission: 'incidents.manage', targetType: 'incident', targetId: String(incident?.id ?? ''), after: { severity: body.severity, title: body.title } });
			res.status(201).json({
				success: true,
				data: {
					id: incident.id,
					severity: incident.severity,
					message: incident.title,
					description: incident.description ?? undefined,
					title: incident.title,
					resolved: incident.resolved,
					occurredAt: incident.occurredAt.toISOString(),
				},
			});
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	'/incidents/:id/resolve',
	authenticate,
	requireAdmin,
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const { id } = req.params;

			const [incident] = await db
				.update(incidentEvents)
				.set({ resolved: true, resolvedAt: new Date() })
				.where(eq(incidentEvents.id, id))
				.returning();

			if (!incident) {
				throw new HttpError(404, 'Incident not found', 'NOT_FOUND');
			}

			await auditLegacy(req, { action: 'incident.resolve', permission: 'incidents.manage', targetType: 'incident', targetId: id, after: { resolved: true } });
			res.json({
				success: true,
				data: {
					id: incident.id,
					severity: incident.severity,
					message: incident.title,
					description: incident.description ?? undefined,
					title: incident.title,
					resolved: incident.resolved,
					occurredAt: incident.occurredAt.toISOString(),
				},
			});
		} catch (err) {
			next(err);
		}
	},
);

// ─── Usage Metrics ────────────────────────────────────────────────────────────

router.get(
	'/usage/:tenantId/summary',
	authenticate,
	requireAdmin,
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const { tenantId } = req.params;

			const now = new Date();
			const periodStart = new Date(now);
			periodStart.setDate(periodStart.getDate() - 30);

			const [{ totalCalls = 0 } = {}] = await db
				.select({ totalCalls: sql<number>`COALESCE(SUM(${usageRecords.value}), 0)` })
				.from(usageRecords)
				.where(
					and(
						eq(usageRecords.tenantId, tenantId),
						gte(usageRecords.recordedAt, periodStart),
						sql`${usageRecords.metric} IN ('api_call', 'api_request', 'conversation', 'message')`,
					),
				);

			const [{ totalTokens = 0 } = {}] = await db
				.select({ totalTokens: sql<number>`COALESCE(SUM(${usageRecords.value}), 0)` })
				.from(usageRecords)
				.where(
					and(
						eq(usageRecords.tenantId, tenantId),
						gte(usageRecords.recordedAt, periodStart),
						sql`${usageRecords.metric} IN ('tokens', 'token_usage', 'prompt_tokens', 'completion_tokens')`,
					),
				);

			// NOTE: this is a flat list-price estimate, not a billed figure — there is no
			// per-provider rate table in the schema. It is deliberately NOT rounded to a
			// whole dollar: `Math.round(tokens * 0.00002)` returned an integer, so every
			// tenant under 50k tokens rendered as `$0.00` in the console and the Cost card
			// read as "free" rather than "nearly nothing". Four decimal places keep
			// sub-cent spend visible without implying more precision than the rate has.
			const costPerToken = 0.00002;
			const totalCost = Math.round(totalTokens * costPerToken * 10000) / 10000;

			res.json({
				success: true,
				data: {
					totalCalls: Number(totalCalls),
					totalTokens: Number(totalTokens),
					totalCost,
					period: '30d',
				},
			});
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	'/usage/:tenantId/by-user',
	authenticate,
	requireAdmin,
	async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		try {
			const db = getDb();
			const { tenantId } = req.params;

			const now = new Date();
			const periodStart = new Date(now);
			periodStart.setDate(periodStart.getDate() - 30);

			const rows = await db
				.select({
					userId: usageRecords.userId,
					calls: sql<number>`COALESCE(SUM(CASE WHEN ${usageRecords.metric} IN ('api_call', 'api_request', 'conversation', 'message') THEN ${usageRecords.value} ELSE 0 END), 0)`,
					tokens: sql<number>`COALESCE(SUM(CASE WHEN ${usageRecords.metric} IN ('tokens', 'token_usage', 'prompt_tokens', 'completion_tokens') THEN ${usageRecords.value} ELSE 0 END), 0)`,
				})
				.from(usageRecords)
				.where(
					and(
						eq(usageRecords.tenantId, tenantId),
						gte(usageRecords.recordedAt, periodStart),
					),
				)
				.groupBy(usageRecords.userId)
				.orderBy(desc(sql`COALESCE(SUM(CASE WHEN ${usageRecords.metric} IN ('api_call', 'api_request', 'conversation', 'message') THEN ${usageRecords.value} ELSE 0 END), 0)`))
				.limit(100);

			const userIds = rows.map((r) => r.userId).filter((id): id is string => id != null);
			const userMap = new Map<string, string>();
			if (userIds.length > 0) {
				const idsArray = userIds.map((id) => id);
				const userRows = await db
					.select({ id: users.id, email: users.email, name: users.name })
					.from(users)
					.where(inArray(users.id, idsArray));
				userRows.forEach((u) => userMap.set(u.id, u.email ?? u.name ?? 'unknown'));
			}

			// Same flat estimate and the same reason for not rounding to a whole dollar as
			// the summary above.
			const costPerToken = 0.00002;
			const data = rows.map((r) => ({
				userId: r.userId,
				email: userMap.get(r.userId) ?? 'unknown',
				calls: Number(r.calls),
				tokens: Number(r.tokens),
				cost: Math.round(Number(r.tokens) * costPerToken * 10000) / 10000,
			}));

			res.json({ success: true, data });
		} catch (err) {
			next(err);
		}
	},
);

export default router;
