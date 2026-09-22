/** Dev-only: confirm the devices columns exist and user_id became nullable. */
import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL || 'postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova', { max: 1 });
const cols = await sql`
	select column_name, is_nullable from information_schema.columns
	where table_name = 'devices' order by ordinal_position`;
for (const c of cols) console.log(`  ${c.column_name} (nullable=${c.is_nullable})`);
const idx = await sql`select indexname from pg_indexes where tablename = 'devices'`;
console.log('indexes:', idx.map((r) => r.indexname).join(', '));
await sql.end();
