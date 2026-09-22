/**
 * Verifies the retention sweep against a real Postgres.
 *
 * Why this is a script and not a vitest test: `services/api/src/__tests__/setup.ts`
 * replaces `../db/connection` with an in-memory fake for the entire API suite, so a
 * test there would exercise the fake's `select()` chain and never the SQL that decides
 * what gets deleted. The predicates in `jobs/retention.ts` are the whole point of the
 * feature — `created_at < now() - (days * interval '1 day')` with a `NULL` meaning
 * "never" — so they are proven here, against the same database the API uses.
 *
 * It seeds throwaway users, runs the sweep, asserts the outcome and removes everything
 * it created. Nothing outside those rows is touched: every query is scoped to the
 * generated user ids.
 *
 * Usage (from services/api, with DATABASE_URL set):
 *
 *   node scripts/verify-retention.mjs
 *
 * Exits non-zero on the first failure so it can gate a deploy.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
	audioRecordings,
	getDb,
	getPool,
	privacyPreferences,
	recordingSummaries,
	transcripts,
	users,
} from '@nova/database';
import { runRetentionSweep } from '../src/jobs/retention.ts';

const db = getDb();
const createdUserIds = [];
const results = [];
const DAY = 24 * 60 * 60 * 1000;

function check(name, ok, detail = '') {
	results.push([name, Boolean(ok)]);
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`);
	return Boolean(ok);
}

/** Seeds one user whose auto-delete windows are `recordingDays` / `transcriptDays`. */
async function seed(recordingDays, transcriptDays, ageDays) {
	const [user] = await db
		.insert(users)
		.values({
			email: `retention-verify-${Date.now()}-${randomUUID().slice(0, 8)}@test.example.com`,
			name: 'Retention Verify',
			passwordHash: 'not-a-real-hash',
		})
		.returning();
	createdUserIds.push(user.id);

	await db
		.insert(privacyPreferences)
		.values({ userId: user.id, autoDeleteRecordingsDays: recordingDays, autoDeleteTranscriptsDays: transcriptDays });

	const [recording] = await db
		.insert(audioRecordings)
		.values({
			userId: user.id,
			title: `retention-verify-${randomUUID().slice(0, 8)}`,
			storageKey: `test/retention-verify/${randomUUID()}.wav`,
			createdAt: new Date(Date.now() - ageDays * DAY),
		})
		.returning();

	return { user, recording };
}

/** A deleter that records keys instead of talking to object storage. */
function fakeStorage() {
	const keys = [];
	return {
		keys,
		deleteObject: async (key) => {
			keys.push(key);
			return true;
		},
	};
}

const recordingsDeletedAt = (id) =>
	db
		.select({ deletedAt: audioRecordings.deletedAt })
		.from(audioRecordings)
		.where(eq(audioRecordings.id, id))
		.then((rows) => rows[0]?.deletedAt ?? null);

console.log('verifying the retention sweep against the configured database\n');

try {
	// ── PAST THE WINDOW ────────────────────────────────────────────────────────
	console.log('a recording past its window')
	{
		const { recording } = await seed(30, null, 31);
		const storage = fakeStorage();
		await runRetentionSweep(db, { deleteObject: storage.deleteObject });
		check('is soft-deleted', (await recordingsDeletedAt(recording.id)) !== null);
		check('its stored object was removed', storage.keys.length === 1);
	}

	// ── INSIDE THE WINDOW ─────────────────────────────────────────────────────
	console.log('\na recording inside its window')
	{
		const { recording } = await seed(30, null, 10);
		await runRetentionSweep(db, { deleteObject: fakeStorage().deleteObject });
		check('is left alone', (await recordingsDeletedAt(recording.id)) === null);
	}

	// ── NULL MEANS NEVER ──────────────────────────────────────────────────────
	console.log('\na user who chose "Never"')
	{
		const { recording } = await seed(null, null, 400);
		await runRetentionSweep(db, { deleteObject: fakeStorage().deleteObject });
		check(
			'is never swept, even 400 days old',
			(await recordingsDeletedAt(recording.id)) === null,
		);
	}

	// ── TRANSCRIPTS ───────────────────────────────────────────────────────────
	console.log('\na transcript past its window')
	{
		const { recording } = await seed(null, 7, 400);
		await db.insert(transcripts).values({
			recordingId: recording.id,
			fullText: 'a transcript old enough to be swept',
			createdAt: new Date(Date.now() - 400 * DAY),
		});
		await runRetentionSweep(db, { deleteObject: fakeStorage().deleteObject });
		const left = await db
			.select({ id: transcripts.id })
			.from(transcripts)
			.where(eq(transcripts.recordingId, recording.id));
		check('is deleted', left.length === 0);
	}

	// ── A TRANSCRIPT INSIDE ITS WINDOW IS KEPT ────────────────────────────────
	console.log('\na transcript inside its window')
	{
		const { recording } = await seed(null, 400, 5);
		await db.insert(transcripts).values({
			recordingId: recording.id,
			fullText: 'recent enough to keep',
			createdAt: new Date(Date.now() - 5 * DAY),
		});
		await runRetentionSweep(db, { deleteObject: fakeStorage().deleteObject });
		const left = await db
			.select({ id: transcripts.id })
			.from(transcripts)
			.where(eq(transcripts.recordingId, recording.id));
		check('is kept', left.length === 1);
	}

	// ── STORAGE FAILURE KEEPS THE ROW ─────────────────────────────────────────
	//
	// Two arms, because the first version of this check only exercised the throwing one
	// and that is **not** how the production driver behaves: `deleteAudio` →
	// `s3Driver.remove` catches every error and returns `false`, and returns `false` when
	// object storage is unconfigured. A sweep that only caught throws therefore stamped
	// `deleted_at` on a failed purge and counted it as purged — orphaning the audio,
	// which is the opposite of what the code claimed. The `false` arm is the one that
	// matters, and it is the one that was missing.
	for (const [label, failingDeleter] of [
		['returns false (what deleteAudio actually does)', async () => false],
		['throws', async () => { throw new Error('storage unavailable'); }],
	]) {
		console.log(`\nwhen the object store fails — deleter ${label}`)
		const { recording } = await seed(30, null, 31);
		const result = await runRetentionSweep(db, { deleteObject: failingDeleter });
		check('the failure is counted', result.storageFailures >= 1, `storageFailures=${result.storageFailures}`);
		check(
			'the row is NOT stamped, so the next sweep retries',
			(await recordingsDeletedAt(recording.id)) === null,
		);
	}

	// ── A SUMMARISED TRANSCRIPT IS PURGED ─────────────────────────────────────
	//
	// `recording_summaries.transcript_id` is NO ACTION, so deleting a transcript that has
	// a summary raised 23503 and rolled back the entire batch — silently, into a log
	// line. The pipeline writes a summary whenever "Save transcripts" is on, which is the
	// default, so this is the ordinary case rather than an edge one.
	console.log('\na transcript that has a saved summary')
	{
		const { recording } = await seed(null, 7, 400);
		const [transcript] = await db
			.insert(transcripts)
			.values({
				recordingId: recording.id,
				fullText: 'a transcript old enough to be swept',
				createdAt: new Date(Date.now() - 400 * DAY),
			})
			.returning();
		await db.insert(recordingSummaries).values({
			recordingId: recording.id,
			transcriptId: transcript.id,
			summary: 'a summary that references the transcript',
			decisions: [],
			actionItems: [],
			extractedContacts: [],
		});

		const result = await runRetentionSweep(db, { deleteObject: fakeStorage().deleteObject });
		check('the sweep reports it purged', result.transcriptsPurged >= 1, `purged=${result.transcriptsPurged}`);
		const left = await db
			.select({ id: transcripts.id })
			.from(transcripts)
			.where(eq(transcripts.recordingId, recording.id));
		check('the transcript is gone', left.length === 0, `left=${left.length}`);
		const summaries = await db
			.select({ id: recordingSummaries.id })
			.from(recordingSummaries)
			.where(eq(recordingSummaries.recordingId, recording.id));
		check('and so is its summary, which does not cascade', summaries.length === 0, `left=${summaries.length}`);
	}

	// ── IDEMPOTENT ────────────────────────────────────────────────────────────
	console.log('\na second pass')
	{
		const { recording } = await seed(30, null, 31);
		const storage = fakeStorage();
		const first = await runRetentionSweep(db, { deleteObject: storage.deleteObject });
		check('the first pass deletes', first.recordingsPurged >= 1, `purged=${first.recordingsPurged}`);
		const second = await runRetentionSweep(db, { deleteObject: storage.deleteObject });
		check('the second pass deletes nothing', second.recordingsPurged === 0, `purged=${second.recordingsPurged}`);
		check('and the row is still soft-deleted', (await recordingsDeletedAt(recording.id)) !== null);
	}
} finally {
	if (createdUserIds.length > 0) {
		// `audio_recordings`, `transcripts` and `privacy_preferences` all cascade.
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
