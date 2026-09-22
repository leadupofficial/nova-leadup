// NOVA env validation — DO NOT AUTO-REPLACE THIS FILE
import { z } from 'zod';

const envSchema = z.object({
 NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
 PORT: z.string().default('3007'),
 DATABASE_URL: z.string().url(),
 JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters').default('fallback-secret-change-me'),
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
