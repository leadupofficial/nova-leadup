/**
 * @nova/database — Public API
 *
 * Re-exports schema tables, relations, drizzle-orm utilities, and connection helpers.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, PoolClient, types as pgTypes } from 'pg';
import * as schema from './schema.js';
import * as adminSchema from './schema-admin.js';

/**
 * Read bare `timestamp` columns as UTC, whatever the process timezone is.
 *
 * Every timestamp in this schema is `timestamp` **without** time zone, and the database runs
 * `Etc/UTC`, so the stored string is a UTC wall clock. node-postgres does not know that: its
 * default parser for OID 1114 constructs a Date in the **process** timezone. On a machine set to
 * `Asia/Kolkata` that read `2026-09-21 19:24:07` back as `13:54:07Z` — five and a half hours
 * early, which the console rendered as an already-expired admin session.
 *
 * The symmetric problem exists on the write side: node-postgres serialises a Date into the
 * process timezone, so a row written on a non-UTC host carries a literal that is offset from the
 * instant it means. That half is fixed by pinning the process to UTC (`process.env.TZ = 'UTC'` in
 * `services/api/src/server.ts`, `ENV TZ=UTC` in the Dockerfile). This override fixes the read half
 * *independently of the process timezone*, so a script or tool that forgets to pin `TZ` still
 * reports the right instant instead of silently shifting every timestamp it prints.
 *
 * It is set on the shared `pg` type registry, so it applies to every consumer of this package —
 * the API and the maintenance scripts alike — and it is deliberately global rather than
 * per-connection: a pool created before this line would otherwise escape it.
 *
 * Historical caveat: rows written by node-postgres on a non-UTC host before this change hold
 * shifted literals (the refresh `sessions` table is the one this affects). Their display moves by
 * the host offset; nothing reconstructs the original instant, and none of them carry a decision
 * that turns on the difference.
 */
pgTypes.setTypeParser(pgTypes.builtins.TIMESTAMP, (value: string) => new Date(`${value}Z`));

export * from './schema.js';
// Admin Control Center tables live in their own module to keep schema.ts readable.
export * from './schema-admin.js';

// NOTE: the legacy `migrate()` export was removed along with src/migrate.ts and
// src/migrations/. That runner applied a SQL schema that contradicted ./schema.ts
// (it created `users.display_name` / `users.is_active` / `sessions.token_hash NOT NULL`
// while the Drizzle schema uses `users.name` / `users.disabled` /
// `sessions.refresh_token_hash`). ./schema.ts plus drizzle/ (applied by
// `pnpm db:migrate`) is the single source of truth.

// ─── Connection Management ──────────────────────────────────────────────────────

let pool: Pool | null = null;
let dbInstance: ReturnType<typeof drizzle> | null = null;

/**
 * Get the singleton Drizzle ORM database instance.
 */
export function getDb(): ReturnType<typeof drizzle> {
	if (!dbInstance) {
		const poolInstance = getPool();
		dbInstance = drizzle(poolInstance, { schema: { ...schema, ...adminSchema } });
	}
	return dbInstance;
}

/**
 * Get the raw pg Pool for direct queries or transactions.
 */
export function getPool(): Pool {
	if (!pool) {
		const connectionString = process.env.DATABASE_URL;
		if (!connectionString) {
			throw new Error('DATABASE_URL is not set');
		}
		pool = new Pool({
			connectionString,
			max: 20,
			idleTimeoutMillis: 30000,
			connectionTimeoutMillis: 2000,
		});

		pool.on('error', (err) => {
			console.error('[database] Pool error:', err);
		});
	}
	return pool;
}

/**
 * Get a dedicated client for transaction-scoped work.
 * Caller is responsible for releasing via client.release().
 */
export async function getClient(): Promise<PoolClient> {
	const poolInstance = getPool();
	return poolInstance.connect();
}

/**
 * Close the pool and reset the singleton.
 */
export async function closeDb(): Promise<void> {
	if (pool) {
		await pool.end();
		pool = null;
		dbInstance = null;
		console.log('[database] Connection pool closed');
	}
}

// Re-export getDb as `db` for convenience imports like `import { db } from '@nova/database'`
export { getDb as db };
