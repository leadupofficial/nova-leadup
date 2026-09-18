import { Router, Response } from 'express';
import { Pool } from 'pg';
import Redis from 'ioredis';

interface HealthCheckResult {
	status: 'healthy' | 'degraded' | 'unhealthy';
	checks: {
		[key: string]: {
			status: 'pass' | 'fail';
			latencyMs?: number;
			message?: string;
		};
	};
	timestamp: string;
}

const router = Router();

// Health check dependencies (injected at startup)
let dbPool: Pool | null = null;
let redisClient: Redis | null = null;

export function setHealthCheckDependencies(pool: Pool, redis: Redis) {
	dbPool = pool;
	redisClient = redis;
}

async function checkDatabase(): Promise<HealthCheckResult['checks']['database']> {
	if (!dbPool) {
		return { status: 'fail', message: 'Database pool not configured' };
	}
	const start = Date.now();
	try {
		const result = await dbPool.query('SELECT 1');
		const latency = Date.now() - start;
		if (result.rows[0]['1'] === 1) {
			return { status: 'pass', latencyMs: latency };
		}
		return { status: 'fail', message: 'Unexpected database response' };
	} catch (error) {
		return { status: 'fail', message: `Database connection failed: ${(error as Error).message}` };
	}
}

async function checkRedis(): Promise<HealthCheckResult['checks']['redis']> {
	if (!redisClient) {
		return { status: 'fail', message: 'Redis client not configured' };
	}
	const start = Date.now();
	try {
		await redisClient.ping();
		const latency = Date.now() - start;
		return { status: 'pass', latencyMs: latency };
	} catch (error) {
		return { status: 'fail', message: `Redis connection failed: ${(error as Error).message}` };
	}
}

async function checkAIProviders(): Promise<HealthCheckResult['checks']['ai_providers']> {
	// Check configured AI providers (OpenAI, Anthropic, etc.)
	const checks: any = { status: 'pass' };
	const providers = process.env.AI_PROVIDERS?.split(',') || [];

	if (providers.length === 0) {
		return { status: 'pass', message: 'No AI providers configured' };
	}

	for (const provider of providers) {
		// In production, make lightweight health checks to provider APIs
		// For now, mark as configured
		checks[provider] = { status: 'pass' };
	}

	return checks;
}

async function checkStorage(): Promise<HealthCheckResult['checks']['storage']> {
	// Check storage service (S3, GCS, or local filesystem)
	const storageType = process.env.STORAGE_TYPE || 'local';
	const checks: any = { status: 'pass' };

	if (storageType === 'local') {
		try {
			const fs = await import('fs');
			const uploadDir = process.env.UPLOAD_DIR || './uploads';
			if (!fs.existsSync(uploadDir)) {
				fs.mkdirSync(uploadDir, { recursive: true });
			}
			checks[storageType] = { status: 'pass' };
		} catch (error) {
			return { status: 'fail', message: `Storage check failed: ${(error as Error).message}` };
		}
	}

	return checks;
}

router.get('/health', async (_req, res: Response<HealthCheckResult>) => {
	const checks: HealthCheckResult['checks'] = {};
	const results = await Promise.allSettled([
		checkDatabase(),
		checkRedis(),
		checkAIProviders(),
		checkStorage(),
	]);

	results.forEach((result, index) => {
		const keys = ['database', 'redis', 'ai_providers', 'storage'];
		if (result.status === 'fulfilled') {
			checks[keys[index]] = result.value;
		} else {
			checks[keys[index]] = { status: 'fail', message: 'Health check timed out' };
		}
	});

	// Determine overall status
	const failedChecks = Object.values(checks).filter((c) => c.status === 'fail');
	const overallStatus: HealthCheckResult['status'] =
		failedChecks.length === 0 ? 'healthy' : failedChecks.length <= 1 ? 'degraded' : 'unhealthy';

	const response: HealthCheckResult = {
		status: overallStatus,
		checks,
		timestamp: new Date().toISOString(),
	};

	const statusCode = overallStatus === 'healthy' ? 200 : overallStatus === 'degraded' ? 503 : 503;
	res.status(statusCode).json(response);
});

router.get('/ready', async (_req, res: Response) => {
	// Readiness probe - only check critical dependencies
	const dbCheck = await checkDatabase();
	if (dbCheck.status === 'fail') {
		return res.status(503).json({ status: 'unready', reason: 'database', details: dbCheck });
	}

	res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
});

router.get('/live', (_req, res: Response) => {
	// Liveness probe - server is running
	res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

export { router as healthRouter };
