/**
 * Redis-backed token denylist for logout revocation.
 *
 * Uses the same REDIS_URL as the rate-limiter, so revocation is
 * consistent across HTTP and WebSocket authentication paths.
 * Falls back to a no-op in-memory store when Redis is unavailable.
 */

import { Redis } from 'ioredis';

const REDIS_PREFIX = 'token:denylist';

class TokenDenylistStore {
	private redis: Redis | null = null;
	private memoryStore: Set<string> = new Set();

	constructor() {
		try {
			const redisUrl = process.env.REDIS_URL;
			if (redisUrl) {
				// TLS comes from the URL scheme (`rediss://`), which ioredis understands.
				// This used to pass `tls: {}` whenever NODE_ENV was 'production', which
				// forces a TLS handshake against a plaintext Redis — so the gateway could
				// not reach a normal production Redis at all, and the readiness probe
				// reported `down` with the server perfectly healthy.
				this.redis = new Redis(redisUrl);
			}
		} catch {
			console.warn('Redis not available for token denylist, using in-memory store');
			this.redis = null;
		}
	}

	/**
	 * Add a token's jti to the denylist until its natural expiration.
	 */
	async revoke(jti: string, ttlSeconds: number): Promise<void> {
		if (this.redis) {
			try {
				await this.redis.setex(`${REDIS_PREFIX}:${jti}`, ttlSeconds, '1');
				return;
			} catch {
				// Fall back to memory on Redis failure
				this.redis = null;
			}
		}
		this.memoryStore.add(jti);
		// Auto-expire from memory after ttlSeconds
		setTimeout(() => this.memoryStore.delete(jti), ttlSeconds * 1000);
	}

	/**
	 * Check if a token's jti has been revoked.
	 */
	async isRevoked(jti: string): Promise<boolean> {
		if (!jti) return false;

		if (this.redis) {
			try {
				const result = await this.redis.exists(`${REDIS_PREFIX}:${jti}`);
				return result === 1;
			} catch {
				this.redis = null;
			}
		}
		return this.memoryStore.has(jti);
	}

	/**
	 * Revoke all tokens for a subject (user) — used on password change / account compromise.
	 * Stores a subject-level revocation timestamp; tokens with older iat are rejected.
	 */
	async revokeAllForSubject(sub: string): Promise<void> {
		if (this.redis) {
			try {
				await this.redis.set(`${REDIS_PREFIX}:subject:${sub}`, Date.now().toString());
				return;
			} catch {
				this.redis = null;
			}
		}
		// Memory fallback — store subject revocation timestamp
		this.memoryStore.add(`subject:${sub}`);
	}

	/**
	 * Check if all tokens for a subject have been revoked.
	 * Returns the revocation timestamp if revoked, null otherwise.
	 */
	async getSubjectRevocation(sub: string): Promise<number | null> {
		if (this.redis) {
			try {
				const result = await this.redis.get(`${REDIS_PREFIX}:subject:${sub}`);
				return result ? parseInt(result, 10) : null;
			} catch {
				this.redis = null;
			}
		}
		const key = `subject:${sub}`;
		if (this.memoryStore.has(key)) {
			return Date.now();
		}
		return null;
	}

	/**
	 * Readiness probe for the Redis connection this store uses.
	 *
	 * The gateway's `/ready` route used to answer `checks: { redis: 'ok' }` from inside
	 * a `try` block with nothing in it that could throw, so it reported Redis healthy
	 * whether or not Redis existed. This actually asks. A store that fell back to its
	 * in-memory set (no REDIS_URL, or a connection that failed) reports `down`.
	 */
	async ping(timeoutMs = 2_000): Promise<'up' | 'down'> {
		if (!this.redis) return 'down';
		try {
			// ioredis queues commands while it is disconnected, so an unbounded ping hangs
			// until its retry budget runs out — which made the readiness probe time out
			// instead of reporting `down`. A probe has to answer.
			const pong = await Promise.race([
				this.redis.ping(),
				new Promise<never>((_, reject) => {
					const t = setTimeout(() => reject(new Error('redis ping timed out')), timeoutMs);
					t.unref?.();
				}),
			]);
			return pong === 'PONG' ? 'up' : 'down';
		} catch {
			return 'down';
		}
	}

	/**
	 * Clean up connections (call on graceful shutdown).
	 */
	async close(): Promise<void> {
		if (this.redis) {
			await this.redis.quit();
			this.redis = null;
		}
	}
}

// Singleton
export const tokenDenylist = new TokenDenylistStore();
export { TokenDenylistStore };
