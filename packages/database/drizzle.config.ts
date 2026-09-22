import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	// `schema*.ts` picks up schema.ts and schema-admin.ts (Admin Control Center
	// tables). A bare `schema.ts` silently ignored schema-admin.ts, so
	// `drizzle-kit generate` reported "No schema changes" while the new tables
	// were never emitted into ./drizzle.
	schema: './src/schema*.ts',
	out: './drizzle',
	dialect: 'postgresql',
	dbCredentials: {
		url: process.env.DATABASE_URL ?? 'postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova',
	},
});
