import { defineConfig } from 'drizzle-kit';

export default defineConfig({
 schema: './src/schema.ts',
 out: './drizzle',
 dialect: 'postgresql',
 dbCredentials: {
 url: process.env.DATABASE_URL ?? 'postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova',
 },
});
