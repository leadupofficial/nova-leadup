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

/**
 * 5xx codes whose message is written for the user and is safe to surface.
 *
 * Keep this list as short as it is: a code belongs here only when the message
 * is authored in this repository (never an upstream body), names a condition
 * the user can understand, and would leave the client with nothing to say if it
 * were replaced by the generic text.
 */
const USER_FACING_OPERATIONAL_CODES = new Set([
	'AI_CREDIT_EXHAUSTED',
	// The provider answered with nothing — most often a reasoning model that
	// spent its whole budget thinking and was cut off. The sentences live in
	// `services/llm-wire-format.ts` and say which of the two it was, so a blank
	// reply bubble becomes something the app can actually show.
	'AI_EMPTY_REPLY',
]);

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
	// `requestId` is included because correlation is the point of the durable log: without it a stored
	// error line cannot be tied to the request that produced it, and `GET /control/traces/:id` — which
	// exists precisely to answer "what happened to this request" — would show every other record and
	// not the error. The header is read directly rather than through `req.id`, which the request-id
	// middleware types as a local extension rather than part of Express's `Request`.
	const requestId = (req.headers['x-request-id'] as string | undefined) ?? null;

	logger.error(
		{ err, method: req.method, path: req.path, statusCode, code, requestId },
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
	// the generic text — with the deliberate exception below.
	//
	// The exception exists because some 5xx are *named operational conditions*
	// rather than an anonymous crash: "NOVA's AI credit has run out" is a
	// message the user can act on, and sanitising it back to "An unexpected
	// error occurred" is what left the app with nothing useful to say. Only
	// codes listed here surface their own text, and every one of them is
	// authored in this repository rather than derived from an upstream body —
	// an unknown error still gets the generic wording.
	const isTest = process.env.NODE_ENV === 'test';
	const operational = statusCode >= 500 && USER_FACING_OPERATIONAL_CODES.has(code);
	const safeTitle = statusCode >= 500 && !operational ? 'Internal Server Error' : (err.message || 'Request failed');
	const safeDetail =
		statusCode >= 500 && !isTest && !operational
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
