/**
 * Validation middleware wrapper
 */

import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AppError } from '../utils/errors';

export function validate(schema: z.ZodSchema, source: 'body' | 'query' | 'params' = 'body') {
 return (req: Request, _res: Response, next: NextFunction): void => {
 const data = source === 'query' ? req.query : source === 'params' ? req.params : req.body;

 const result = schema.safeParse(data);
 if (!result.success) {
 const message = result.error.errors.map((e) => e.message).join(', ');
 next(new AppError(`Validation failed: ${message}`, StatusCodes.BAD_REQUEST, false, 'VALIDATION_ERROR'));
 return;
 }

 if (source === 'body') {
 (req as any).validatedBody = result.data;
 } else if (source === 'query') {
 (req as any).validatedQuery = result.data;
 } else {
 (req as any).validatedParams = result.data;
 }

 next();
 };
}
