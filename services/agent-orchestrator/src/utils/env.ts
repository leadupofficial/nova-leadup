import { z } from 'zod';

const envSchema = z.object({
 NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
 ANTHROPIC_API_KEY: z.string().optional(),
 REDIS_URL: z.string().url().optional(),
 JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
 LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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
