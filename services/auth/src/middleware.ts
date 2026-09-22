/**
 * Auth middleware for @nova/auth Express app.
 */
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { verifyAccessToken } from './jwt.js';
import { tokenDenylist } from './tokenDenylist.js';
import { ROLE_PERMISSIONS } from '@nova/auth-types';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import Redis from 'ioredis';

/**
 * Redis client for the rate-limit stores.
 *
 * `ioredis` emits `error` events, and an EventEmitter with no `error` listener
 * **throws** — so an unreachable Redis (a perfectly normal condition: the gateway,
 * the admin API and the integration service all import this module) produced a flood
 * of unhandled errors and eventually a `MaxRetriesPerRequestError` that took the
 * process down. The listener keeps the failure where it belongs: in the log.
 */
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
	lazyConnect: false,
	maxRetriesPerRequest: 2,
});
redis.on('error', (err: Error) => {
	// eslint-disable-next-line no-console
	console.error('[auth] redis unavailable; rate limiting degrades gracefully:', err.message);
});

/**
 * A rate-limit store backed by Redis that cannot take the process down.
 *
 * `rate-limit-redis` loads its Lua scripts **in the constructor**:
 *
 * ```js
 * this.incrementScriptSha = this.loadIncrementScript();   // floating promise
 * ```
 *
 * That promise is never awaited or caught, so with Redis unreachable it rejected as an
 * **unhandled rejection** — which killed the admin API process and failed the auth test
 * suite while all 27 tests passed. Wrapping `sendCommand` to swallow errors only moved
 * the failure: the store then threw `unexpected reply from redis client` from the same
 * floating promise.
 *
 * This store does the same job with two plain commands (`INCR` + `PEXPIRE`), so there is
 * no script loading and no floating promise. On any Redis error it delegates to an
 * in-memory store, so rate limiting keeps working within one process instead of
 * disappearing — and `passOnStoreError` on the limiters covers the remaining path where
 * the memory store itself could throw.
 */
class FailOpenRedisStore {
	private readonly memory = new MemoryStore();
	/** `Store` requires this to be public. */
	prefix = 'rl:';
	/** Window length; `express-rate-limit` passes it through `init`. */
	private windowMs = 60_000;

	init(options?: { windowMs?: number; prefix?: string }): void {
		this.windowMs = options?.windowMs ?? this.windowMs;
		this.prefix = options?.prefix ?? this.prefix;
		(this.memory as unknown as { init?: (o: unknown) => void }).init?.(options);
	}

	async increment(key: string): Promise<{ totalHits: number; resetTime: Date | undefined }> {
		try {
			const redisKey = this.prefix + key;
			const totalHits = await redis.incr(redisKey);
			if (totalHits === 1) {
				await redis.pexpire(redisKey, this.windowMs);
			}
			const ttl = await redis.pttl(redisKey);
			return {
				totalHits,
				resetTime: new Date(Date.now() + (ttl > 0 ? ttl : this.windowMs)),
			};
		} catch {
			return this.memory.increment(key);
		}
	}

	async decrement(key: string): Promise<void> {
		try {
			await redis.decr(this.prefix + key);
		} catch {
			return this.memory.decrement(key);
		}
	}

	async resetKey(key: string): Promise<void> {
		try {
			await redis.del(this.prefix + key);
		} catch {
			return this.memory.resetKey(key);
		}
	}

	async resetAll(): Promise<void> {
		try {
			const keys = await redis.keys(`${this.prefix}*`);
			if (keys.length > 0) await redis.del(...keys);
		} catch {
			return this.memory.resetAll();
		}
	}
}

export const authLimiter = rateLimit({
  store: new FailOpenRedisStore(),
  passOnStoreError: true,
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many authentication attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiLimiter = rateLimit({
  store: new FailOpenRedisStore(),
  passOnStoreError: true,
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

export interface AuthContext {
 userId: string;
 orgId: string;
 workspaceId: string;
 role: string;
 permissions: string[];
}

export interface AuthUser {
 id: string;
 email: string;
 name: string;
}

class AuthHttpError extends Error {
 constructor(
 message: string,
 public statusCode: number,
 public title: string = message,
 public problemType: string = 'https://api.nova.leadup.in/problems/unknown'
 ) {
 super(message);
 this.name = 'AuthHttpError';
 Object.setPrototypeOf(this, AuthHttpError.prototype);
 }
}

export { AuthHttpError };

export async function authenticateJwt(req: Request, _res: Response, next: NextFunction): Promise<void> {
 try {
 const authHeader = req.headers.authorization;
 if (!authHeader?.startsWith('Bearer ')) {
 return next(new AuthHttpError('Missing authorization token', 401, 'Unauthorized', 'https://api.nova.leadup.in/problems/unauthorized'));
 }

 const token = authHeader.slice(7);
 const payload = verifyAccessToken(token);

 // Token revocation: reject if the jti is on the denylist
 if (tokenDenylist.isRevoked(payload.jti, payload.sub)) {
   return next(new AuthHttpError('Token has been revoked', 401, 'Unauthorized', 'https://api.nova.leadup.in/problems/token-revoked'));
 }

 // The claims of a token that passed the signature and denylist checks are
 // authoritative. This used to make three database round-trips
 // (`findRoleByKey`, `findSessionByToken`, `findUserById`) against a schema this
 // package no longer matches — `roles.key` vs `roles.slug`,
 // `sessions.token_hash`/`status` vs `sessions.refresh_token_hash`/`revoked_at`,
 // `users.deleted_at` vs `users.disabled`. Every request through services/admin and
 // services/integration-service therefore died with `column "key" does not exist`
 // and answered 500, with a valid owner token included. Revocation is enforced by
 // the `jti` denylist above, which is how services/api's middleware does it.
 const roleKey = payload.role || 'member';
 const permissions = ROLE_PERMISSIONS[roleKey as keyof typeof ROLE_PERMISSIONS] ?? [];

 const ctx: AuthContext = {
 userId: payload.sub,
 orgId: payload.orgId,
 workspaceId: payload.workspaceId,
 role: roleKey,
 permissions: [...permissions],
 };

 (req as unknown as { auth: AuthContext }).auth = ctx;

 // Attach minimal user info from the token, so downstream handlers do not need a
 // second lookup for the fields they all use.
 (req as unknown as { user: AuthUser }).user = {
 id: payload.sub,
 email: (payload as { email?: string }).email ?? '',
 name: (payload as { name?: string }).name ?? '',
 };

 next();
 } catch (err) {
 if (err instanceof jwt.JsonWebTokenError) {
 return next(new AuthHttpError('Invalid token', 401, 'Unauthorized', 'https://api.nova.leadup.in/problems/invalid-token'));
 }
 next(err instanceof Error ? err : new Error('Authentication failed'));
 }
}

export function requirePermission(permission: string) {
 return (req: Request, res: Response, next: NextFunction): void => {
 const ctx = (req as unknown as { auth: AuthContext }).auth;
 if (!ctx || !ctx.permissions.includes(permission)) {
 const httpErr = new AuthHttpError(
 `Forbidden — requires ${permission}`,
 403, 'Forbidden', 'https://api.nova.leadup.in/problems/forbidden'
 );
 return next(httpErr);
 }
 next();
 };
}

export function requireRole(...roles: string[]) {
 return (req: Request, res: Response, next: NextFunction): void => {
 const ctx = (req as unknown as { auth: AuthContext }).auth;
 if (!ctx || !roles.includes(ctx.role)) {
 const httpErr = new AuthHttpError(
 `Forbidden — requires role: ${roles.join(' or ')}`,
 403, 'Forbidden', 'https://api.nova.leadup.in/problems/forbidden'
 );
 return next(httpErr);
 }
 next();
 };
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
 if (err instanceof AuthHttpError) {
 res.status(err.statusCode).json({
 type: err.problemType,
 title: err.title,
 status: err.statusCode,
 detail: err.message,
 });
 return;
 }
 res.status(500).json({
 type: 'https://api.nova.leadup.in/problems/server-error',
 title: 'Internal Server Error',
 status: 500,
 detail: err.message || 'An unexpected error occurred.',
 });
}

export function sendProblem(res: Response, err: Error | AuthHttpError, instance?: string): void {
 const status = err instanceof AuthHttpError ? err.statusCode : 500;
 const title = err instanceof AuthHttpError ? err.title : 'Internal Server Error';
 const code = err instanceof AuthHttpError ? err.problemType : 'https://api.nova.leadup.in/problems/server-error';
 const detail = err instanceof Error ? err.message : 'An unexpected error occurred.';
 res.status(status).json({
 type: code,
 title,
 status,
 detail,
 instance,
 });
}
