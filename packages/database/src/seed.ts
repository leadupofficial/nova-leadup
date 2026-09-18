/**
 * @nova/database — Seed Data
 *
 * Run: pnpm db:seed
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { and, eq } from 'drizzle-orm';
import * as schema from './schema.js';

dotenv.config({ path: '.env' });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
 console.error('DATABASE_URL is not set');
 process.exit(1);
}

const db = drizzle(databaseUrl, { schema });

async function seed() {
 console.log('Seeding database...');

 // Demo org
 const orgResult = await db.insert(schema.organizations)
 .values({
 name: 'Demo Organization',
 slug: 'demo-org',
 })
 .returning({ id: schema.organizations.id });

 const orgId = orgResult[0]?.id;
 console.log(`Created organization: ${orgId}`);

 // Demo user
 const passwordHash = '$2b$10$dummy.hash.for.demo.only';
 const userResult = await db.insert(schema.users)
 .values({
 email: 'demo@nova.leadup.in',
 passwordHash,
 emailVerified: true,
 })
 .returning({ id: schema.users.id });

 const userId = userResult[0]?.id;
 console.log(`Created user: ${userId}`);

 // User profile
 await db.insert(schema.userProfiles)
 .values({
 userId,
 displayName: 'Demo User',
 timezone: 'UTC',
 language: 'en',
 });

 console.log('Seed complete!');
}

seed().catch(console.error);
