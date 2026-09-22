/**
 * NOVA — Admin session control.
 *
 * A `sessions` row is the refresh token. The console could already revoke *all* of a
 * user's sessions from the user detail page, but there was no way to answer the
 * operational questions an operator actually asks during an incident:
 *
 *  - "how many sessions are live right now, platform-wide?"
 *  - "which account is this IP address signed in as?"
 *  - "this one row looks like a stolen token — kill *that* session, not every session
 *    the user owns."
 *
 * That last one matters. Revoking every session for a user is a blunt instrument: it
 * signs the person out on their own phone as well as on the attacker's. Revoking a
 * single session is the correct response to one compromised token, so
 * `POST /control/sessions/:id/revoke` exists and is separately audited.
 *
 * ## What is deliberately absent
 *
 * There is no "create session", no "extend expiry", and no way to read a refresh
 * token. `refresh_token_hash` is a hash, the plaintext existed only in the response
 * that issued it, and nothing here can reconstruct it — which is the point.
 *
 * ## Honesty about propagation
 *
 * Revocation deletes nothing; it sets `revoked_at`, and the auth middleware refuses a
 * refresh whose row is revoked. The app only notices on its next refresh, so the same
 * bound the user-detail page states applies here: up to 15 minutes while idle, sooner
 * if the client makes any call. The response says so rather than implying a push.
 */

import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { getDbPool } from '../../db/connection.js';
import { HttpError } from '../../middleware/error-handler.js';
import { validate } from '../../middleware/validate.js';
import {
	type AdminRequest,
	requirePermission,
} from '../../admin/access.js';
import { auditedOperation } from '../../admin/audit.js';

const router: ReturnType<typeof Router> = Router();

const ListSessionsSchema = z.object({
	page: z.coerce.number().int().positive().default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(25),
	/** Matches user email, name, IP address or user-agent, case-insensitively. */
	search: z.string().max(200).optional(),
	status: z.enum(['active', 'revoked', 'expired', 'all']).default('active'),
	sort: z.enum(['createdAt', 'expiresAt']).default('createdAt'),
	order: z.enum(['asc', 'desc']).default('desc'),
	userId: z.string().uuid().optional(),
});

const RevokeSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

/**
 * "Active" is a property of two columns, not one, so it is defined here once and used
 * by both the filter and the per-row flag. A session that has not been revoked but
 * whose `expires_at` has passed is *not* active — it is simply finished, and calling
 * it active overstates how many people are signed in.
 */
const ACTIVE_SQL = 's.revoked_at IS NULL AND s.expires_at > now()';

export type SessionRow = {
	id: string;
	user_id: string;
	email: string | null;
	name: string | null;
	disabled: boolean | null;
	device_id: string | null;
	device_name: string | null;
	device_platform: string | null;
	ip_address: string | null;
	user_agent: string | null;
	expires_at: Date;
	revoked_at: Date | null;
	created_at: Date;
};

/**
 * Derives the operator-facing state of a session row.
 *
 * Exported because it is the one piece of this route with a decision in it, and the
 * decision is easy to get subtly wrong: `revoked_at IS NULL` alone would call a
 * three-week-old expired session "active", which inflates "who is signed in right now"
 * on the dashboard. `now` is a parameter so the boundary is testable rather than
 * dependent on when the suite runs.
 */
export function toSession(row: SessionRow, now: Date = new Date()) {
	const revoked = row.revoked_at !== null;
	const expired = !revoked && row.expires_at <= now;
	return {
		id: row.id,
		user: { id: row.user_id, email: row.email, name: row.name, disabled: row.disabled ?? false },
		device: row.device_id
			? { id: row.device_id, name: row.device_name, platform: row.device_platform }
			: null,
		ipAddress: row.ip_address,
		userAgent: row.user_agent,
		expiresAt: row.expires_at.toISOString(),
		revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
		createdAt: row.created_at.toISOString(),
		/** `active` is the only state an operator can act on. */
		state: revoked ? 'revoked' : expired ? 'expired' : 'active',
		active: !revoked && !expired,
	};
}

/**
 * Builds the `WHERE` fragments for the list query, appending bind parameters in order.
 *
 * Returns plain fragments rather than Drizzle objects because the projection spans a
 * three-table join with a `FILTER` tally, which the query builder does not express
 * without losing the shared-predicate property that keeps the counts and the rows in
 * agreement. Every value is a bind parameter; nothing from the query string is ever
 * concatenated into SQL.
 */
export function sessionConditions(
	q: { status: 'active' | 'revoked' | 'expired' | 'all'; userId?: string; search?: string },
	params: unknown[],
): string[] {
	const conditions: string[] = [];
	if (q.status === 'active') conditions.push(ACTIVE_SQL);
	if (q.status === 'revoked') conditions.push('s.revoked_at IS NOT NULL');
	if (q.status === 'expired') conditions.push('s.revoked_at IS NULL AND s.expires_at <= now()');
	if (q.userId) {
		params.push(q.userId);
		conditions.push(`s.user_id = $${params.length}`);
	}
	if (q.search) {
		params.push(`%${q.search.toLowerCase()}%`);
		const p = `$${params.length}`;
		conditions.push(
			`(lower(u.email) LIKE ${p} OR lower(u.name) LIKE ${p} OR s.ip_address LIKE ${p} OR lower(s.user_agent) LIKE ${p})`,
		);
	}
	return conditions;
}

const SELECT_COLUMNS = `
	s.id, s.user_id, u.email, u.name, u.disabled,
	s.device_id, d.name AS device_name, d.platform AS device_platform,
	s.ip_address, s.user_agent, s.expires_at, s.revoked_at, s.created_at
`;

/**
 * `GET /control/sessions` — every refresh session, filterable.
 *
 * The counts come from the same predicate as the rows, so the totals can never
 * disagree with the page that is rendered beside them.
 */
router.get(
	'/sessions',
	requirePermission('users.read'),
	validate(ListSessionsSchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: z.infer<typeof ListSessionsSchema> }).validatedQuery;
			const pool = getDbPool();
			const offset = (q.page - 1) * q.pageSize;

			const conditions: string[] = [];
			const params: unknown[] = [];
			conditions.push(...sessionConditions(q, params));

			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
			const sortColumn = q.sort === 'expiresAt' ? 's.expires_at' : 's.created_at';
			const direction = q.order === 'asc' ? 'ASC' : 'DESC';

			// The status tally ignores the status filter so the tab counts stay stable while
			// an operator is looking at one tab. It does honour the search and user filters,
			// because those describe what the operator is looking at.
			const scopeConditions = conditions.filter((c) => !c.includes('revoked_at') && !c.includes('expires_at'));
			const scopeWhere = scopeConditions.length > 0 ? `WHERE ${scopeConditions.join(' AND ')}` : '';

			const [countResult, tallyResult, rows] = await Promise.all([
				pool.query<{ total: string }>(
					`SELECT count(*)::int AS total
					 FROM sessions s LEFT JOIN users u ON u.id = s.user_id ${where}`,
					params,
				),
				pool.query<{ active: string; revoked: string; expired: string }>(
					`SELECT
						count(*) FILTER (WHERE ${ACTIVE_SQL})::int AS active,
						count(*) FILTER (WHERE s.revoked_at IS NOT NULL)::int AS revoked,
						count(*) FILTER (WHERE s.revoked_at IS NULL AND s.expires_at <= now())::int AS expired
					 FROM sessions s LEFT JOIN users u ON u.id = s.user_id ${scopeWhere}`,
					scopeConditions.length > 0 ? params : [],
				),
				pool.query<SessionRow>(
					`SELECT ${SELECT_COLUMNS}
					 FROM sessions s
					 LEFT JOIN users u ON u.id = s.user_id
					 LEFT JOIN devices d ON d.id = s.device_id
					 ${where}
					 ORDER BY ${sortColumn} ${direction} NULLS LAST
					 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
					[...params, q.pageSize, offset],
				),
			]);

			const totalItems = Number(countResult.rows[0]?.total ?? 0);
			const tally = tallyResult.rows[0];

			res.json({
				success: true,
				data: {
					data: rows.rows.map((row) => toSession(row)),
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
					counts: {
						active: Number(tally?.active ?? 0),
						revoked: Number(tally?.revoked ?? 0),
						expired: Number(tally?.expired ?? 0),
					},
					notes: [
						'A session is the refresh token. Revoking one makes the next refresh fail, which signs the app out; the client notices on its next call, so the worst case while idle is the 15-minute access-token lifetime.',
						'The access token itself is a signed JWT and is not re-checked against this table, so a revoked session can still make requests until its access token expires. That is a property of stateless access tokens, not a gap in this page.',
						'Refresh tokens are stored only as hashes. No page, including this one, can read or replay one.',
					],
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

/**
 * `POST /control/sessions/:id/revoke` — kill one session.
 *
 * Narrower than the user-level revoke on purpose: reacting to a single suspicious row
 * should not sign the same person out everywhere. Both write the same audit action
 * family, and this one names the session so the log says *which* token was killed.
 */
router.post(
	'/sessions/:id/revoke',
	requirePermission('users.sessions_revoke'),
	validate(RevokeSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id } = req.params;
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
				throw new HttpError(400, 'Invalid session id', 'BAD_REQUEST');
			}
			const body = (req as unknown as { validatedBody: z.infer<typeof RevokeSchema> }).validatedBody;
			const pool = getDbPool();

			const existing = await pool.query<{ id: string; user_id: string; revoked_at: Date | null }>(
				`SELECT id, user_id, revoked_at FROM sessions WHERE id = $1`,
				[id],
			);
			const session = existing.rows[0];
			if (!session) throw new HttpError(404, 'Session not found', 'NOT_FOUND');

			const result = await auditedOperation({
				req,
				action: 'session.revoke',
				permission: 'users.sessions_revoke',
				targetType: 'session',
				targetId: id,
				reason: body.reason,
				run: async () => {
					const updated = await pool.query<{ id: string }>(
						`UPDATE sessions SET revoked_at = now()
						 WHERE id = $1 AND revoked_at IS NULL
						 RETURNING id`,
						[id],
					);
					return { revoked: updated.rowCount ?? 0, userId: session.user_id };
				},
			});

			res.json({
				success: true,
				data: {
					...result,
					alreadyRevoked: session.revoked_at !== null,
					propagation:
						result.revoked > 0
							? 'The session is dead. The app is signed out the next time it refreshes, at most 15 minutes while idle; any request it makes sooner fails sooner.'
							: 'This session was already revoked, so nothing changed. Revoking twice is not an error and is recorded.',
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

export default router;
