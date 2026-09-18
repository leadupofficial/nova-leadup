/**
 * Token issuance for the NOVA API.
 *
 * Two different token types, deliberately:
 *
 *  - **Access token**: a short-lived HS256 JWT carrying `{ sub, email, role, jti }`.
 *    The `jti` is what makes logout revocation possible — `authenticate()` checks it
 *    against the in-process denylist.
 *
 *  - **Refresh token**: an opaque 256-bit random string. Only its SHA-256 hash is
 *    stored (`sessions.refresh_token_hash`), so a database leak does not hand an
 *    attacker usable refresh tokens. It is intentionally *not* a JWT: it carries no
 *    claims and therefore cannot be forged or used without the matching row.
 *
 * This mirrors the conventions already used by `services/auth` (bcrypt cost 12, HS256
 * access tokens with a `jti`, opaque hashed refresh tokens) so the two implementations
 * agree on token semantics.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { HttpError } from '../middleware/error-handler.js';

export interface AccessTokenClaims {
	sub: string;
	email: string;
	role: string;
}

export interface SignedAccessToken {
	token: string;
	/** Lifetime in seconds — this is what the client receives as `expires_in`. */
	expiresIn: number;
	jti: string;
	/** Absolute expiry as epoch milliseconds, for the denylist. */
	expiresAt: number;
}

/**
 * Reads the access-token secret the same way `middleware/auth.ts` does, so signing and
 * verification can never disagree about which secret is in play.
 */
function accessSecret(): string {
	const secret = process.env.JWT_SECRET || config.jwt.secret;
	if (!secret) {
		throw new HttpError(500, 'Server misconfigured: JWT_SECRET not set', 'INTERNAL_CONFIG');
	}
	return secret;
}

const DURATION_PATTERN = /^(\d+)\s*([smhd])?$/;

/**
 * Parses a duration such as `15m`, `24h`, `30d` or a bare number of seconds.
 * Returns a fallback when the value is unparseable rather than throwing, so a typo in
 * an env var cannot take authentication down entirely.
 */
export function parseDurationSeconds(value: string | undefined, fallbackSeconds: number): number {
	if (!value) return fallbackSeconds;
	const match = DURATION_PATTERN.exec(value.trim());
	if (!match) return fallbackSeconds;

	const amount = Number.parseInt(match[1], 10);
	switch (match[2]) {
		case 'm':
			return amount * 60;
		case 'h':
			return amount * 3600;
		case 'd':
			return amount * 86400;
		case 's':
		case undefined:
		default:
			return amount;
	}
}

const DEFAULT_ACCESS_TTL_SECONDS = 24 * 3600;
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 86400;

export function accessTokenTtlSeconds(): number {
	return parseDurationSeconds(config.jwt.expiresIn, DEFAULT_ACCESS_TTL_SECONDS);
}

export function refreshTokenTtlSeconds(): number {
	// The monorepo has used three spellings for this; services/api/.env uses
	// JWT_REFRESH_EXPIRY (7d). Falling back to 30d when none is set.
	return parseDurationSeconds(
		process.env.JWT_REFRESH_TTL ??
			process.env.JWT_REFRESH_EXPIRY ??
			process.env.JWT_REFRESH_EXPIRES_IN,
		DEFAULT_REFRESH_TTL_SECONDS,
	);
}

export function signAccessToken(claims: AccessTokenClaims): SignedAccessToken {
	const jti = crypto.randomUUID();
	const expiresIn = accessTokenTtlSeconds();
	const token = jwt.sign({ ...claims, jti }, accessSecret(), {
		algorithm: 'HS256',
		expiresIn,
	});

	return { token, expiresIn, jti, expiresAt: Date.now() + expiresIn * 1000 };
}

/** SHA-256 of a refresh token — the only form ever persisted. */
export function hashRefreshToken(token: string): string {
	return crypto.createHash('sha256').update(token).digest('hex');
}

export interface GeneratedRefreshToken {
	token: string;
	hash: string;
	expiresAt: Date;
}

export function generateRefreshToken(): GeneratedRefreshToken {
	// 256 bits of entropy, URL-safe so it survives JSON round-trips untouched.
	const token = crypto.randomBytes(32).toString('base64url');
	const ttlSeconds = refreshTokenTtlSeconds();
	return {
		token,
		hash: hashRefreshToken(token),
		expiresAt: new Date(Date.now() + ttlSeconds * 1000),
	};
}
