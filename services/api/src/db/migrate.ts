/**
 * Simple migration runner for NOVA.
 *
 * Tracks applied migrations in the `schema_migrations` table.
 * Each file in src/db/migrations/ named 001-*.sql, 002-*.sql … is run once in order.
 *
 * Usage:
 * npx tsx src/db/migrate.ts (or npm run db:migrate)
 */
import { getPool, query, closePool } from './connection';

const MIGRATIONS_DIR = new URL('.', import.meta.url).pathname;

interface MigrationRow {
 version: string;
 applied_at: string;
}

async function ensureMigrationsTable(pool: ReturnType<typeof getPool>): Promise<void> {
 await pool.query(`
 CREATE TABLE IF NOT EXISTS schema_migrations (
 version VARCHAR(20) PRIMARY KEY,
 applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
 )
 `);
}

async function getAppliedVersions(pool: ReturnType<typeof getPool>): Promise<Set<string>> {
 const { rows } = await pool.query<MigrationRow>(
 'SELECT version FROM schema_migrations ORDER BY version'
 );
 return new Set(rows.map((r) => r.version));
}

async function runMigrations(): Promise<void> {
 const { readdir, readFile } = await import('fs/promises');
 const pool = getPool();

 try {
 await ensureMigrationsTable(pool);
 const applied = await getAppliedVersions(pool);

 const files = (await readdir(MIGRATIONS_DIR))
 .filter((f) => f.endsWith('.sql') && /^\d{3}-/.test(f))
 .sort();

 let appliedCount = 0;
 for (const file of files) {
 const version = file.slice(0, 3);
 if (applied.has(version)) continue;

 const sql = await readFile(`${MIGRATIONS_DIR}/${file}`, 'utf-8');
 await pool.query('BEGIN');
 try {
 await pool.query(sql);
 await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
 await pool.query('COMMIT');
 appliedCount++;
 console.log(`[migrate] applied ${file}`);
 } catch (err) {
 await pool.query('ROLLBACK');
 throw err;
 }
 }

 console.log(`[migrate] done — ${appliedCount} new, ${files.length - appliedCount} already applied`);
 } finally {
 await closePool();
 }
}

runMigrations().catch((err) => {
 console.error('[migrate] FATAL:', err);
 process.exit(1);
});
