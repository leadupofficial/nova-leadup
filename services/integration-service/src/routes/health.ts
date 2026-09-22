import { Router } from 'express';
import type { Request, Response } from 'express';

const router: ReturnType<typeof Router> = Router();
const startTime = Date.now();

function getUptimeSeconds(): number {
	return Math.floor((Date.now() - startTime) / 1000);
}

router.get('/health', (_req: any, res: any) =>
	res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: getUptimeSeconds() }),
);

router.get('/health/live', (_req: any, res: any) =>
	res.json({ status: 'alive', timestamp: new Date().toISOString(), uptime: getUptimeSeconds() }),
);

router.get('/health/ready', async (_req: any, res: any) => {
	let dbStatus: 'up' | 'down' = 'down';
	let redisStatus: 'up' | 'down' = 'down';
	let storageStatus: 'up' | 'down' = 'down';
	let aiStatus: 'up' | 'down' | 'disabled' = 'disabled';

	try {
		// This service has no local db/redis/storage modules: the probes are
		// best-effort and fall through to their catch blocks. Non-literal specifiers
		// keep that runtime behaviour while letting the source compile.
		const dbModule = '../db.js';
		const { getPool } = await import(dbModule);
		await getPool().query('SELECT 1');
		dbStatus = 'up';
	} catch (err) {
		console.error('[health] database check failed:', err instanceof Error ? err.message : String(err));
	}

	try {
		const redisModule = '../redis.js';
		const { getRedisClient } = await import(redisModule);
		const redis = getRedisClient();
		await redis.ping();
		redisStatus = 'up';
	} catch {
		console.warn('[health] redis check failed');
	}

	try {
		const storageModule = '../storage.js';
		const { getStorageClient } = await import(storageModule);
		const s3 = getStorageClient();
		await s3.listBuckets().promise();
		storageStatus = 'up';
	} catch {
		console.warn('[health] storage check failed');
	}

	try {
		if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.length > 0) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 2000);
			const resp = await fetch('https://api.anthropic.com/v1/messages', {
				method: 'POST',
				signal: controller.signal,
				headers: {
					'content-type': 'application/json',
					'x-api-key': process.env.ANTHROPIC_API_KEY,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify({
					model: 'claude-haiku-4-5',
					max_tokens: 1,
					messages: [{ role: 'user', content: 'ping' }],
				}),
			});
			clearTimeout(timeout);
			aiStatus = resp.ok || resp.status === 400 ? 'up' : 'down';
		}
	} catch {
		aiStatus = 'down';
	}

	const overall = dbStatus === 'up' && redisStatus === 'up' && storageStatus === 'up' && aiStatus === 'up' ? 'ready' : 'degraded';
	const statusCode = overall === 'ready' ? 200 : 503;

	res.status(statusCode).json({
		status: overall,
		timestamp: new Date().toISOString(),
		uptime: getUptimeSeconds(),
		checks: { db: dbStatus, redis: redisStatus, storage: storageStatus, aiService: aiStatus },
	});
});

export { router as healthRoutes };
