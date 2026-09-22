import { Router } from 'express';
import type { Request, Response } from 'express';

const router: ReturnType<typeof Router> = Router();
const startTime = Date.now();

function getUptimeSeconds(): number {
	return Math.floor((Date.now() - startTime) / 1000);
}

router.get('/health', (req: Request, res: Response) =>
	res.json({ status: 'ok', timestamp: new Date().toISOString(), uptime: getUptimeSeconds() }),
);

router.get('/health/live', (req: Request, res: Response) =>
	res.json({ status: 'alive', timestamp: new Date().toISOString(), uptime: getUptimeSeconds() }),
);

router.get('/health/ready', async (req: Request, res: Response) => {
	let dbStatus: 'up' | 'down' = 'down';
	let redisStatus: 'up' | 'down' = 'down';
	let storageStatus: 'up' | 'down' = 'down';
	let aiStatus: 'up' | 'down' | 'disabled' = 'disabled';

	try {
		if (process.env.DATABASE_URL) {
			dbStatus = 'up';
		}
	} catch {
		dbStatus = 'down';
	}

	try {
		if (process.env.REDIS_URL) {
			redisStatus = 'up';
		}
	} catch {
		redisStatus = 'down';
	}

	try {
		if (process.env.S3_BUCKET || process.env.STORAGE_PROVIDER) {
			storageStatus = 'up';
		}
	} catch {
		storageStatus = 'down';
	}

	try {
		if (process.env.ANTHROPIC_API_KEY) {
			aiStatus = 'up';
		}
	} catch {
		aiStatus = 'down';
	}

	const overall = dbStatus === 'up' && redisStatus === 'up' ? 'ready' : 'degraded';
	const statusCode = overall === 'ready' ? 200 : 503;

	res.status(statusCode).json({
		status: overall,
		timestamp: new Date().toISOString(),
		uptime: getUptimeSeconds(),
		checks: { db: dbStatus, redis: redisStatus, storage: storageStatus, aiService: aiStatus },
	});
});

export { router as healthRoutes };
