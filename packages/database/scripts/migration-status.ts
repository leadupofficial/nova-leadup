/** Dev-only: report migration tracking state and the Admin Control Center objects. */
import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL || 'postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova', {
	max: 1,
});

const migrations = (await sql`
	select id, hash, created_at from drizzle.__drizzle_migrations order by created_at`) as unknown as Array<{
	id: number;
	hash: string;
	created_at: string;
}>;
console.log(`migration rows: ${migrations.length}`);
for (const row of migrations) {
	console.log(`  ${row.id}  ${String(row.hash).slice(0, 16)}  ${new Date(Number(row.created_at)).toISOString()}`);
}

const tables = (await sql`
	select table_name from information_schema.tables
	where table_schema = 'public'
	  and (table_name like 'admin%' or table_name in ('system_configs','feature_flag_overrides','job_executions','provider_health_checks'))`) as unknown as Array<{
	table_name: string;
}>;
console.log('admin tables present:', tables.map((t) => t.table_name).join(', ') || '(none)');

const dedupe = (await sql`
	select column_name from information_schema.columns
	where table_name = 'reminders' and column_name = 'dedupe_key'`) as unknown as unknown[];
console.log('reminders.dedupe_key exists:', dedupe.length > 0);

await sql.end();
