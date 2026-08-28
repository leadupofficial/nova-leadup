/**
 * Structured logger using pino.
 */
import pino from 'pino';
import type { Request, Response, NextFunction } from 'express';

export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export function createLogger() {
 return (req: Request, _res: Response, next: NextFunction): void => {
 const child = logger.child({ requestId: (req as unknown as { requestId?: string }).requestId });
 (req as unknown as { logger: typeof logger }).logger = child;
 child.info({ method: req.method, path: req.path }, 'request');
 next();
 };
}
