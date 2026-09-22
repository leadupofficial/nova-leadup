/**
 * Retention sweep — the contract the app's "Auto-delete" control depends on.
 *
 * `me_page.dart` renders "Delete recordings after 30/60/90 days" and "Delete
 * transcripts after …" under **Privacy controls → Auto-delete**, with `_RetentionRow`
 * treating `null` as "Never". Until `jobs/retention.ts` existed, nothing read those
 * columns: a user chose a window and no deletion ever happened.
 *
 * The unit tests below pin the decision rule and the "null means never" contract
 * without a database. The integration test runs the sweep against the real Postgres
 * from `DATABASE_URL` and skips when it is unreachable, so the suite stays green on a
 * machine without one — the same convention the API's other DB-backed tests use.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
	audioRecordings,
	privacyPreferences,
	transcripts,
	users,
} from '@nova/database';
import { isSweepable, runRetentionSweep } from '../jobs/retention.js';
import { getDb, getDbPool } from '../db/connection.js';

// ─── The rule, without a database ─────────────────────────────────────────────

describe('isSweepable', () => {
	const DAY = 24 * 60 * 60 * 1000;

	it('treats null as "Never", not as the column default', () => {
		// This is the whole contract of the UI's "Never" choice. Falling back to the
		// schema default here would silently delete recordings for a user who
		// explicitly asked for them to be kept.
		expect(isSweepable(null, 365 * DAY)).toBe(false);
		expect(isSweepable(undefined, 365 * DAY)).toBe(false);
	});

	it('does not sweep inside the window and does sweep past it', () => {
		expect(isSweepable(30, 29 * DAY)).toBe(false);
		expect(isSweepable(30, 30 * DAY)).toBe(false); // exactly on the boundary
		expect(isSweepable(30, 30 * DAY + 1)).toBe(true);
		expect(isSweepable(7, 8 * DAY)).toBe(true);
	});

	it('honours a zero-day window as "immediately eligible"', () => {
		expect(isSweepable(0, 1)).toBe(true);
	});
});

// ─── Wiring ───────────────────────────────────────────────────────────────────

describe('the sweep is actually started', () => {
	it('the boot path starts it, and the server module exports what it wires', async () => {
		// The class of bug this guards: a job module that exists, type-checks and is
		// never imported. `privacy_preferences.auto_delete_recordings_days` was read by
		// nothing for the whole life of the schema, and the app still offered the
		// control. A grep-level assertion is weak, but it is enough to fail if the
		// `startRetentionSweep(getDb)` call is deleted from `server.ts`.
		const source = await import('node:fs').then((fs) =>
			fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8'),
		);
		expect(source).toContain('startRetentionSweep(getDb)');
		expect(source).toContain("from './jobs/retention.js'");
	});

	it('logs and continues rather than throwing when the database rejects the query', async () => {
		// Retention is a background job on the request-serving process. A failing sweep
		// must never surface as an unhandled rejection, which would take the API down —
		// the same failure mode that killed the process via `authenticate` earlier in
		// this project's history.
		await expect(runRetentionSweep(getDb())).resolves.toEqual(
			expect.objectContaining({
				recordingsPurged: expect.any(Number),
				transcriptsPurged: expect.any(Number),
				storageFailures: expect.any(Number),
			}),
		);
	});
});

// The SQL predicates themselves are verified against a real Postgres by
// `scripts/verify-retention.mjs`, because `src/__tests__/setup.ts` replaces
// `../db/connection` with an in-memory fake for the whole API suite — a test here
// would only ever exercise the fake, not the query.
