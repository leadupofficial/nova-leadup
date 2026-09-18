import { logger } from '../utils/logger.js';

export function validateEnvironment(): void {
 const required = ['DATABASE_URL', 'JWT_SECRET'];
 const optional = ['REDIS_URL', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY', 'SARVAM_API_KEY'];

 const missing: string[] = [];

 for (const key of required) {
 if (!process.env[key]) {
 missing.push(key);
 }
 }

 if (missing.length > 0) {
 throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
 }

 if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
 throw new Error('JWT_SECRET must be at least 32 characters');
 }

 if (process.env.JWT_SECRET === 'fallback-secret-change-me') {
 logger.warn('WARNING: Using fallback JWT_SECRET. Set JWT_SECRET environment variable immediately.');
 }

 const optionalMissing = optional.filter((key) => !process.env[key]);
 if (optionalMissing.length > 0) {
 logger.warn(`Optional environment variables not set: ${optionalMissing.join(', ')}`);
 }
}

export function validateDatabaseUrl(url: string | undefined): boolean {
 if (!url) return false;

 try {
 new URL(url);
 return true;
 } catch {
 return false;
 }
}

export function maskSecret(secret: string): string {
 if (!secret) return '[NOT SET]';
 const visible = Math.min(secret.length, 4);
 return `${secret.substring(0, visible)}${'*'.repeat(Math.max(0, secret.length - visible))}`;
}
