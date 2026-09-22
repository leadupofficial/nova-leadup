/**
 * Seeds a plain reviewer account for App Store / Play Store review.
 *
 * Why this exists: both stores require the reviewer to be able to reach the app's
 * functionality, and App Review expects working credentials in the review notes. The
 * only seeder in the repository was `seed-admin.mjs`, which creates an **owner** — an
 * account that can read every user in the admin console. Handing store reviewers an
 * owner account is both unnecessary and a real disclosure risk, and
 * `packages/database/src/seed.ts` writes an invalid bcrypt hash for its demo user
 * (`'$2b$10$dummy.hash.for.demo.only'`), so that account can never sign in at all.
 *
 * This creates an ordinary user with the `user` role: exactly what a reviewer needs to
 * exercise onboarding, conversations, tasks, reminders, recordings and — the part the
 * stores actually check — in-app account deletion.
 *
 * Idempotent: re-running resets the password of the same account rather than creating a
 * second one.
 *
 * Run inside the api container (it has `@nova/database`, `bcryptjs` and `DATABASE_URL`):
 *
 *   docker cp services/api/scripts/seed-review-account.mjs nova-api:/app/services/api/
 *   docker exec nova-api node services/api/scripts/seed-review-account.mjs
 *
 * Or with an explicit password and address:
 *
 *   docker exec -e REVIEW_EMAIL='appreview@leadup.tech' \
 *               -e REVIEW_PASSWORD='...' \
 *               nova-api node services/api/scripts/seed-review-account.mjs
 *
 * WARNING: this prints the password to stdout once. Put it in the review notes and
 * change or delete the account after the review, so a published credential does not
 * outlive the submission. Refuses to run when NODE_ENV=production unless
 * ALLOW_REVIEW_SEED_IN_PRODUCTION=1 is set, because a working credential printed to a
 * production log is exactly the kind of thing that should take a deliberate decision.
 */
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { getDb, getPool, roleBindings, roles, users } from '@nova/database';

const BCRYPT_ROUNDS = 12;

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_REVIEW_SEED_IN_PRODUCTION !== '1') {
	console.error(
		'[seed] refusing to run with NODE_ENV=production. Re-run with ' +
			'ALLOW_REVIEW_SEED_IN_PRODUCTION=1 if that is genuinely intended.',
	);
	process.exit(1);
}

const email = (process.env.REVIEW_EMAIL || 'appreview@leadup.tech').trim().toLowerCase();
const password = process.env.REVIEW_PASSWORD || crypto.randomBytes(12).toString('base64url');
const name = process.env.REVIEW_NAME || 'App Review';

const db = getDb();

// ── 1. The user ───────────────────────────────────────────────────────────────
let [user] = await db.select().from(users).where(eq(users.email, email));

if (user) {
	const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
	await db
		.update(users)
		.set({ passwordHash, disabled: false, updatedAt: new Date() })
		.where(eq(users.id, user.id));
	console.log(`[seed] reset the password for the existing review account ${email}`);
} else {
	const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
	[user] = await db
		.insert(users)
		.values({
			email,
			name,
			passwordHash,
			// Left unverified on purpose: there is no verify-email route in
			// `services/api`, and nothing in the product gates on the flag, so claiming
			// verified would be untrue.
			emailVerified: false,
		})
		.returning();
	console.log(`[seed] created review account ${email} (${user.id})`);
}

// ── 2. The `user` role binding ────────────────────────────────────────────────
//
// Not strictly required to sign in — `resolveUserRole` falls back to `user` when there
// is no binding — but creating it explicitly keeps this account's privileges identical
// to a real signup's, which is the point: the reviewer must see what a user sees.
// `roles` is scoped to an organization (`organization_id` is NOT NULL, unique on
// (organization_id, slug)), so this is a lookup by slug with an explicit limit rather
// than an unbounded name match that could return several rows across tenants.
const [userRole] = await db
	.select()
	.from(roles)
	.where(eq(roles.slug, 'user'))
	.limit(1);

if (userRole) {
	const existing = await db
		.select()
		.from(roleBindings)
		.where(eq(roleBindings.userId, user.id));

	if (existing.length === 0) {
		await db
			.insert(roleBindings)
			.values({ userId: user.id, roleId: userRole.id, scope: 'organization' });
		console.log('[seed] bound the `user` role');
	} else {
		console.log('[seed] role binding already present');
	}
} else {
	console.log('[seed] no `user` role row exists; the API will fall back to the `user` claim');
}

// ── 3. What the reviewer must be told ─────────────────────────────────────────
console.log('');
console.log('  ── App Review / Play review credentials ──');
console.log(`  email:    ${email}`);
console.log(`  password: ${password}`);
console.log('');
console.log('  This is an ordinary user account: no admin console access, no cross-user');
console.log('  data. Paste these into App Store Connect → App Review Information and the');
console.log('  Play Console → App access section.');
console.log('');
console.log('  DELETE THIS ACCOUNT AFTER THE REVIEW:');
console.log(`    docker exec nova-api node -e "…"   # or remove the row for ${email}`);
console.log('');

await getPool().end();
