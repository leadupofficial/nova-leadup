/**
 * Server-side / build-time env validation.
 * Safe to import from anywhere in the admin app — uses zod for runtime checks.
 *
 * NEXT_PUBLIC_* values are inlined by Next at build time, so they're safe
 * to read on both server and client. ADMIN_API_KEY is server-only.
 */
import { z } from 'zod';

const PublicEnvSchema = z.object({
 NEXT_PUBLIC_API_BASE: z
 .string()
 .url('NEXT_PUBLIC_API_BASE must be a valid URL')
 .default('http://91.107.202.66:3001'),
});

const ServerEnvSchema = PublicEnvSchema.extend({
 ADMIN_API_KEY: z.string().min(1, 'ADMIN_API_KEY is required on the server'),
});

export type PublicEnv = z.infer<typeof PublicEnvSchema>;
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cachedPublic: PublicEnv | null = null;

/** Returns validated public env vars (safe on server and client). */
export function getPublicEnv(): PublicEnv {
 if (cachedPublic) return cachedPublic;
 const parsed = PublicEnvSchema.safeParse({
 NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE,
 });
 if (!parsed.success) {
 // eslint-disable-next-line no-console
 console.error('[admin] Invalid public env:', parsed.error.flatten().fieldErrors);
 return { NEXT_PUBLIC_API_BASE: 'http://91.107.202.66:3001' };
 }
 cachedPublic = parsed.data;
 return cachedPublic;
}

/**
 * Returns validated server-only env vars. Throws if required vars are missing.
 * Only call from server contexts (Route Handlers, Server Components, server actions).
 */
export function getServerEnv(): ServerEnv {
 const parsed = ServerEnvSchema.safeParse({
 NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE,
 ADMIN_API_KEY: process.env.ADMIN_API_KEY,
 });
 if (!parsed.success) {
 const flat = parsed.error.flatten().fieldErrors;
 throw new Error(
 `[admin] Invalid server env: ${Object.entries(flat)
 .map(([k, v]) => `${k}: ${(v ?? []).join(', ')}`)
 .join('; ')}`,
 );
 }
 return parsed.data;
}
