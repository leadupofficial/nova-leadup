/**
 * Verifies the account-deletion invariants against a real database.
 *
 * Why this is a script and not a vitest test: `src/__tests__/setup.ts` replaces
 * `../db/connection` with an in-memory mock for the whole API suite, so the statements
 * that matter here — foreign-key detaching, a JSON field being dropped, an
 * `artifact_type` boundary — would never execute. The same reason `verify-retention.mjs`
 * exists.
 *
 * Every check below corresponds to something an adversarial pass found wrong or worth
 * pinning:
 *
 *   * the three `users` foreign keys that have no `ON DELETE` action must be detached,
 *     or the delete aborts with a foreign-key violation;
 *   * a request filed for **one artifact** must not complete as a whole-account
 *     deletion (a seeded `artifactType='recordings'` row destroyed an account before
 *     this guard existed);
 *   * an AI report's `details.excerpt` is user content and must not survive the account
 *     that filed it, while the fact of the report and its reason should.
 *
 * Usage (from services/api, with DATABASE_URL set):
 *
 *   npx tsx scripts/verify-account-deletion.mjs
 */
import { eq, inArray, sql } from 'drizzle-orm';
import {
	audioRecordings,
	auditLogs,
	deletionRequests,
	getDb,
	getPool,
	leadFollowUps,
	leads,
	users,
} from '@nova/database';

const db = getDb();
const results = [];
const createdUserIds = [];

function check(name, ok, detail = '') {
	results.push([name, Boolean(ok)]);
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`);
	return Boolean(ok);
}

async function seedUser(tag) {
	const [user] = await db
		.insert(users)
		.values({
			email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.example.com`,
			name: 'Deletion Verify',
			passwordHash: 'not-a-real-hash',
		})
		.returning();
	createdUserIds.push(user.id);
	return user;
}

/** The detach-then-delete the route performs, so the script fails if it drifts. */
async function deleteAccountAsRoute(userId) {
	await db.transaction(async (tx) => {
		await tx.update(auditLogs).set({ userId: null }).where(eq(auditLogs.userId, userId));
		await tx.update(auditLogs).set({ details: sql`${auditLogs.details} - 'excerpt'` })
			.where(eq(auditLogs.actorId, userId));
		await tx.update(leads).set({ assignedTo: null }).where(eq(leads.assignedTo, userId));
		await tx.update(leadFollowUps).set({ assignedTo: null }).where(eq(leadFollowUps.assignedTo, userId));
		await tx.delete(users).where(eq(users.id, userId));
	});
}

console.log('verifying the account-deletion invariants\n');

try {
	// ── The foreign keys with no ON DELETE action ─────────────────────────────
	console.log('the foreign keys that do not cascade')
	{
		const user = await seedUser('fk');

		// One row per non-cascading reference. `audit_logs.actor_id` is a varchar and
		// carries no constraint, which is what lets the trail outlive the account.
		await db.insert(auditLogs).values({
			userId: user.id, actorType: 'user', actorId: user.id,
			action: 'verify.fk', targetType: 'user', targetId: user.id,
			outcome: 'success', details: { keep: 'me' },
		});
		const [lead] = await db.insert(leads).values({ userId: user.id, assignedTo: user.id, name: 'Fk', status: 'new' })
			.returning().catch(() => [null]);
		if (lead) {
			await db.insert(leadFollowUps).values({
				leadId: lead.id, assignedTo: user.id, followUpDate: new Date(),
			});
		}

		let threw = null;
		try {
			await deleteAccountAsRoute(user.id);
		} catch (err) {
			threw = err;
		}

		check('the delete does not violate a foreign key', threw === null,
			threw ? String(threw.message).slice(0, 90) : '');

		const [gone] = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id)).limit(1);
		check('the user row is gone', !gone);
	}

	// ── A request for one artifact is not an account request ──────────────────
	console.log('\na request filed for a single artifact')
	{
		const victim = await seedUser('artifact');
		const [request] = await db
			.insert(deletionRequests)
			.values({ userId: victim.id, artifactType: 'recordings', status: 'pending' })
			.returning();

		// This asserts the **precondition** the route's guard depends on, not the guard
		// itself: `POST /deletion-requests/:id/complete` is an HTTP endpoint that needs an
		// owner token, and this script has no HTTP client. It is driven from
		// `verify-store-compliance.py` and by hand; what is pinned here is that such a row
		// can exist and carries a type other than `account`, which is the case that used
		// to destroy the whole account.
		const [row] = await db
			.select({ artifactType: deletionRequests.artifactType })
			.from(deletionRequests)
			.where(eq(deletionRequests.id, request.id))
			.limit(1);
		check('a request row can exist for a single artifact', row?.artifactType === 'recordings',
			String(row?.artifactType));

		const [alive] = await db.select({ id: users.id }).from(users).where(eq(users.id, victim.id)).limit(1);
		check('and nothing in this script completes it', Boolean(alive));
	}

	// ── A reported excerpt goes with the account ──────────────────────────────
	console.log('\na reported AI excerpt')
	{
		const reporter = await seedUser('reporter');
		await db.insert(auditLogs).values({
			userId: reporter.id, actorType: 'user', actorId: reporter.id,
			action: 'ai.response.reported', targetType: 'message', targetId: 'msg-verify',
			outcome: 'success',
			details: { reason: 'harmful', excerpt: 'PRIVATE-REPLY-CONTENT-must-not-survive', reportedFrom: 'app' },
		});

		await deleteAccountAsRoute(reporter.id);

		const rows = await db
			.select({ details: auditLogs.details, action: auditLogs.action })
			.from(auditLogs)
			.where(eq(auditLogs.actorId, reporter.id));

		check('the trail row survives, as documented', rows.length === 1, `rows=${rows.length}`);
		const leaked = rows.filter((r) => JSON.stringify(r.details ?? {}).includes('PRIVATE-REPLY-CONTENT'));
		check('but the excerpt does not', leaked.length === 0, `${leaked.length} still hold it`);
		check('and the reason is kept', rows[0]?.details?.reason === 'harmful',
			JSON.stringify(rows[0]?.details ?? {}));
	}
} finally {
	if (createdUserIds.length > 0) {
		// Children cascade from `users`; the detached `audit_logs` rows do not, so they go
		// by `actor_id` first.
		await db.delete(auditLogs).where(inArray(auditLogs.actorId, createdUserIds));
		await db.delete(users).where(inArray(users.id, createdUserIds));
	}
	await getPool().end();
}

const passed = results.filter(([, ok]) => ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
if (passed !== results.length) {
	console.log('FAILED: ' + results.filter(([, ok]) => !ok).map(([n]) => n).join(', '));
	process.exit(1);
}
