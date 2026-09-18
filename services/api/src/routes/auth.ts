/**
 * NOVA API — Authentication routes.
 *
 * Replaces the previous stubs, which answered `POST /login` with
 * `{ message: 'Login endpoint', email }` and never issued a token. The mobile client
 * requires `access_token` / `refresh_token` / `expires_in`, so login and registration
 * could never succeed.
 *
 * Design notes:
 *  - Passwords are hashed with bcrypt at cost 12, matching `services/auth` so hashes
 *    are interchangeable between the two implementations.
 *  - Access tokens are short-lived HS256 JWTs with a `jti`; refresh tokens are opaque
 *    random values stored only as a SHA-256 hash (see `utils/tokens.ts`).
 *  - Refresh tokens are single-use and rotated on every refresh.
 *  - Login returns one indistinguishable error for "unknown email" and "wrong
 *    password" so the endpoint cannot be used to enumerate accounts.
 *
 * Responses use the same `{ success, data }` envelope as the rest of the API.
 */
import crypto from 'crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { and, eq, isNull } from 'drizzle-orm';
import { roleBindings, roles, sessions, users } from '@nova/database';
import { getDb } from '../db/connection.js';
import { HttpError } from '../middleware/error-handler.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { tokenDenylist } from '../middleware/token-denylist.js';
import { logger } from '../utils/logger.js';
import {
	accessTokenTtlSeconds,
	generateRefreshToken,
	hashRefreshToken,
	signAccessToken,
} from '../utils/tokens.js';

const router: ReturnType<typeof Router> = Router();

/** Cost 12 — the same work factor used by services/auth. */
const BCRYPT_ROUNDS = 12;

/**
 * Role claim used when an account holds no RBAC binding. `users` has no role column;
 * roles live in `roles` / `role_bindings` (see `resolveUserRole`).
 */
const DEFAULT_ROLE = 'user';

/**
 * Privilege order used to collapse a user's bindings into the single `role` claim an
 * access token carries. `requireAdmin` (routes/admin.ts) and the admin console accept
 * only owner/admin, so the most privileged binding must win.
 */
const ROLE_PRIORITY = ['owner', 'admin', 'manager', 'member', 'user'] as const;

const escapeHtml = (str: string): string => {
	if (typeof str !== 'string') return '';
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
};

// ─── Schemas ──────────────────────────────────────────────────────────────────

const RegisterSchema = z.object({
	email: z.string().email('A valid email address is required').max(255),
	password: z.string().min(8, 'Password must be at least 8 characters').max(200),
	name: z.string().max(255).optional(),
});

const LoginSchema = z.object({
	email: z.string().email('A valid email address is required').max(255),
	password: z.string().min(1, 'Password is required').max(200),
});

// The mobile client sends `refreshToken`; older callers of this API and the
// `services/auth` implementation use `refreshToken` too, but snake_case is accepted
// as well for consistency with the token fields in the response.
const TokenBodySchema = z.object({
	refreshToken: z.string().min(1).optional(),
	refresh_token: z.string().min(1).optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function refreshTokenFrom(body: unknown): string | undefined {
	if (!body || typeof body !== 'object') return undefined;
	const record = body as Record<string, unknown>;
	const value = record.refreshToken ?? record.refresh_token;
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function clientIp(req: Request): string | null {
	const forwarded = req.headers['x-forwarded-for'];
	const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
	const ip = (first ?? req.ip ?? req.socket?.remoteAddress ?? '').trim();
	return ip ? ip.slice(0, 45) : null;
}

function isUniqueViolation(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

interface UserRow {
	id: string;
	email: string | null;
	name: string | null;
	emailVerified: boolean;
	createdAt: Date;
}

/** The extra columns the login/refresh paths need. */
interface UserCredentialsRow extends UserRow {
	passwordHash: string | null;
	disabled: boolean;
}

interface PublicUser {
	id: string;
	email: string;
	name: string;
	email_verified: boolean;
	created_at: Date;
}

function toPublicUser(user: UserRow): PublicUser {
	return {
		id: user.id,
		email: escapeHtml(user.email ?? ''),
		name: escapeHtml(user.name ?? ''),
		email_verified: user.emailVerified,
		created_at: user.createdAt,
	};
}

interface IssuedSession {
	access_token: string;
	refresh_token: string;
	token_type: 'Bearer';
	expires_in: number;
	user: PublicUser;
}

/**
 * Resolves the caller's role from `role_bindings` → `roles`.
 *
 * A self-registered account has no bindings and therefore keeps `DEFAULT_ROLE`. The
 * lookup is intentionally fail-open to `user`: an RBAC problem must not make sign-in
 * impossible, and `user` grants no admin access.
 */
async function resolveUserRole(userId: string): Promise<string> {
	try {
		const rows = await getDb()
			.select({ slug: roles.slug })
			.from(roleBindings)
			.innerJoin(roles, eq(roles.id, roleBindings.roleId))
			.where(eq(roleBindings.userId, userId));

		if (rows.length === 0) return DEFAULT_ROLE;

		const slugs = rows.map((row) => row.slug);
		const preferred = ROLE_PRIORITY.find((candidate) => slugs.includes(candidate));
		// Unknown-but-bound role: surface it rather than silently downgrading to `user`.
		return preferred ?? slugs[0] ?? DEFAULT_ROLE;
	} catch (error) {
		logger.warn('[auth] could not resolve role bindings; defaulting to', DEFAULT_ROLE, error);
		return DEFAULT_ROLE;
	}
}

async function issueSession(user: UserRow, req: Request): Promise<IssuedSession> {
	// Resolved on every issuance, so a role change takes effect on the next refresh
	// rather than being frozen into the account.
	const role = await resolveUserRole(user.id);
	const access = signAccessToken({
		sub: user.id,
		email: user.email ?? '',
		role,
	});
	const refresh = generateRefreshToken();

	await getDb().insert(sessions).values({
		userId: user.id,
		refreshTokenHash: refresh.hash,
		ipAddress: clientIp(req),
		userAgent: (req.headers['user-agent'] ?? '').slice(0, 1000) || null,
		expiresAt: refresh.expiresAt,
	});

	return {
		access_token: access.token,
		refresh_token: refresh.token,
		token_type: 'Bearer',
		expires_in: access.expiresIn,
		user: toPublicUser(user),
	};
}

/**
 * Burns roughly the same CPU as a real `bcrypt.compare` when the account does not
 * exist, so response timing does not reveal which emails are registered.
 */
let dummyPasswordHash: string | null = null;

async function equalizeFailedLoginTiming(password: string): Promise<void> {
	dummyPasswordHash ??= await bcrypt.hash(crypto.randomUUID(), BCRYPT_ROUNDS);
	await bcrypt.compare(password, dummyPasswordHash);
}

function invalidCredentials(): HttpError {
	return new HttpError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
}

function invalidRefreshToken(): HttpError {
	return new HttpError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post('/register', async (req, res, next) => {
	try {
		const body = RegisterSchema.parse(req.body);
		const email = normalizeEmail(body.email);
		const db = getDb();

		const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
		if (existing) {
			throw new HttpError(409, 'An account with this email already exists', 'EMAIL_IN_USE');
		}

		const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
		// `users.name` is NOT NULL, so fall back to the local part of the email.
		const name = body.name?.trim() || email.split('@')[0] || 'there';

		let created: UserRow | undefined;
		try {
			[created] = (await db
				.insert(users)
				.values({ email, passwordHash, name })
				.returning()) as UserRow[];
		} catch (error) {
			// The pre-check above loses a race between two concurrent registrations;
			// the unique index is the real guard.
			if (isUniqueViolation(error)) {
				throw new HttpError(409, 'An account with this email already exists', 'EMAIL_IN_USE');
			}
			throw error;
		}

		if (!created) {
			throw new HttpError(500, 'Failed to create account', 'INTERNAL_ERROR');
		}

		const issued = await issueSession(created, req);
		logger.info({ userId: created.id }, 'User registered');
		res.status(201).json({ success: true, data: issued });
	} catch (error) {
		next(error);
	}
});

router.post('/login', async (req, res, next) => {
	try {
		const body = LoginSchema.parse(req.body);
		const email = normalizeEmail(body.email);
		const db = getDb();

		const [user] = (await db
			.select()
			.from(users)
			.where(eq(users.email, email))
			.limit(1)) as UserCredentialsRow[];

		// A missing account, a passwordless account (e.g. social-only sign-up), and a
		// wrong password must be indistinguishable — including in how long they take.
		if (!user?.passwordHash) {
			await equalizeFailedLoginTiming(body.password);
			throw invalidCredentials();
		}

		const passwordMatches = await bcrypt.compare(body.password, user.passwordHash);
		if (!passwordMatches) {
			throw invalidCredentials();
		}

		if (user.disabled) {
			throw new HttpError(403, 'This account has been disabled', 'ACCOUNT_DISABLED');
		}

		await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

		const issued = await issueSession(user, req);
		logger.info({ userId: user.id }, 'User logged in');
		res.status(200).json({ success: true, data: issued });
	} catch (error) {
		next(error);
	}
});

router.post('/refresh', async (req, res, next) => {
	try {
		const parsed = TokenBodySchema.safeParse(req.body ?? {});
		const provided = parsed.success
			? (parsed.data.refreshToken ?? parsed.data.refresh_token)
			: undefined;
		if (!provided) {
			throw new HttpError(400, 'refreshToken is required', 'VALIDATION_ERROR');
		}

		const db = getDb();
		const [session] = await db
			.select()
			.from(sessions)
			.where(
				and(
					eq(sessions.refreshTokenHash, hashRefreshToken(provided)),
					isNull(sessions.revokedAt),
				),
			)
			.limit(1);

		if (!session) throw invalidRefreshToken();

		if (session.expiresAt.getTime() <= Date.now()) {
			await db
				.update(sessions)
				.set({ revokedAt: new Date() })
				.where(eq(sessions.id, session.id));
			throw invalidRefreshToken();
		}

		const [user] = (await db
			.select()
			.from(users)
			.where(eq(users.id, session.userId))
			.limit(1)) as UserCredentialsRow[];

		if (!user) throw invalidRefreshToken();
		if (user.disabled) {
			throw new HttpError(403, 'This account has been disabled', 'ACCOUNT_DISABLED');
		}

		// Rotate: the presented refresh token is single-use, so replaying a rotated
		// token fails closed rather than minting a second long-lived session.
		await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, session.id));

		const issued = await issueSession(user, req);
		res.status(200).json({ success: true, data: issued });
	} catch (error) {
		next(error);
	}
});

router.post('/logout', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const db = getDb();
		const provided = refreshTokenFrom(req.body);
		const userId = req.user?.id;

		if (provided) {
			await db
				.update(sessions)
				.set({ revokedAt: new Date() })
				.where(
					and(
						eq(sessions.refreshTokenHash, hashRefreshToken(provided)),
						isNull(sessions.revokedAt),
					),
				);
		} else if (userId) {
			// No refresh token supplied, so the specific device cannot be identified:
			// treat it as "sign out everywhere" rather than silently doing nothing.
			await db
				.update(sessions)
				.set({ revokedAt: new Date() })
				.where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
		}

		// Revoke the presented access token now instead of waiting for it to expire.
		// The denylist entry auto-expires; using the full TTL is a safe over-estimate.
		if (userId && req.user?.jti) {
			tokenDenylist.revoke(
				req.user.jti,
				userId,
				Date.now() + accessTokenTtlSeconds() * 1000,
			);
		}

		res.status(204).send();
	} catch (error) {
		next(error);
	}
});

router.get('/me', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		if (!req.user?.id) {
			throw new HttpError(401, 'Unauthorized', 'UNAUTHORIZED');
		}

		// Read the current row rather than echoing the token claims, so the client gets
		// up-to-date profile data.
		const [user] = (await getDb()
			.select()
			.from(users)
			.where(eq(users.id, req.user.id))
			.limit(1)) as UserRow[];

		if (!user) {
			throw new HttpError(404, 'User not found', 'NOT_FOUND');
		}

		res.status(200).json({ success: true, data: { user: toPublicUser(user) } });
	} catch (error) {
		next(error);
	}
});

export { router as authRoutes };
