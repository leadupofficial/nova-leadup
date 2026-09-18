import 'dotenv/config';
import { Pool, PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export function getDbPool(): Pool {
	if (!pool) {
		// DATABASE_URL is the single source of truth across the monorepo:
		// `packages/database` (getPool), drizzle.config.ts, the seeder, and
		// `pnpm db:migrate` all read it. This module previously built its own pool
		// from discrete DB_* variables that defaulted to a *different* database
		// (localhost:5432/nova) than the one migrations were applied to
		// (DATABASE_URL, which pointed at port 5433). The result was a schema that
		// existed in one database while every query ran against another.
		//
		// Discrete DB_* variables are still honoured as a fallback for deployments
		// that inject them individually.
		const connectionString = process.env.DATABASE_URL;

		pool = connectionString
			? new Pool({
					connectionString,
					max: 20,
					idleTimeoutMillis: 30000,
					connectionTimeoutMillis: 2000,
				})
			: new Pool({
					host: config.database.host,
					port: config.database.port,
					database: config.database.database,
					user: config.database.user,
					password: config.database.password,
					max: 20,
					idleTimeoutMillis: 30000,
					connectionTimeoutMillis: 2000,
				});

		pool.on('error', (err) => {
			logger.error(err, 'Database pool error');
		});

		logger.info(
			connectionString
				? 'PostgreSQL pool initialized (DATABASE_URL)'
				: 'PostgreSQL pool initialized (DB_* variables)',
		);
	}
	return pool;
}

export function getDb() {
 if (!db) {
 const poolInstance = getDbPool();
 db = drizzle(poolInstance);
 logger.info('Drizzle ORM initialized');
 }
 return db;
}

export async function getClient(): Promise<PoolClient> {
 const poolInstance = getDbPool();
 return poolInstance.connect();
}

export async function closeDb(): Promise<void> {
 if (pool) {
 await pool.end();
 pool = null;
 db = null;
 logger.info('Database connection closed');
 }
}
