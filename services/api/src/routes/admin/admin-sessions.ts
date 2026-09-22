/**
 * NOVA — administrator session control.
 *
 * The registry `admin_sessions` was designed for, finally populated and finally usable.
 * Before this, the table had no writer, so there was no answer to "which administrators
 * are signed in", no handle on an operator's access token, and therefore no way to end
 * another operator's session at all — revoking a refresh token, which is how the mobile
 * app is signed out, does not touch a 15-minute admin access token.
 *
 * ## Why these routes are `admin_users.*` and not `users.*`
 *
 * `users.sessions_revoke` is about a *user's* devices. An administrator's console session
 * is a different thing with a different blast radius: it holds control-plane permissions.
 * Gating it on `admin_users.manage` means only an account that can already change who is an
 * administrator can end one, which is the same principal who could simply change the grant.
 *
 * ## The one guard, and why there is only one
 *
 * A caller may not revoke the session it is currently using. That is the accidental-footgun
 * case (clicking revoke on your own row signs you out mid-incident) and the message says so.
 *
 * There is deliberately **no** "last administrator" guard here, unlike role revocation. The
 * two look similar and are not: removing a role grant takes authority away until an operator
 * with the right permission restores it, whereas ending a session is undone by signing in
 * again. Refusing to revoke the only remaining super-admin session would leave a compromised
 * token alive precisely when ending it matters most.
 */

import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { getDbPool } from '../../db/connection.js';
import { HttpError } from '../../middleware/error-handler.js';
import { validate } from '../../middleware/validate.js';
import { type AdminRequest, requirePermission } from '../../admin/access.js';
import { auditedOperation } from '../../admin/audit.js';
import {
	revokeAdminSession,
	adminSessionState,
	type AdminSessionRecord,
} from '../../admin/admin-sessions.js';

const router: ReturnType<typeof Router> = Router();

const ListSchema = z.object({
	page: z.coerce.number().int().positive().default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(25),
	status: z.enum(['active', 'revoked', 'expired', 'all']).default('active'),
	/** Matches the administrator's email or name, or the session's IP or user-agent. */
	search: z.string().max(200).optional(),
});

const RevokeSchema = z.object({ reason: z.string().min(3).max(500) }).strict();

/**
 * "Active" is two conditions, not one, and it is defined once here so the filter, the tally
 * and the per-row flag cannot disagree. `revoked_at IS NULL` alone would call a session whose
 * token expired an hour ago a live session.
 */
const ACTIVE_SQL = 's.revoked_at IS NULL AND s.expires_at > now()';

type SessionRow = AdminSessionRecord & {
	email: string | null;
	name: string | null;
	user_disabled: boolean | null;
};

function toSession(row: SessionRow, currentJti: string | undefined) {
	return {
		id: row.id,
		user: { id: row.userId, email: row.email, name: row.name, disabled: row.user_disabled ?? false },
		role: row.role,
		ipAddress: row.ipAddress,
		userAgent: row.userAgent,
		expiresAt: new Date(row.expiresAt).toISOString(),
		revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
		lastSeenAt: new Date(row.lastSeenAt).toISOString(),
		createdAt: new Date(row.createdAt).toISOString(),
		state: adminSessionState(row),
		/**
		 * True for the session making this request. The console uses it to disable the revoke
		 * control on the caller's own row rather than letting them click into a refusal.
		 */
		current: Boolean(currentJti && row.jti === currentJti),
	};
}

/**
 * `GET /control/admin-sessions` — every administrator console session.
 *
 * The tally is computed from the same predicate as the rows, so the tabs and the table in the
 * console cannot disagree with each other.
 */
router.get(
	'/admin-sessions',
	requirePermission('admin_users.read'),
	validate(ListSchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: z.infer<typeof ListSchema> }).validatedQuery;
			const pool = getDbPool();
			const offset = (q.page - 1) * q.pageSize;

			const conditions: string[] = [];
			const params: unknown[] = [];

			if (q.status === 'active') conditions.push(ACTIVE_SQL);
			if (q.status === 'revoked') conditions.push('s.revoked_at IS NOT NULL');
			if (q.status === 'expired') conditions.push('s.revoked_at IS NULL AND s.expires_at <= now()');
			if (q.search) {
				params.push(`%${q.search.toLowerCase()}%`);
				const p = `$${params.length}`;
				conditions.push(
					`(lower(u.email) LIKE ${p} OR lower(u.name) LIKE ${p} OR s.ip_address LIKE ${p} OR lower(s.user_agent) LIKE ${p})`,
				);
			}

			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
			// The tally ignores the status filter so the tab counts stay stable while an
			// operator looks at one tab; it honours the search, which describes what they see.
			const scopeConditions = conditions.filter((c) => !c.includes('revoked_at') && !c.includes('expires_at'));
			const scopeWhere = scopeConditions.length > 0 ? `WHERE ${scopeConditions.join(' AND ')}` : '';

			const [countResult, tallyResult, rows] = await Promise.all([
				pool.query<{ total: string }>(
					`SELECT count(*)::int AS total FROM admin_sessions s LEFT JOIN users u ON u.id = s.user_id ${where}`,
					params,
				),
				pool.query<{ active: string; revoked: string; expired: string }>(
					`SELECT
						count(*) FILTER (WHERE ${ACTIVE_SQL})::int AS active,
						count(*) FILTER (WHERE s.revoked_at IS NOT NULL)::int AS revoked,
						count(*) FILTER (WHERE s.revoked_at IS NULL AND s.expires_at <= now())::int AS expired
					 FROM admin_sessions s LEFT JOIN users u ON u.id = s.user_id ${scopeWhere}`,
					scopeConditions.length > 0 ? params : [],
				),
				pool.query<SessionRow>(
					// Aliased to camelCase so the SELECT and `toSession` agree by construction.
					// They did not on the first pass: the query returned `last_seen_at` while the
					// mapper read `lastSeenAt`, so the value was `undefined`,
					// `new Date(undefined).toISOString()` threw, and the whole listing was a 500.
					`SELECT s.id, s.user_id AS "userId", s.jti, s.role,
					        s.ip_address AS "ipAddress", s.user_agent AS "userAgent",
					        s.expires_at AS "expiresAt", s.revoked_at AS "revokedAt",
					        s.last_seen_at AS "lastSeenAt", s.created_at AS "createdAt",
					        u.email, u.name, u.disabled AS user_disabled
					 FROM admin_sessions s LEFT JOIN users u ON u.id = s.user_id
					 ${where}
					 ORDER BY s.last_seen_at DESC
					 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
					[...params, q.pageSize, offset],
				),
			]);

			const totalItems = Number(countResult.rows[0]?.total ?? 0);
			const tally = tallyResult.rows[0];
			const currentJti = req.user?.jti;

			res.json({
				success: true,
				data: {
					data: rows.rows.map((row) => toSession(row, currentJti)),
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
						'A session row is created the first time an access token is used against the control plane, and records the token\'s own expiry rather than a guessed lifetime.',
						'Revoking one marks the row and adds the token to the denylist, which `verifyAccessToken` consults before any request is handled. The session therefore ends on this replica immediately — unlike a user session revoke, which the mobile app only notices on its next refresh.',
						'Revocations are recorded in `revoked_tokens` and each replica polls for the ones it has not seen, so a multi-replica deployment honours a revocation within one poll interval (5 s) rather than not at all. The replica that performed the revocation applies it immediately; the bound on the others is the interval, not the token lifetime.',
						'Access tokens are not stored: only the token id (jti), the role it carried, the client it was used from and its expiry.',
					],
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

/**
 * `POST /control/admin-sessions/:id/revoke` — end one administrator's session.
 *
 * The reason is required because this is a security action against a person: without it the
 * audit row answers "who ended whose session" and not "why", which is the question asked
 * afterwards.
 */
router.post(
	'/admin-sessions/:id/revoke',
	requirePermission('admin_users.manage'),
	validate(RevokeSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { id } = req.params;
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
				throw new HttpError(400, 'Invalid session id', 'BAD_REQUEST');
			}
			const body = (req as unknown as { validatedBody: z.infer<typeof RevokeSchema> }).validatedBody;
			const pool = getDbPool();

			const { rows } = await pool.query<{
				id: string;
				user_id: string;
				jti: string;
				role: string;
				ip_address: string | null;
				user_agent: string | null;
				expires_at: Date;
				revoked_at: Date | null;
				last_seen_at: Date;
				created_at: Date;
				email: string | null;
			}>(
				`SELECT s.id, s.user_id, s.jti, s.role, s.ip_address, s.user_agent, s.expires_at,
				        s.revoked_at, s.last_seen_at, s.created_at, u.email
				 FROM admin_sessions s LEFT JOIN users u ON u.id = s.user_id
				 WHERE s.id = $1`,
				[id],
			);
			const raw = rows[0];
			if (!raw) throw new HttpError(404, 'Session not found', 'NOT_FOUND');

			// The raw query answers snake_case and `revokeAdminSession` takes the Drizzle
			// shape, so the mapping is explicit rather than a cast that would hide a column
			// rename.
			const record: AdminSessionRecord = {
				id: raw.id,
				userId: raw.user_id,
				jti: raw.jti,
				role: raw.role,
				ipAddress: raw.ip_address,
				userAgent: raw.user_agent,
				expiresAt: raw.expires_at,
				revokedAt: raw.revoked_at,
				lastSeenAt: raw.last_seen_at,
				createdAt: raw.created_at,
			};

			// The one guard: a caller cannot end the session it is using. It is recoverable —
			// sign in again — so this is a footgun guard rather than a safety interlock, and
			// the message says which button to use instead.
			if (req.user?.jti && record.jti === req.user.jti) {
				throw new HttpError(
					409,
					'That is the session you are using. Use Sign out to end it, or revoke a different session.',
					'SELF_SESSION',
				);
			}

			const result = await auditedOperation({
				req,
				action: 'admin_session.revoke',
				permission: 'admin_users.manage',
				targetType: 'admin_session',
				targetId: id,
				reason: body.reason,
				before: { userId: record.userId, role: record.role, alreadyRevoked: record.revokedAt !== null },
				run: async () => {
					await revokeAdminSession(record);
					return { revoked: record.revokedAt === null, userId: record.userId };
				},
			});

			res.json({
				success: true,
				data: {
					...result,
					alreadyRevoked: record.revokedAt !== null,
					propagation: result.revoked
						? 'The session is ended. The denylist is consulted before any request is handled, so this replica refuses the next request from that token immediately; other replicas honour it when they read the session row.'
						: 'That session was already revoked, so nothing changed. Revoking twice is not an error and is recorded.',
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

export default router;
