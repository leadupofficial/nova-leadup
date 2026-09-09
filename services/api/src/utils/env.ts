import { z } from 'zod';

const envSchema = z.object({
 NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
 PORT: z.string().default('3001'),
 DATABASE_URL: z.string().url(),
 JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
 REDIS_URL: z.string().url().optional(),
 ANTHROPIC_API_KEY: z.string().optional(),
 ELEVENLABS_API_KEY: z.string().optional(),
 SARVAM_API_KEY: z.string().optional(),
 OPENAI_API_KEY: z.string().optional(),
 DEEPGRAM_API_KEY: z.string().optional(),
 LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
 CORS_ORIGIN: z.string().default('http://localhost:19000'),
});

export type Env = z.infer<typeof envSchema>;

let _cached: Env | undefined;

export function validateEnv(envInput?: Record<string, string | undefined>): Env {
 const target = envInput || process.env;
 _cached = envSchema.parse(target);
 return _cached;
}

/**
 * Lazy env proxy. Reads through to process.env and validates on first access.
 * Use `env.X` and the validation runs once.
 */
export const env = new Proxy({} as Env, {
 get(_target, prop: string) {
 if (!_cached) {
 _cached = envSchema.parse(process.env);
 }
 return _cached![prop as keyof Env];
 },
});
