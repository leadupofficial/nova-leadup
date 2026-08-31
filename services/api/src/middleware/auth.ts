import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { HttpError } from '../middleware/error-handler';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

export interface AuthenticatedRequest extends Request {
 user?: { id: string; email: string; role: string };
}

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
 const authHeader = req.headers.authorization;
 if (!authHeader?.startsWith('Bearer ')) {
 throw new HttpError(401, 'Missing or invalid authorization header', 'UNAUTHORIZED');
 }
 const token = authHeader.split(' ')[1];
 try {
 const payload = jwt.verify(token, JWT_SECRET) as { sub: string; email: string; role: string };
 req.user = { id: payload.sub, email: payload.email, role: payload.role };
 next();
 } catch {
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
