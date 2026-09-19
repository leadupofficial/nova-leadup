import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../config/database';
import { logger } from '../utils/logger';

const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('FATAL: JWT_SECRET environment variable is not set. Application startup aborted.');
  }
  return secret;
})();

export interface AuthRequest extends Request {
 user?: {
 id: number;
 email: string;
 name: string;
 role: string;
 };
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
 try {
 const authHeader = req.headers.authorization;

 if (!authHeader || !authHeader.startsWith('Bearer ')) {
 return res.status(401).json({
 success: false,
 message: 'Access token is required',
 code: 'MISSING_TOKEN'
 });
 }

 const token = authHeader.split(' ')[1];

 if (!token) {
 return res.status(401).json({
 success: false,
 message: 'Access token is required',
 code: 'MISSING_TOKEN'
 });
 }

 // Verify token
 const decoded = jwt.verify(token, JWT_SECRET) as { userId: number };

 // Get user from database
 const [users] = await pool.query(
 'SELECT id, email, name, role, is_active FROM users WHERE id = ?',
 [decoded.userId]
 );

 const user = (users as any[])[0];

 if (!user) {
 return res.status(401).json({
 success: false,
 message: 'Invalid token - user not found',
 code: 'INVALID_TOKEN'
 });
 }

 if (!user.is_active) {
 return res.status(403).json({
 success: false,
 message: 'Account is deactivated. Contact administrator.',
 code: 'ACCOUNT_DEACTIVATED'
 });
 }

 req.user = {
 id: user.id,
 email: user.email,
 name: user.name,
 role: user.role,
 };

 next();
 } catch (error) {
 logger.error('Auth middleware error:', error);

 if (error instanceof jwt.TokenExpiredError) {
 return res.status(401).json({
 success: false,
 message: 'Token expired',
 code: 'TOKEN_EXPIRED'
 });
 }

 if (error instanceof jwt.JsonWebTokenError) {
 return res.status(401).json({
 success: false,
 message: 'Invalid token',
 code: 'INVALID_TOKEN'
 });
 }

 return res.status(500).json({
 success: false,
 message: 'Authentication error',
 code: 'AUTH_ERROR'
 });
 }
}

export function requireRole(...roles: string[]) {
 return (req: AuthRequest, res: Response, next: NextFunction) => {
 if (!req.user) {
 return res.status(401).json({
 success: false,
 message: 'Authentication required',
 code: 'AUTH_REQUIRED'
 });
 }

 if (!roles.includes(req.user.role)) {
 logger.warn(`Access denied: User ${req.user.id} attempted to access resource requiring roles: ${roles.join(', ')}`);

 return res.status(403).json({
 success: false,
 message: 'Insufficient permissions',
 code: 'INSUFFICIENT_PERMISSIONS'
 });
 }

 next();
 };
}
