import type { Request, Response, NextFunction } from 'express';

/**
 * The context `authenticateJwt` (from `@nova/auth`) attaches to the request.
 *
 * This interface used to describe a `req.admin` object produced by a local
 * `authenticateAdmin` middleware that decoded the bearer token as base64 JSON with no
 * signature check. That middleware is deleted — real tokens are verified by
 * `authenticateJwt`, which attaches `req.auth`.
 */
export interface AdminContext {
	userId: string;
	permissions: string[];
	role: string;
}

/**
 * Permission gate.
 *
 * It read `req.admin`, which nothing sets — `authenticateJwt` sets `req.auth` — so it
 * could never pass and would have 403'd every request it guarded. Nothing guarded by
 * it ever shipped, but a helper that cannot succeed is a trap for the next person.
 */
export function requirePermission(permission: string) {
	return (req: Request, _res: Response, next: NextFunction): void => {
		const ctx = (req as unknown as { auth?: AdminContext }).auth;
		if (!ctx || !ctx.permissions.includes(permission)) {
			return next(createError(403, `Missing permission: ${permission}`));
		}
		next();
	};
}

/**
 * RFC 7807 error responses.
 *
 * The service previously had no error handler mounted at all, so failures came back as
 * Express's default **HTML** page with the raw driver message in a `<pre>` — a pg error
 * leaked table and column names to the caller. An `HttpError` carries a message we chose
 * to show; anything else is an internal failure, so it is logged in full and reported
 * generically.
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
	// `@nova/auth`'s middleware forwards its own `AuthHttpError`, which carries
	// `statusCode` rather than this package's `HttpError.status`. Without handling it,
	// a role denial (a real 403) was reported as a 500 "unexpected error" — the exact
	// opposite of useful when debugging an authorization rule.
	const authStatus = (err as { statusCode?: number }).statusCode;
	const status = err instanceof HttpError ? err.status : typeof authStatus === 'number' ? authStatus : 500;
	const clientError = status < 500;

	console.error('[admin] error:', err);

	res.status(status).json({
		type: clientError
			? 'https://api.nova.leadup.in/problems/request-error'
			: 'https://api.nova.leadup.in/problems/server-error',
		title: clientError ? err.message : 'Internal Server Error',
		status,
		detail: clientError ? err.message : 'An unexpected error occurred.',
	});
}

export class HttpError extends Error {
	constructor(public status: number, message: string) {
		super(message);
		this.name = 'HttpError';
	}
}

export function createError(status: number, message: string): HttpError {
	return new HttpError(status, message);
}
