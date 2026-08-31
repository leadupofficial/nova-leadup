/**
 * PostgreSQL connection pool singleton.
 */
import pg from 'pg';
const { Pool } = pg;

function getPool(): Pool {
 const url = process.env.DATABASE_URL;
 if (!url) {
 throw new Error('DATABASE_URL is not set');
 }
 // Reuse a module-level pool to avoid leaking connections
 const globalForPool = globalThis as unknown as { __novaPool?: Pool };
 if (!globalForPool.__novaPool) {
 globalForPool.__novaPool = new Pool({
 connectionString: url,
 max: 20,
 idleTimeoutMillis: 30_000,
 connectionTimeoutMillis: 5_000,
 });
 }
 return globalForPool.__novaPool;
}

export async function query<T = unknown>(
 text: string,
 params?: unknown[]
 ): Promise<{ rows: T[]; rowCount: number }> {
 const pool = getPool();
 const result = await pool.query(text, params);
 return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

export async function closePool(): Promise<void> {
 const pool = getPool();
 await pool.end();
}

export { getPool };
