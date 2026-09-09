/**
 * @nova/database — Public API
 *
 * Re-exports schema tables, relations, drizzle-orm utilities, and connection helpers.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, PoolClient } from 'pg';
import * as schema from './schema';

export * from './schema';
export { migrate, type MigrateOptions } from './migrate';

// ─── Connection Management ──────────────────────────────────────────────────────

let pool: Pool | null = null;
let dbInstance: ReturnType<typeof drizzle> | null = null;

/**
 * Get the singleton Drizzle ORM database instance.
 */
export function getDb(): ReturnType<typeof drizzle> {
	if (!dbInstance) {
		const poolInstance = getPool();
		dbInstance = drizzle(poolInstance, { schema });
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
