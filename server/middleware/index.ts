/**
 * Global Express middleware utilities
 */

import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AppError } from '../utils/errors';

export type RateLimitStore = Map<string, { count: number; resetAt: number }>;

/**
 * Request logging middleware
 */
export function requestLogger(
 req: Request,
 res: Response,
 next: NextFunction
): void {
 const start = Date.now();
 const requestId = generateRequestId();

 res.setHeader('X-Request-ID', requestId);
 res.setHeader('X-Response-Time', `${Date.now() - start}ms`);

 res.on('finish', () => {
 const duration = Date.now() - start;

 console.log({
 requestId,
 method: req.method,
 url: req.url,
 statusCode: res.statusCode,
 duration,
 userAgent: req.get('user-agent'),
 ip: req.ip || req.connection.remoteAddress,
 contentType: req.get('content-type'),
 contentLength: req.get('content-length'),
 });
 });

 next();
}

function generateRequestId(): string {
 return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Simple in-memory rate limiter
 */
export function createRateLimiter(
 windowMs: number,
 max: number,
 store: RateLimitStore = new Map()
) {
 return function rateLimiter(
 req: Request,
 res: Response,
 next: NextFunction
 ): void {
 const key = req.ip || 'anonymous';
 const now = Date.now();
 const windowStart = now - windowMs;

 while (store.has(key) && store.get(key)!.resetAt < now) {
 store.delete(key);
 }

 const record = store.get(key) || { count: 0, resetAt: now + windowMs };

 if (record.count >= max) {
 const retryAfter = Math.ceil((record.resetAt - now) / 1000);
 res.setHeader('Retry-After', String(retryAfter));
 throw new AppError(
 `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
 StatusCodes.TOO_MANY_REQUESTS,
 true
 );
 }

 record.count++;
 store.set(key, record);

 next();
 };
}

/**
 * Request timeout middleware
 */
export function requestTimeout(timeoutMs = 30000) {
 return (req: Request, res: Response, next: NextFunction): void => {
 const timeout = setTimeout(() => {
 res.status(StatusCodes.REQUEST_TIMEOUT).json({
 error: 'RequestTimeout',
 message: 'Request timed out',
 statusCode: StatusCodes.REQUEST_TIMEOUT,
 timestamp: new Date().toISOString(),
 });
 }, timeoutMs);

 res.on('finish', () => clearTimeout(timeout));
 res.on('close', () => clearTimeout(timeout));
 next();
 };
}

/**
 * Sets security-related headers
 */
export function securityHeaders(
 req: Request,
 res: Response,
 next: NextFunction
): void {
 res.setHeader('X-Content-Type-Options', 'nosniff');
 res.setHeader('X-Frame-Options', 'DENY');
 res.setHeader('X-XSS-Protection', '1; mode=block');
 res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
 res.setHeader(
 'Permissions-Policy',
 'camera=(), microphone=(), geolocation=()'
 );
 next();
}

/**
 * CORS configuration helper
 */
export function corsConfig() {
 const allowedOrigins =
 process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()) || ['http://localhost:5173'];

 return {
 origin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
 if (!origin || allowedOrigins.includes(origin)) {
 callback(null, true);
 } else {
 callback(new Error('Not allowed by CORS'));
 }
 },
 credentials: true,
 methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
 allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
 exposedHeaders: ['X-Request-ID', 'X-Response-Time'],
 maxAge: 86400,
 };
}
