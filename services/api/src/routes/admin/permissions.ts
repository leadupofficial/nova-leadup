/**
 * NOVA — the permission catalogue, and the caller's own authority.
 *
 * ## Why these two routes exist
 *
 * The console carried its **own copy** of the role→permission matrix in
 * `apps/admin/src/lib/permissions.ts`, resolved from the JWT's role claim in the browser, and its
 * `/permissions` page carried its own copy of the permission catalogue with labels and descriptions.
 * The file's own comment called the duplication acceptable because the failure mode is a visible 403
 * rather than a silent privilege. That was true, and it missed a real defect:
 *
 * **the console resolved the claim, and the API resolves the grant first.** An operator whose
 * `platform_admin_roles` row differs from the role in their token saw destinations for the *claim*, not
 * for the authority the server would actually apply — so the console could hide pages they can use and
 * offer pages that answer 403. The claim is a fallback the server only uses when there is no grant.
 *
 * `GET /control/me/permissions` answers "what may I do" from the same resolution the gate performed, so
 * there is one authority and the duplicated matrix can be deleted rather than kept in step by hand.
 * `GET /control/permissions` exposes the catalogue for the page that lists it, for the same reason.
 *
 * ## Neither route is a privilege
 *
 * `/me/permissions` is self-inspection and needs no permission of its own — every authenticated admin
 * may read their own authority, and requiring one would mean an operator could not see what they hold.
 * It reports the **effective** set the server just enforced, and says where it came from.
 *
 * `/permissions` returns metadata about permissions, not about accounts: it is the same list for every
 * caller, so it needs `admin_users.read` only as a sanity bound rather than as a data-protection
 * measure. It carries no account, grant or session information.
 */

import { Router, type NextFunction, type Response } from 'express';
import { type AdminRequest, adminGate, requirePermission } from '../../admin/access.js';
import { ADMIN_ROLES, PERMISSION_METADATA, ROLE_PERMISSIONS, type AdminRole } from '../../admin/permissions.js';
import { roleRank } from '../../admin/roles.js';

const router: ReturnType<typeof Router> = Router();
router.use(adminGate);

/**
 * The caller's own effective authority.
 *
 * Reads the actor and permission set the gate already resolved — this route performs no resolution of
 * its own, so it cannot disagree with what the same request was allowed to do.
 */
router.get('/me/permissions', async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const actor = req.adminActor;
		const permissions = req.adminPermissions ?? [];
		res.json({
			success: true,
			data: {
				email: actor?.email ?? null,
				platformRole: actor?.platformRole ?? null,
				adminRole: actor?.adminRole ?? null,
				permissions,
				source: actor?.adminRole ? 'grant-or-claim' : 'none',
				notes: [
					'Resolved server-side on this request by the same code that enforces it. The console uses this rather than decoding the role claim itself, because a database grant overrides the claim and the claim alone can describe access the server would refuse.',
					'Presentation only in one direction: hiding a destination the server would allow is a usability bug, and showing one it would refuse is a 403. Neither can grant anything.',
				],
			},
		});
	} catch (error) {
		next(error);
	}
});

/**
 * The catalogue and the role matrix.
 *
 * The console's `/permissions` page rendered a hand-maintained copy of this. Two lists that must be
 * kept in step by hand drift, and the one the operator reads should be the one the server enforces.
 */
router.get(
	'/permissions',
	requirePermission('admin_users.read'),
	async (_req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			res.json({
				success: true,
				data: {
					catalog: PERMISSION_METADATA,
					roles: ADMIN_ROLES.map((role) => ({
						role,
						rank: roleRank(role),
						permissions: ROLE_PERMISSIONS[role as AdminRole] ?? [],
					})),
					notes: [
						'This is the authority the API enforces on every request, not a copy. Role→permission resolution happens per request in services/api/src/admin/permissions.ts.',
						'A database grant (platform_admin_roles) overrides the role claim in an access token. An account with no grant falls back to the claim, which is how every deployment behaved before role assignment existed.',
						'Permissions are additive and never imply one another: holding config.write does not confer config.secrets, and holding admin_users.read does not confer admin_users.manage.',
					],
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

export default router;
