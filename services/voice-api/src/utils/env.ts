import { z } from 'zod';

const envSchema = z.object({
 NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
 PORT: z.coerce.number(),
 ELEVENLABS_API_KEY: z.string().optional(),
 SARVAM_API_KEY: z.string().optional(),
 CORS_ORIGIN: z.string().default('http://localhost:19000'),
 LOG_LEVEL: z.string().default('info'),
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
