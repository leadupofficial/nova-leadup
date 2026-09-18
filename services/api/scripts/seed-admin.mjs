/**
 * Seeds the NOVA platform owner account.
 *
 * Why this exists: `users` has no role column. Roles are RBAC rows in
 * `roles` / `role_bindings`, and `services/api` resolves the JWT `role` claim from
 * them (see `resolveUserRole` in `src/routes/auth.ts`). `requireAdmin` on
 * `/api/v1/admin/*` and the admin console's `AdminAuthGuard` both accept only
 * `owner`/`admin`, so without a binding the admin panel can never be used.
 *
 * Idempotent: safe to re-run. Creates the organization, the `owner` role, the user
 * and the binding only when each is missing. When the user already exists its
 * password is reset to the one printed here.
 *
 * Run inside the api container (it has @nova/database, bcryptjs and DATABASE_URL):
 *
 *   docker cp services/api/scripts/seed-admin.mjs nova-api:/app/services/api/
 *   docker exec nova-api node services/api/scripts/seed-admin.mjs
 *
 * Or with an explicit password:
 *
 *   docker exec -e SEED_ADMIN_PASSWORD='...' nova-api node services/api/seed-admin.mjs
 *
 * WARNING: this prints the password to stdout. Change it after first sign-in.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import {
	getDb,
	getPool,
	organizations,
	roleBindings,
	roles,
	users,
} from '@nova/database';

const BCRYPT_ROUNDS = 12;

const email = (process.env.SEED_ADMIN_EMAIL || 'admin@nova.leadup.in').trim().toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
const orgSlug = process.env.SEED_ORG_SLUG || 'nova';

const db = getDb();

// ── 1. Organization ───────────────────────────────────────────────────────────
let [org] = await db.select().from(organizations).where(eq(organizations.slug, orgSlug));
if (!org) {
	[org] = await db
		.insert(organizations)
		.values({ name: 'NOVA', slug: orgSlug, plan: 'internal' })
		.returning();
	console.log(`[seed] created organization ${org.slug} (${org.id})`);
} else {
	console.log(`[seed] reusing organization ${org.slug} (${org.id})`);
}

// ── 2. `owner` role scoped to that organization ───────────────────────────────
let [ownerRole] = await db
	.select()
	.from(roles)
	.where(and(eq(roles.organizationId, org.id), eq(roles.slug, 'owner')));
if (!ownerRole) {
	[ownerRole] = await db
		.insert(roles)
		.values({
			organizationId: org.id,
			name: 'Owner',
			slug: 'owner',
			permissions: ['*'],
			isSystem: true,
		})
		.returning();
	console.log(`[seed] created role owner (${ownerRole.id})`);
} else {
	console.log(`[seed] reusing role owner (${ownerRole.id})`);
}

// ── 3. The owner user ─────────────────────────────────────────────────────────
const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
let [user] = await db.select().from(users).where(eq(users.email, email));
if (!user) {
	[user] = await db
		.insert(users)
		.values({
			email,
			name: 'NOVA Owner',
			passwordHash,
			organizationId: org.id,
			emailVerified: true,
		})
		.returning();
	console.log(`[seed] created user ${user.email} (${user.id})`);
} else {
	await db
		.update(users)
		.set({ passwordHash, organizationId: org.id, disabled: false, emailVerified: true })
		.where(eq(users.id, user.id));
	console.log(`[seed] updated existing user ${user.email} (${user.id}) — password reset`);
}

// ── 4. Bind the role ──────────────────────────────────────────────────────────
const [binding] = await db
	.select()
	.from(roleBindings)
	.where(and(eq(roleBindings.userId, user.id), eq(roleBindings.roleId, ownerRole.id)));
if (!binding) {
	await db
		.insert(roleBindings)
		.values({ userId: user.id, roleId: ownerRole.id, scope: 'organization' });
	console.log('[seed] created role binding owner');
} else {
	console.log('[seed] role binding owner already present');
}

console.log('');
console.log('================ ADMIN CREDENTIALS ================');
console.log(`  email    : ${email}`);
console.log(`  password : ${password}`);
console.log(`  role     : owner`);
console.log('  Change this password after the first sign-in.');
console.log('===================================================');

await getPool().end();
