import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger.js';

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
	const isProd = process.env.NODE_ENV === 'production';

	// Log the full error server-side with stack trace for debugging
	logger.error(
		{ err, method: req.method, path: req.path, statusCode, code },
		`${req.method} ${req.path} -> ${statusCode}`
	);

	// For validation errors, return structured details
	if (err instanceof ZodError) {
		return res.status(400).json({
			type: 'https://api.nova.leadup.in/problems/validation-error',
			title: 'Validation Error',
			status: 400,
			detail: 'Request validation failed',
			errors: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
		});
	}

	// Always return generic messages to clients — never leak
	// including stack traces, DB schemas, file paths, or service topology.
	const safeTitle = statusCode >= 500 ? 'Internal Server Error' : (err.message || 'Request failed');
	const safeDetail = statusCode >= 500 ? 'An unexpected error occurred' : (err.message || 'Request failed');

	const response: Record<string, unknown> = {
		type: `https://api.nova.leadup.in/problems/${code.toLowerCase()}`,
		title: safeTitle,
		status: statusCode,
		detail: safeDetail,
		instance: req.path,
	};

	res.status(statusCode).json(response);
}
