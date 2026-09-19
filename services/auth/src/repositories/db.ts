/**
 * Minimal PostgreSQL pool + query helpers scoped to @nova/auth.
 */
import pg from 'pg';

const { Pool } = pg;

let _authPool: pg.Pool | null = null;

function getPool(): pg.Pool {
 if (!_authPool) {
 const url = process.env.DATABASE_URL;
 if (!url) throw new Error('DATABASE_URL is not set');
 _authPool = new Pool({ connectionString: url, max: 10 });
 }
 return _authPool;
}

export async function q<T = unknown>(
 sql: string,
 params?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
 const pool = getPool();
 const r = await pool.query(sql, params);
 return { rows: r.rows, rowCount: r.rowCount ?? 0 };
}

export async function qOne<T = unknown>(
 sql: string,
 params?: unknown[]
): Promise<T | null> {
 const { rows } = await q<T>(sql, params);
 return rows[0] ?? null;
}

export async function qVal(sql: string, params?: unknown[]): Promise<unknown> {
 const { rows } = await q<Record<string, unknown>>(sql, params);
 const first = rows[0];
 if (!first) return null;
 return first[Object.keys(first)[0]] ?? null;
}

export async function closePool(): Promise<void> {
 if (_authPool) {
 await _authPool.end();
 _authPool = null;
 }
}
