/**
 * NOVA API — Activity Centre, backed by `audit_logs`.
 *
 * Audit rows are written by the platform, not by clients; this route is
 * read-only and scoped to `req.user!.id` so a caller only ever sees the actions
 * recorded against their own account.
 *
 * Envelope and cursor pagination mirror `/reminders`: `data` carries the page
 * under its collection key alongside `pagination`.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { auditLogs } from '@nova/database';
import { eq, desc, and, sql, gt, lt, asc, ilike } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { validate } from '../middleware/validate.js';
import {
	ActivityListQuerySchema,
	parseCursorPagination,
	decodeCursor,
	encodeCursor,
} from '../schemas/index.js';

const router: ReturnType<typeof Router> = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Neutralise LIKE metacharacters in user input. The value is still bound as a
 * parameter — this only stops `%`/`_`/`\` from acting as wildcards.
 */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

// ─── /activity ───────────────────────────────────────────────────────────────

router.get('/', authenticate, validate(ActivityListQuerySchema, 'query'), async (req: AuthenticatedRequest, res, next) => {
	try {
		const validatedQuery = (req as unknown as { validatedQuery?: z.infer<typeof ActivityListQuerySchema> }).validatedQuery;
		const q = validatedQuery ?? (parseCursorPagination(req) as z.infer<typeof ActivityListQuerySchema>);
		const db = getDb();
		const userId = req.user!.id;

		const whereClauses = [eq(auditLogs.userId, userId)];
		// Substring match: the Activity Centre's "Approvals" tab filters on
		// `action=approval`, while stored actions are namespaced strings such as
		// `tool.approval.requested`.
		if (q.action) whereClauses.push(ilike(auditLogs.action, `%${escapeLike(q.action)}%`));
		if (q.outcome) whereClauses.push(eq(auditLogs.outcome, q.outcome));

		if (q.cursor) {
			const decoded = parseCursor(q.cursor);
			whereClauses.push(q.direction === 'backward'
				? lt(auditLogs.id, decoded)
				: gt(auditLogs.id, decoded));
		}

		const where = and(...whereClauses);

		const [countRow] = await db.select({ count: sql<number>`count(*)` })
			.from(auditLogs)
			.where(where);
		const total = Number(countRow?.count ?? 0);

		const orderBy = q.direction === 'backward' ? asc(auditLogs.occurredAt) : desc(auditLogs.occurredAt);
		const rows = await db.select().from(auditLogs)
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
				activity: pageData,
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

export { router as activityRoutes };
