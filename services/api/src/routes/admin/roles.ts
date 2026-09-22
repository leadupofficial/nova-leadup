/**
 * NOVA — Admin role management routes.
 *
 * Mounted under `/control/platform-roles`. This is the write path that makes the console's
 * permission matrix real: before it existed, `role_bindings` was empty and an account's
 * rights came only from the `role` claim minted at login.
 *
 * A permission that grants permissions is the most dangerous surface in the system, so the
 * guards live in `admin/roles.ts` (all four of them, so they cannot be forgotten at a call
 * site) and every mutation here is audited with the operator's reason.
 *
 * Read access is `admin_users.read`; every write is `admin_users.manage`, which only
 * SUPER_ADMIN holds. That is not the only protection — `setPlatformGrant` independently
 * refuses to grant above the caller's own rank, refuses self-changes, and refuses to remove
 * the last administrator.
 */

import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { ADMIN_ROLES, ROLE_PERMISSIONS, toAdminRole, type AdminRole } from '../../admin/permissions.js';
import { type AdminRequest, adminGate, requirePermission } from '../../admin/access.js';
import { auditedOperation } from '../../admin/audit.js';
import {
	canManageAdmins,
	effectiveRoleLabel,
	isKnownAdminRole,
	listAllGrants,
	listGrantsForUser,
	removePlatformGrant,
	resolveGrantedPermissions,
	roleRank,
	setPlatformGrant,
} from '../../admin/roles.js';
import { HttpError } from '../../middleware/error-handler.js';
import { validate } from '../../middleware/validate.js';
import { getDb } from '../../db/connection.js';
import { users } from '@nova/database';
import { eq } from 'drizzle-orm';

const router: ReturnType<typeof Router> = Router();
router.use(adminGate);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GrantSchema = z
	.object({
		role: z.enum(ADMIN_ROLES as unknown as [AdminRole, ...AdminRole[]]),
		reason: z.string().min(3).max(500),
	})
	.strict();

const RevokeSchema = z
	.object({
		reason: z.string().min(3).max(500),
		confirm: z.string().min(1),
	})
	.strict();

/** `GET /control/platform-roles` — every grant, with its effective permission set. */
router.get(
	'/platform-roles',
	requirePermission('admin_users.read'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const grants = await listAllGrants();

			res.json({
				success: true,
				data: {
					grants: grants.map((grant) => {
						const adminRole = isKnownAdminRole(grant.role) ? grant.role : null;
						return {
							id: grant.id,
							userId: grant.userId,
							email: grant.email,
							name: grant.name,
							role: grant.role,
							roleKnown: adminRole !== null,
							permissionCount: adminRole ? ROLE_PERMISSIONS[adminRole].length : 0,
							permissions: adminRole ? ROLE_PERMISSIONS[adminRole] : [],
							grantedBy: grant.grantedBy,
							reason: grant.reason,
							createdAt: grant.createdAt.toISOString(),
							updatedAt: grant.updatedAt.toISOString(),
						};
					}),
					caller: {
						userId: req.adminActor?.id ?? null,
						claimRole: req.adminActor?.platformRole ?? null,
						grantSource: req.adminGrantSource ?? null,
						canManageAdmins: await canManageAdmins(req.adminActor?.id ?? '', req.adminActor?.platformRole),
						canGrantUpTo: (() => {
							// The strongest role this caller may assign, so the UI can disable the
							// rest rather than offering a button that answers 403.
							const callerRank = roleRank(toAdminRole(req.adminActor?.platformRole ?? null) ?? '');
							return ADMIN_ROLES.filter((role) => roleRank(role) <= callerRank);
						})(),
					},
					roles: ADMIN_ROLES.map((role) => ({
						role,
						rank: roleRank(role),
						permissionCount: ROLE_PERMISSIONS[role].length,
						description: describeRole(role),
					})),
					availableAccounts: await listCandidateAccounts(),
					notes: [
						'One grant per account: assigning a role replaces any previous grant.',
						'An account with no grant falls back to the role claim in its access token, which is how every deployment behaved before role assignment existed.',
						'Only a SUPER_ADMIN can grant or revoke. A grant above the caller’s own rank is refused, self-changes are refused, and the last account able to manage administrators cannot be demoted or revoked.',
					],
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

/** `PUT /control/platform-roles/:userId` — grant or replace an account's platform role. */
router.put(
	'/platform-roles/:userId',
	requirePermission('admin_users.manage'),
	validate(GrantSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { userId } = req.params;
			if (!UUID_PATTERN.test(userId)) throw new HttpError(400, 'Invalid user id', 'BAD_REQUEST');

			const body = (req as unknown as { validatedBody: z.infer<typeof GrantSchema> }).validatedBody;
			const before = await listGrantsForUser(userId);

			const result = await auditedOperation({
				req,
				action: 'platform_role.grant',
				permission: 'admin_users.manage',
				targetType: 'user',
				targetId: userId,
				reason: body.reason,
				before: { grants: before.map((grant) => ({ role: grant.role })) },
				run: async () => {
					const outcome = await setPlatformGrant({
						userId,
						role: body.role,
						grantedBy: req.adminActor?.id ?? 'unknown',
						// Re-derived rather than trusted as a string, so an unknown role cannot be
						// passed where a known one is required.
						grantedByRole: toAdminRole(req.adminActor?.platformRole ?? null),
						reason: body.reason,
					});
					if (!outcome.ok) {
						// Thrown so `auditedOperation` records the failure and the error handler
						// returns a structured problem response.
						throw new HttpError(outcome.code === 'NOT_FOUND' ? 404 : 403, outcome.message, outcome.code);
					}
					return outcome.grant;
				},
			});

			res.json({
				success: true,
				data: {
					userId,
					role: result.role,
					permissionCount: ROLE_PERMISSIONS[result.role as AdminRole]?.length ?? 0,
					propagation:
						'Applied on this account’s next request: permissions are resolved per request, so no re-login and no token reissue is needed. Revocation takes effect the same way.',
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

/** `DELETE /control/platform-roles/:userId` — revoke, restoring the token-claim path. */
router.delete(
	'/platform-roles/:userId',
	requirePermission('admin_users.manage'),
	validate(RevokeSchema),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { userId } = req.params;
			if (!UUID_PATTERN.test(userId)) throw new HttpError(400, 'Invalid user id', 'BAD_REQUEST');

			const body = (req as unknown as { validatedBody: z.infer<typeof RevokeSchema> }).validatedBody;
			// Typed confirmation: revoking a grant changes what a person can do with no undo.
			if (body.confirm !== 'REVOKE') {
				throw new HttpError(400, 'Type REVOKE to confirm removing this grant.', 'CONFIRMATION_REQUIRED');
			}

			const before = await listGrantsForUser(userId);

			await auditedOperation({
				req,
				action: 'platform_role.revoke',
				permission: 'admin_users.manage',
				targetType: 'user',
				targetId: userId,
				reason: body.reason,
				before: { grants: before.map((grant) => ({ role: grant.role })) },
				run: async () => {
					const outcome = await removePlatformGrant({ userId, removedBy: req.adminActor?.id ?? 'unknown' });
					if (!outcome.ok) {
						throw new HttpError(outcome.code === 'NOT_FOUND' ? 404 : 403, outcome.message, outcome.code);
					}
					return { revoked: true };
				},
			});

			res.json({
				success: true,
				data: {
					userId,
					revoked: true,
					propagation:
						'The grant is gone, so this account falls back to the role claim in its token — which may still be an admin role. Revoke the token claim at the auth service to remove console access entirely.',
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

/** `GET /control/platform-roles/:userId` — one account's grant and effective permissions. */
router.get(
	'/platform-roles/:userId',
	requirePermission('admin_users.read'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { userId } = req.params;
			if (!UUID_PATTERN.test(userId)) throw new HttpError(400, 'Invalid user id', 'BAD_REQUEST');

			const [grants, resolved, effective] = await Promise.all([
				listGrantsForUser(userId),
				resolveGrantedPermissions(userId),
				effectiveRoleLabel(userId, undefined),
			]);

			res.json({
				success: true,
				data: {
					userId,
					grants: grants.map((grant) => ({ role: grant.role, grantedBy: grant.grantedBy, reason: grant.reason })),
					effectiveRole: effective.role,
					effectiveSource: effective.source,
					effectivePermissions: resolved?.permissions ?? [],
					note:
						resolved === null
							? 'This account has no platform role grant, so its permissions come from the role claim in its access token.'
							: 'This account has an explicit grant, which decides its permissions.',
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

function describeRole(role: AdminRole): string {
	switch (role) {
		case 'SUPER_ADMIN':
			return 'Everything, including granting roles and managing secrets.';
		case 'PLATFORM_ADMIN':
			return 'Run the platform: AI, voice, flags, maintenance, kill switches. Cannot grant roles.';
		case 'SUPPORT_ADMIN':
			return 'Help a human: read accounts and NOVA state, suspend, revoke sessions.';
		case 'OPERATIONS_ADMIN':
			return 'Keep the machinery running: jobs, services, incidents, realtime.';
		case 'ANALYTICS_ADMIN':
			return 'Metrics and cost. No personal data.';
		case 'DEVELOPER':
			return 'Read everything for debugging, including logs and traces. Writes nothing.';
		case 'READ_ONLY':
			return 'Aggregate reads only.';
		default:
			return '';
	}
}

/**
 * Accounts that could be granted a role.
 *
 * Bounded and ordered by recency, because the platform has thousands of accounts and the
 * console only needs a picker. The search box on the page filters client-side over this set;
 * assigning a role is a rare, deliberate action, not a bulk operation.
 */
async function listCandidateAccounts(): Promise<
	Array<{ id: string; email: string | null; name: string | null; disabled: boolean }>
> {
	try {
		const db = getDb();
		const rows = (await db
			.select({
				id: users.id,
				email: users.email,
				name: users.name,
				disabled: users.disabled,
			})
			.from(users)
			.orderBy(users.createdAt)
			.limit(200)) as unknown as Array<{
			id: string;
			email: string | null;
			name: string | null;
			disabled: boolean;
		}>;
		return rows;
	} catch {
		return [];
	}
}

export default router;
