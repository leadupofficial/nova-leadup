/**
 * JWT issuance and verification for NOVA.
 */
import jwt from 'jsonwebtoken';
import type { JwtPayload } from '@nova/auth-types/index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const REFRESH_SECRET = process.env.JWT_REFRESH_TOKEN_SECRET || process.env.JWT_SECRET || 'change-me-in-production';
const ACCESS_TTL = '15m';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface TokenPair {
 accessToken: string;
 refreshToken: string;
 expiresIn: number;
}

export function signAccessToken(payload: Omit<JwtPayload, 'iat' | 'exp'>): { token: string; expiresIn: number } {
 const expiresIn = process.env.JWT_ACCESS_TTL ?? ACCESS_TTL;
 const token = jwt.sign(payload as JwtPayload, JWT_SECRET, {
 algorithm: 'HS256',
 expiresIn,
 });
 const seconds = parseExpiresIn(expiresIn);
 return { token, expiresIn: seconds };
}

export function verifyAccessToken(token: string): JwtPayload {
 return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
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
 case 's': return num;
 case 'm': return num * 60;
 case 'h': return num * 3600;
 case 'd': return num * 86400;
 default: return 900;
 }
}
