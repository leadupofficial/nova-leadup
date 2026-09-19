/**
 * NOVA API — `GET /api/v1/subscriptions`.
 *
 * Reports the caller's effective plan, its subscription row (when one exists),
 * the billing period, the **resolved entitlements** for that plan, and
 * current-period usage against every metered metric.
 *
 * The two properties that matter:
 *
 *  1. **No subscription row is not an error.** Every account in production is
 *     in that state today; the response is `plan: "free"` with the current UTC
 *     month as the period. A 200 carrying Free is the honest answer, and it is
 *     what the client's paywall reads.
 *  2. **Limits come from one place.** The numbers below are read from
 *     `src/entitlements/plans.ts`; this route holds no limit of its own, so a
 *     pricing change is one edit there.
 *
 * Read-only on purpose. Mutating a plan is a billing-provider action
 * (subscriptions are keyed by organization and carry a provider + external id);
 * exposing a write here before the provider integration exists would let a
 * client grant itself a tier.
 */
import { Router, type Response } from 'express';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { describeEntitlements } from '../entitlements/index.js';

const router: ReturnType<typeof Router> = Router();

router.use(authenticate);

router.get('/', async (req: AuthenticatedRequest, res: Response, next) => {
	try {
		const summary = await describeEntitlements(req.user!.id);

		res.status(200).json({
			success: true,
			data: {
				plan: summary.plan,
				// The plan on the row, even when it is no longer granting, so the
				// client can say "your Pro plan ended" instead of "you are on Free".
				storedPlan: summary.storedPlan,
				status: summary.status,
				granting: summary.granting,
				provider: summary.provider,
				externalSubscriptionId: summary.externalSubscriptionId,
				period: {
					start: summary.currentPeriodStart.toISOString(),
					end: summary.currentPeriodEnd.toISOString(),
					source: summary.periodSource,
				},
				currentPeriodStart: summary.currentPeriodStart.toISOString(),
				currentPeriodEnd: summary.currentPeriodEnd.toISOString(),
				cancelledAt: summary.cancelledAt ? summary.cancelledAt.toISOString() : null,
				entitlements: summary.entitlements,
				limits: summary.limits,
				usage: summary.usage,
				usageAvailable: summary.usageAvailable,
			},
		});
	} catch (err) {
		next(err);
	}
});

export default router;
