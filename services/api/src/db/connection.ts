import 'dotenv/config';
import { Pool, PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { logger } from '../utils/logger';
import { config } from '../config';

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export function getDbPool(): Pool {
 if (!pool) {
 pool = new Pool({
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

 logger.info('PostgreSQL pool initialized');
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
