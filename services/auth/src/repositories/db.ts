/**
 * Minimal PostgreSQL pool + query helpers scoped to @nova/auth.
 */
import pg from 'pg';
import { getPool as getApiPool } from '../../api/src/db/connection';

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
 const { rows } = await q(sql, params);
 return rows[0]?.[Object.keys(rows[0])[0]] ?? null;
}

export async function closePool(): Promise<void> {
 if (_authPool) {
 await _authPool.end();
 _authPool = null;
 }
}
