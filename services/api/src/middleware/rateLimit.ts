/**
 * Rate limiting middleware — IP-based sliding window with per-route config.
 *
 * Security fix applied:
 * - P1-06: Added IP-based rate limiting on auth endpoints.
 *
 * Design:
 * - Auth routes: 10 requests / 60s window (brute-force protection)
 * - Default: 100 requests / 60s window
 * - Uses an in-memory sliding window; the Map is bounded and auto-cleaned, and
 *   reclamation never discards a key that is inside an active block (P-01).
 * - For distributed deployments, replace `SlidingWindowStore` with Redis.
 */
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './error-handler.js';

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

	/** Keys currently tracked. Exposed for the memory-bound tests. */
	get size(): number {
		return this.store.size;
	}

	check(key: string): RateLimitResult {
		const now = Date.now();
		const entry = this.store.get(key);

		if (!entry) {
			this.store.set(key, { timestamps: [now] });
			this.enforceLimit(now);
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
			this.enforceLimit(now);
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
		this.enforceLimit(now);
		return { limited: false };
	}

	/** True while the key is inside an active block (P-01). */
	private isBlocked(entry: RateLimitEntry, now: number): boolean {
		return entry.blockedUntil !== undefined && now < entry.blockedUntil;
	}

	/**
	 * True when nothing about the entry is still live: every timestamp is outside
	 * the window and it is not blocked. Only these may be reclaimed.
	 */
	private isExpired(entry: RateLimitEntry, now: number): boolean {
		if (this.isBlocked(entry, now)) return false;
		return entry.timestamps.every((ts) => now - ts > this.windowMs);
	}

	/**
	 * Keeps the map bounded **without ever discarding a live brute-force block.**
	 *
	 * This used to delete the oldest 30 % of keys whenever `check()` found the map
	 * over its cap. On the auth limiter that was a self-inflicted bypass: the key
	 * is `ip:route`, `/api/v1/auth/<anything>` is a new key per request, so an
	 * attacker could flood the limiter with fresh keys and evict their own
	 * accumulated block — and every other caller's block — resetting the
	 * protection the store exists for.
	 *
	 * Reclamation now runs in two ordered steps:
	 *  1. windows that have fully elapsed and hold no block — nothing live is lost;
	 *  2. only if that was not enough, the oldest entries that are **not** blocked.
	 *     A key inside an active block is never removed, so an attacker cannot
	 *     evict a block by flooding; the worst a flood can drop is a partial
	 *     counter from an unblocked window.
	 *
	 * Blocks are also bounded in lifetime by the window itself, so a map full of
	 * blocks drains on the cleanup timer rather than growing forever.
	 */
	private enforceLimit(now: number = Date.now()): void {
		if (this.store.size <= this.maxEntries) return;

		for (const [key, entry] of this.store) {
			if (this.isExpired(entry, now)) this.store.delete(key);
		}
		if (this.store.size <= this.maxEntries) return;

		for (const [key, entry] of this.store) {
			if (this.store.size <= this.maxEntries) break;
			if (this.isBlocked(entry, now)) continue;
			this.store.delete(key);
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
/**
 * The auth limiter.
 *
 * **Nothing resets it, and that is deliberate.** A successful sign-in does not clear the window, so ten
 * attempts per minute per IP is a hard ceiling whether or not some of them succeed — which is the
 * property that matters against credential stuffing, where the attacker holds valid credentials for one
 * account and is guessing at others.
 *
 * This comment replaces one that claimed a reset happens "after successful authentication" — a helper
 * with that name existed and no caller used it. The comment misled a verification script into expecting
 * the window to clear, which is why it is now stated as the opposite: if you are looking for
 * `resetRateLimit`, it was deleted rather than left as a temptation.
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


// ─── Fixed-window limiter (express-rate-limit-compatible options) ─────────────
//
// `rateLimitMiddleware` above is the sliding-window limiter the server mounts on
// `/api/v1`. This is the smaller, fixed-window counterpart with the option names
// the rest of the ecosystem uses (`windowMs` / `max` / `keyGenerator`); it
// reports exhaustion through `next(HttpError)` so the shared error handler owns
// the response, rather than writing 429 itself.

export interface RateLimitOptions {
	/** Window length in milliseconds. Defaults to 60s. */
	windowMs?: number;
	/** Maximum requests allowed per key per window. Defaults to 100. */
	max?: number;
	/** Derives the limiting key from the request. Defaults to the peer IP. */
	keyGenerator?: (req: Request) => string;
}

interface FixedWindowBucket {
	count: number;
	resetAt: number;
}

/**
 * Live bucket state. Exported so callers (and tests) can reset it wholesale —
 * `buckets.clear()` — without reaching into the module's internals.
 */
export const buckets = new Map<string, FixedWindowBucket>();

/**
 * Ceiling on tracked fixed-window keys.
 *
 * The map had neither a cap nor a cleanup timer, so every one-off key — a new
 * client, a probing scanner, a load balancer health check behind a rotating
 * address — left a bucket behind for the life of the process, and the map only
 * ever grew. The map is not mounted today (`rateLimit()` has no call site), which
 * is exactly why the leak was latent rather than visible.
 */
export const MAX_FIXED_WINDOW_BUCKETS = 10_000;

/** How often expired fixed-window buckets are reclaimed. */
const BUCKET_CLEANUP_INTERVAL_MS = 60_000;

let bucketCleanupTimer: ReturnType<typeof setInterval> | null = null;

/** Drops every bucket whose window has already reset. Nothing live is touched. */
function sweepExpiredBuckets(now: number = Date.now()): void {
	for (const [key, bucket] of buckets) {
		if (now >= bucket.resetAt) buckets.delete(key);
	}
}

/**
 * Starts the reclamation timer. Called when a limiter is constructed, and idempotent
 * — every `rateLimit()` shares the one module-level map.
 */
function startBucketCleanup(): void {
	if (bucketCleanupTimer) return;
	bucketCleanupTimer = setInterval(() => sweepExpiredBuckets(), BUCKET_CLEANUP_INTERVAL_MS);
	// Never hold the process open: this is housekeeping, not work.
	bucketCleanupTimer.unref?.();
}

/** Stops the reclamation timer. Exposed for tests and a graceful shutdown hook. */
export function stopBucketCleanup(): void {
	if (bucketCleanupTimer) {
		clearInterval(bucketCleanupTimer);
		bucketCleanupTimer = null;
	}
}

/**
 * Makes room for one more bucket without letting the map grow past its cap.
 *
 * Expired windows are reclaimed first, so the bound normally costs nothing. If
 * every tracked window is still live, the bucket that resets soonest goes: a
 * fixed window holds no block, so no accumulated brute-force state is discarded —
 * only a counter that was about to expire anyway. The incoming key is always
 * admitted, so the limiter keeps limiting under memory pressure.
 */
function evictForCapacity(now: number): void {
	if (buckets.size < MAX_FIXED_WINDOW_BUCKETS) return;

	sweepExpiredBuckets(now);
	if (buckets.size < MAX_FIXED_WINDOW_BUCKETS) return;

	let oldestKey: string | null = null;
	let oldestReset = Infinity;
	for (const [key, bucket] of buckets) {
		if (bucket.resetAt < oldestReset) {
			oldestReset = bucket.resetAt;
			oldestKey = key;
		}
	}
	if (oldestKey !== null) buckets.delete(oldestKey);
}

function defaultKeyGenerator(req: Request): string {
	return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Build a fixed-window rate limiter.
 *
 * Over the limit the request is rejected with a 429 `HttpError`, so the response
 * body is the standard problem-details document produced by `errorHandler`.
 */
export function rateLimit(options: RateLimitOptions = {}) {
	const windowMs = options.windowMs ?? 60_000;
	const max = options.max ?? 100;
	const keyGenerator = options.keyGenerator ?? defaultKeyGenerator;

	startBucketCleanup();

	return (req: Request, res: Response, next: NextFunction): void => {
		const now = Date.now();
		const key = String(keyGenerator(req));

		let bucket = buckets.get(key);
		if (!bucket || now >= bucket.resetAt) {
			// Only a *new* key can push the map past its cap; a key that already has
			// a bucket is being re-set in place.
			if (!buckets.has(key)) evictForCapacity(now);
			bucket = { count: 0, resetAt: now + windowMs };
			buckets.set(key, bucket);
		}
		bucket.count += 1;

		const remaining = Math.max(0, max - bucket.count);
		res.setHeader('X-RateLimit-Limit', String(max));
		res.setHeader('X-RateLimit-Remaining', String(remaining));
		res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

		if (bucket.count > max) {
			const retryAfterMs = Math.max(0, bucket.resetAt - now);
			res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
			next(new HttpError(429, 'Too Many Requests', 'RATE_LIMITED'));
			return;
		}

		next();
	};
}

export { SlidingWindowStore, AUTH_RATE_LIMIT, DEFAULT_RATE_LIMIT };
