import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';

export interface AppError extends Error {
 statusCode?: number;
 code?: string;
 isOperational?: boolean;
}

export class HttpError extends Error implements AppError {
 statusCode: number;
 code: string;
 isOperational: boolean;

 constructor(statusCode: number, message: string, code = 'INTERNAL_ERROR') {
 super(message);
 this.statusCode = statusCode;
 this.code = code;
 this.isOperational = true;
 Error.captureStackTrace(this, this.constructor);
 }
}

export function errorHandler(err: AppError, req: Request, res: Response, next: NextFunction) {
 if (res.headersSent) return next(err);

 const statusCode = err.statusCode || 500;
 const code = err.code || 'INTERNAL_ERROR';
 const message = err.message || 'Internal server error';

 logger.error(err, `${req.method} ${req.path} -> ${statusCode}`);

 if (err instanceof ZodError) {
 return res.status(400).json({
 type: 'https://api.nova.leadup.in/problems/validation-error',
 title: 'Validation Error',
 status: 400,
 detail: 'Request validation failed',
 errors: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
 });
 }

 const response: Record<string, unknown> = {
 type: `https://api.nova.leadup.in/problems/${code.toLowerCase()}`,
 title: statusCode < 500 ? message : 'Internal Server Error',
 status: statusCode,
 detail: message,
 instance: req.path,
 };

 res.status(statusCode).json(response);
}

export { HttpError };
