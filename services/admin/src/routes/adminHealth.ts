import { Router } from 'express';
import { getPool } from '../db.js';

const router: Router = Router();

/**
 * `/ready` used to answer, unconditionally:
 *
 * ```json
 * { "status": "ready", "dependencies": { "database": "ok", "cache": "ok" } }
 * ```
 *
 * Neither value came from a check. A readiness probe that says "ok" without asking is
 * worse than no probe: it is the signal an orchestrator uses to decide whether to send
 * traffic, and it could not go red. It now pings the database it claims to depend on,
 * and returns `503 degraded` when that ping fails. There is no cache client in this
 * service, so the fabricated `cache` key is gone.
 */
router.get('/live', (_req, res) => {
	res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

router.get('/ready', async (_req, res) => {
	let database: 'up' | 'down' = 'down';
	try {
		await getPool().query('SELECT 1');
		database = 'up';
	} catch {
		database = 'down';
	}

	res.status(database === 'up' ? 200 : 503).json({
		status: database === 'up' ? 'ready' : 'degraded',
		timestamp: new Date().toISOString(),
		dependencies: { database },
	});
});

export { router as adminHealthRoutes };
