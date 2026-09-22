/**
 * Read-only database inspection helper used during Admin Control Center work.
 *
 * Usage: DATABASE_URL=... node scripts/db-inspect.mjs [table ...]
 *
 * Prints the public table list and row counts. Never mutates anything.
 */
import pg from 'pg';

const url = process.env.DATABASE_URL || 'postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova';
const client = new pg.Client({ connectionString: url });
await client.connect();

const tables = await client.query(
	"select table_name from information_schema.tables where table_schema='public' order by 1",
);
console.log(`TABLES (${tables.rowCount}):`);
console.log(tables.rows.map((r) => r.table_name).join(', '));

const requested = process.argv.slice(2);
const targets = requested.length > 0 ? requested : tables.rows.map((r) => r.table_name);
console.log('\nROW COUNTS:');
for (const table of targets) {
	try {
		const r = await client.query(`select count(*)::int as n from "${table}"`);
		console.log(`  ${table}: ${r.rows[0].n}`);
	} catch (err) {
		console.log(`  ${table}: ERR ${err.message}`);
	}
}

await client.end();
