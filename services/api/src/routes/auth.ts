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
import { recordLoginAttempt } from '../services/auth-events.js';
import {
	FirebaseTokenError,
	verifyFirebaseIdToken,
} from '../services/firebase-tokens.js';
import { requiresSecondFactor, verifySecondFactor } from '../admin/mfa.js';
import {
	accessTokenTtlSeconds,
	generateRefreshToken,
	hashRefreshToken,
	signAccessToken,
} from '../utils/tokens.js';
// The one place the minimum password length is written down. `schemas/index.ts` owns it
// so the register route, the shared schemas and the mobile client cannot drift apart.
import { PASSWORD_MIN_LENGTH } from '../schemas/index.js';

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

/**
 * The register schema is defined here because this route needs slightly stricter email
 * handling than the shared one, but the password rule is **not** duplicated: it comes
 * from `PASSWORD_MIN_LENGTH`, the single constant in `schemas/index.ts`.
 *
 * It used to be redefined here as `min(8)` while `schemas/index.ts` said 12 and
 * `utils/validation.ts` said 8 — three definitions, two of them dead, and no way to
 * tell which one a given screen was talking to. The mobile client had been written
 * against *this* one (8), so the value users saw and the value enforced were the same
 * by luck rather than by construction. The shared constant is now the only place the
 * number appears, and the client mirrors it.
 */
const RegisterSchema = z.object({
	email: z.string().email('A valid email address is required').max(255),
	password: z
		.string()
		.min(
			PASSWORD_MIN_LENGTH,
			`Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
		)
		.max(200),
	name: z.string().max(255).optional(),
});

const LoginSchema = z.object({
	email: z.string().email('A valid email address is required').max(255),
	password: z.string().min(1, 'Password is required').max(200),
	// The second factor, when the account has one confirmed. Optional rather than conditional: an
	// account without MFA sends nothing, and an account with it gets a distinct 401 asking for this.
	// Both spellings are accepted, matching how the token fields are handled below.
	mfaCode: z.string().min(4).max(64).optional(),
	mfa_code: z.string().min(4).max(64).optional(),
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

/**
 * The extra columns Firebase phone sign-in needs.
 *
 * `phone` is uniquely indexed, so it is the key this path looks a user up by; a
 * phone-only account has `passwordHash = NULL` and no email.
 */
interface UserPhoneRow extends UserRow {
	phone: string | null;
	phoneVerified: boolean;
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
		logger.warn(
			{ err: error, fallbackRole: DEFAULT_ROLE },
			'[auth] could not resolve role bindings; defaulting to a safe role'
		);
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

/**
 * POST /auth/firebase/exchange — trade a Firebase ID token for a NOVA session.
 *
 * This is the second half of phone sign-in. The device verifies the phone number with
 * Firebase and is handed a Firebase ID token; that token proves the number to Google, not
 * to us, and it is not a NOVA session. Here we verify it (see `services/firebase-tokens.ts`)
 * and mint the access/refresh pair the rest of the API already understands.
 *
 * Two deliberate refusals:
 *
 *  * **A token that is not a phone sign-in is rejected, not downgraded.** An anonymous or
 *    social Firebase session carries no verified number, and letting one create a NOVA
 *    account here would mean the phone column records something nobody proved.
 *  * **No password is ever set.** These accounts have `password_hash = NULL`, which the
 *    login route already treats as "cannot sign in this way" and answers with the same
 *    generic error as an unknown email, so the phone path cannot be used to probe for
 *    accounts.
 */
const FirebaseExchangeSchema = z.object({
	idToken: z.string().min(20),
});

router.post('/firebase/exchange', async (req, res, next) => {
	try {
		const body = FirebaseExchangeSchema.parse(req.body);

		let identity;
		try {
			identity = await verifyFirebaseIdToken(body.idToken);
		} catch (error) {
			if (error instanceof FirebaseTokenError) {
				// A misconfigured server is our fault and deserves a 5xx; a bad token is
				// the caller's and deserves a 401.
				const status = error.code === 'FIREBASE_NOT_CONFIGURED' ? 503
					: error.code === 'FIREBASE_UNAVAILABLE' ? 503
						: 401;
				throw new HttpError(status, error.message, error.code);
			}
			throw error;
		}

		if (!identity.phoneVerified || !identity.phoneNumber) {
			throw new HttpError(
				400,
				'That sign-in did not verify a phone number',
				'FIREBASE_PHONE_REQUIRED',
			);
		}

		// E.164 as Firebase reports it, with the leading `+` kept because that is what
		// makes the value unambiguous across countries.
		const phone = identity.phoneNumber.trim().replace(/\s+/g, '');
		const db = getDb();

		let [user] = (await db
			.select()
			.from(users)
			.where(eq(users.phone, phone))
			.limit(1)) as UserPhoneRow[];

		if (!user) {
			// `users.name` is NOT NULL. Onboarding asks for the real name; until then the
			// number is the only honest label we have, and inventing "there" for a person
			// who never typed anything is worse than showing what they signed in with.
			const name = identity.email?.split('@')[0]?.trim() || phone;
			try {
				[user] = (await db
					.insert(users)
					.values({
						phone,
						name,
						phoneVerified: true,
						email: identity.email ?? null,
						emailVerified: false,
					})
					.returning()) as UserPhoneRow[];
			} catch (error) {
				// Two devices signing in with the same number at once: the pre-check loses
				// the race, the unique index does not. Re-read rather than fail.
				if (!isUniqueViolation(error)) throw error;
				[user] = (await db
					.select()
					.from(users)
					.where(eq(users.phone, phone))
					.limit(1)) as UserPhoneRow[];
			}
		}

		if (!user) {
			throw new HttpError(500, 'Failed to create account', 'INTERNAL_ERROR');
		}

		if (user.disabled) {
			await recordLoginAttempt({
				email: user.email ?? phone,
				ipAddress: req.ip ?? null,
				userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
				requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
				reason: 'account-disabled',
				userId: user.id,
			});
			throw new HttpError(403, 'This account has been disabled', 'ACCOUNT_DISABLED');
		}

		// Firebase re-verifies the number on every sign-in, so a row that was created
		// before verification (or by an operator) is brought up to date here.
		if (!user.phoneVerified) {
			await db.update(users).set({ phoneVerified: true }).where(eq(users.id, user.id));
			user = { ...user, phoneVerified: true };
		}

		await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

		const issued = await issueSession(user, req);
		logger.info({ userId: user.id, provider: identity.signInProvider }, 'User signed in with Firebase');
		res.status(200).json({ success: true, data: issued });
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

		// Where this attempt came from, recorded with every outcome so a successful sign-in can be
		// compared against the failures around it. `req.id` is set by `request-id.ts`.
		const attempt = {
			email,
			ipAddress: req.ip ?? null,
			userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
			// Taken from the header rather than `req.id`, which the request-id middleware only
			// types as a local extension (`RequestWithId`), not as part of Express's `Request`.
			requestId: (req.headers['x-request-id'] as string | undefined) ?? null,
		};

		// A missing account, a passwordless account (e.g. social-only sign-up), and a
		// wrong password must be indistinguishable — including in how long they take. The
		// *reason* is recorded for the operator and never returned to the caller.
		if (!user?.passwordHash) {
			await equalizeFailedLoginTiming(body.password);
			await recordLoginAttempt({ ...attempt, reason: 'unknown-account', userId: null });
			throw invalidCredentials();
		}

		const passwordMatches = await bcrypt.compare(body.password, user.passwordHash);
		if (!passwordMatches) {
			await recordLoginAttempt({ ...attempt, reason: 'bad-password', userId: user.id });
			throw invalidCredentials();
		}

		if (user.disabled) {
			// The credential was correct, so this row names the account: a suspended account
			// repeatedly trying to sign in is a different signal from a stranger guessing.
			await recordLoginAttempt({ ...attempt, reason: 'account-disabled', userId: user.id });
			throw new HttpError(403, 'This account has been disabled', 'ACCOUNT_DISABLED');
		}

		// Second factor, when this account has one confirmed. Enrolment is opt-in and administrator
		// only, so the mobile client is unaffected — but the check lives in the shared login route
		// rather than in the console, because a factor that only guards one client is not a factor.
		if (await requiresSecondFactor(user.id)) {
			const submitted = body.mfaCode ?? body.mfa_code;
			if (!submitted) {
				// `MFA_REQUIRED` is a distinct code so the console can prompt for the code instead of
				// showing "invalid credentials" and sending the operator to reset a working password.
				await recordLoginAttempt({ ...attempt, reason: 'mfa-required', userId: user.id });
				throw new HttpError(401, 'A verification code is required for this account', 'MFA_REQUIRED');
			}
			const factor = await verifySecondFactor(user.id, submitted);
			if (!factor.ok) {
				// The rate limiter (10 requests / 60 s per IP) is what makes a six-digit space
				// unguessable here: three codes are valid per step and the window is 90 seconds.
				await recordLoginAttempt({ ...attempt, reason: 'mfa-invalid', userId: user.id });
				throw new HttpError(401, 'That verification code is not valid', 'MFA_INVALID');
			}
		}

		await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

		const issued = await issueSession(user, req);
		await recordLoginAttempt({ ...attempt, reason: 'ok', userId: user.id });
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
