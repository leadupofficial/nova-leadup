import { z } from 'zod';

const PORT = z.coerce.number();
const envSchema = z.object({
 NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
 DATABASE_URL: z.string().url(),
 JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
 REDIS_URL: z.string().url(),
 PORT,
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

// The `export const env = validateEnv();` that used to sit here ran the whole auth
// service configuration check as a side effect of importing the module — and the
// module is imported by `index.ts`, whose package root other services import for
// `authenticateJwt`. It was also unused: only `validateEnv` is imported anywhere.
// `index.ts` now calls it when it actually starts the server.
