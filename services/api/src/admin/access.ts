/**
 * NOVA — Admin access control middleware.
 *
 * This is the security boundary for the control plane. Every `/admin/*` route
 * passes through one of these guards, and the guard is what decides; the console
 * hiding a button is presentation, not authorisation.
 *
 * Three behaviours here are deliberate and worth not "simplifying" later:
 *
 * 1. **Denials are audited.** `requirePermission` writes a `denied` row before
 *    throwing 403. Without it the audit log answers "what did admins do" but not
 *    "who tried to do what they could not" — the question that actually detects a
 *    compromised or over-reaching account.
 *
 * 2. **A self-service role change is refused.** `requirePermission` cannot know
 *    that by itself, so `assertNotSelfEscalation` exists and is called by the
 *    admin-user routes. Without it a PLATFORM_ADMIN with `admin_users.manage`
 *    could promote itself to SUPER_ADMIN and the role split would be decorative.
 *
 * 3. **The environment header is informational only.** `X-Nova-Environment` is
 *    recorded on the audit row so a production change made from a staging console
 *    is legible after the fact. It is never used to permit or deny: a client-sent
 *    header is not an authorisation signal.
 */

import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../middleware/error-handler.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import {
	type Permission,
	effectivePermissions,
	isAdminPlatformRole,
	toAdminRole,
} from './permissions.js';
import { actorFromRequest, recordAdminAction, type AdminActor } from './audit.js';
import { beginAdminSession } from './admin-sessions.js';

export type AdminRequest = AuthenticatedRequest & {
	adminActor?: AdminActor;
	adminPermissions?: Permission[];
	/** Environment the operator claims to be acting from. Recorded, not trusted. */
	adminEnvironment?: string;
	/** Whether the effective permissions came from a database grant or the token claim. */
	adminGrantSource?: 'grant' | 'claim';
};

const VALID_ENVIRONMENTS = new Set(['local', 'development', 'staging', 'production']);

/**
 * Resolves the acting admin and attaches `adminActor` plus `adminPermissions`.
 *
 * Two sources of authority, in this order:
 *
 *  1. **An explicit platform role grant** in `platform_admin_roles`. When an account has
 *     one, it decides the permission set — this is what makes role assignment from the
 *     console real rather than cosmetic.
 *  2. **The `role` claim in the access token**, for accounts with no grant. Every
 *     deployment before role assignment existed relies on this, so it stays as the
 *     fallback and nothing that worked stops working.
 *
 * Async because resolving a grant reads the database. That is safe here: the mounts use
 * `adminGate` as normal middleware and Express 4 does not catch rejected promises, so the
 * body is wrapped in try/catch and every failure is forwarded with `next(err)` — the same
 * discipline `authenticate` documents.
 */
export async function resolveAdmin(req: AdminRequest, _res: Response, next: NextFunction): Promise<void> {
	try {
		const user = req.user;
		if (!user) {
			throw new HttpError(401, 'Authentication required', 'UNAUTHORIZED');
		}

		// A database grant can authorise an account whose token claim is not an admin role,
		// which is the whole point of granting one. So the claim check happens only when
		// there is no grant.
		const { resolveGrantedPermissions } = await import('./roles.js');
		const granted = await resolveGrantedPermissions(user.id);

		if (!granted && !isAdminPlatformRole(user.role)) {
			throw new HttpError(403, 'Forbidden — not an administrator account', 'FORBIDDEN');
		}

		const environmentHeader = req.headers['x-nova-environment'];
		const environment = Array.isArray(environmentHeader) ? environmentHeader[0] : environmentHeader;

		req.adminActor = actorFromRequest(req) ?? undefined;
		req.adminPermissions = granted ? granted.permissions : effectivePermissions(user.role);
		// Recorded so an audit row shows whether a grant or a claim authorised the action —
		// the two have different lifecycles and different revocation paths.
		req.adminGrantSource = granted ? 'grant' : 'claim';
		req.adminEnvironment =
			typeof environment === 'string' && VALID_ENVIRONMENTS.has(environment.toLowerCase())
				? environment.toLowerCase()
				: (process.env.NODE_ENV ?? 'development');

		// Register this token's session, and refuse it if an operator has ended it.
		//
		// Here rather than in a route because this is the one place every control-plane
		// request passes through, and the check has to cover reads as well as mutations: a
		// stale listing on a revoked token is still a live session. `admin_sessions` had no
		// writer before this, so a revocation had nothing to act on.
		const sessionLive = await beginAdminSession({
			userId: user.id,
			jti: user.jti,
			role: req.adminActor?.adminRole ?? user.role,
			ipAddress: req.adminActor?.ipAddress ?? null,
			userAgent: req.adminActor?.userAgent ?? null,
			expiresAtSeconds: user.exp,
		});
		if (!sessionLive) {
			throw new HttpError(
				401,
				'This administrator session was ended. Sign in again.',
				'SESSION_REVOKED',
			);
		}

		next();
	} catch (error) {
		next(error);
	}
}

/** `authenticate` + `resolveAdmin`. Mount once at the router root. */
export const adminGate = [authenticate, resolveAdmin];

/**
 * Requires a permission, and records a denial when it is absent.
 *
 * The audit write happens *before* `next(err)` and is awaited, so a 403 is never
 * observed by the client without a corresponding row. `recordAdminAction` swallows
 * its own errors, so this cannot turn a 403 into a 500.
 */
export function requirePermission(permission: Permission) {
	return async (req: AdminRequest, _res: Response, next: NextFunction): Promise<void> => {
		try {
			if (!req.adminActor) {
				// Defensive: a mis-mounted route must fail closed rather than
				// treating "no resolved actor" as "no restriction".
				throw new HttpError(401, 'Authentication required', 'UNAUTHORIZED');
			}

			const granted = req.adminPermissions ?? [];
			if (!granted.includes(permission)) {
				await recordAdminAction({
					actor: req.adminActor,
					action: `${req.method} ${req.baseUrl}${req.path}`,
					permission,
					outcome: 'denied',
					reason: `Role ${req.adminActor.adminRole ?? 'unknown'} does not hold ${permission}`,
				});
				throw new HttpError(
					403,
					`Forbidden — this action requires the "${permission}" permission`,
					'FORBIDDEN',
				);
			}
			next();
		} catch (error) {
			next(error);
		}
	};
}

/** Convenience for a route needing any one of several permissions. */
export function requireAnyPermission(...permissions: Permission[]) {
	return async (req: AdminRequest, _res: Response, next: NextFunction): Promise<void> => {
		try {
			const granted = req.adminPermissions ?? [];
			if (!permissions.some((p) => granted.includes(p))) {
				await recordAdminAction({
					actor: req.adminActor ?? null,
					action: `${req.method} ${req.baseUrl}${req.path}`,
					permission: permissions[0],
					outcome: 'denied',
					reason: `Requires one of: ${permissions.join(', ')}`,
				});
				throw new HttpError(
					403,
					`Forbidden — this action requires one of: ${permissions.join(', ')}`,
					'FORBIDDEN',
				);
			}
			next();
		} catch (error) {
			next(error);
		}
	};
}

/**
 * Refuses a role change that targets the caller's own account.
 *
 * Called by the admin-user management routes. Prevents privilege
 * self-escalation, and equally prevents an admin from locking themselves out by
 * demoting their own last SUPER_ADMIN account.
 */
export function assertNotSelfEscalation(req: AdminRequest, targetUserId: string): void {
	if (req.adminActor?.id === targetUserId) {
		throw new HttpError(
			403,
			'Forbidden — you cannot change your own role or permissions',
			'SELF_ESCALATION_BLOCKED',
		);
	}
}

/** True when the actor holds the permission. For conditional logic inside a route. */
export function holdsPermission(req: AdminRequest, permission: Permission): boolean {
	return (req.adminPermissions ?? []).includes(permission);
}

export { toAdminRole };
