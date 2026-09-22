/**
 * Rate Limiter Middleware for API and WebSocket connections.
 *
 * Implements sliding window rate limiting using Redis as the backing store.
 * Falls back to in-memory storage if Redis is unavailable.
 *
 * SECURITY: Prevents brute force attacks, DoS attempts, and abuse.
 */

import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';

// Re-export for convenience
export { secureRandomHex, isValidSecureToken } from '../auth/secure-random.js';

/**
 * Rate limit configuration.
 */
export interface RateLimitConfig {
 // Number of requests allowed in the window
 limit: number;
 // Window duration in milliseconds
 windowMs: number;
 // Key generator function to identify clients
 keyGenerator?: (req: Request) => string;
 // Custom error message
 message?: string;
 // Whether to skip rate limiting for certain conditions
 skip?: (req: Request) => boolean;
 // Callback when rate limit is exceeded
 onLimitReached?: (req: Request, key: string) => void;
}

/**
 * Create a sliding window rate limiter middleware.
 *
 * @param config - Rate limit configuration
 * @returns Express middleware function
 */
export function createRateLimiter(config: RateLimitConfig) {
 const {
 limit,
 windowMs,
 keyGenerator = defaultKeyGenerator,
 message = 'Too many requests. Please try later.',
 skip,
 onLimitReached,
 } = config;

 // Try to use Redis if available, fall back to in-memory
 let redisClient: Redis | null = null;
 try {
 const redisUrl = process.env.REDIS_URL;
 if (redisUrl) {
 // TLS follows the URL scheme (`rediss://`); ioredis enables it itself. Forcing
 // `tls: {}` under NODE_ENV=production broke every plaintext production Redis,
 // which silently pushed rate limiting onto the in-memory fallback.
 redisClient = new Redis(redisUrl);
 }
 } catch (error) {
 console.warn('Redis not available, using in-memory rate limiting');
 redisClient = null;
 }

 // In-memory store for fallback
 const memoryStore = new Map<string, { count: number; resetTime: number }>();

 function defaultKeyGenerator(_req: Request): string {
 return _req.ip || _req.socket.remoteAddress || 'unknown';
 }

 async function checkRateLimit(key: string): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
 const now = Date.now();

 if (redisClient) {
 try {
 const windowKey = `ratelimit:${key}`;
 const windowStart = now - windowMs;
 await redisClient.zremrangebyscore(windowKey, 0, windowStart);
 const count = await redisClient.zcard(windowKey);
 if (count >= limit) {
 // ioredis 6 types `zrange`'s start/stop as strings on the WITHSCORES
 // overload; the wire command is identical.
 const oldest = await redisClient.zrange(windowKey, '0', '0', 'WITHSCORES');
 const resetTime = oldest.length > 0 ? parseInt(oldest[1]) + windowMs : now + windowMs;
 return { allowed: false, remaining: 0, resetTime };
 }
 await redisClient.zadd(windowKey, now, `${now}:${Math.random()}`);
 await redisClient.expire(windowKey, Math.ceil(windowMs / 1000));
 return { allowed: true, remaining: limit - count - 1, resetTime: now + windowMs };
 } catch (error) {
 console.error('Redis rate limit check failed:', error);
 // Fail closed: reject when rate limiter is unavailable
 return { allowed: false, remaining: 0, resetTime: now + windowMs };
 }
 }

 // In-memory fallback
 const record = memoryStore.get(key);
 if (!record || now > record.resetTime) {
 memoryStore.set(key, { count: 1, resetTime: now + windowMs });
 return { allowed: true, remaining: limit - 1, resetTime: now + windowMs };
 }
 if (record.count >= limit) {
 return { allowed: false, remaining: 0, resetTime: record.resetTime };
 }
 record.count++;
 return { allowed: true, remaining: limit - record.count, resetTime: record.resetTime };
 }

 // Expose a direct check() method for non-Express contexts (e.g., WebSocket)
 return {
 middleware: (req: Request, res: Response, next: NextFunction) => {
 if (skip?.(req)) return next();
 const key = keyGenerator(req);
 checkRateLimit(key).then((result) => {
 res.setHeader('X-RateLimit-Limit', limit.toString());
 res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
 res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000).toString());
 if (!result.allowed) {
 onLimitReached?.(req, key);
 return res.status(429).json({ error: message, retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000) });
 }
 next();
 }).catch(() => next());
 },
 check: async (key: string) => checkRateLimit(key),
 };
}

/**
 * Create a rate limiter with different limits for authenticated vs anonymous users.
 *
 * @param options - Rate limit options
 * @returns Express middleware function
 */
export function createTieredRateLimiter({
 anonymousLimit,
 authenticatedLimit,
 windowMs,
 }: {
 anonymousLimit: number;
 authenticatedLimit: number;
 windowMs: number;
 }) {
 const anonLimiter = createRateLimiter({
 limit: anonymousLimit,
 windowMs,
 keyGenerator: (req) => `anon:${req.ip}`,
 });

 const authLimiter = createRateLimiter({
 limit: authenticatedLimit,
 windowMs,
 keyGenerator: (req) => `auth:${(req as any).user?.id || req.ip}`,
 });

 return (req: Request, res: Response, next: NextFunction) => {
 const userId = (req as any).user?.id;
 if (userId) {
 return authLimiter.middleware(req, res, next);
 } else {
 return anonLimiter.middleware(req, res, next);
 }
 };
}
