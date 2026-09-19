/**
 * NOVA API — §13.10 device wake-word config tests.
 *
 * Two things are being pinned here:
 *
 * 1. The route stores a **preference record**. It answers with the phrase the
 *    device reported and says, in the payload, that the device enforces it.
 * 2. It refuses to store a phrase the calling client did not report as
 *    installed. That refusal is the whole point of the endpoint: the server has
 *    no way to know which classifiers a build ships, so accepting an arbitrary
 *    string would let the account claim a wake word that no device can honour.
 */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup.js';

import app from '../server.js';
import { getDb } from '../db/connection.js';

const JWT_SECRET = process.env.JWT_SECRET!;
const CONFIG_PATH = '/api/v1/device/wake-word/config';

function token(payload: Record<string, unknown> = { sub: 'user-123', email: 'test@example.com', role: 'user' }) {
	return jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
}

const auth = () => ({ Authorization: `Bearer ${token()}` });

/** A db whose single companion-config lookup resolves to `row`. */
function dbWithStoredConfig(row: unknown) {
	return {
		select: () => ({
			from: () => ({ where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }) }),
		}),
	} as unknown as ReturnType<typeof getDb>;
}

/** A db that records what the route tried to persist. */
function capturingDb() {
	const captured: { values?: Record<string, unknown>; conflictSet?: Record<string, unknown> } = {};
	const db = {
		select: () => ({
			from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
		}),
		insert: () => ({
			values: (values: Record<string, unknown>) => {
				captured.values = values;
				return {
					onConflictDoUpdate: (options: { set?: Record<string, unknown> }) => {
						captured.conflictSet = options?.set;
						return { returning: () => Promise.resolve([{ id: 'cc-1', ...values }]) };
					},
				};
			},
		}),
	} as unknown as ReturnType<typeof getDb>;
	return { db, captured };
}

describe('GET /api/v1/device/wake-word/config', () => {
	it('returns 401 without a token', async () => {
		const res = await request(app).get(CONFIG_PATH);
		expect(res.status).toBe(401);
	});

	it('reports no choice, and no invented phrase, before one is made', async () => {
		const res = await request(app).get(CONFIG_PATH).set(auth());

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		// Not 'NOVA', not 'hey_nova' — the server does not know what is installed.
		expect(res.body.data.wakeWord).toBeNull();
		expect(res.body.data.available).toEqual([]);
		expect(res.body.data.updatedAt).toBeNull();
	});

	it('says in the payload that the device, not the API, enforces the phrase', async () => {
		const res = await request(app).get(CONFIG_PATH).set(auth());

		expect(res.body.data.enforcedOnDevice).toBe(true);
		expect(res.body.data.control).toBe('preference_record');
		expect(res.body.data.note).toMatch(/cannot change what the microphone listens for/);
	});

	it('returns the stored choice and the phrases the device reported', async () => {
		vi.mocked(getDb).mockReturnValueOnce(
			dbWithStoredConfig({
				wakeWord: {
					word: 'hey_jarvis',
					available: ['hey_jarvis', 'hey_mycroft'],
					updatedAt: '2026-09-18T00:00:00.000Z',
				},
			}),
		);

		const res = await request(app).get(CONFIG_PATH).set(auth());

		expect(res.status).toBe(200);
		expect(res.body.data.wakeWord).toBe('hey_jarvis');
		expect(res.body.data.available).toEqual(['hey_jarvis', 'hey_mycroft']);
		expect(res.body.data.updatedAt).toBe('2026-09-18T00:00:00.000Z');
	});

	it('does not trust a stored row with the wrong types', async () => {
		vi.mocked(getDb).mockReturnValueOnce(
			dbWithStoredConfig({ wakeWord: { word: 7, available: 'hey_jarvis', updatedAt: 12 } }),
		);

		const res = await request(app).get(CONFIG_PATH).set(auth());

		expect(res.status).toBe(200);
		expect(res.body.data.wakeWord).toBeNull();
		expect(res.body.data.available).toEqual([]);
		expect(res.body.data.updatedAt).toBeNull();
	});
});

describe('PATCH /api/v1/device/wake-word/config', () => {
	it('returns 401 without a token', async () => {
		const res = await request(app)
			.patch(CONFIG_PATH)
			.send({ wakeWord: 'hey_jarvis', available: ['hey_jarvis'] });
		expect(res.status).toBe(401);
	});

	it('records a phrase the device reports as installed', async () => {
		const { db, captured } = capturingDb();
		vi.mocked(getDb).mockReturnValueOnce(db);

		const res = await request(app)
			.patch(CONFIG_PATH)
			.set(auth())
			.send({ wakeWord: 'hey_jarvis', available: ['hey_jarvis'] });

		expect(res.status).toBe(200);
		expect(res.body.data.wakeWord).toBe('hey_jarvis');
		expect(res.body.data.available).toEqual(['hey_jarvis']);
		expect(res.body.data.enforcedOnDevice).toBe(true);

		// The stored record is the one the device was asked about — the choice
		// plus the list it was validated against.
		const stored = captured.values?.wakeWord as Record<string, unknown>;
		expect(stored.word).toBe('hey_jarvis');
		expect(stored.available).toEqual(['hey_jarvis']);
		expect(typeof stored.updatedAt).toBe('string');

		// Upsert on user_id, and nothing else on the companion row is touched —
		// choosing a phrase is not the same decision as enabling listening.
		expect(captured.conflictSet).toBeDefined();
		expect(Object.keys(captured.conflictSet!)).toEqual(['wakeWord', 'updatedAt']);
	});

	it('accepts one of several installed phrases', async () => {
		const { db, captured } = capturingDb();
		vi.mocked(getDb).mockReturnValueOnce(db);

		const res = await request(app)
			.patch(CONFIG_PATH)
			.set(auth())
			.send({ wakeWord: 'hey_mycroft', available: ['hey_jarvis', 'hey_mycroft'] });

		expect(res.status).toBe(200);
		expect(res.body.data.wakeWord).toBe('hey_mycroft');
		expect((captured.values?.wakeWord as Record<string, unknown>).word).toBe('hey_mycroft');
	});

	it('rejects a phrase the client did not report as installed', async () => {
		const res = await request(app)
			.patch(CONFIG_PATH)
			.set(auth())
			// The exact dishonesty this endpoint exists to prevent: "hey_nova"
			// has no classifier in the repo, so no device could listen for it.
			.send({ wakeWord: 'hey_nova', available: ['hey_jarvis'] });

		expect(res.status).toBe(400);
		expect(res.body.error).toBe('VALIDATION_ERROR');
		expect(res.body.detail).toMatch(/must be one of the wake words reported in available/);
	});

	it('rejects an empty available list rather than guessing', async () => {
		const res = await request(app)
			.patch(CONFIG_PATH)
			.set(auth())
			.send({ wakeWord: 'hey_jarvis', available: [] });

		expect(res.status).toBe(400);
		expect(res.body.error).toBe('VALIDATION_ERROR');
		expect(res.body.detail).toMatch(/at least one installed wake word/);
	});

	it('rejects a missing available list rather than trusting the phrase', async () => {
		const res = await request(app)
			.patch(CONFIG_PATH)
			.set(auth())
			.send({ wakeWord: 'hey_jarvis' });

		expect(res.status).toBe(400);
		expect(res.body.error).toBe('VALIDATION_ERROR');
	});

	it('rejects a name that is not a classifier identifier', async () => {
		const res = await request(app)
			.patch(CONFIG_PATH)
			.set(auth())
			.send({ wakeWord: 'Hey Jarvis', available: ['Hey Jarvis'] });

		expect(res.status).toBe(400);
		expect(res.body.error).toBe('VALIDATION_ERROR');
	});

	it('rejects a missing wakeWord', async () => {
		const res = await request(app)
			.patch(CONFIG_PATH)
			.set(auth())
			.send({ available: ['hey_jarvis'] });

		expect(res.status).toBe(400);
		expect(res.body.error).toBe('VALIDATION_ERROR');
	});
});
