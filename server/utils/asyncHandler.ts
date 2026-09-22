/**
 * Async handler wrapper to eliminate try/catch blocks in route handlers
 */

import type { Request, Response, NextFunction } from 'express';

export function asyncHandler(
 fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
 return (req: Request, res: Response, next: NextFunction): void => {
 Promise.resolve(fn(req, res, next)).catch(next);
 };
}
