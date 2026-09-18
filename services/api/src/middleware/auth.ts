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

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
	const JWT_SECRET = getJwtSecret();
	const authHeader = req.headers.authorization;
	if (!authHeader?.startsWith('Bearer ')) {
		throw new HttpError(401, 'Missing or invalid authorization header', 'UNAUTHORIZED');
	}
	const token = authHeader.split(' ')[1];
	if (!token) {
		throw new HttpError(401, 'Missing or invalid authorization header', 'UNAUTHORIZED');
	}
	try {
		const payload = jwt.verify(token, JWT_SECRET) as { sub: string; email: string; role: string; jti?: string };
		// Token revocation: reject if the jti is on the denylist
		const jti = payload.jti;
		if (jti && tokenDenylist.isRevoked(jti, payload.sub)) {
			throw new HttpError(401, 'Token has been revoked', 'UNAUTHORIZED');
		}
		req.user = { id: payload.sub, email: payload.email, role: payload.role, jti };
		next();
	} catch (err) {
		if (err instanceof HttpError) throw err;
		throw new HttpError(401, 'Invalid or expired token', 'UNAUTHORIZED');
	}
}

export function requireRole(...roles: string[]) {
	return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
		if (!req.user || !roles.includes(req.user.role)) {
			throw new HttpError(403, 'Forbidden', 'FORBIDDEN');
		}
		next();
	};
}
