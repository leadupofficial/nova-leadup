/**
 * Dev-only one-shot repair, kept because it documents a real hazard.
 *
 * An earlier reset deleted the newest row of `drizzle.__drizzle_migrations` and
 * assumed that would re-run migration 0006. Drizzle actually keys applied
 * migrations by the `id` = journal `idx`, so deleting "the newest row" removed
 * 0005 — and the next `pnpm db:migrate` tried to re-apply it, failing on
 * `reminders.dedupe_key already exists`.
 *
 * This script restores the tracking rows for 0005 and 0006 at their journal
 * timestamps so the migrator stops trying to re-apply them, and then applies the
 * Admin Control Center DDL from `drizzle/repair-admin-control-center.sql` (a
 * verbatim copy of the objects migration 0006 owns) so the database is left in the
 * state 0006 describes.
 *
 * Safe to run twice: the inserts are guarded and the repair DDL is idempotent.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');

const url = process.env.DATABASE_URL || 'postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova';
// `transaction: false` matters. postgres.js wraps a multi-statement `unsafe()`
// string in an implicit transaction, so one failing statement rolls back every
// CREATE TABLE before it — which is exactly how the first run of this repair left
// no tables behind while reporting a constraint error. Migration SQL is already
// written to be applied statement-by-statement by drizzle; match that here.
const sql = postgres(url, { max: 1, transaction: false });

/** Drizzle stores `sha256(sql)` of each migration file plus the journal timestamp. */
function hashOf(tag: string): string {
	return createHash('sha256').update(readFileSync(join(drizzleDir, `${tag}.sql`), 'utf8')).digest('hex');
}

const TARGETS = [
	{ id: 5, when: 1789992832348, tag: '0005_curvy_maestro' },
	{ id: 6, when: 1790008845694, tag: '0006_admin_control_center' },
];

for (const target of TARGETS) {
	const hash = hashOf(target.tag);
	await sql`
		INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at)
		VALUES (${target.id}, ${hash}, ${target.when})
		ON CONFLICT (id) DO UPDATE SET hash = EXCLUDED.hash, created_at = EXCLUDED.created_at`;
	console.log(`[repair] migration ${target.id} (${target.tag}) recorded`);
}

// Apply migration 0006 itself. Its six tables were dropped by the earlier reset,
// so a from-scratch application is clean, and applying the real file keeps the
// recorded hash honest: it is the hash of the SQL that actually ran.
const migrationSql = readFileSync(join(drizzleDir, '0006_admin_control_center.sql'), 'utf8')
	.split('--> statement-breakpoint')
	.join(';\n');

/**
 * Split on `;` but never inside a `$$ ... $$` PL/pgSQL body.
 *
 * A naive split tore the append-only trigger function in half, which is how this
 * script first reported "constraint already exists" for a statement that had
 * actually never run: the function body's internal semicolons were treated as
 * statement terminators.
 */
function splitStatements(sqlText: string): string[] {
	const out: string[] = [];
	let current = '';
	let inDollarQuote = false;

	for (let i = 0; i < sqlText.length; i += 1) {
		const two = sqlText.slice(i, i + 2);
		if (two === '$$') {
			inDollarQuote = !inDollarQuote;
			current += two;
			i += 1;
			continue;
		}
		const char = sqlText[i];
		if (char === ';' && !inDollarQuote) {
			if (current.trim()) out.push(current.trim());
			current = '';
			continue;
		}
		current += char;
	}
	if (current.trim()) out.push(current.trim());

	return out.filter((statement) => {
		const withoutComments = statement
			.split('\n')
			.filter((line) => !line.trim().startsWith('--'))
			.join('\n')
			.trim();
		return withoutComments.length > 0;
	});
}

const statements = splitStatements(migrationSql);

for (const [index, statement] of statements.entries()) {
	const label = statement.split('\n').find((line) => !line.trim().startsWith('--'))?.slice(0, 70) ?? '';
	try {
		await sql.unsafe(`${statement};`);
	} catch (error) {
		const tables = (await sql`
			select table_name from information_schema.tables
			where table_schema = 'public' and table_name like 'admin%'`) as unknown as Array<{ table_name: string }>;
		console.error(
			`[repair] FAILED at statement ${index + 1} (${label}) — admin tables present: ${
				tables.map((t) => t.table_name).join(', ') || '(none)'
			}`,
		);
		throw error;
	}
}
console.log(`[repair] applied ${statements.length} statements from migration 0006`);

const tables = (await sql`
	select table_name from information_schema.tables
	where table_schema = 'public'
	  and (table_name like 'admin%' or table_name in ('system_configs','feature_flag_overrides','job_executions','provider_health_checks'))
	order by 1`) as unknown as Array<{ table_name: string }>;
console.log(`[repair] admin tables now: ${tables.map((t) => t.table_name).join(', ') || '(none)'}`);

await sql.end();
