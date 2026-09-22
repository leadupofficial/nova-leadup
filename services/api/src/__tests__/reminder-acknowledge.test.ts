/**
 * NOVA API — `POST /reminders/:id/acknowledge`.
 *
 * This route is the writer `reminders.triggered_at` never had, and it is the only
 * delivery signal the platform can observe: the OS fires the reminder's alarm with the
 * app closed, so a *tap* is what the server can see. Two consequences it has to get
 * right, and both are pinned here:
 *
 *  1. **It is scoped to the owner.** A reminder id is not a capability; another account's
 *     reminder must answer 404 rather than being acknowledged. The route filters on
 *     `user_id` in the same predicate as the id, so a mismatch is a miss, not a leak.
 *  2. **It is idempotent in one direction.** The first acknowledgement records the time;
 *     every later one reports that nothing changed instead of overwriting it. A
 *     `triggered_at` that moved on every tap would make the journal read as several
 *     deliveries of one reminder.
 *
 * The route must also NOT insert into `reminder_events`. Migration 0010's
 * `reminders_triggered_change` trigger does that, exactly as the `trigger_at` trigger in
 * 0004 does for reschedules, and 0004 states plainly that application code inserting too
 * would double-count. `writesNothingToTheJournal` below asserts it.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup.js';

import app from '../server.js';
import { getDb } from '../db/connection.js';

const JWT_SECRET = process.env.JWT_SECRET!;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const REMINDER_ID = '33333333-3333-4333-8333-333333333333';

function auth(userId: string = USER_ID) {
	const token = jwt.sign(
		{ sub: userId, email: 'test@example.com', role: 'user' },
		JWT_SECRET,
		{ expiresIn: '1h' },
	);
	return { Authorization: `Bearer ${token}` };
}

function path(id: string = REMINDER_ID): string {
	return `/api/v1/reminders/${id}/acknowledge`;
}

/** A reminder row as the route reads it. */
function reminderRow(overrides: Record<string, unknown> = {}) {
	return {
		id: REMINDER_ID,
		userId: USER_ID,
		title: 'Call the bank',
		triggerAt: new Date('2026-09-22T03:30:00.000Z'),
		triggeredAt: null,
		dismissed: false,
		...overrides,
	};
}

/**
 * A db whose lookup resolves to `existing`, whose update records the patch, and which
 * counts every table it was asked to insert into.
 *
 * The insert count is the point of `writesNothingToTheJournal`: the journal is the
 * database trigger's job, and an application insert would silently double every row.
 */
function dbWith(existing: unknown, insertResult: unknown = null) {
	const inserts: string[] = [];
	let patch: Record<string, unknown> | null = null;
	const db = {
		select: () => ({
			from: () => ({
				where: () => ({ limit: () => Promise.resolve(existing ? [existing] : []) }),
			}),
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => {
				patch = values;
				return {
					where: () => ({
						returning: () => Promise.resolve(insertResult ? [insertResult] : []),
					}),
				};
			},
		}),
		insert: (table: unknown) => {
			inserts.push(String((table as { __name?: string })?.__name ?? table));
			return { values: () => Promise.resolve([]) };
		},
	};
	return { db: db as unknown as ReturnType<typeof getDb>, inserts, patch: () => patch };
}

describe('POST /reminders/:id/acknowledge', () => {
	it('refuses an unauthenticated caller', async () => {
		const res = await request(app).post(path());
		expect(res.status).toBe(401);
	});

	it('rejects a malformed id before touching the database', async () => {
		const res = await request(app).post(path('not-a-uuid')).set(auth());
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('INVALID_ID');
	});

	it("404s another account's reminder instead of acknowledging it", async () => {
		// The lookup is filtered by owner, so a reminder that exists but belongs to
		// someone else is indistinguishable from one that does not exist. That is the
		// intended answer: acknowledging by id alone would let any signed-in account
		// mark any reminder delivered.
		vi.mocked(getDb).mockReturnValueOnce(dbWith(null).db);

		const res = await request(app).post(path()).set(auth(OTHER_USER_ID));
		expect(res.status).toBe(404);
		expect(res.body.code).toBe('NOT_FOUND');
	});

	it('rejects a body rather than ignoring it', async () => {
		// A strict empty schema: accepting `{ triggeredAt: '...' }` would let a client
		// choose the recorded instant, and the server is the only party that can say when
		// it was told.
		const res = await request(app)
			.post(path())
			.set(auth())
			.send({ triggeredAt: '2026-01-01T00:00:00.000Z' });
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('VALIDATION_ERROR');
	});

	it('records the first acknowledgement and reports it', async () => {
		const fixed = new Date('2026-09-21T18:39:30.653Z');
		const { db, patch } = dbWith(reminderRow(), reminderRow({ triggeredAt: fixed }));
		vi.mocked(getDb).mockReturnValueOnce(db);

		const res = await request(app).post(path()).set(auth()).send({});

		expect(res.status).toBe(200);
		expect(res.body.data.firstAcknowledgement).toBe(true);
		expect(res.body.data.triggeredAt).toBe(fixed.toISOString());
		// The row is stamped and nothing else on the reminder is touched.
		expect(Object.keys(patch() ?? {})).toEqual(['triggeredAt']);
	});

	it('reports a repeat acknowledgement as a no-op with the original instant', async () => {
		const first = new Date('2026-09-21T18:39:30.653Z');
		const { db, patch } = dbWith(reminderRow({ triggeredAt: first }), reminderRow());
		vi.mocked(getDb).mockReturnValueOnce(db);

		const res = await request(app).post(path()).set(auth()).send({});

		expect(res.status).toBe(200);
		expect(res.body.data.firstAcknowledgement).toBe(false);
		// The original instant is what comes back, unchanged.
		expect(res.body.data.triggeredAt).toBe(first.toISOString());
		// And no write was attempted at all, which is what keeps the count at one.
		expect(patch()).toBeNull();
	});

	it('writes nothing to the journal in application code', async () => {
		// Migration 0010's trigger owns the journal row. An insert here would double-count
		// every acknowledgement, which is exactly what 0004 warns about for reschedules.
		const fixed = new Date('2026-09-21T18:39:30.653Z');
		const { db, inserts } = dbWith(reminderRow(), reminderRow({ triggeredAt: fixed }));
		vi.mocked(getDb).mockReturnValueOnce(db);

		await request(app).post(path()).set(auth()).send({});

		expect(inserts).toEqual([]);
	});

	it('reports the losing side of a concurrent acknowledgement as a no-op', async () => {
		// Two taps at once: both read `triggered_at IS NULL`, one update matches a row and
		// the other matches none. The loser must not 500, and must not claim it recorded
		// anything — the winner's instant is the truth.
		const { db } = dbWith(reminderRow(), null);
		vi.mocked(getDb).mockReturnValueOnce(db);

		const res = await request(app).post(path()).set(auth()).send({});

		expect(res.status).toBe(200);
		expect(res.body.data.firstAcknowledgement).toBe(false);
		expect(res.body.data.triggeredAt).toBeNull();
	});
});
