/**
 * NOVA — Admin dashboard and analytics routes.
 *
 * Mounted under `/api/v1/admin` behind `adminGate`, so `req.adminActor` and
 * `req.adminPermissions` are always populated by the time a handler runs, and every
 * route names the permission it needs.
 *
 * Every metric here stands in one of three states and the response type carries
 * which: a number, a number with a `caveat` sentence, or an explicit
 * `unavailableReason` plus the instrumentation that would fix it. There is no
 * fourth state where a missing signal silently renders as `0`.
 */

import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
	type AdminRequest,
	adminGate,
	requirePermission,
} from '../../admin/access.js';
import {
	getActivityMetrics,
	getAiMetrics,
	getCostBreakdown,
	getPlatformMetrics,
	getReliabilityMetrics,
} from '../../admin/metrics.js';
import { latestProviderHealth, runAllProviderTests } from '../../admin/providers.js';
import { listServiceHealth } from '../../admin/system.js';
import { getRuntimeControls } from '../../admin/control.js';
import { validate } from '../../middleware/validate.js';

const router: ReturnType<typeof Router> = Router();
router.use(adminGate);

const RangeSchema = z.object({
	days: z.coerce.number().int().min(1).max(365).default(30),
});

/**
 * `GET /admin/overview`
 *
 * The single call the console's landing page makes. Composed from the same
 * functions the detail pages use, so a number on the dashboard and the same number
 * on its detail page cannot disagree.
 *
 * Named `/overview` rather than `/dashboard` deliberately. The **legacy** router in
 * `routes/admin.ts` already owns `GET /admin/dashboard` and is mounted first, so a
 * second handler on that path is unreachable — Express answers with whichever was
 * registered first, and this one silently never ran. The legacy route serves the admin
 * screen bundled inside the Flutter app and returns a different fixed shape
 * (`status`, `metrics`, `checks`), so overloading the path would break that client.
 * Two consumers, two paths, no ambiguity.
 */
router.get(
	'/overview',
	requirePermission('analytics.read'),
	async (_req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const [platform, activity, ai, reliability, health, controls] = await Promise.all([
				getPlatformMetrics(),
				getActivityMetrics(),
				getAiMetrics(30),
				getReliabilityMetrics(),
				latestProviderHealth(),
				getRuntimeControls(),
			]);

			res.json({
				success: true,
				data: {
					platform,
					activity,
					ai,
					reliability,
					providers: health,
					controls,
					generatedAt: new Date().toISOString(),
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

/** `GET /admin/metrics/platform` */
router.get(
	'/metrics/platform',
	requirePermission('analytics.read'),
	async (_req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			res.json({ success: true, data: await getPlatformMetrics() });
		} catch (error) {
			next(error);
		}
	},
);

/** `GET /admin/metrics/activity` */
router.get(
	'/metrics/activity',
	requirePermission('analytics.read'),
	async (_req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			res.json({ success: true, data: await getActivityMetrics() });
		} catch (error) {
			next(error);
		}
	},
);

/** `GET /admin/metrics/ai?days=30` */
router.get(
	'/metrics/ai',
	requirePermission('analytics.read'),
	validate(RangeSchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { days } = (req as unknown as { validatedQuery: z.infer<typeof RangeSchema> }).validatedQuery;
			res.json({ success: true, data: await getAiMetrics(days) });
		} catch (error) {
			next(error);
		}
	},
);

/** `GET /admin/metrics/reliability` */
router.get(
	'/metrics/reliability',
	requirePermission('analytics.read'),
	async (_req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			res.json({ success: true, data: await getReliabilityMetrics() });
		} catch (error) {
			next(error);
		}
	},
);

/** `GET /admin/cost?days=30` */
router.get(
	'/cost',
	requirePermission('cost.read'),
	validate(RangeSchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { days } = (req as unknown as { validatedQuery: z.infer<typeof RangeSchema> }).validatedQuery;
			res.json({ success: true, data: await getCostBreakdown(days) });
		} catch (error) {
			next(error);
		}
	},
);

/** `GET /admin/services` — service and dependency health. */
router.get(
	'/services',
	requirePermission('services.read'),
	async (_req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			res.json({ success: true, data: await listServiceHealth() });
		} catch (error) {
			next(error);
		}
	},
);

/**
 * `POST /admin/providers/test-all`
 *
 * Runs every provider connectivity check. Read-level permission is deliberate:
 * testing connectivity is non-mutating and an operator diagnosing an outage should
 * not need `ai.secrets` to discover that Anthropic is rejecting the key. The call is
 * still audited by `requirePermission`'s denial path and by the health-check rows
 * themselves, which record who ran them.
 */
router.post(
	'/providers/test-all',
	requirePermission('services.read'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const results = await runAllProviderTests({
				trigger: 'manual',
				checkedBy: req.adminActor?.email ?? null,
			});
			res.json({ success: true, data: results });
		} catch (error) {
			next(error);
		}
	},
);

export default router;
