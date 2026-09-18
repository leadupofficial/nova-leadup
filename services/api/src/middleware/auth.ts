import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { HttpError } from '../middleware/error-handler.js';
import { tokenDenylist } from '../middleware/token-denylist.js';

function getJwtSecret(): string {
	const secret = process.env.JWT_SECRET;
	if (!secret) {
		throw new HttpError(500, 'Server misconfigured: JWT_SECRET not set', 'INTERNAL_CONFIG');
	}
	return secret;
}

export interface AuthenticatedRequest extends Request {
	user?: { id: string; email: string; role: string; jti?: string };
}

/**
 * Verifies the bearer token and attaches `req.user`.
 *
 * **These middlewares are deliberately synchronous and forward failures with
 * `next(err)`.** They were previously declared `async` and used bare `throw`.
 * Express 4 does not catch rejected promises from async middleware, so every
 * unauthenticated request became an unhandled rejection and **terminated the Node
 * process** — a remote denial of service reachable without any credentials on every
 * route that uses `authenticate` (`/api/v1/auth/me`, `/health/ready`, `/settings/*`,
 * `/admin/*`, ...). The container simply restarted, so it looked like a flaky service
 * rather than a crash on the unauthenticated path.
 *
 * Nothing here awaits, so `async` was never needed. Errors are both caught locally and
 * safe under Express's own synchronous try/catch.
 */
export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
	try {
		const jwtSecret = getJwtSecret();

		const authHeader = req.headers.authorization;
		if (!authHeader?.startsWith('Bearer ')) {
			throw new HttpError(401, 'Missing or invalid authorization header', 'UNAUTHORIZED');
		}

		const token = authHeader.split(' ')[1];
		if (!token) {
			throw new HttpError(401, 'Missing or invalid authorization header', 'UNAUTHORIZED');
		}

		let payload: { sub: string; email: string; role: string; jti?: string };
		try {
			payload = jwt.verify(token, jwtSecret) as typeof payload;
		} catch {
			throw new HttpError(401, 'Invalid or expired token', 'UNAUTHORIZED');
		}

		if (payload.jti && tokenDenylist.isRevoked(payload.jti, payload.sub)) {
			throw new HttpError(401, 'Token has been revoked', 'UNAUTHORIZED');
		}

		req.user = {
			id: payload.sub,
			email: payload.email,
			role: payload.role,
			jti: payload.jti,
		};
		next();
	} catch (error) {
		next(error);
	}
}

/**
 * Role gate. Synchronous for the same reason as [authenticate] — a bare `throw` in an
 * `async` middleware takes the process down instead of returning 403.
 */
export function requireRole(...roles: string[]) {
	return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
		try {
			if (!req.user || !roles.includes(req.user.role)) {
				throw new HttpError(403, 'Forbidden', 'FORBIDDEN');
			}
			next();
		} catch (error) {
			next(error);
		}
	};
}
