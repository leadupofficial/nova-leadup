import 'dotenv/config';
import { config } from '../config';
import { getDb } from '../db/connection';
import { logger } from '../utils/logger';

export async function migrate(): Promise<void> {
 const db = getDb();
 const queries = [
 `CREATE TABLE IF NOT EXISTS users (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 email VARCHAR(255) UNIQUE NOT NULL,
 password_hash VARCHAR(255) NOT NULL,
 name VARCHAR(255),
 role VARCHAR(50) DEFAULT 'user',
 email_verified BOOLEAN DEFAULT FALSE,
 created_at TIMESTAMP DEFAULT NOW(),
 updated_at TIMESTAMP DEFAULT NOW()
 )`,
 `CREATE TABLE IF NOT EXISTS sessions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash VARCHAR(255) NOT NULL,
 expires_at TIMESTAMP NOT NULL,
 created_at TIMESTAMP DEFAULT NOW()
 )`,
 `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
 `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
 ];

 for (const query of queries) {
 try {
 await db.execute(query);
 logger.debug('Migration executed');
 } catch (error) {
 logger.error(error, 'Migration failed');
 throw error;
 }
 }
 logger.info('Database migrations complete');
}
