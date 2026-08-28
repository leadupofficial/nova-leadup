import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, generateOtp, encryptToken, decryptToken, generateApiKey, hmacSha256 } from '../crypto';

describe('hashPassword / verifyPassword', () => {
 it('hashes a password and verifies it', async () => {
 const hash = await hashPassword('secure-password-123');
 expect(hash).not.toBe('secure-password-123');
 expect(await verifyPassword('secure-password-123', hash)).toBe(true);
 expect(await verifyPassword('wrong-password', hash)).toBe(false);
 });

 it('produces different hashes for the same password (salted)', async () => {
 const h1 = await hashPassword('same-password');
 const h2 = await hashPassword('same-password');
 expect(h1).not.toBe(h2);
 expect(await verifyPassword('same-password', h1)).toBe(true);
 expect(await verifyPassword('same-password', h2)).toBe(true);
 });
});

describe('generateOtp', () => {
 it('returns a 6-digit string by default', () => {
 const otp = generateOtp(6);
 expect(otp).toMatch(/^\d{6}$/);
 });

 it('returns strings of the requested length', () => {
 expect(generateOtp(4).length).toBe(4);
 expect(generateOtp(8).length).toBe(8);
 });

 it('generates different OTPs on each call', () => {
 const set = new Set([generateOtp(6), generateOtp(6), generateOtp(6)]);
 expect(set.size).toBeGreaterThan(1);
 });
});

describe('encryptToken / decryptToken', () => {
 it('round-trips a value through AES-256-GCM', () => {
 process.env.AUTH_ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');
 const plaintext = 'super-secret-token-123';
 const encrypted = encryptToken(plaintext);
 expect(encrypted).not.toBe(plaintext);
 expect(encrypted.split('.').length).toBe(3);
 const decrypted = decryptToken(encrypted);
 expect(decrypted).toBe(plaintext);
 });

 it('throws on malformed ciphertext', () => {
 process.env.AUTH_ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');
 expect(() => decryptToken('not-a-valid-token')).toThrow();
 });
});

describe('generateApiKey', () => {
 it('returns prefix, key, and hash', () => {
 process.env.API_KEY_SECRET = 'test-secret';
 const result = generateApiKey();
 expect(result.prefix.startsWith('nova_live_')).toBe(true);
 expect(result.prefix.length).toBe(16);
 expect(result.key.startsWith('nova_live_')).toBe(true);
 expect(result.hash).toBeTruthy();
 expect(result.key.length).toBeGreaterThan(20);
 });
});

describe('hmacSha256', () => {
 it('produces a deterministic hex digest', () => {
 const a = hmacSha256('secret', 'data');
 const b = hmacSha256('secret', 'data');
 expect(a).toBe(b);
 expect(a).toMatch(/^[0-9a-f]{64}$/);
 });
});
