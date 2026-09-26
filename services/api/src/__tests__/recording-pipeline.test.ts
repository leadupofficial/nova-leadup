/**
 * NOVA API — the meeting-capture pipeline and its HTTP surface.
 *
 * A full pipeline run is asserted end to end against an in-memory database and
 * object store, and the routes are driven through supertest. What matters here
 * is that the recording's `status` stays honest: an upload that storage refused
 * is never marked stored, a recording with no audio behind it is never queued
 * for transcription, and a failed run ends at `failed` rather than at
 * `completed` with an empty summary.
 *
 * The guard and the composer themselves are covered by `meeting-summary.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { getTableName } from 'drizzle-orm';
import './setup.js';

import app from '../server.js';
import { getDb } from '../db/connection.js';
import { chatCompletion } from '../services/ai.js';
import { AudioStorageError, setAudioStorageDriver } from '../services/audio-storage.js';
import {
	MEETING_SUMMARY_CAPABILITIES,
	NO_SPEECH_SUMMARY_TEXT,
} from '../services/meeting-summary.js';
import {
	RECORDING_STATUS,
	resetPipelineState,
	runRecordingPipeline,
} from '../services/recording-pipeline.js';
import { DEVICE_CONTROL_TOOL_LEVELS, deviceControlActionLevel } from '../services/assistant-tools.js';
import {
	AUDIO_KEY,
	OTHER_USER_ID,
	RECORDING_ID,
	USER_ID,
	auth,
	emptyDb,
	makeDb,
	memoryDriver,
	objects,
	recordingRow,
	resetStorageFixtures,
	storageFlags,
	type Row,
} from './helpers/recording-fixtures.js';

afterAll(() => setAudioStorageDriver(null));

beforeEach(() => {
	vi.mocked(chatCompletion).mockReset();
	resetPipelineState();
	resetStorageFixtures();
});

// ─── 4. The pipeline ─────────────────────────────────────────────────────────

const SPOKEN = 'We agreed to drop the onboarding fee. Ravi will send the updated deck by Friday.';

function storeFor(overrides: Row = {}): Record<string, Row[]> {
	return {
		audio_recordings: [recordingRow(overrides)],
		transcripts: [],
		transcript_segments: [],
		recording_summaries: [],
	};
}

/**
 * A database whose `select(projection)` returns *only* the projected keys.
 *
 * `makeDb` hands back the whole row whichever columns were asked for, so a route
 * test built on it passes even when the projection is missing a field — which is
 * exactly the change under test for `failureReason`. This one honours the
 * projection object's own keys, which is what a real driver returns.
 */
function projectingDb(recordings: Row[]): ReturnType<typeof getDb> {
	const tables: Record<string, Row[]> = {
		audio_recordings: recordings,
		transcripts: [],
		recording_summaries: [],
		transcript_segments: [],
	};
	const select = (selection?: Record<string, unknown>): unknown => {
		let rows: Row[] = [];
		const q: Record<string, unknown> = {};
		for (const method of ['from', 'where', 'orderBy', 'limit', 'offset']) {
			q[method] = (table?: unknown) => {
				if (method === 'from' && table) rows = tables[getTableName(table as never)] ?? [];
				return q;
			};
		}
		const projected = (): Row[] =>
			selection
				? rows.map((row) => Object.fromEntries(Object.keys(selection).map((key) => [key, row[key]])))
				: rows;
		q.then = (ok: unknown) => Promise.resolve(projected()).then(ok as never);
		q.catch = (no: unknown) => Promise.resolve(projected()).then(undefined as never, no as never);
		return q;
	};
	return { select } as unknown as ReturnType<typeof getDb>;
}

describe('runRecordingPipeline', () => {
	it('transcribes, stores the transcript and summary, and completes the recording', async () => {
		const store = storeFor();
		objects.set(AUDIO_KEY, Buffer.from('audio-bytes'));
		vi.mocked(getDb).mockReturnValue(makeDb(store));
		const transcriber = vi.fn(async () => ({
			transcript: SPOKEN,
			confidence: 0.95,
			language: 'en',
			provider: 'deepgram',
			words: [
				{ word: 'We', startSeconds: 0, endSeconds: 0.2, confidence: 0.9 },
				{ word: 'agreed', startSeconds: 0.2, endSeconds: 0.6, confidence: 0.9 },
				{ word: 'to', startSeconds: 0.6, endSeconds: 0.7, confidence: 0.9 },
				{ word: 'drop', startSeconds: 0.7, endSeconds: 1, confidence: 0.9 },
				{ word: 'the', startSeconds: 1, endSeconds: 1.1, confidence: 0.9 },
				{ word: 'onboarding', startSeconds: 1.1, endSeconds: 1.6, confidence: 0.9 },
				{ word: 'fee.', startSeconds: 1.6, endSeconds: 2, confidence: 0.9 },
			],
		}));

		const result = await runRecordingPipeline(RECORDING_ID, USER_ID, { transcriber });

		expect(result.status).toBe(RECORDING_STATUS.completed);
		expect(store.transcripts[0].fullText).toBe(SPOKEN);
		expect(store.transcript_segments.length).toBeGreaterThan(0);
		expect(store.transcript_segments.every((s) => s.speakerIndex === 0)).toBe(true);
		expect(store.recording_summaries[0].recordingId).toBe(RECORDING_ID);
		expect(String(store.recording_summaries[0].summary)).toContain('agreed to drop the onboarding fee');
		expect(store.audio_recordings[0].status).toBe(RECORDING_STATUS.completed);
		expect(store.audio_recordings[0].completedAt).toBeInstanceOf(Date);
	});

	it('writes an honest "no speech" summary when the audio contains nothing', async () => {
		const store = storeFor();
		objects.set(AUDIO_KEY, Buffer.from('silence'));
		vi.mocked(getDb).mockReturnValue(makeDb(store));
		const transcriber = vi.fn(async () => ({
			transcript: '',
			confidence: 0,
			language: 'en',
			provider: 'deepgram',
		}));

		const result = await runRecordingPipeline(RECORDING_ID, USER_ID, { transcriber });

		expect(result.summarySource).toBe('no-speech');
		expect(store.recording_summaries[0].summary).toBe(NO_SPEECH_SUMMARY_TEXT);
		expect(store.recording_summaries[0].decisions).toEqual([]);
		expect(store.recording_summaries[0].actionItems).toEqual([]);
		expect(chatCompletion).not.toHaveBeenCalled();
	});

	it('marks the recording failed — never completed — when the audio cannot be read', async () => {
		const store = storeFor();
		storageFlags.rejectReads = true;
		vi.mocked(getDb).mockReturnValue(makeDb(store));

		const result = await runRecordingPipeline(RECORDING_ID, USER_ID);

		expect(result.status).toBe(RECORDING_STATUS.failed);
		expect(result.failureReason).toBe('audio-unreadable');
		expect(store.audio_recordings[0].status).toBe(RECORDING_STATUS.failed);
		expect(store.recording_summaries).toEqual([]);
	});

	it('clears a previous failure reason when a re-run succeeds', async () => {
		// A failed recording can be re-processed. Without clearing the column, a row
		// that is `completed` would still carry the reason from its earlier failure —
		// the app would show a completed recording with "why it failed".
		const store = storeFor({ status: RECORDING_STATUS.failed, failureReason: 'audio-unreadable' });
		objects.set(AUDIO_KEY, Buffer.from('audio-bytes'));
		vi.mocked(getDb).mockReturnValue(makeDb(store));
		const transcriber = vi.fn(async () => ({
			transcript: SPOKEN,
			confidence: 0.95,
			language: 'en',
			provider: 'deepgram',
		}));

		const result = await runRecordingPipeline(RECORDING_ID, USER_ID, { transcriber });

		expect(result.status).toBe(RECORDING_STATUS.completed);
		expect(store.audio_recordings[0].failureReason).toBeNull();
	});

	it('marks the recording failed when transcription throws', async () => {
		const store = storeFor();
		objects.set(AUDIO_KEY, Buffer.from('audio'));
		vi.mocked(getDb).mockReturnValue(makeDb(store));
		const transcriber = vi.fn(async () => {
			throw new Error('provider down');
		});

		const result = await runRecordingPipeline(RECORDING_ID, USER_ID, { transcriber });

		expect(result.status).toBe(RECORDING_STATUS.failed);
		expect(store.recording_summaries).toEqual([]);
	});
});

// ─── 5. The HTTP surface ─────────────────────────────────────────────────────

describe('GET /api/v1/recordings/capabilities', () => {
	it('requires a token', async () => {
		expect((await request(app).get('/api/v1/recordings/capabilities')).status).toBe(401);
	});

	it('states plainly that diarisation is unavailable', async () => {
		const res = await request(app).get('/api/v1/recordings/capabilities').set(auth());

		expect(res.status).toBe(200);
		expect(res.body.data.diarisation).toBe(false);
		expect(res.body.data.liveTranscription).toBe(false);
		expect(res.body.data.transcription).toBe('async');
		expect(res.body.data.objectStorage).toBe(true);
		expect(res.body.data.reason.diarisation).toMatch(/not configured/);
		expect(MEETING_SUMMARY_CAPABILITIES.decisions).toBe(true);
	});

	it('reports storage as absent when the deployment has no object store', async () => {
		storageFlags.capabilities = { objectStorage: false, endpoint: null, bucket: null, maxUploadBytes: 1 };

		const res = await request(app).get('/api/v1/recordings/capabilities').set(auth());

		expect(res.body.data.objectStorage).toBe(false);
		expect(res.body.data.reason.objectStorage).toMatch(/cannot be uploaded/);
	});
});

describe('POST /api/v1/recordings/:id/audio', () => {
	it('returns 401 without a token', async () => {
		const res = await request(app)
			.post(`/api/v1/recordings/${RECORDING_ID}/audio`)
			.set('Content-Type', 'audio/wav')
			.send(Buffer.from('abc'));
		expect(res.status).toBe(401);
	});

	it('returns 404 for a recording that is not the caller’s', async () => {
		vi.mocked(getDb).mockReturnValueOnce(emptyDb());

		const res = await request(app)
			.post(`/api/v1/recordings/${RECORDING_ID}/audio`)
			.set(auth(OTHER_USER_ID))
			.set('Content-Type', 'audio/wav')
			.send(Buffer.from('abc'));
		expect(res.status).toBe(404);
	});

	it('refuses a content type that is not audio', async () => {
		vi.mocked(getDb).mockReturnValue(makeDb({ audio_recordings: [recordingRow()] }));

		const res = await request(app)
			.post(`/api/v1/recordings/${RECORDING_ID}/audio`)
			.set(auth())
			.set('Content-Type', 'text/plain')
			.send('not really audio');

		expect(res.status).toBe(415);
		expect(res.body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
		expect(objects.size).toBe(0);
	});

	it('stores the audio and moves the row to uploaded with the real object key', async () => {
		const store = { audio_recordings: [recordingRow()] };
		vi.mocked(getDb).mockReturnValue(makeDb(store));

		const res = await request(app)
			.post(`/api/v1/recordings/${RECORDING_ID}/audio?durationSeconds=95`)
			.set(auth())
			.set('Content-Type', 'audio/wav')
			.send(Buffer.from('abc'));

		expect(res.status).toBe(200);
		expect(res.body.data.storage).toMatchObject({ objectStorage: true, bytes: 3, key: AUDIO_KEY });
		expect(objects.has(AUDIO_KEY)).toBe(true);
		expect(store.audio_recordings[0].status).toBe(RECORDING_STATUS.uploaded);
		expect(store.audio_recordings[0].durationSeconds).toBe(95);
	});

	it('answers 503 and leaves the row untouched when object storage refuses the write', async () => {
		const store = { audio_recordings: [recordingRow({ status: RECORDING_STATUS.recording })] };
		vi.mocked(getDb).mockReturnValue(makeDb(store));
		setAudioStorageDriver({
			...memoryDriver,
			async put() {
				throw new AudioStorageError('The recording could not be saved to storage.', 'unavailable');
			},
		});

		const res = await request(app)
			.post(`/api/v1/recordings/${RECORDING_ID}/audio`)
			.set(auth())
			.set('Content-Type', 'audio/wav')
			.send(Buffer.from('abc'));

		expect(res.status).toBe(503);
		expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
		// Nothing may claim the audio was stored.
		expect(store.audio_recordings[0].status).toBe(RECORDING_STATUS.recording);
		expect(store.audio_recordings[0].storageChecksum).toBeUndefined();
	});
});

/**
 * superagent has no parser for `audio/*`, so the raw response is buffered here.
 * A download test must compare the exact bytes, not a decoded approximation.
 */
function binaryParser(
	res: request.Response,
	callback: (err: Error | null, body?: Buffer) => void,
): void {
	const chunks: Buffer[] = [];
	res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
	res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('GET /api/v1/recordings/:id/audio', () => {
	it('returns 401 without a token', async () => {
		const res = await request(app).get(`/api/v1/recordings/${RECORDING_ID}/audio`);
		expect(res.status).toBe(401);
	});

	it('returns 404 for a recording that is not the caller’s', async () => {
		vi.mocked(getDb).mockReturnValueOnce(emptyDb());

		const res = await request(app)
			.get(`/api/v1/recordings/${RECORDING_ID}/audio`)
			.set(auth(OTHER_USER_ID));
		expect(res.status).toBe(404);
	});

	it('returns the stored bytes with the container type recovered from the key', async () => {
		// The read half of the upload route. It was never registered, so this
		// download answered 404 even when the object was demonstrably in storage.
		const payload = Buffer.from('RIFF....exact-audio-bytes');
		const store = { audio_recordings: [recordingRow({ status: RECORDING_STATUS.uploaded })] };
		objects.set(AUDIO_KEY, payload);
		vi.mocked(getDb).mockReturnValue(makeDb(store));

		const res = await request(app)
			.get(`/api/v1/recordings/${RECORDING_ID}/audio`)
			.set(auth())
			.buffer(true)
			.parse(binaryParser);

		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toContain('audio/wav');
		expect(res.headers['content-length']).toBe(String(payload.length));
		const body = res.body as Buffer;
		expect(body.length).toBe(payload.length);
		// The bytes must come back byte-for-byte, which the checksum states in one go.
		expect(createHash('sha256').update(body).digest('hex'))
			.toBe(createHash('sha256').update(payload).digest('hex'));
	});

	it('answers 404 when the row exists but the object does not', async () => {
		// A placeholder key is not an object, so the download must not invent audio.
		const store = { audio_recordings: [recordingRow()] };
		vi.mocked(getDb).mockReturnValue(makeDb(store));

		const res = await request(app)
			.get(`/api/v1/recordings/${RECORDING_ID}/audio`)
			.set(auth());
		expect(res.status).toBe(404);
		expect(res.body.code).toBe('NOT_FOUND');
	});

	it('answers 503 when the object store is unreachable', async () => {
		const store = { audio_recordings: [recordingRow({ status: RECORDING_STATUS.uploaded })] };
		objects.set(AUDIO_KEY, Buffer.from('audio'));
		storageFlags.rejectReads = true;
		vi.mocked(getDb).mockReturnValue(makeDb(store));

		const res = await request(app)
			.get(`/api/v1/recordings/${RECORDING_ID}/audio`)
			.set(auth());
		expect(res.status).toBe(503);
		expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
	});
});

describe('POST /api/v1/recordings/:id/process', () => {
	it('returns 401 without a token', async () => {
		expect((await request(app).post(`/api/v1/recordings/${RECORDING_ID}/process`)).status).toBe(401);
	});

	it('refuses to queue a recording with no audio behind it', async () => {
		vi.mocked(getDb).mockReturnValue(makeDb({ audio_recordings: [recordingRow()] }));

		const res = await request(app)
			.post(`/api/v1/recordings/${RECORDING_ID}/process`)
			.set(auth())
			.send({});

		expect(res.status).toBe(409);
		expect(res.body.code).toBe('NO_AUDIO');
	});

	it('answers 202 with processing and starts the work out of band', async () => {
		const store = { audio_recordings: [recordingRow()] };
		objects.set(AUDIO_KEY, Buffer.from('audio'));
		vi.mocked(getDb).mockReturnValue(makeDb(store));
		const res = await request(app)
			.post(`/api/v1/recordings/${RECORDING_ID}/process`)
			.set(auth())
			.send({});

		expect(res.status).toBe(202);
		expect(res.body.data).toEqual({
			recordingId: RECORDING_ID,
			status: RECORDING_STATUS.processing,
		});
	});

	it('returns 404 for a recording that is not the caller’s', async () => {
		vi.mocked(getDb).mockReturnValueOnce(emptyDb());

		const res = await request(app)
			.post(`/api/v1/recordings/${RECORDING_ID}/process`)
			.set(auth(OTHER_USER_ID))
			.send({});
		expect(res.status).toBe(404);
	});
});

// ─── 5b. Why a recording failed reaches the client ───────────────────────────

describe('GET /api/v1/recordings/:id — a failed recording', () => {
	it('returns the reason it failed, not only the status', async () => {
		// The reaper now writes `failure_reason`; this asserts the other half —
		// that the column is in the projection both reads use, so the app can tell
		// the user what actually happened instead of just "failed".
		vi.mocked(getDb).mockReturnValue(
			projectingDb([
				recordingRow({
					status: RECORDING_STATUS.failed,
					failureReason: 'audio-missing-after-upload',
				}),
			]),
		);

		const res = await request(app).get(`/api/v1/recordings/${RECORDING_ID}`).set(auth());

		expect(res.status).toBe(200);
		expect(res.body.data.recording.status).toBe(RECORDING_STATUS.failed);
		expect(res.body.data.recording.failureReason).toBe('audio-missing-after-upload');
	});

	it('does not invent a reason for a recording that completed', async () => {
		vi.mocked(getDb).mockReturnValue(
			projectingDb([recordingRow({ status: RECORDING_STATUS.completed, failureReason: null })]),
		);

		const res = await request(app).get(`/api/v1/recordings/${RECORDING_ID}`).set(auth());

		expect(res.status).toBe(200);
		expect(res.body.data.recording.failureReason).toBeNull();
	});
});

// ─── 6. Voice-triggered start/stop is registered at the right level ──────────

describe('device-control levels for recording', () => {
	it('rates starting a recording as sensitive and stopping it as low-risk', () => {
		// §9.5/§15.4: recording is off by default, explicit, and visibly active.
		// Starting opens the microphone on the people in the room, so it is L3 —
		// above any configured threshold, and therefore always confirmed.
		expect(deviceControlActionLevel('start_recording')).toBe(3);
		expect(deviceControlActionLevel('stop_recording')).toBe(1);
	});

	it('classifies every device action, so none can default to unconfirmed', () => {
		for (const [name, level] of Object.entries(DEVICE_CONTROL_TOOL_LEVELS)) {
			expect(deviceControlActionLevel(name), `${name} must carry its declared level`).toBe(level);
		}
	});
});
