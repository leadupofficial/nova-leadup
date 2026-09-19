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

	// `body-parser` marks an over-limit request with `type: 'entity.too.large'`
	// and a 413 status but no error code, so the raw-audio upload route would
	// otherwise report it as an unlabelled 413/500. Labelling it here keeps the
	// client's error handling to a single branch.
	if ((err as { type?: string }).type === 'entity.too.large') {
		err.statusCode = 413;
		err.code = 'PAYLOAD_TOO_LARGE';
		err.message = 'The uploaded file is too large.';
	}

	const statusCode = err.statusCode || 500;
	const code = err.code || 'INTERNAL_ERROR';

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
			instance: req.path,
			// Legacy machine-readable aliases. The mobile client reads
			// `['detail','title','message','error']` in that order, so adding
			// these changes no existing consumer's behaviour.
			error: 'VALIDATION_ERROR',
			code: 'VALIDATION_ERROR',
			errors: err.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
		});
	}

	// Always return generic messages to clients in production — never leak
	// including stack traces, DB schemas, file paths, or service topology.
	// Under NODE_ENV=test the raw message is surfaced in `detail` (the RFC 7807
	// developer-facing field) while `title` stays generic, so a failing 5xx is
	// debuggable from the suite. Production and every deployed environment keep
	// the generic text; this is not a `NODE_ENV !== 'production'` escape hatch.
	const isTest = process.env.NODE_ENV === 'test';
	const safeTitle = statusCode >= 500 ? 'Internal Server Error' : (err.message || 'Request failed');
	const safeDetail = statusCode >= 500 && !isTest
		? 'An unexpected error occurred'
		: (err.message || 'Request failed');

	const response: Record<string, unknown> = {
		type: `https://api.nova.leadup.in/problems/${code.toLowerCase()}`,
		title: safeTitle,
		status: statusCode,
		detail: safeDetail,
		instance: req.path,
		// Legacy machine-readable aliases kept for clients that read `error` or
		// `code` instead of the RFC 7807 `type`/`title` pair.
		error: code,
		code,
	};

	res.status(statusCode).json(response);
}
