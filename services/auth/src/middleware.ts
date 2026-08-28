/**
 * Auth middleware for @nova/auth Express app.
 */
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { verifyAccessToken } from './jwt.js';
import { findSessionByToken } from './repositories/sessions.js';
import { findUserById } from './repositories/users.js';
import { findRoleByKey } from './repositories/roles.js';
import { ROLE_PERMISSIONS } from '@nova/auth-types';

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

 const roleRow = await findRoleByKey(payload.role);
 const roleKey = roleRow?.key ?? 'member';
 const permissions = ROLE_PERMISSIONS[roleKey as keyof typeof ROLE_PERMISSIONS] ?? [];

 const ctx: AuthContext = {
 userId: payload.sub,
 orgId: payload.orgId,
 workspaceId: payload.workspaceId,
 role: roleKey,
 permissions: [...permissions],
 };

 (req as unknown as { auth: AuthContext }).auth = ctx;

 // Look up session to confirm it is still active
 const session = await findSessionByToken(token);
 if (!session || session.status !== 'active') {
 return next(new AuthHttpError('Session expired or revoked', 401, 'Unauthorized', 'https://api.nova.leadup.in/problems/session-expired'));
 }

 // Attach minimal user info from DB
 const user = await findUserById(payload.sub);
 if (user) {
 (req as unknown as { user: AuthUser }).user = {
 id: user.id,
 email: user.email,
 name: (user as any).name ?? '',
 };
 }

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
