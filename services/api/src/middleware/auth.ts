import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { HttpError } from '../middleware/error-handler.js';
import { tokenDenylist } from '../middleware/token-denylist.js';
import { getDbPool } from '../db/connection.js';
import { logger } from '../utils/logger.js';

function getJwtSecret(): string {
	const secret = process.env.JWT_SECRET;
	if (!secret) {
		throw new HttpError(500, 'Server misconfigured: JWT_SECRET not set', 'INTERNAL_CONFIG');
	}
	return secret;
}

export interface AuthenticatedRequest extends Request {
	user?: { id: string; email: string; role: string; jti?: string; exp?: number };
}

export interface AccessTokenUser {
	id: string;
	email: string;
	role: string;
	jti?: string;
	/**
	 * The token's `exp` claim, in Unix **seconds**.
	 *
	 * Surfaced so an admin session row can record when its token actually dies rather than
	 * guessing a lifetime: `admin_sessions.expires_at` is NOT NULL, and a fabricated value
	 * would make the console's "expires" column a fiction. It is also what an operator needs
	 * to give `tokenDenylist.revoke` the right TTL when force-logging another operator out.
	 */
	exp?: number;
}

/**
 * Verifies an access token and returns the user it belongs to.
 *
 * Extracted from [authenticate] so the realtime voice WebSocket — which has no
 * Express request to hang `req.user` on — enforces exactly the same checks:
 * signature, expiry, and the JTI denylist. Throws `HttpError(401)` (or 500 when
 * the server has no `JWT_SECRET`) rather than returning null, so a caller
 * cannot accidentally treat a failure as an authenticated identity.
 */
export function verifyAccessToken(token: string): AccessTokenUser {
	const jwtSecret = getJwtSecret();

	let payload: { sub: string; email: string; role: string; jti?: string; exp?: number };
	try {
		payload = jwt.verify(token, jwtSecret) as typeof payload;
	} catch {
		throw new HttpError(401, 'Invalid or expired token', 'UNAUTHORIZED');
	}

	if (payload.jti && tokenDenylist.isRevoked(payload.jti, payload.sub)) {
		throw new HttpError(401, 'Token has been revoked', 'UNAUTHORIZED');
	}

	return {
		id: payload.sub,
		email: payload.email,
		role: payload.role,
		jti: payload.jti,
		exp: typeof payload.exp === 'number' ? payload.exp : undefined,
	};
}

/**
 * Refuses an account that has been suspended, or that no longer exists.
 *
 * ## Why this has to run on every request
 *
 * A suspension only means "suspended now" if the account's state is consulted while its token
 * is still valid. Nothing did: `authenticate` verified the signature, the expiry and the
 * denylist, and then trusted the `sub` claim. Measured on the running system before this
 * existed — a real access token continued to return **200 from both a control-plane route and
 * a user route after `users.disabled` was set to true**. Suspension blocked new logins and
 * refresh, so the account was signed out within the 15-minute access-token lifetime, but for
 * those 15 minutes a suspended or deleted account kept full use of the API.
 *
 * That is the bound several comments in this repository claim does not exist. They were
 * describing this function, which did not do the read the comments asserted.
 *
 * ## Failure behaviour
 *
 * **Known-disabled or missing → refused, with the same 403 `ACCOUNT_DISABLED` the login and
 * refresh paths already return**, so a client handles it identically wherever it appears.
 * **A read failure fails open**, matching `resolveGrantedPermissions` in `admin/roles.ts`,
 * which documents the same choice for the same reason: a database blip must not turn into an
 * authentication outage that takes out every route at once, including the ones an operator
 * needs to diagnose the blip. The degradation is logged at error level so it is visible rather
 * than silent.
 *
 * ## Cost
 *
 * One primary-key lookup per authenticated request. Deliberately not cached: a cache would
 * reintroduce exactly the window this exists to close, and a PK read on a pooled connection is
 * the cheapest query this service makes.
 */
async function assertAccountUsable(userId: string): Promise<void> {
	try {
		// A raw pool query rather than the Drizzle client, deliberately.
		//
		// This runs before every route, so it must not consume a `getDb()` call that the route
		// itself is scripted to answer: several suites prime `vi.mocked(getDb).mockReturnValueOnce`
		// for the query their route makes, and the first `getDb()` call in the request is now this
		// one, which left those routes reading an unscripted mock. The pool is a separate accessor
		// and its query is answered once, in the shared harness, for every authenticated request.
		const pool = getDbPool();
		const { rows } = await pool.query<{ disabled: boolean }>(
			'SELECT disabled FROM users WHERE id = $1 LIMIT 1',
			[userId],
		);
		const row = rows[0];

		// No row at all means a token for an account that has been deleted. The token is
		// still cryptographically valid, which is the whole problem: nothing else in the
		// request path checks that the subject exists.
		if (!row) {
			throw new HttpError(403, 'This account no longer exists', 'ACCOUNT_DISABLED');
		}
		if (row.disabled) {
			throw new HttpError(403, 'This account has been disabled', 'ACCOUNT_DISABLED');
		}
	} catch (error) {
		// An HttpError from the checks above is a decision and must propagate.
		if (error instanceof HttpError) throw error;
		logger.error(
			{ err: error, userId },
			'Could not read the account state; allowing this request rather than failing every route',
		);
	}
}

/**
 * Verifies the bearer token and attaches `req.user`.
 *
 * **Async, and that is safe only because every failure is forwarded with `next(err)`.**
 * An earlier version of this middleware was declared `async` and used bare `throw`; Express 4
 * does not catch rejected promises from async middleware, so every unauthenticated request
 * became an unhandled rejection and **terminated the Node process** — a remote denial of
 * service reachable without credentials on every route using `authenticate`
 * (`/api/v1/auth/me`, `/health/ready`, `/settings/*`, `/admin/*`, …). The container restarted,
 * so it looked like a flaky service rather than a crash on the unauthenticated path.
 *
 * The whole body therefore sits inside one `try`/`catch` that ends in `next(error)`, and the
 * account check awaits inside it. If that discipline is ever relaxed, the process-level crash
 * comes back.
 */
export async function authenticate(
	req: AuthenticatedRequest,
	res: Response,
	next: NextFunction,
): Promise<void> {
	try {
		const authHeader = req.headers.authorization;
		if (!authHeader?.startsWith('Bearer ')) {
			throw new HttpError(401, 'Missing or invalid authorization header', 'UNAUTHORIZED');
		}

		const token = authHeader.split(' ')[1];
		if (!token) {
			throw new HttpError(401, 'Missing or invalid authorization header', 'UNAUTHORIZED');
		}

		const user = verifyAccessToken(token);
		await assertAccountUsable(user.id);

		req.user = {
			id: user.id,
			email: user.email,
			role: user.role,
			jti: user.jti,
			exp: user.exp,
		};
		next();
	} catch (error) {
		next(error);
	}
}

/**
 * Role gate. Synchronous for the same reason as [authenticate] — a bare `throw` in an
 * `async` middleware takes the process down instead of returning 403.
 */
export function requireRole(...roles: string[]) {
	return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
		try {
			if (!req.user || !roles.includes(req.user.role)) {
				throw new HttpError(403, 'Forbidden', 'FORBIDDEN');
			}
			next();
		} catch (error) {
			next(error);
		}
	};
}

/**
 * Admin gate as a ready-to-mount middleware.
 *
 * `routes/admin.ts` applies the same `owner | admin` check inline via a private
 * helper; this is the shared, exported form so other routers (and tests) can
 * mount the gate directly instead of re-deriving the role list.
 */
export const requireAdmin = requireRole('owner', 'admin');
