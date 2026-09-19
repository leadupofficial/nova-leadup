import { Pool, PoolClient, QueryResult } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export interface DatabaseConfig {
 host: string;
 port: number;
 database: string;
 user: string;
 password: string;
 ssl?: boolean;
 connectionTimeout?: number;
 idleTimeout?: number;
 maxConnections?: number;
}

export class Database {
 private static instance: Database | null = null;
 private pool: Pool;
 private orm: ReturnType<typeof drizzle>;

 private constructor(config: DatabaseConfig) {
 this.pool = new Pool({
 host: config.host,
 port: config.port,
 database: config.database,
 user: config.user,
 password: config.password,
 ssl: config.ssl || false,
 connectionTimeoutMillis: config.connectionTimeout || 30000,
 idleTimeoutMillis: config.idleTimeout || 30000,
 max: config.maxConnections || 20,
 });

 this.pool.on('error', (err) => {
 console.error('Unexpected database pool error:', err);
 });

 this.orm = drizzle(this.pool, { schema });
 }

 static getInstance(config?: DatabaseConfig): Database {
 if (!Database.instance) {
 if (!config) {
 throw new Error('Database config required for first initialization');
 }
 Database.instance = new Database(config);
 }
 return Database.instance;
 }

 static resetInstance(): void {
 if (Database.instance) {
 Database.instance.close();
 Database.instance = null;
 }
 }

 get client() {
 return this.orm;
 }

 async query(sql: string, params?: any[]): Promise<QueryResult> {
 const start = Date.now();
 try {
 const result = await this.pool.query(sql, params);
 const duration = Date.now() - start;
 if (duration > 1000) {
 console.warn(`Slow query detected (${duration}ms):`, sql.substring(0, 100));
 }
 return result;
 } catch (error) {
 console.error('Database query error:', error);
 throw error;
 }
 }

 async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
 const client = await this.pool.connect();
 try {
 await client.query('BEGIN');
 const result = await callback(client);
 await client.query('COMMIT');
 return result;
 } catch (error) {
 try {
 await client.query('ROLLBACK');
 } catch {
 // Ignore rollback errors
 }
 throw error;
 } finally {
 client.release();
 }
 }

 async close(): Promise<void> {
 await this.pool.end();
 }

 async healthCheck(): Promise<{ healthy: boolean; latency: number }> {
 const start = Date.now();
 try {
 await this.query('SELECT 1');
 return { healthy: true, latency: Date.now() - start };
 } catch {
 return { healthy: false, latency: Date.now() - start };
 }
 }
}

export const createDatabase = (config: DatabaseConfig) => Database.getInstance(config);
export const getDatabase = () => Database.getInstance();
