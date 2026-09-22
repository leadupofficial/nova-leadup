/** Read-only table/row inspection helper for Admin Control Center work. */
import 'dotenv/config';
import postgres from 'postgres';

const url = process.env.DATABASE_URL || 'postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova';
const sql = postgres(url, { max: 1 });

const tables = await sql<{ table_name: string }[]>`
  select table_name from information_schema.tables where table_schema = 'public' order by 1`;
console.log(`TABLES (${tables.length}):`);
console.log(tables.map((t) => t.table_name).join(', '));
console.log('\nROW COUNTS:');
for (const { table_name } of tables) {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table_name)}`;
  console.log(`  ${table_name}: ${row.n}`);
}
await sql.end();
