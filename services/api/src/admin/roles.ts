/**
 * NOVA — Platform admin role grants.
 *
 * ## The problem this solves
 *
 * Admin rights came from a single `role` claim in the access token, issued at login. There
 * was no way to grant an existing account an operational role without either editing that
 * claim at the auth service or hand-writing a row. The `roles` and `role_bindings` tables
 * existed and were **empty**.
 *
 * ## Why this does not reuse `roles` as-is
 *
 * `roles.organization_id` is `NOT NULL` and its uniqueness is per organization — it models
 * *tenant* roles (a member of org X who is an admin of org X). A NOVA platform operator is
 * not scoped to a tenant: they act on the whole platform. Reusing the table would have
 * required inventing a fake organization and calling it "platform", which is a lie that the
 * next reader has to decode.
 *
 * So platform grants live in their own table (`platform_admin_roles`) with an explicit
 * `role` column, and the permission set is computed from the **same** `ROLE_PERMISSIONS`
 * matrix the JWT path uses. There is one definition of what a role can do; only the source
 * of the assignment differs.
 *
 * ## The four guards
 *
 * A permission that grants permissions is the most dangerous one in the system, so this is
 * deliberately conservative:
 *
 *  1. **Only a SUPER_ADMIN may grant or revoke.** Enforced by `admin_users.manage`, which
 *     only SUPER_ADMIN holds, plus an explicit check that the *target role* is not above the
 *     caller's own rank. Without the rank check, one PLATFORM_ADMIN who somehow acquired
 *     `admin_users.manage` could mint SUPER_ADMINs.
 *  2. **Nobody may change their own grant.** Mirrors `assertNotSelfEscalation`.
 *  3. **The last SUPER_ADMIN cannot be demoted.** Removing the final `admin_users.manage`
 *     holder would leave a platform nobody can administer — an accidental, unrecoverable
 *     lockout that a "confirm?" dialog does not prevent.
 *  4. **A SUPER_ADMIN's grant cannot be edited at all while they are the last one**, and a
 *     narrow override on a super-admin is refused outright: narrowing the owner's own
 *     permissions is a footgun with no legitimate operational use.
 *
 * Every mutation is audited by the route that calls it, with the operator's reason.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { platformAdminRoles, users } from '@nova/database';
import { getDb } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { ADMIN_ROLES, ROLE_PERMISSIONS, type AdminRole, type Permission } from './permissions.js';

/** Role strength, for the "may not grant above your own rank" check. */
const ROLE_RANK: Record<AdminRole, number> = {
	READ_ONLY: 0,
	ANALYTICS_ADMIN: 1,
	DEVELOPER: 2,
	SUPPORT_ADMIN: 3,
	OPERATIONS_ADMIN: 4,
	PLATFORM_ADMIN: 5,
	SUPER_ADMIN: 6,
};

export function roleRank(role: string): number {
	return ROLE_RANK[role as AdminRole] ?? -1;
}

export function isKnownAdminRole(value: string): value is AdminRole {
	return (ADMIN_ROLES as readonly string[]).includes(value);
}

export type PlatformGrant = {
	id: string;
	userId: string;
	/** As stored. Narrow with `isKnownAdminRole` before using it as a role. */
	role: string;
	grantedBy: string | null;
	reason: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export async function listGrantsForUser(userId: string): Promise<PlatformGrant[]> {
	const db = getDb();
	const rows = (await db
		.select()
		.from(platformAdminRoles)
		.where(eq(platformAdminRoles.userId, userId))) as unknown as PlatformGrant[];
	return rows;
}

export async function listAllGrants(): Promise<
	Array<PlatformGrant & { email: string | null; name: string | null }>
> {
	const db = getDb();
	const rows = (await db
		.select({
			id: platformAdminRoles.id,
			userId: platformAdminRoles.userId,
			role: platformAdminRoles.role,
			grantedBy: platformAdminRoles.grantedBy,
			reason: platformAdminRoles.reason,
			createdAt: platformAdminRoles.createdAt,
			updatedAt: platformAdminRoles.updatedAt,
			email: users.email,
			name: users.name,
		})
		.from(platformAdminRoles)
		.leftJoin(users, eq(users.id, platformAdminRoles.userId))) as unknown as Array<
		PlatformGrant & { email: string | null; name: string | null }
	>;
	return rows;
}

/**
 * The permissions an account holds from its database grants.
 *
 * Returns `null` when the account has **no** grant, which is the signal for the access
 * layer to fall back to the JWT role claim. `null` and `[]` mean different things and the
 * distinction matters: `[]` would deny everything to an owner who has never been assigned a
 * platform role, locking the only administrator out of the console they just deployed.
 */
export async function resolveGrantedPermissions(
	userId: string,
): Promise<{ permissions: Permission[]; roles: AdminRole[] } | null> {
	try {
		const grants = await listGrantsForUser(userId);
		if (grants.length === 0) return null;

		const permissions = new Set<Permission>();
		const roles: AdminRole[] = [];
		for (const grant of grants) {
			const adminRole = grant.role as AdminRole;
			if (!isKnownAdminRole(adminRole)) {
				// A role this build does not know contributes nothing rather than being
				// coerced to something permissive.
				logger.warn({ userId, role: grant.role }, '[admin-roles] unknown role on a grant; ignored');
				continue;
			}
			roles.push(adminRole);
			for (const permission of ROLE_PERMISSIONS[adminRole]) permissions.add(permission);
		}

		// Every grant was unknown: treat it as no grant so the claim path still applies,
		// rather than denying the account every permission.
		if (roles.length === 0) return null;

		return { permissions: [...permissions], roles };
	} catch (error) {
		// Fail open to the token claim. A database problem must not strip an operator's
		// permissions mid-incident; the claim was already verified by the auth layer.
		logger.error({ err: error, userId }, '[admin-roles] could not resolve grants; falling back to the token claim');
		return null;
	}
}

/** How many accounts hold a grant whose permission set includes `permission`. */
export async function countHoldersOf(permission: Permission): Promise<number> {
	const db = getDb();
	const rows = (await db.select().from(platformAdminRoles)) as unknown as PlatformGrant[];

	const qualifying = rows
		.filter((row) => isKnownAdminRole(row.role))
		.filter((row) => ROLE_PERMISSIONS[row.role as AdminRole].includes(permission));

	// Distinct accounts, in case someone holds two roles.
	return new Set(qualifying.map((row) => row.userId)).size;
}

export type GrantResult =
	| { ok: true; grant: PlatformGrant }
	| { ok: false; code: string; message: string };

/**
 * Grant or replace an account's platform role.
 *
 * One role per account: a second grant replaces the first. That keeps "what can this person
 * do" answerable by looking at one row, and matches how the rest of the system reasons about
 * a single role claim. Multiple concurrent grants would create a union nobody can hold in
 * their head during an incident.
 */
export async function setPlatformGrant(options: {
	userId: string;
	role: AdminRole;
	grantedBy: string;
	grantedByRole: AdminRole | null;
	reason: string;
}): Promise<GrantResult> {
	const { userId, role, grantedBy, grantedByRole, reason } = options;

	if (!isKnownAdminRole(role)) {
		return { ok: false, code: 'UNKNOWN_ROLE', message: `"${role}" is not a known admin role.` };
	}

	// Guard 2: no self-service grants, in either direction.
	if (userId === grantedBy) {
		return {
			ok: false,
			code: 'SELF_ESCALATION_BLOCKED',
			message: 'You cannot change your own platform role. Ask another super-admin.',
		};
	}

	// Guard 1: never grant above the caller's own rank.
	if (grantedByRole === null || roleRank(role) > roleRank(grantedByRole)) {
		return {
			ok: false,
			code: 'RANK_EXCEEDED',
			message: `Granting ${role} requires a role at least as privileged as ${role}. You hold ${grantedByRole ?? 'none'}.`,
		};
	}

	const db = getDb();
	const [target] = (await db
		.select({ id: users.id, email: users.email })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1)) as unknown as Array<{ id: string; email: string | null }>;

	if (!target) {
		return { ok: false, code: 'NOT_FOUND', message: 'No such account.' };
	}

	const existing = await listGrantsForUser(userId);
	const current = existing[0];

	// Guard 4: an existing SUPER_ADMIN grant can only be replaced by another SUPER_ADMIN
	// grant. Narrowing the top role through this path is more likely to be a mistake than an
	// intent, and it is exactly how an operator locks themselves out by accident.
	if (current && roleRank(current.role) === roleRank('SUPER_ADMIN') && roleRank(role) < roleRank('SUPER_ADMIN')) {
		return {
			ok: false,
			code: 'WOULD_DEMOTE_SUPER_ADMIN',
			message:
				'This account holds SUPER_ADMIN. Narrowing it is refused here; use the documented recovery path so the platform cannot be left without a super-admin.',
		};
	}

	// Guard 3: refuse the change if it would leave nobody able to manage admins.
	if (roleRank(current?.role ?? 'READ_ONLY') >= roleRank('SUPER_ADMIN') && roleRank(role) < roleRank('SUPER_ADMIN')) {
		const holders = await countHoldersOf('admin_users.manage');
		const wouldRemain =
			holders - (current && ROLE_PERMISSIONS[current.role as AdminRole].includes('admin_users.manage') ? 1 : 0);
		if (wouldRemain < 1) {
			return {
				ok: false,
				code: 'LAST_SUPER_ADMIN',
				message:
					'This is the last account that can manage administrators. Grant another first — otherwise nobody could undo a mistake.',
			};
		}
	}

	const [row] = (await db
		.insert(platformAdminRoles)
		.values({ userId, role, grantedBy, reason })
		.onConflictDoUpdate({
			target: platformAdminRoles.userId,
			set: { role, grantedBy, reason, updatedAt: new Date() },
		})
		.returning()) as unknown as PlatformGrant[];

	if (!row) {
		return { ok: false, code: 'WRITE_FAILED', message: 'The grant could not be saved.' };
	}

	return { ok: true, grant: row };
}

/** Remove an account's platform grant, restoring the token-claim path for it. */
export async function removePlatformGrant(options: {
	userId: string;
	removedBy: string;
}): Promise<GrantResult> {
	const { userId, removedBy } = options;

	if (userId === removedBy) {
		return {
			ok: false,
			code: 'SELF_ESCALATION_BLOCKED',
			message: 'You cannot remove your own platform role. Ask another super-admin.',
		};
	}

	const existing = await listGrantsForUser(userId);
	if (existing.length === 0) {
		return { ok: false, code: 'NOT_FOUND', message: 'This account has no platform role grant.' };
	}

	// Guard 3 again: revoking the last administrator would lock the platform.
	const holdsAdminManage = existing.some((grant) =>
		isKnownAdminRole(grant.role) ? ROLE_PERMISSIONS[grant.role as AdminRole].includes('admin_users.manage') : false,
	);
	if (holdsAdminManage) {
		const holders = await countHoldersOf('admin_users.manage');
		if (holders <= 1) {
			return {
				ok: false,
				code: 'LAST_SUPER_ADMIN',
				message:
					'This is the last account that can manage administrators, so its grant cannot be revoked. Grant another super-admin first.',
			};
		}
	}

	const db = getDb();
	await db.delete(platformAdminRoles).where(eq(platformAdminRoles.userId, userId));

	return { ok: true, grant: existing[0] };
}

/**
 * Whether an account can administer other administrators, from either source.
 *
 * Used by the console to decide whether to offer role controls, and by the route guard's
 * tests. It deliberately considers the token claim too, because an owner with no database
 * grant is still a super-admin.
 */
export async function canManageAdmins(userId: string, claimRole: string | undefined): Promise<boolean> {
	const granted = await resolveGrantedPermissions(userId);
	if (granted) return granted.permissions.includes('admin_users.manage');
	const { toAdminRole } = await import('./permissions.js');
	const adminRole = toAdminRole(claimRole);
	return adminRole ? ROLE_PERMISSIONS[adminRole].includes('admin_users.manage') : false;
}

/** The role label an account should be shown as, preferring an explicit grant. */
export async function effectiveRoleLabel(
	userId: string,
	claimRole: string | undefined,
): Promise<{ role: AdminRole | null; source: 'grant' | 'claim' | 'none' }> {
	const granted = await resolveGrantedPermissions(userId);
	if (granted && granted.roles.length > 0) {
		// Highest rank wins when an account somehow holds more than one.
		const strongest = granted.roles.reduce((best, role) => (roleRank(role) > roleRank(best) ? role : best));
		return { role: strongest, source: 'grant' };
	}
	const { toAdminRole } = await import('./permissions.js');
	const fromClaim = toAdminRole(claimRole);
	return fromClaim ? { role: fromClaim, source: 'claim' } : { role: null, source: 'none' };
}

export { ADMIN_ROLES, ROLE_PERMISSIONS, isNull, inArray, sql, and };
