/**
 * Server-side / build-time env validation.
 * Safe to import from anywhere in the admin app — uses zod for runtime checks.
 *
 * NEXT_PUBLIC_* values are inlined by Next at build time, so they're safe
 * to read on both server and client. ADMIN_API_KEY is server-only.
 */
import { z } from 'zod';

/**
 * The default must carry the same `/api/v1` prefix the real value does.
 *
 * `.env.example` documents `NEXT_PUBLIC_API_BASE=https://nova.leadup.in/api/v1`, and
 * everything that consumes it — `lib/api.ts`'s `buildUrl()`, this app's pages — appends
 * only a resource path (`/admin/users`, `/auth/login`). A default without the prefix
 * makes every console request 404.
 *
 * It is **localhost**, not a production host. The previous default was a hard-coded
 * `http://91.107.202.66:3001/api/v1` — a specific deployment's address baked into the
 * source. That failed in two directions: a local `next start` with no `.env.local` sent
 * every server-side fetch to an unreachable host and the whole console rendered
 * "Could not reach the admin API", and any other deployment that forgot the variable
 * would silently target someone else's server. A local default fails loudly and
 * harmlessly instead, which is the right direction for a missing configuration value.
 *
 * Production sets this explicitly (see `apps/admin/Dockerfile`, which takes it as a
 * build argument), so the default is only ever used by a developer running locally.
 */
const DEFAULT_API_BASE = 'http://127.0.0.1:3001/api/v1';

const PublicEnvSchema = z.object({
 NEXT_PUBLIC_API_BASE: z
 .string()
 .url('NEXT_PUBLIC_API_BASE must be a valid URL')
 .default(DEFAULT_API_BASE),
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
 return { NEXT_PUBLIC_API_BASE: DEFAULT_API_BASE };
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
