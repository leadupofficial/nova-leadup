import { defineConfig } from 'drizzle-kit';

export default defineConfig({
 schema: './src/schema.ts',
 out: './drizzle',
 dialect: 'postgresql',
 dbCredentials: {
 url: process.env.DATABASE_URL ?? 'postgres://nova_user:nova_secure_2026@localhost:5432/nova',
 },
});
