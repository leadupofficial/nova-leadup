import { z } from 'zod';

const envSchema = z.object({
	NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
	DATABASE_URL: z.string().url(),
	JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
	JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
	JWT_ACCESS_TTL: z.string().default('15m'),
	JWT_REFRESH_TTL: z.string().default('7d'),
	API_KEY_SECRET: z.string().min(32, 'API_KEY_SECRET must be at least 32 characters'),
	AUTH_ENCRYPTION_KEY: z.string().min(44, 'AUTH_ENCRYPTION_KEY must be a base64-encoded 32-byte key'),
	REDIS_URL: z.string().url(),
	PORT: z.coerce.number(),
	CORS_ORIGIN: z.string().default('http://localhost:3000'),
	ANTHROPIC_API_KEY: z.string().optional(),
	ELEVENLABS_API_KEY: z.string().optional(),
	SARVAM_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
	try {
		return envSchema.parse(process.env);
	} catch (err) {
		if (err instanceof z.ZodError) {
			console.error('[auth] Missing or invalid required environment variables:');
			for (const issue of err.issues) {
				console.error(`  ${issue.path.join('.')}: ${issue.message}`);
			}
			console.error('[auth] Set the above variables before starting the service.');
			throw new Error('Required environment variables are not configured. Check logs for details.');
		}
		throw err;
	}
}

let cached: Env | undefined;

/**
 * Lazily validated environment.
 *
 * This used to be `export const env = loadEnv()` at module scope, which validated the
 * *entire* auth service configuration as a side effect of importing anything from
 * `@nova/auth`. Seventeen files across other services import `authenticateJwt` from
 * this package; `services/integration-service` is one of them and has no
 * `JWT_REFRESH_SECRET`, `API_KEY_SECRET` or `AUTH_ENCRYPTION_KEY`, so its process died
 * on an import before it could serve anything. Reading a property validates once, on
 * first access, so a consumer pays only for what it touches and the auth service still
 * fails fast at its own first use.
 */
export const env: Env = new Proxy({} as Env, {
	get(_target, prop) {
		if (!cached) cached = loadEnv();
		return cached[prop as keyof Env];
	},
});
