import { Queue } from 'bullmq';
import { ServiceHealth } from '@nova/types';

const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT) ?? 6379;

const connection = { host: REDIS_HOST, port: REDIS_PORT };

/**
 * Default job options with retry and dead-letter behavior.
 * - attempts: total tries (initial + retries)
 * - backoff: exponential backoff starting at 2s
 * - removeOnComplete/removeOnFail: keep completed/failed jobs for audit
 */
const DEFAULT_JOB_OPTIONS = {
	attempts: 3,
	backoff: {
		type: 'exponential',
		delay: 2000,
	} as const,
	removeOnComplete: { count: 1000 },
	removeOnFail: { count: 5000 },
};

export function createQueue(name: string): Queue {
	const queue = new Queue(name, {
		connection,
		defaultJobOptions: DEFAULT_JOB_OPTIONS,
	});

	queue.on('error', (err) => {
		console.error(`[workers] Queue "${name}" error:`, err.message);
	});

	return queue;
}

let redisHealthy = true;

export function getWorkerHealth(): ServiceHealth {
	const checks: ServiceHealth['checks'] = {
		database: { status: 'pass' },
		redis: { status: redisHealthy ? 'pass' : 'fail' },
		storage: { status: 'pass' },
	};

	return {
		status: redisHealthy ? 'healthy' : 'degraded',
		timestamp: new Date(),
		checks,
	};
}

export function setRedisHealth(healthy: boolean): void {
	redisHealthy = healthy;
}
