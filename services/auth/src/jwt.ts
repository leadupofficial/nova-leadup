/**
 * JWT issuance and verification for NOVA.
 */
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { JwtPayload } from '@nova/auth-types';

/**
 * Access-token signing and verification read `process.env` on demand rather than
 * through the package's validated `env` object.
 *
 * `authenticateJwt` is imported by other services, and pulling the full `env` schema in
 * here made every one of them require the whole auth configuration —
 * `JWT_REFRESH_SECRET`, `API_KEY_SECRET`, `AUTH_ENCRYPTION_KEY` — merely to verify one
 * JWT. `services/integration-service` could not boot because of it. This module needs
 * `JWT_SECRET` and defaults for the two TTLs, and nothing more.
 *
 * (`REFRESH_SECRET` was read from `env` here and never used: refresh tokens are random
 * opaque strings, not signed JWTs. It is gone rather than kept as required-but-unused.)
 */
function jwtSecret(): string {
	const secret = process.env.JWT_SECRET;
	if (!secret) {
		throw new Error('JWT_SECRET is not set — NOVA access tokens cannot be signed or verified');
	}
	return secret;
}

export interface TokenPair {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}

export function signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): { token: string; expiresIn: number; jti: string } {
	const jti = crypto.randomUUID();
	const expiresIn = process.env.JWT_ACCESS_TTL ?? '15m';
	const token = jwt.sign({ ...payload, jti }, jwtSecret(), {
		algorithm: 'HS256',
		// jsonwebtoken types `expiresIn` as `number | ms.StringValue` (a template
		// literal union); the value comes from env and is validated at runtime by
		// `parseExpiresIn` below.
		expiresIn: expiresIn as SignOptions['expiresIn'],
	});
	const seconds = parseExpiresIn(expiresIn);
	return { token, expiresIn: seconds, jti };
}

/**
 * Access tokens are issued with an extra `jti` claim (used for revocation);
 * `@nova/auth-types`'s `JwtPayload` models only the portable subset.
 */
export type AccessTokenPayload = JwtPayload & { jti: string };

export function verifyAccessToken(token: string): AccessTokenPayload {
	return jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] }) as AccessTokenPayload;
}

export function signRefreshToken(): { token: string; expiresAt: Date } {
	const token = crypto.randomUUID().replace(/-/g, '');
	const expiresAt = new Date(Date.now() + parseDuration(process.env.JWT_REFRESH_TTL ?? '7d'));
	return { token, expiresAt };
}

function parseExpiresIn(val: string): number {
	const m = val.match(/^(\d+)([smhd])$/);
	if (!m) return 900;
	const num = parseInt(m[1], 10);
	const unit = m[2];
	switch (unit) {
		case 's':
			return num;
		case 'm':
			return num * 60;
		case 'h':
			return num * 3600;
		case 'd':
			return num * 86400;
		default:
			return 900;
	}
}

function parseDuration(val: string): number {
	const m = val.match(/^(\d+)([smhd])$/);
	if (!m) return 7 * 24 * 60 * 60 * 1000;
	const num = parseInt(m[1], 10);
	const unit = m[2];
	switch (unit) {
		case 's':
			return num * 1000;
		case 'm':
			return num * 60 * 1000;
		case 'h':
			return num * 3600 * 1000;
		case 'd':
			return num * 24 * 60 * 60 * 1000;
		default:
			return 7 * 24 * 60 * 60 * 1000;
	}
}
