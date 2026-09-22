import 'dotenv/config';
import postgres from 'postgres';
const url = process.env.DATABASE_URL || 'postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova';
const sql = postgres(url, { max: 1 });
const rows = await sql<{ table_name: string }[]>`
  select table_name from information_schema.tables
  where table_schema='public' and table_name in
  ('admin_audit_logs','admin_sessions','feature_flag_overrides','job_executions','provider_health_checks','system_configs')
  order by 1`;
console.log('NEW TABLES:', rows.map(r => r.table_name).join(', '));

// Prove the append-only trigger actually refuses an update.
const [ins] = await sql<{ id: string }[]>`
  insert into admin_audit_logs (action, outcome, actor_email)
  values ('selftest.append', 'success', 'system@verify') returning id`;
console.log('insert ok:', ins.id);
try {
  await sql`update admin_audit_logs set outcome='failure' where id=${ins.id}`;
  console.log('TAMPER TEST: FAILED - update was allowed');
} catch (e) {
  console.log('TAMPER TEST: PASS - update rejected:', (e as Error).message.split('\n')[0]);
}
try {
  await sql`delete from admin_audit_logs where id=${ins.id}`;
  console.log('TAMPER TEST: FAILED - delete was allowed');
} catch (e) {
  console.log('TAMPER TEST: PASS - delete rejected:', (e as Error).message.split('\n')[0]);
}
await sql.end();
