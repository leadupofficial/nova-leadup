import jwt from 'jsonwebtoken';
import crypto from 'crypto';

export interface TokenPayload {
 userId: string;
 email: string;
 role: 'user' | 'admin' | 'super_admin';
 organizationId?: string;
}

export class SecurityUtils {
 static generateSecureToken(length = 32): string {
 return crypto.randomBytes(length).toString('hex');
 }

 static hashToken(token: string): string {
 return crypto.createHash('sha256').update(token).digest('hex');
 }

 static generateJWT(payload: TokenPayload, secret: string, expiresIn = '1h'): string {
 // HS256 is pinned on both sides. Leaving `algorithm` unset on sign lets the library
 // pick a default, and leaving it unset on verify accepts whatever the token claims —
 // the algorithm-confusion class. (This helper currently has no callers; it is pinned
 // so that plugging it in later cannot reintroduce that.)
 return jwt.sign(payload as object, secret, { algorithm: 'HS256', expiresIn } as jwt.SignOptions);
 }

 static verifyJWT<T = TokenPayload>(token: string, secret: string): T {
 return jwt.verify(token, secret, { algorithms: ['HS256'] }) as T;
 }

 static generateAPIKey(): { key: string; hashed: string } {
 const key = 'np_live_' + SecurityUtils.generateSecureToken(24);
 const hashed = SecurityUtils.hashToken(key);
 return { key, hashed };
 }

 static constantTimeCompare(a: string, b: string): boolean {
 const bufA = Buffer.from(a, 'utf8');
 const bufB = Buffer.from(b, 'utf8');
 return crypto.timingSafeEqual(bufA, bufB);
 }
}

export const PasswordPolicy = {
 minLength: 8,
 requireUppercase: true,
 requireLowercase: true,
 requireNumbers: true,
 requireSpecialChars: true,
 maxAgeDays: 90,
 historyCount: 5,
};

export function validatePassword(password: string): { valid: boolean; errors: string[] } {
 const errors: string[] = [];
 if (password.length < PasswordPolicy.minLength) {
 errors.push(`Password must be at least ${PasswordPolicy.minLength} characters`);
 }
 if (PasswordPolicy.requireUppercase && !/[A-Z]/.test(password)) {
 errors.push('Password must contain at least one uppercase letter');
 }
 if (PasswordPolicy.requireLowercase && !/[a-z]/.test(password)) {
 errors.push('Password must contain at least one lowercase letter');
 }
 if (PasswordPolicy.requireNumbers && !/[0-9]/.test(password)) {
 errors.push('Password must contain at least one number');
 }
 if (PasswordPolicy.requireSpecialChars && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
 errors.push('Password must contain at least one special character');
 }
 return { valid: errors.length === 0, errors };
}
