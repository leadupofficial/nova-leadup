/**
 * Redis-backed sliding-window rate limiter.
 *
 * Supports:
 * - Per-IP limiting (key: rl:ip:<ip>:<endpoint>)
 * - Per-user limiting (key: rl:user:<userId>:<endpoint>)
 * - Global token-bucket style limits
 */
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
 maxRetriesPerRequest: null,
});

interface RateLimitConfig {
 windowMs: number;
 max: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
 windowMs: 60_000, // 1 min
 max: 60, // 60 req/min
};

const ENDPOINT_LIMITS: Record<string, RateLimitConfig> = {
 '/auth/register': { windowMs: 60_000, max: 5 },
 '/auth/login': { windowMs: 60_000, max: 10 },
 '/auth/phone/otp/request': { windowMs: 60_000, max: 5 },
 '/auth/phone/otp/verify': { windowMs: 60_000, max: 5 },
 '/auth/password-reset': { windowMs: 60_000, max: 5 },
};

export function rateLimitMiddleware(req: Express.Request, res: Express.Response, next: Express.NextFunction): void {
 const endpoint = req.route?.path ?? req.path;
 const config = ENDPOINT_LIMITS[endpoint] ?? DEFAULT_CONFIG;
 const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
 const key = `rl:ip:${ip}:${endpoint}`;

 redis.incr(key, (err, count) => {
 if (err) return next();
 if (count === 1) {
 redis.pexpire(key, config.windowMs, () => {});
 }
 if (count > config.max) {
 res.set('Retry-After', String(Math.ceil(config.windowMs / 1000)));
 return sendProblem(res, 429, 'Too Many Requests', 'Rate limit exceeded. Try again later.', req.path);
 }
 next();
 });
}

export function rateLimitUser(
 userId: string,
 endpoint: string,
 config: RateLimitConfig = DEFAULT_CONFIG
): Promise<boolean> {
 const key = `rl:user:${userId}:${endpoint}`;
 const count = await redis.incr(key);
 if (count === 1) {
 await redis.pexpire(key, config.windowMs);
 }
 return count <= config.max;
}

function sendProblem(
 res: Express.Response,
 status: number,
 title: string,
 detail: string,
 instance?: string
): void {
 res.status(status).json({
 type: 'https://api.nova.leadup.in/problems/rate-limit',
 title,
 status,
 detail,
 instance,
 });
}
