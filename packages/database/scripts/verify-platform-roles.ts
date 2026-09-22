/**
 * Dev-only: verify migration 0007's table, foreign key and CHECK constraint.
 *
 * Read-only apart from one probe row that it removes again.
 */
import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL || 'postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova', { max: 1 });

const [table] = await sql`
	select table_name from information_schema.tables
	where table_schema = 'public' and table_name = 'platform_admin_roles'`;
console.log('table exists:', Boolean(table));

const constraints = await sql`
	select conname from pg_constraint
	where conrelid = 'platform_admin_roles'::regclass order by conname`;
console.log('constraints:', constraints.map((r) => r.conname).join(', '));

// The 0006 foreign keys must still be present: a regenerated migration tried to drop them.
const kept = await sql`
	select conname from pg_constraint where conname in (
		'admin_sessions_user_id_users_id_fk',
		'job_executions_user_id_users_id_fk',
		'job_executions_organization_id_organizations_id_fk')`;
console.log('0006 FKs still present:', kept.length, 'of 3');

const [user] = await sql`select id from users limit 1`;
if (user) {
	await sql`insert into platform_admin_roles (user_id, role, granted_by, reason)
		values (${user.id}, 'READ_ONLY', 'verify-script', 'constraint probe')
		on conflict (user_id) do nothing`;
	console.log('insert READ_ONLY ok');
	try {
		await sql`update platform_admin_roles set role = 'NOT_A_ROLE' where user_id = ${user.id}`;
		console.log('CHECK TEST: FAILED — an invalid role was accepted');
	} catch {
		console.log('CHECK TEST: PASS — an invalid role was rejected');
	}
	await sql`delete from platform_admin_roles where user_id = ${user.id}`;
	console.log('probe row removed');
}

await sql.end();
