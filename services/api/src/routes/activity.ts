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

} from '../schemas/index.js';
import { decodeKeysetCursor, encodeKeysetCursor, keysetWhere } from '../utils/pagination.js';

const router: ReturnType<typeof Router> = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The single-id cursor helper that lived here is gone: `decodeKeysetCursor` validates
// the uuid as part of decoding, so a second validator would be a place for the two to
// disagree. `UUID_RE` is still used by the `:id` route parameter checks below.

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

		const cursorColumn = auditLogs.id;
		if (q.cursor) {
			// Keyset on `(occurred_at, id)` — see the same fix in tasks.ts. This one at
			// least validated the uuid, which is why a malformed cursor answered 400 here
			// while tasks and reminders answered 500; the pagination itself was still wrong.
			let cursor;
			try {
				cursor = decodeKeysetCursor(q.cursor);
			} catch {
				throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
			}
			whereClauses.push(keysetWhere(auditLogs.occurredAt, cursorColumn, cursor, q.direction));
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
		const last = pageData[pageData.length - 1];
		const first = pageData[0];

		res.status(200).json({
			success: true,
			data: {
				activity: pageData,
				pagination: {
					nextCursor: hasMore && last ? encodeKeysetCursor(last.occurredAt, last.id) : null,
					prevCursor: first ? encodeKeysetCursor(first.occurredAt, first.id) : null,
					hasMore,
					limit: q.limit,
					total,
				},
			},
		});
	} catch (err) { next(err); }
});

export { router as activityRoutes };
