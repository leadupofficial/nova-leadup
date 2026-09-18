/**
 * Rate limiting middleware — IP-based sliding window with per-route config.
 *
 * Security fix applied:
 * - P1-06: Added IP-based rate limiting on auth endpoints.
 *
 * Design:
 * - Auth routes: 10 requests / 60s window (brute-force protection)
 * - Default: 100 requests / 60s window
 * - Uses an in-memory sliding window; the Map is bounded and auto-cleaned.
 * - For distributed deployments, replace `SlidingWindowStore` with Redis.
 */

interface RateLimitConfig {
	windowMs: number;
	maxRequests: number;
	skipSuccessfulRequests?: boolean;
	skipFailedRequests?: boolean;
}

interface RateLimitEntry {
	timestamps: number[];
	blockedUntil?: number;
}

interface RateLimitResult {
	limited: boolean;
	retryAfterMs?: number;
}

class SlidingWindowStore {
	private readonly store = new Map<string, RateLimitEntry>();
	private readonly cleanupIntervalMs = 60_000;
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly windowMs: number,
		private readonly maxRequests: number,
		private readonly maxEntries = 10000,
	) {
		this.startCleanup();
	}

	check(key: string): RateLimitResult {
		const now = Date.now();
		const entry = this.store.get(key);

		if (!entry) {
			this.store.set(key, { timestamps: [now] });
			this.enforceLimit();
			return { limited: false };
		}

		// Currently in a block?
		if (entry.blockedUntil && now < entry.blockedUntil) {
			return { limited: true, retryAfterMs: entry.blockedUntil - now };
		}

		// Remove timestamps outside the window
		entry.timestamps = entry.timestamps.filter((ts) => now - ts <= this.windowMs);

		if (entry.timestamps.length === 0) {
			entry.timestamps = [now];
			this.enforceLimit();
			return { limited: false };
		}

		if (entry.timestamps.length >= this.maxRequests) {
			// Block the key for the remaining window duration
			const oldest = entry.timestamps[0];
			const retryAfter = this.windowMs - (now - oldest);
			entry.blockedUntil = now + Math.max(retryAfter, 1000);
			return { limited: true, retryAfterMs: entry.blockedUntil - now };
		}

		entry.timestamps.push(now);
		this.enforceLimit();
		return { limited: false };
	}

	reset(key: string): void {
		this.store.delete(key);
	}

	private enforceLimit(): void {
		if (this.store.size > this.maxEntries) {
			// Evict oldest 30% of entries
			const keys = Array.from(this.store.keys()).slice(0, Math.floor(this.maxEntries * 0.3));
			keys.forEach((k) => this.store.delete(k));
		}
	}

	private startCleanup(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			const now = Date.now();
			for (const [key, entry] of this.store.entries()) {
				const recent = entry.timestamps.filter((ts) => now - ts <= this.windowMs);
				if (recent.length === 0 && (!entry.blockedUntil || now >= entry.blockedUntil)) {
					this.store.delete(key);
				} else {
					entry.timestamps = recent;
					if (entry.blockedUntil && now >= entry.blockedUntil) {
						delete entry.blockedUntil;
					}
				}
			}
		}, this.cleanupIntervalMs);
	}

	destroy(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.store.clear();
	}
}

/**
 * Per-route rate limit stores keyed by (ip | routeKey).
 */
const authStore = new SlidingWindowStore(60_000, 10, 5000); // 10 req / 60s
const defaultStore = new SlidingWindowStore(60_000, 100, 20000); // 100 req / 60s

const AUTH_RATE_LIMIT: RateLimitConfig = {
	windowMs: 60_000,
	maxRequests: 10,
};

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
	windowMs: 60_000,
	maxRequests: 100,
};

/**
 * P1-06: IP-based rate limiting middleware.
 *
 * Auth endpoints get stricter limits; everything else gets a default limit.
 * Returns 429 with Retry-After when exceeded.
 */
export function rateLimitMiddleware(config: RateLimitConfig = DEFAULT_RATE_LIMIT) {
	return (req: any, res: any, next: any) => {
		const routeKey = req.route?.path || req.path || req.url;
		const isAuthRoute = /^\/(auth|oauth2?|saml)/.test(routeKey);

		const store = isAuthRoute ? authStore : defaultStore;
		const effectiveConfig = isAuthRoute ? AUTH_RATE_LIMIT : config;

		// Build a composite key: IP + route (so limits are per-route per-IP)
		const ip = (req.ip || req.connection?.remoteAddress || 'unknown') as string;
		const key = `${ip}:${routeKey}`;

		const result = store.check(key);

		if (result.limited) {
			const retryAfter = result.retryAfterMs || effectiveConfig.windowMs;
			res.setHeader('Retry-After', Math.ceil(retryAfter / 1000));
			res.setHeader('X-RateLimit-Limit', String(effectiveConfig.maxRequests));
			res.setHeader('X-RateLimit-Remaining', '0');
			res.setHeader('X-RateLimit-Reset', String(Math.ceil((Date.now() + retryAfter) / 1000)));
			return res.status(429).json({
				error: 'Too Many Requests',
				message: 'Rate limit exceeded. Please try again later.',
				retryAfter: Math.ceil(retryAfter / 1000),
			});
		}

		res.setHeader('X-RateLimit-Limit', String(effectiveConfig.maxRequests));
		// Approximate remaining: total allowed minus what's in the current window
		const entry = (store as unknown as { store: Map<string, RateLimitEntry> }).store.get(key);
		const remaining = entry ? Math.max(0, effectiveConfig.maxRequests - entry.timestamps.length) : effectiveConfig.maxRequests;
		res.setHeader('X-RateLimit-Remaining', String(remaining));
		res.setHeader(
			'X-RateLimit-Reset',
			String(Math.ceil((Date.now() + effectiveConfig.windowMs) / 1000))
		);

		next();
	};
}

/**
 * Reset rate limits for a given key (used after successful authentication).
 */
export function resetRateLimit(key: string): void {
	authStore.reset(key);
	defaultStore.reset(key);
}

export { SlidingWindowStore, AUTH_RATE_LIMIT, DEFAULT_RATE_LIMIT };
