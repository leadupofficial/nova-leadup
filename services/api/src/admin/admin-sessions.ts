/**
 * NOVA — the registry of live administrator sessions.
 *
 * ## Why this module exists
 *
 * The `admin_sessions` table was created by migration 0006 with an index on `jti`, a unique
 * constraint on it, and an index on `expires_at` — and **nothing ever inserted a row**.
 * `touchAdminSession()` updated `last_seen_at` on a row that could not exist, so it silently
 * matched zero rows on every privileged action, and the table sat empty while 638 audit rows
 * named who had acted.
 *
 * The consequences were operational, not cosmetic:
 *
 *  * "which administrators are signed in right now" was unanswerable — the console derived
 *    actors from the audit log, which says who acted in the past and nothing about who holds
 *    a usable token now;
 *  * an operator had **no way to end another operator's session**. Revoking a refresh token
 *    (the mobile mechanism) does not touch an admin's 15-minute access token, and there was
 *    no handle to the access token at all;
 *  * nothing recorded the address or client an admin token was being used from, so a stolen
 *    token was indistinguishable from a legitimate one.
 *
 * ## Two layers, and which one is authoritative
 *
 * 1. **`tokenDenylist`** — in-process, checked synchronously by `verifyAccessToken` on every
 *    request. Revoking here ends the session on *this* replica immediately, which is what
 *    makes force-logout a real action rather than a request to log out later.
 * 2. **`admin_sessions`** — the durable record. It is what the console lists, what carries
 *    the operator's reason for a revocation after the fact, and what survives a restart.
 *
 * They are revoked together. The denylist alone would lose the reason on restart; the table
 * alone would let a revoked session keep working until its token expired. The honest limit is
 * documented in `revokeAdminSession`: on a multi-replica deployment the denylist is per
 * process, so a revocation is immediate on the replica that performed it and reaches the
 * others when they read the row — which they do on the next request.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { adminSessions } from '@nova/database';
import { getDb } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { tokenDenylist } from '../middleware/token-denylist.js';

/** How stale `last_seen_at` may get before a read refreshes it. */
const LAST_SEEN_REFRESH_MS = 60_000;

export type AdminSessionRecord = {
	id: string;
	userId: string;
	jti: string;
	role: string;
	ipAddress: string | null;
	userAgent: string | null;
	expiresAt: Date;
	revokedAt: Date | null;
	lastSeenAt: Date;
	createdAt: Date;
};

/**
 * Records the session this request is using, and reports whether it may continue.
 *
 * Called from `resolveAdmin`, so it runs on every `/control/*` request that got past
 * `authenticate` — including read-only pages, because a session that only appears after a
 * mutation would make "who is signed in" wrong for exactly the observers who never mutate.
 *
 * Returns `false` when the session has been revoked, which the caller turns into a 401.
 *
 * ## Failure behaviour, deliberately asymmetric
 *
 * * **Registration and the `last_seen_at` refresh are best-effort.** A failure is logged and
 *   ignored. A registry write must never be the reason an operator cannot reach the console
 *   during the incident they are trying to fix.
 * * **The revocation check fails open**, matching `resolveGrantedPermissions` in
 *   `admin/roles.ts`, which documents the same choice for the same reason. This is defensible
 *   here rather than merely convenient: `verifyAccessToken` has *already* consulted the
 *   in-process denylist before this runs, so a revocation performed on this replica is
 *   enforced regardless of the database. What a database outage costs is cross-replica
 *   immediacy, not the ability to revoke at all — and refusing every admin request because a
 *   lookup failed would take the control plane down with the thing it is used to diagnose.
 */
export async function beginAdminSession(input: {
	userId: string;
	jti: string | undefined;
	role: string;
	ipAddress: string | null;
	userAgent: string | null;
	/** The token's `exp`, in Unix seconds. */
	expiresAtSeconds: number | undefined;
}): Promise<boolean> {
	// No `jti` means a token minted outside the normal path (a test fixture, or a legacy
	// token). There is no stable handle to register or revoke, so it is left untracked
	// rather than stored under a synthetic id that could never be matched again.
	if (!input.jti) return true;

	try {
		const db = getDb();
		const [existing] = (await db
			.select()
			.from(adminSessions)
			.where(eq(adminSessions.jti, input.jti))
			.limit(1)) as unknown as AdminSessionRecord[];

		if (existing) {
			if (existing.revokedAt) return false;

			// Throttled: one write per session per minute, not one per request. The console
			// polls several pages on load, and a write per request would make an operator's
			// page views the busiest table in the database.
			if (Date.now() - new Date(existing.lastSeenAt).getTime() > LAST_SEEN_REFRESH_MS) {
				await db
					.update(adminSessions)
					.set({
						lastSeenAt: new Date(),
						ipAddress: input.ipAddress,
						userAgent: input.userAgent,
					})
					.where(eq(adminSessions.id, existing.id));
			}
			return true;
		}

		// First request on this token. `expiresAt` comes from the token itself; the fallback
		// exists only for a token with no `exp` claim, and is deliberately short rather than
		// long, so an unexpiring session cannot be produced by a malformed token.
		const expiresAt = input.expiresAtSeconds
			? new Date(input.expiresAtSeconds * 1000)
			: new Date(Date.now() + 15 * 60 * 1000);

		await db.insert(adminSessions).values({
			userId: input.userId,
			jti: input.jti,
			role: input.role,
			ipAddress: input.ipAddress,
			userAgent: input.userAgent,
			expiresAt,
		});
		return true;
	} catch (error) {
		// Race on the unique `jti`: two concurrent first requests. The row exists now, so the
		// session is registered; nothing is wrong and nothing needs reporting at error level.
		logger.warn({ err: error, userId: input.userId }, '[admin-sessions] could not register or read the session');
		return true;
	}
}

/** Ends one administrator session, immediately on this replica and durably everywhere. */
export async function revokeAdminSession(record: AdminSessionRecord): Promise<void> {
	const db = getDb();
	await db
		.update(adminSessions)
		.set({ revokedAt: new Date() })
		.where(and(eq(adminSessions.id, record.id), isNull(adminSessions.revokedAt)));

	tokenDenylist.revoke(record.jti, record.userId, new Date(record.expiresAt).getTime());
}

/** What a session row means to an operator. Derived on the server so the console cannot re-invent it. */
export function adminSessionState(
	record: Pick<AdminSessionRecord, 'revokedAt' | 'expiresAt'>,
	now: Date = new Date(),
): 'active' | 'revoked' | 'expired' {
	if (record.revokedAt) return 'revoked';
	// Expiry is checked second so a session that was revoked and then expired reads as
	// revoked: the revocation is the operator's decision and is the more useful fact.
	return new Date(record.expiresAt) <= now ? 'expired' : 'active';
}

/** Active sessions for one account, which is what a "sign out everywhere" needs to count. */
export async function countActiveSessionsForUser(userId: string): Promise<number> {
	const db = getDb();
	const [row] = (await db
		.select({ n: sql<number>`count(*)::int` })
		.from(adminSessions)
		.where(
			and(
				eq(adminSessions.userId, userId),
				isNull(adminSessions.revokedAt),
				sql`${adminSessions.expiresAt} > now()`,
			),
		)) as unknown as Array<{ n: number }>;
	return Number(row?.n ?? 0);
}
