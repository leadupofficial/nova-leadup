/**
 * @nova/admin — Health endpoints (no auth required for liveness/readiness).
 */
import { Router } from 'express';
import { getPool } from '../db.js';

export const healthRouter: Router = Router();

const DB_PING_TIMEOUT_MS = 2_000;

/**
 * The database check used to be fire-and-forget:
 *
 * ```ts
 * let dbStatus = 'down';
 * pool.query('SELECT 1').then(() => { dbStatus = 'up'; }).catch(() => { dbStatus = 'down'; });
 * res.json({ dependencies: { database: { status: dbStatus } } });
 * ```
 *
 * The promise settles *after* the response has been built from the initial value, so
 * this endpoint reported `database: down` whatever the database was doing. Production
 * served exactly that — `{"status":"degraded","dependencies":{"database":{"status":
 * "down"}}}` — at the same moment `/api/v1/auth/login` was answering 401s out of the
 * same database, i.e. the check was a false alarm, not a finding.
 *
 * `redis` and `storage` were hardcoded `'up'` and this service has no Redis or
 * object-store client at all, so those were never checks either; they are gone rather
 * than kept as decoration.
 *
 * The ping is awaited now, bounded by a timeout, and only what was actually checked is
 * reported.
 */
healthRouter.get('', async (_req, res) => {
	let dbStatus: 'up' | 'down' = 'down';
	try {
		const timeout = new Promise<never>((_, reject) => {
			const t = setTimeout(
				() => reject(new Error('database health check timed out')),
				DB_PING_TIMEOUT_MS,
			);
			t.unref?.();
		});
		await Promise.race([getPool().query('SELECT 1'), timeout]);
		dbStatus = 'up';
	} catch {
		dbStatus = 'down';
	}

	res.json({
		status: dbStatus === 'up' ? 'healthy' : 'degraded',
		timestamp: new Date().toISOString(),
		version: process.env.npm_package_version ?? '0.1.0',
		dependencies: {
			database: { status: dbStatus },
		},
	});
});

healthRouter.get('/ready', (_req, res) => {
	res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
});

healthRouter.get('/live', (_req, res) => {
	res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});
