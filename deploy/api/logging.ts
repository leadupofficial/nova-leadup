/**
 * deploy/api/logging.ts — NOVA-Leadup structured JSON logging middleware
 *
 * Usage (Express):
 * import { requestLogger, errorLogger } from './logging';
 * app.use(requestLogger);
 * app.use(errorLogger);
 *
 * Output format (per line, NDJSON):
 * {
 * "timestamp": "2026-09-11T14:32:01.420Z",
 * "level": "info",
 * "requestId": "a3f9c2e1-7b4d-4f8a-9c1e-2b6d5f4a3c2e",
 * "method": "POST",
 * "path": "/api/v1/auth/login",
 * "statusCode": 201,
 * "durationMs": 47,
 * "message": "request completed",
 * "userId": null,
 * "ip": "127.0.0.1"
 * }
 */

import { v4 as uuidv4 } from 'uuid';
import type { Request, Response, NextFunction } from 'express';

// ── Types ────────────────────────────────────────────────────────────────────

export interface LogContext {
 timestamp: string;
 level: 'info' | 'warn' | 'error';
 requestId: string;
 method?: string;
 path?: string;
 statusCode?: number;
 durationMs?: number;
 message: string;
 userId?: string | null;
 ip?: string;
 userAgent?: string;
 error?: { name: string; message: string; stack?: string };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let logCounter = 0;

export function getRequestId(req: Request): string {
 const header = req.headers['x-request-id'];
 if (typeof header === 'string' && header.length > 0) return header;
 if (Array.isArray(header) && header[0]) return header[0];
 const id = req.id ?? uuidv4();
 req.id = id;
 return id;
}

export function buildLogEntry(ctx: LogContext): string {
 const entry: Record<string, unknown> = {
 timestamp: ctx.timestamp,
 level: ctx.level,
 requestId: ctx.requestId,
 message: ctx.message,
 };
 if (ctx.method) entry.method = ctx.method;
 if (ctx.path) entry.path = ctx.path;
 if (ctx.statusCode !== undefined) entry.statusCode = ctx.statusCode;
 if (ctx.durationMs !== undefined) entry.durationMs = ctx.durationMs;
 if (ctx.userId !== undefined) entry.userId = ctx.userId;
 if (ctx.ip) entry.ip = ctx.ip;
 if (ctx.userAgent) entry.userAgent = ctx.userAgent;
 if (ctx.error) entry.error = ctx.error;
 return JSON.stringify(entry);
}

export function writeLog(entry: string): void {
 // In production replace with winston/pino. Here we use console for NDJSON.
 // Docker captures stdout as JSON log lines.
 process.stdout.write(entry + '\n');
}

// ── Middleware ───────────────────────────────────────────────────────────────

/**
 * requestLogger — attaches a unique requestId to every inbound request,
 * logs method/path on entry, and logs status/duration on response finish.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
 const requestId = getRequestId(req);
 req.id = requestId;

 const start = Date.now();
 const ctx: LogContext = {
 timestamp: new Date().toISOString(),
 level: 'info',
 requestId,
 method: req.method,
 path: req.path,
 userId: (req as Record<string, unknown>).user
 ? String((req as Record<string, unknown>).user.id ?? null)
 : null,
 ip: req.ip ?? req.socket.remoteAddress ?? undefined,
 userAgent: req.get('user-agent') ?? undefined,
 message: 'request started',
 };

 res.on('finish', () => {
 const durationMs = Date.now() - start;
 const level: LogContext['level'] = res.statusCode >= 500 ? 'error'
 : res.statusCode >= 400 ? 'warn'
 : 'info';

 writeLog(buildLogEntry({
 ...ctx,
 level,
 statusCode: res.statusCode,
 durationMs,
 message: 'request completed',
 }));
 });

 next();
}

/**
 * errorLogger — logs unhandled errors as structured JSON with stack trace.
 */
export function errorLogger(
 err: Error,
 req: Request,
 _res: Response,
 next: NextFunction,
): void {
 if (!err) return next();

 writeLog(buildLogEntry({
 timestamp: new Date().toISOString(),
 level: 'error',
 requestId: getRequestId(req),
 method: req.method,
 path: req.path,
 userId: (req as Record<string, unknown>).user
 ? String((req as Record<string, unknown>).user.id ?? null)
 : null,
 message: err.message,
 error: {
 name: err.name,
 message: err.message,
 stack: err.stack,
 },
 }));

 next(err);
}
