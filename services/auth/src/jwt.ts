/**
 * JWT issuance and verification for NOVA.
 */
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { JwtPayload } from '@nova/auth-types';
import { env } from './env.js';

const JWT_SECRET = env.JWT_SECRET;
const REFRESH_SECRET = env.JWT_REFRESH_SECRET;
const ACCESS_TTL = env.JWT_ACCESS_TTL;
const REFRESH_TTL_MS = parseDuration(env.JWT_REFRESH_TTL);

export interface TokenPair {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}

export function signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): { token: string; expiresIn: number; jti: string } {
	const jti = crypto.randomUUID();
	const expiresIn = ACCESS_TTL;
	const token = jwt.sign({ ...payload, jti }, JWT_SECRET, {
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
	return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as AccessTokenPayload;
}

export function signRefreshToken(): { token: string; expiresAt: Date } {
	const token = crypto.randomUUID().replace(/-/g, '');
	const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
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
