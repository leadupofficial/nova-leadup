/**
 * NOVA API — Comprehensive health check service.
 *
 * Checks the health of all critical dependencies:
 * - PostgreSQL database connectivity
 * - Redis cache / session store
 * - AI provider (Anthropic) API key availability
 * - S3 / object storage connectivity
 *
 * Returns a structured health report suitable for both
 * /health/live (liveness) and /health/ready (readiness) probes.
 */
import { getDbPool } from '../db/connection.js';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HealthCheckResult {
	name: string;
	status: 'up' | 'down' | 'disabled';
	latencyMs?: number;
	message?: string;
	details?: Record<string, string>;
}

export interface HealthReport {
	status: 'healthy' | 'degraded' | 'unhealthy';
	timestamp: string;
	uptime: number;
	checks: HealthCheckResult[];
	summary: {
		total: number;
		up: number;
		down: number;
		disabled: number;
	};
}

// ─── Individual checkers ──────────────────────────────────────────────────────

async function checkDatabase(): Promise<HealthCheckResult> {
	const start = Date.now();
	try {
		const pool = getDbPool();
		const result = await pool.query('SELECT 1');
		const latency = Date.now() - start;

		return {
			name: 'database',
			status: 'up',
			latencyMs: latency,
			message: 'PostgreSQL connection healthy',
			details: {
				version: (result as any).rows?.[0]?.version ?? 'connected',
				poolSize: String((pool as any).totalCount ?? 'n/a'),
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn({ err: message }, 'Health check: database down');
		return {
			name: 'database',
			status: 'down',
			message: `Database connection failed: ${message}`,
		};
	}
}

async function checkRedis(): Promise<HealthCheckResult> {
	const start = Date.now();
	try {
		let getRedisClient: (() => unknown) | undefined;
		try {
			const mod: any = await import('../redis.js');
			getRedisClient = mod.getRedisClient;
		} catch {
			return {
				name: 'redis',
				status: 'disabled',
				message: 'Redis client not configured in this service',
			};
		}
		if (!getRedisClient) {
			return {
				name: 'redis',
				status: 'disabled',
				message: 'Redis client not configured in this service',
			};
		}
		const client = getRedisClient();
		const pong = await (client as { ping: () => Promise<string> }).ping();
		const latency = Date.now() - start;

		return {
			name: 'redis',
			status: 'up',
			latencyMs: latency,
			message: `Redis responded with "${pong}"`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn({ err: message }, 'Health check: redis down');
		return {
			name: 'redis',
			status: 'down',
			message: `Redis connection failed: ${message}`,
		};
	}
}

async function checkAIProviders(): Promise<HealthCheckResult> {
	const start = Date.now();
	const apiKey = process.env.ANTHROPIC_API_KEY;

	if (!apiKey) {
		return {
			name: 'ai_providers',
			status: 'disabled',
			message: 'ANTHROPIC_API_KEY not configured',
		};
	}

	try {
		// Lightweight check: verify key format without making an API call
		const keyPrefix = apiKey.slice(0, 4);
		const isValidFormat = apiKey.startsWith('sk-ant-');

		if (!isValidFormat) {
			return {
				name: 'ai_providers',
				status: 'down',
				message: 'ANTHROPIC_API_KEY has invalid format (expected sk-ant-...)',
			};
		}

		const latency = Date.now() - start;
		return {
			name: 'ai_providers',
			status: 'up',
			latencyMs: latency,
			message: 'Anthropic API key configured and valid format',
			details: {
				provider: 'anthropic',
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			name: 'ai_providers',
			status: 'down',
			message: `AI provider check failed: ${message}`,
		};
	}
}

async function checkStorage(): Promise<HealthCheckResult> {
	const start = Date.now();
	try {
		let getStorageClient: (() => unknown) | undefined;
		try {
			const mod: any = await import('../storage.js');
			getStorageClient = mod.getStorageClient;
		} catch {
			return {
				name: 'storage',
				status: 'disabled',
				message: 'Storage client not configured in this service',
			};
		}
		if (!getStorageClient) {
			return {
				name: 'storage',
				status: 'disabled',
				message: 'Storage client not configured in this service',
			};
		}
		const client = getStorageClient();
		const result = await (client as { listBuckets: () => { promise: () => Promise<unknown> } }).listBuckets().promise();
		const latency = Date.now() - start;

		return {
			name: 'storage',
			status: 'up',
			latencyMs: latency,
			message: 'Object storage reachable',
			details: {
				bucketCount: String((result as any).Buckets?.length ?? 0),
			},
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn({ err: message }, 'Health check: storage down');
		return {
			name: 'storage',
			status: 'down',
			message: `Storage check failed: ${message}`,
		};
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

const startTime = Date.now();

export function getUptimeSeconds(): number {
	return Math.floor((Date.now() - startTime) / 1000);
}

/**
 * Run all health checks and return a comprehensive health report.
 */
export async function runHealthChecks(): Promise<HealthReport> {
	const checks: HealthCheckResult[] = await Promise.all([
		checkDatabase(),
		checkRedis(),
		checkAIProviders(),
		checkStorage(),
	]);

	const summary = {
		total: checks.length,
		up: checks.filter((c) => c.status === 'up').length,
		down: checks.filter((c) => c.status === 'down').length,
		disabled: checks.filter((c) => c.status === 'disabled').length,
	};

	let status: 'healthy' | 'degraded' | 'unhealthy';
	if (summary.down === 0) {
		status = summary.disabled > 0 ? 'healthy' : 'healthy';
	} else if (summary.down === summary.total) {
		status = 'unhealthy';
	} else {
		status = 'degraded';
	}

	return {
		status,
		timestamp: new Date().toISOString(),
		uptime: getUptimeSeconds(),
		checks,
		summary,
	};
}

/**
 * Simple liveness check — always returns alive unless the process is shutting down.
 */
export function getLiveness() {
	return {
		status: 'alive',
		timestamp: new Date().toISOString(),
		uptime: getUptimeSeconds(),
	};
}
