/**
 * NOVA API — the recording lifecycle reaper (R-05, R-10, R-09).
 *
 * `enqueueRecordingProcessing` runs the pipeline in-process, after the response,
 * with no durable queue. Three non-terminal states therefore have no owner once
 * the process or the client that created them goes away:
 *
 *  * `processing` — the process died mid-run. The retention sweep selects by age
 *    only, so nothing retries the row and the audio is eventually deleted with no
 *    transcript ever produced (R-05).
 *  * `uploaded` — the client died between the audio upload and `/process`. Nothing
 *    server-side ever picks it up (R-10).
 *  * `recording` — the client died mid-capture. Nothing closes the row (R-09).
 *
 * The tests below pin the decision rule (no database), then drive the sweep
 * against the in-memory store so the recovery itself — re-enqueue versus close at
 * `failed` — is asserted, not just described.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import './setup.js';

import { getDb } from '../db/connection.js';
import {
	RECORDING_STATUS,
	resetPipelineState,
	runRecordingPipeline,
} from '../services/recording-pipeline.js';
import {
	REAPER_DEADLINES,
	isStaleForReaper,
	runRecordingReaper,
} from '../jobs/recording-reaper.js';
import {
	AUDIO_KEY,
	RECORDING_ID,
	USER_ID,
	makeDb,
	objects,
	recordingRow,
	resetStorageFixtures,
	type Row,
} from './helpers/recording-fixtures.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** One recording row whose state was last written `ageMs` ago. */
function aged(status: string, ageMs: number, overrides: Row = {}): Row {
	return recordingRow({
		status,
		updatedAt: new Date(NOW.getTime() - ageMs),
		...overrides,
	});
}

/** Lets every pending microtask and `setImmediate` callback run. */
async function settle(times = 5): Promise<void> {
	for (let i = 0; i < times; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

beforeEach(() => {
	resetPipelineState();
	resetStorageFixtures();
});

// ─── The rule, without a database ────────────────────────────────────────────

describe('isStaleForReaper', () => {
	it('treats a state that has not moved beyond its deadline as recoverable-but-not-yet', () => {
		expect(isStaleForReaper(RECORDING_STATUS.uploaded, new Date(NOW.getTime() - 10 * MINUTE), NOW)).toBe(false);
		expect(isStaleForReaper(RECORDING_STATUS.processing, new Date(NOW.getTime() - 59 * MINUTE), NOW)).toBe(false);
		expect(isStaleForReaper(RECORDING_STATUS.recording, new Date(NOW.getTime() - 23 * HOUR), NOW)).toBe(false);
	});

	it('reports each non-terminal state stale once its deadline has passed', () => {
		expect(isStaleForReaper(RECORDING_STATUS.uploaded, new Date(NOW.getTime() - (REAPER_DEADLINES.uploaded + MINUTE)), NOW)).toBe(true);
		expect(isStaleForReaper(RECORDING_STATUS.processing, new Date(NOW.getTime() - (REAPER_DEADLINES.processing + MINUTE)), NOW)).toBe(true);
		expect(isStaleForReaper(RECORDING_STATUS.recording, new Date(NOW.getTime() - (REAPER_DEADLINES.recording + MINUTE)), NOW)).toBe(true);
	});

	it('never treats a terminal state as stale, however old it is', () => {
		// `completed` and `failed` are what the client polls for. Re-opening either
		// would be the reaper inventing work nobody asked for.
		expect(isStaleForReaper(RECORDING_STATUS.completed, new Date(NOW.getTime() - 365 * 24 * HOUR), NOW)).toBe(false);
		expect(isStaleForReaper(RECORDING_STATUS.failed, new Date(NOW.getTime() - 365 * 24 * HOUR), NOW)).toBe(false);
		expect(isStaleForReaper('totally-made-up', new Date(0), NOW)).toBe(false);
	});
});

// ─── The sweep ───────────────────────────────────────────────────────────────

describe('runRecordingReaper', () => {
	it('adopts an `uploaded` row that was never processed (R-10)', async () => {
		const store: Record<string, Row[]> = { audio_recordings: [aged(RECORDING_STATUS.uploaded, 20 * MINUTE)] };
		objects.set(AUDIO_KEY, Buffer.from('audio-bytes'));
		vi.mocked(getDb).mockReturnValue(makeDb(store));
		const requeue = vi.fn();

		const result = await runRecordingReaper(makeDb(store), { now: NOW, requeue });

		expect(requeue).toHaveBeenCalledWith(RECORDING_ID, USER_ID);
		expect(result.requeued).toBe(1);
		expect(result.failed).toBe(0);
		// The reaper does not write `processing` itself; the pipeline's first
		// transition does. What matters is that an owner was handed the row.
		expect(store.audio_recordings[0].status).toBe(RECORDING_STATUS.uploaded);
	});

	it('retries a `processing` row whose run died with the process (R-05)', async () => {
		const store: Record<string, Row[]> = { audio_recordings: [aged(RECORDING_STATUS.processing, 2 * HOUR)] };
		objects.set(AUDIO_KEY, Buffer.from('audio-bytes'));
		vi.mocked(getDb).mockReturnValue(makeDb(store));
		const requeue = vi.fn();

		const result = await runRecordingReaper(makeDb(store), { now: NOW, requeue });

		expect(requeue).toHaveBeenCalledWith(RECORDING_ID, USER_ID);
		expect(result.requeued).toBe(1);
	});

	it('leaves a `processing` row alone while it is still inside its deadline', async () => {
		// This is what stops the reaper from double-running a healthy pipeline: a
		// transcription that is merely slow must not be restarted underneath itself.
		const store: Record<string, Row[]> = { audio_recordings: [aged(RECORDING_STATUS.processing, 5 * MINUTE)] };
		objects.set(AUDIO_KEY, Buffer.from('audio-bytes'));
		vi.mocked(getDb).mockReturnValue(makeDb(store));
		const requeue = vi.fn();

		const result = await runRecordingReaper(makeDb(store), { now: NOW, requeue });

		expect(requeue).not.toHaveBeenCalled();
		expect(result.requeued).toBe(0);
		expect(result.failed).toBe(0);
		expect(store.audio_recordings[0].status).toBe(RECORDING_STATUS.processing);
	});

	it('closes a row at `failed` when its audio is gone, instead of re-queueing a run that could only fail', async () => {
		const store: Record<string, Row[]> = { audio_recordings: [aged(RECORDING_STATUS.uploaded, 20 * MINUTE)] };
		vi.mocked(getDb).mockReturnValue(makeDb(store));
		const requeue = vi.fn();

		const result = await runRecordingReaper(makeDb(store), { now: NOW, requeue });

		expect(requeue).not.toHaveBeenCalled();
		expect(result.failed).toBe(1);
		expect(store.audio_recordings[0].status).toBe(RECORDING_STATUS.failed);
	});

	it('closes a stale `recording` row that never finished capture (R-09)', async () => {
		const store: Record<string, Row[]> = { audio_recordings: [aged(RECORDING_STATUS.recording, 25 * HOUR)] };
		vi.mocked(getDb).mockReturnValue(makeDb(store));
		const requeue = vi.fn();

		const result = await runRecordingReaper(makeDb(store), { now: NOW, requeue });

		expect(result.failed).toBe(1);
		expect(requeue).not.toHaveBeenCalled();
		expect(store.audio_recordings[0].status).toBe(RECORDING_STATUS.failed);
	});

	it('skips a stale row that this process is already running', async () => {
		// The clock is the real one here: starting the run stamps `updated_at` with
		// the wall clock, so a pinned `NOW` in the past would make the row look fresh
		// for the wrong reason.
		const live = new Date();
		const store: Record<string, Row[]> = {
			audio_recordings: [
				recordingRow({ status: RECORDING_STATUS.processing, updatedAt: new Date(live.getTime() - 2 * HOUR) }),
			],
			transcripts: [],
			transcript_segments: [],
			recording_summaries: [],
		};
		objects.set(AUDIO_KEY, Buffer.from('audio-bytes'));
		vi.mocked(getDb).mockReturnValue(makeDb(store));

		let release: (() => void) | null = null;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const transcriber = vi.fn(async () => {
			await gate;
			return { transcript: 'hello', confidence: 1, language: 'en', provider: 'deepgram' };
		});

		const run = runRecordingPipeline(RECORDING_ID, USER_ID, { transcriber });
		await settle();
		expect(transcriber).toHaveBeenCalled();

		// The pipeline stamps `updated_at` once, when the run starts, and never
		// heartbeats — so a run that has been inside a long transcription past its
		// deadline looks exactly like this from the database.
		store.audio_recordings[0].updatedAt = new Date(live.getTime() - 2 * HOUR);

		const requeue = vi.fn();
		const result = await runRecordingReaper(makeDb(store), { now: live, requeue });

		expect(requeue).not.toHaveBeenCalled();
		expect(result.skipped).toBe(1);

		release!();
		await run;
	});

	it('records *why* it closed the row, not just that it did', async () => {
		// `setStatus` already spread an `extra` object, but `fail()` never used it,
		// so a failed recording reached the client as a bare status. The reason is
		// the only thing that tells the user whether to retry the upload or start
		// over, and it is the value the failure was logged with internally.
		const store: Record<string, Row[]> = { audio_recordings: [aged(RECORDING_STATUS.uploaded, 20 * MINUTE)] };
		vi.mocked(getDb).mockReturnValue(makeDb(store));

		await runRecordingReaper(makeDb(store), { now: NOW, requeue: vi.fn() });

		expect(store.audio_recordings[0].status).toBe(RECORDING_STATUS.failed);
		expect(store.audio_recordings[0].failureReason).toBe('audio-missing-after-upload');
	});

	it('records the abandoned-capture reason for a stale `recording` row', async () => {
		const store: Record<string, Row[]> = { audio_recordings: [aged(RECORDING_STATUS.recording, 25 * HOUR)] };
		vi.mocked(getDb).mockReturnValue(makeDb(store));

		await runRecordingReaper(makeDb(store), { now: NOW, requeue: vi.fn() });

		expect(store.audio_recordings[0].failureReason).toBe('capture-abandoned');
	});

	it('never throws when the database refuses the read', async () => {
		// A background job that can take the API process down is worse than a job
		// that does nothing.
		const broken = {
			select: () => ({
				from: () => ({
					where: () => ({ limit: () => Promise.reject(new Error('db down')) }),
				}),
			}),
		} as unknown as ReturnType<typeof getDb>;

		await expect(runRecordingReaper(broken, { now: NOW })).resolves.toMatchObject({
			examined: 0,
			requeued: 0,
			failed: 0,
			skipped: 0,
		});
	});
});

// ─── Wiring ──────────────────────────────────────────────────────────────────

describe('the reaper is actually started', () => {
	it('the boot path starts it, and the server module imports it', async () => {
		// The class of bug this guards: a job module that exists, type-checks and is
		// never imported. Nothing else would ever call `runRecordingReaper`, so the
		// whole recovery would be dead code.
		const source = await import('node:fs').then((fs) =>
			fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8'),
		);
		expect(source).toContain('startRecordingReaper(getDb)');
		expect(source).toContain("from './jobs/recording-reaper.js'");
	});
});
