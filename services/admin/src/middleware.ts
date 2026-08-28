/**
 * @nova/admin — Middleware: JWT auth, RBAC, and error handling.
 *
 * Reuses @nova/auth-types for role definitions and
 * performs JWT verification locally (same DATABASE_URL).
 */
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { ROLE_PERMISSIONS, type Role, type Permission } from '@nova/auth-types';
import { qOne } from '../db.js';

export interface AdminAuthContext {
 userId: string;
 orgId: string;
 workspaceId: string;
 role: string;
 permissions: Permission[];
}

class AdminHttpError extends Error {
 constructor(
 message: string,
 public statusCode: number,
 public title: string = message,
 public problemType: string = 'https://api.nova.leadup.in/problems/unknown'
 ) {
 super(message);
 this.name = 'AdminHttpError';
 Object.setPrototypeOf(this, AdminHttpError.prototype);
 }
}

export { AdminHttpError };

export async function authenticateJwt(req: Request, _res: Response, next: NextFunction): Promise<void> {
 try {
 const authHeader = req.headers.authorization;
 if (!authHeader?.startsWith('Bearer ')) {
 return next(new AdminHttpError('Missing authorization token', 401, 'Unauthorized'));
 }

 const token = authHeader.slice(7);
 const secret = process.env.JWT_SECRET || 'change-me-in-production';
 const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as {
 sub: string;
 orgId: string;
 workspaceId: string;
 role: string;
 };

 // Confirm session is still active
 const session = await qOne<{ status: string }>(
 'SELECT status FROM sessions WHERE token_hash = $1 AND status = $2',
 [token, 'active']
 );
 if (!session) {
 return next(new AdminHttpError('Session expired or revoked', 401, 'Unauthorized'));
 }

 const permissions = ROLE_PERMISSIONS[payload.role as Role] ?? [];

 (req as unknown as { auth: AdminAuthContext }).auth = {
 userId: payload.sub,
 orgId: payload.orgId,
 workspaceId: payload.workspaceId,
 role: payload.role,
 permissions,
 };
 next();
 } catch (err) {
 if (err instanceof jwt.JsonWebTokenError) {
 return next(new AdminHttpError('Invalid token', 401, 'Unauthorized'));
 }
 next(err instanceof Error ? err : new Error('Authentication failed'));
 }
}

export function requirePermission(permission: Permission) {
 return (req: Request, _res: Response, next: NextFunction): void => {
 const ctx = (req as unknown as { auth: AdminAuthContext }).auth;
 if (!ctx || !ctx.permissions.includes(permission)) {
 return next(new AdminHttpError(`Forbidden — requires ${permission}`, 403, 'Forbidden'));
 }
 next();
 };
}

export function requireRole(...roles: string[]) {
 return (req: Request, _res: Response, next: NextFunction): void => {
 const ctx = (req as unknown as { auth: AdminAuthContext }).auth;
 if (!ctx || !roles.includes(ctx.role)) {
 return next(new AdminHttpError(`Forbidden — requires role: ${roles.join(' or ')}`, 403, 'Forbidden'));
 }
 next();
 };
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
 if (err instanceof AdminHttpError) {
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
 detail: err instanceof Error ? err.message : 'An unexpected error occurred.',
 });
}
