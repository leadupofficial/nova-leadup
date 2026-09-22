/**
 * NOVA API — the privacy switches, over HTTP.
 *
 * Every switch under Profile → Privacy controls used to store a preference that **no
 * code read**: a user could turn "Save recordings" off and still be recorded. The
 * enforcement now lives in `services/privacy-preferences.ts` and at each write site, and
 * this file is what stops a future edit from quietly deleting it — an adversarial pass
 * found exactly that had already happened once, on the conversation route the app
 * actually uses rather than the one that had been gated.
 *
 * The database is the suite's in-memory Drizzle mock. `setPrivacyPreferencesRow` is what
 * makes the gates reachable at all: without a `privacy_preferences` row the reader falls
 * back to `PRIVACY_DEFAULTS` (everything on) and every assertion below would pass while
 * proving nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup.js';
import { setPrivacyPreferencesRow } from './setup.js';

import app from '../server.js';

const JWT_SECRET = process.env.JWT_SECRET!;

function token(userId = 'user-1'): string {
	return jwt.sign({ sub: userId, email: 'user-1@example.com', role: 'user' }, JWT_SECRET, {
		expiresIn: '1h',
	});
}

const auth = () => `Bearer ${token()}`;

afterEach(() => {
	// Every test starts from the defaults, so one test's switch cannot leak into the next.
	setPrivacyPreferencesRow();
});

describe('the reader itself', () => {
	it('treats a user with no row as saving everything', async () => {
		// The deliberate default: an account created before this module existed has no row
		// and must not suddenly stop being able to record.
		setPrivacyPreferencesRow(null);
		const { getPrivacyPreferences } = await import('../services/privacy-preferences.js');
		const { getDb } = await import('../db/connection.js');
		const prefs = await getPrivacyPreferences(getDb(), 'user-1');

		expect(prefs).toEqual({
			saveConversations: true,
			saveRecordings: true,
			saveTranscripts: true,
			saveMemories: true,
			cloudProcessing: true,
			localProcessing: false,
		});
	});

	it('does not pretend a switch is off when it cannot read the row', async () => {
		// The failure mode this documents: a database blip, or the schema drift this repo
		// has hit before, makes the reader fall back to "everything on". That is the
		// deliberate choice — failing closed would turn a short outage into data loss for
		// users who never changed a setting — but it must not be silent, so the fallback
		// is logged at error level. This asserts the *behaviour*; the log line is what an
		// operator sees.
		const { getPrivacyPreferences } = await import('../services/privacy-preferences.js');
		const broken = {
			select: () => {
				throw new Error('database unavailable');
			},
		} as never;

		await expect(getPrivacyPreferences(broken, 'user-1')).resolves.toMatchObject({
			saveMemories: true,
			saveConversations: true,
		});
	});

	it('returns the stored values when a row exists', async () => {
		setPrivacyPreferencesRow({ saveMemories: false, saveTranscripts: false });
		const { getPrivacyPreferences } = await import('../services/privacy-preferences.js');
		const { getDb } = await import('../db/connection.js');
		const prefs = await getPrivacyPreferences(getDb(), 'user-1');

		expect(prefs.saveMemories).toBe(false);
		expect(prefs.saveTranscripts).toBe(false);
		expect(prefs.saveRecordings).toBe(true);
	});
});

describe('saveMemories', () => {
	it('stores a memory while the switch is on', async () => {
		const res = await request(app)
			.post('/api/v1/memories')
			.set('Authorization', auth())
			.send({ content: 'I like filter coffee', category: 'preference', sourceType: 'manual' });

		expect(res.status).toBe(201);
	});

	it('refuses to store one when the switch is off', async () => {
		// The regression guard. `routes/memories.ts` now delegates to `createMemory`
		// (which runs this check and the embedding hook); before that it wrote its own
		// row and needed its own copy of the check. Either way this is what fails if
		// the gate is removed.
		setPrivacyPreferencesRow({ saveMemories: false });

		const res = await request(app)
			.post('/api/v1/memories')
			.set('Authorization', auth())
			.send({ content: 'must not be stored', category: 'preference', sourceType: 'manual' });

		expect(res.status).toBe(409);
		expect(JSON.stringify(res.body)).toContain('MEMORY_SAVING_DISABLED');
	});
});

describe('saveConversations', () => {
	it('still answers a turn when the switch is off', async () => {
		// Refusing the call would make the feature unusable, and "don't save my
		// conversations" means *talk without being recorded*, not *stop talking*.
		setPrivacyPreferencesRow({ saveConversations: false });

		// A UUID: the route validates `:id` before it reaches any privacy logic, so a
		// placeholder like `conv-1` answers 400 and the test would pass for the wrong
		// reason.
		const res = await request(app)
			.post('/api/v1/conversations/550e8400-e29b-41d4-a716-446655440000/messages')
			.set('Authorization', auth())
			.send({ role: 'user', content: 'hello' });

		expect(res.status).toBe(201);
		expect(res.body?.data?.userMessage?.content).toBe('hello');
	});

	it('marks a new session ephemeral rather than storing it', async () => {
		setPrivacyPreferencesRow({ saveConversations: false });

		const res = await request(app)
			.post('/api/v1/conversations')
			.set('Authorization', auth())
			.send({ mode: 'text' });

		expect(res.status).toBe(201);
		expect(res.body?.data?.ephemeral).toBe(true);
	});

	it('does not mark one ephemeral while the switch is on', async () => {
		const res = await request(app)
			.post('/api/v1/conversations')
			.set('Authorization', auth())
			.send({ mode: 'text' });

		expect(res.status).toBe(201);
		expect(res.body?.data?.ephemeral).toBeUndefined();
	});
});

describe('processing modes this deployment cannot provide', () => {
	it('refuses "On-device processing"', async () => {
		// Accepting it would let the app claim the audio never leaves the phone while
		// every turn is still sent to a provider.
		const res = await request(app)
			.patch('/api/v1/settings/privacy')
			.set('Authorization', auth())
			.send({ localProcessing: true });

		expect(res.status).toBe(409);
		expect(JSON.stringify(res.body)).toContain('LOCAL_PROCESSING_UNAVAILABLE');
	});

	it('refuses "Cloud processing: off"', async () => {
		const res = await request(app)
			.patch('/api/v1/settings/privacy')
			.set('Authorization', auth())
			.send({ cloudProcessing: false });

		expect(res.status).toBe(409);
		expect(JSON.stringify(res.body)).toContain('CLOUD_PROCESSING_REQUIRED');
	});

	it('still accepts a patch it can honour', async () => {
		// Otherwise the two refusals above would have broken the whole sheet.
		const res = await request(app)
			.patch('/api/v1/settings/privacy')
			.set('Authorization', auth())
			.send({ saveTranscripts: false, saveRecordings: false });

		expect(res.status).toBe(200);
	});
});
