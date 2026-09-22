import Redis from 'ioredis';
import { createHash } from 'crypto';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
	maxRetriesPerRequest: null,
});

const LOCK_PREFIX = 'rl:refresh:';
const LOCK_TTL_MS = 5_000;

/**
 * Hash a refresh token to use as a Redis key, so the raw credential is never
 * stored or visible in Redis keyspace.
 */
function hashRefreshToken(refreshToken: string): string {
	return createHash('sha256').update(refreshToken).digest('hex');
}

/**
 * Acquire a distributed lock for a refresh token to prevent concurrent refresh races.
 * Returns true if the lock was acquired, false otherwise.
 */
export async function acquireRefreshLock(refreshToken: string): Promise<boolean> {
	const key = `${LOCK_PREFIX}${hashRefreshToken(refreshToken)}`;
	// SET NX EX: set if not exists, with expiry in seconds
	const result = await redis.set(key, '1', 'EX', Math.ceil(LOCK_TTL_MS / 1000), 'NX');
	return result === 'OK';
}

/**
 * Release a distributed lock for a refresh token.
 */
export async function releaseRefreshLock(refreshToken: string): Promise<void> {
	const key = `${LOCK_PREFIX}${hashRefreshToken(refreshToken)}`;
	await redis.del(key);
}

/**
 * Execute a function while holding a distributed lock on the given refresh token.
 * Prevents concurrent refresh token usage (race condition).
 */
export async function withRefreshLock<T>(refreshToken: string, fn: () => Promise<T>): Promise<T> {
	const acquired = await acquireRefreshLock(refreshToken);
	if (!acquired) {
		throw new Error('Refresh token is being processed, please retry');
	}
	try {
		return await fn();
	} finally {
		await releaseRefreshLock(refreshToken);
	}
}
