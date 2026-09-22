/**
 * NOVA — Security Center routes.
 *
 * One read route. §29's dashboard is an aggregation, and every number in it comes from a table
 * something else already writes: sign-in attempts from `services/auth-events.ts`, refusals and
 * privilege changes from `admin_audit_logs`, live operator sessions from `admin_sessions`,
 * credential state from the configuration read model.
 *
 * ## Why this is read-only, and stays read-only
 *
 * Every action the Security Center *describes* already has a home where it is performed with
 * confirmation, impact and its own permission — suspending an account is on the user page, ending
 * an operator's session is on Admin Sessions, a kill switch is on Maintenance. Duplicating those
 * buttons here would give two paths to the same mutation with different affordances, which is how
 * an operator ends up clicking the one that skips the confirmation. This page observes; it does not
 * act.
 */

import { Router, type NextFunction, type Response } from 'express';
import { z } from 'zod';
import { type AdminRequest, requirePermission } from '../../admin/access.js';
import { getSecurityOverview } from '../../admin/security.js';
import { validate } from '../../middleware/validate.js';

const router: ReturnType<typeof Router> = Router();

const QuerySchema = z.object({
	/** Overrides the default window. Bounded so one request cannot scan the whole table. */
	days: z.coerce.number().int().min(1).max(90).default(7),
});

router.get(
	'/security/overview',
	requirePermission('security.read'),
	validate(QuerySchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: { days: number } }).validatedQuery;
			res.json({ success: true, data: await getSecurityOverview(q.days) });
		} catch (error) {
			next(error);
		}
	},
);

export default router;
