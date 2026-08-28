import type { Pool } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
 if (!pool) {
 pool = new (require('pg').Pool)({
 connectionString: process.env.DATABASE_URL,
 max: 10,
 idleTimeoutMillis: 30_000,
 connectionTimeoutMillis: 5_000,
 });
 }
 return pool;
}

export async function q<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
 const start = Date.now();
 const pool = getPool();
 const result = await pool.query(sql, params);
 return { rows: result.rows, rowCount: result.rowCount ?? 0 };
}

export async function qOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
 const { rows } = await q<T>(sql, params);
 return rows[0] ?? null;
}

export async function closePool(): Promise<void> {
 if (pool) {
 await pool.end();
 pool = null;
 }
}
