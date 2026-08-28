/**
 * Cryptographic primitives for @nova/auth.
 * Wraps bcrypt, AES-256-GCM, HMAC-SHA256, and OTP generation.
 */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
 return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
 return bcrypt.compare(plain, hash);
}

export function generateOtp(length = 6): string {
 const min = 10 ** (length - 1);
 const max = 10 ** length - 1;
 const num = crypto.randomInt(min, max + 1);
 return String(num);
}

export function encryptToken(plaintext: string): string {
 const key = getEncryptionKey();
 const iv = crypto.randomBytes(12);
 const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
 const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
 const tag = cipher.getAuthTag();
 return `${iv.toString('base64')}.${encrypted.toString('base64')}.${tag.toString('base64')}`;
}

export function decryptToken(packageStr: string): string {
 const key = getEncryptionKey();
 const [ivB64, dataB64, tagB64] = packageStr.split('.');
 if (!ivB64 || !dataB64 || !tagB64) {
 throw new Error('Malformed token');
 }
 const iv = Buffer.from(ivB64, 'base64');
 const encrypted = Buffer.from(dataB64, 'base64');
 const tag = Buffer.from(tagB64, 'base64');
 const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
 decipher.setAuthTag(tag);
 return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function generateApiKey(): { prefix: string; key: string; hash: string } {
 const secret = crypto.randomBytes(32).toString('base64url');
 const prefix = `nova_live_${secret.slice(0, 6)}`;
 const key = `${prefix}_${secret}`;
 const hash = crypto.createHmac('sha256', process.env.API_KEY_SECRET || 'default').update(key).digest('hex');
 return { prefix, key, hash };
}

export function hmacSha256(secret: string, data: string): string {
 return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function getEncryptionKey(): Buffer {
 const raw = process.env.AUTH_ENCRYPTION_KEY;
 if (!raw) throw new Error('AUTH_ENCRYPTION_KEY is not set');
 const decoded = Buffer.from(raw, 'base64');
 if (decoded.length !== 32) throw new Error('AUTH_ENCRYPTION_KEY must be 32 bytes');
 return decoded;
}
