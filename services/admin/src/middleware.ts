import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export interface AdminContext {
 adminId: string;
 permissions: string[];
 role: string;
}

export async function authenticateAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
 const authHeader = req.headers.authorization;
 if (!authHeader?.startsWith('Bearer ')) {
 return next(createError(401, 'Missing authorization token'));
 }
 try {
 const decoded = JSON.parse(Buffer.from(authHeader.slice(7), 'base64').toString());
 const ctx: AdminContext = { adminId: decoded.sub, permissions: decoded.permissions ?? [], role: decoded.role ?? 'admin' };
 (req as unknown as { admin: AdminContext }).admin = ctx;
 next();
 } catch {
 next(createError(401, 'Invalid token'));
 }
}

export function requirePermission(permission: string) {
 return (req: Request, res: Response, next: NextFunction): void => {
 const ctx = (req as unknown as { admin?: AdminContext }).admin;
 if (!ctx || !ctx.permissions.includes(permission)) {
 return next(createError(403, `Missing permission: ${permission}`));
 }
 next();
 };
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
 console.error('[admin] error:', err);
 res.status(err instanceof HttpError ? err.status : 500).json({
 type: 'https://api.nova.leadup.in/problems/server-error',
 title: err.message || 'Internal Server Error',
 status: err instanceof HttpError ? err.status : 500,
 detail: err.message,
 });
}

class HttpError extends Error {
 constructor(public status: number, message: string) {
 super(message);
 this.name = 'HttpError';
 }
}

function createError(status: number, message: string): HttpError {
 return new HttpError(status, message);
}
