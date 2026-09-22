/**
 * NOVA Workflow Engine — Database helper
 */
import pg from 'pg';
const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
	if (!pool) {
		pool = new Pool({
			connectionString: process.env.DATABASE_URL,
		});
	}
	return pool;
}

export default { getPool };
