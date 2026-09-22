import { Router } from 'express';
import { tokenDenylist } from '../auth/token-denylist.js';

const router: ReturnType<typeof Router> = Router();

router.get('/live', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

/**
 * Readiness. This used to be:
 *
 * ```ts
 * try {
 *   res.json({ status: 'ok', checks: { redis: 'ok' } });
 * } catch {
 *   res.status(503).json({ status: 'error', checks: { redis: 'error' } });
 * }
 * ```
 *
 * Nothing in the `try` could throw, so the 503 branch was unreachable and Redis was
 * reported healthy unconditionally. It now asks the same Redis connection the token
 * denylist uses, and the gateway reports `degraded` when that connection is not usable.
 */
router.get('/ready', async (_req, res) => {
	const redis = await tokenDenylist.ping();
	const ready = redis === 'up';

	res.status(ready ? 200 : 503).json({
		status: ready ? 'ok' : 'degraded',
		timestamp: new Date().toISOString(),
		checks: { redis },
	});
});

export { router as healthRoutes };
