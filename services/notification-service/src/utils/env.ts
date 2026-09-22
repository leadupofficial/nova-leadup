import { z } from 'zod';

const envSchema = z.object({
 NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
 DATABASE_URL: z.string().url(),
 // Required, with no fallback.
 //
 // This used to be `.default('fallback-secret-change-me')`, which was 25 characters and
 // therefore failed this very rule (min 32), so the container crash-looped at import with
 // "Invalid environment configuration" and never started. Even had it been long enough, a
 // well-known default JWT secret in production would let anyone forge tokens, so the
 // fallback is removed rather than lengthened. docker-compose.prod.yml now passes
 // JWT_SECRET explicitly.
 JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
 ANTHROPIC_API_KEY: z.string().optional(),
 REDIS_URL: z.string().url(),
 });

export type Env = z.infer<typeof envSchema>;

export function validateEnv(): Env {
 try {
 return envSchema.parse(process.env);
 } catch (err) {
 if (err instanceof z.ZodError) {
 console.error('[env] Invalid environment configuration:');
 for (const issue of err.issues) {
 console.error(` ${issue.path.join('.')}: ${issue.message}`);
 }
 throw new Error('Invalid environment configuration. Check logs for details.');
 }
 throw err;
 }
}

export const env = validateEnv();
