/**
 * NOVA API — bounds on what a recording may cost (R-07, R-09).
 *
 * Two unbounded reads/writes were confirmed:
 *
 *  * `GET /api/v1/recordings/:id` returned every `transcript_segments` row for the
 *    transcript. A four-hour meeting produces thousands of rows and the whole
 *    set went into one response, with nothing telling the client it had been cut
 *    if it ever were (R-07).
 *  * nothing enforced a maximum recording duration, and `audio_recordings`
 *    accepted any client-reported figure — the create/update schemas had no
 *    ceiling at all and the upload query's was a day (R-09).
 *
 * The duration cap is asserted at both layers: the schema (every write path goes
 * through one of the three) and the route, so the 400 a client actually receives
 * is covered too.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import './setup.js';

import app from '../server.js';
import { getDb } from '../db/connection.js';
import { setAudioStorageDriver } from '../services/audio-storage.js';
import { RECORDING_STATUS } from '../services/recording-pipeline.js';
import {
	CreateRecordingSchema,
	MAX_RECORDING_SECONDS,
	RecordingAudioQuerySchema,
	UpdateRecordingSchema,
} from '../schemas/index.js';
import { MAX_SEGMENTS_PER_RESPONSE } from '../routes/recordings.js';
import {
	AUDIO_KEY,
	RECORDING_ID,
	auth,
	makeDb,
	objects,
	recordingRow,
	resetStorageFixtures,
	type Row,
} from './helpers/recording-fixtures.js';

beforeEach(() => {
	resetStorageFixtures();
});

afterAll(() => setAudioStorageDriver(null));

// ─── R-09: a maximum recording duration ──────────────────────────────────────

describe('the maximum recording duration', () => {
	it('is accepted exactly at the cap and rejected one second past it', () => {
		// Guarded first so the two assertions below cannot pass vacuously on an
		// undefined constant.
		expect(Number.isFinite(MAX_RECORDING_SECONDS)).toBe(true);
		expect(MAX_RECORDING_SECONDS).toBeGreaterThan(0);

		expect(CreateRecordingSchema.safeParse({ title: 'Standup', durationSeconds: MAX_RECORDING_SECONDS }).success).toBe(true);
		expect(CreateRecordingSchema.safeParse({ title: 'Standup', durationSeconds: MAX_RECORDING_SECONDS + 1 }).success).toBe(false);

		expect(UpdateRecordingSchema.safeParse({ durationSeconds: MAX_RECORDING_SECONDS }).success).toBe(true);
		expect(UpdateRecordingSchema.safeParse({ durationSeconds: MAX_RECORDING_SECONDS + 1 }).success).toBe(false);
	});

	it('rejects the day-long figure the upload query used to allow', () => {
		// 86_400 was a placeholder, not a policy: it meant a client could declare a
		// 24-hour meeting and the API would meter and process it as one.
		expect(RecordingAudioQuerySchema.safeParse({ durationSeconds: 86_400 }).success).toBe(false);
		expect(RecordingAudioQuerySchema.safeParse({ durationSeconds: MAX_RECORDING_SECONDS }).success).toBe(true);
	});

	it('refuses an audio upload that declares more than the cap, and stores nothing', async () => {
		const store: Record<string, Row[]> = { audio_recordings: [recordingRow()] };
		vi.mocked(getDb).mockReturnValue(makeDb(store));

		const res = await request(app)
			.post(`/api/v1/recordings/${RECORDING_ID}/audio?durationSeconds=${MAX_RECORDING_SECONDS + 1}`)
			.set(auth())
			.set('Content-Type', 'audio/wav')
			.send(Buffer.from('abc'));

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('VALIDATION_ERROR');
		expect(objects.has(AUDIO_KEY)).toBe(false);
		expect(store.audio_recordings[0].status).toBe(RECORDING_STATUS.processing);
	});

	it('refuses an update that declares more than the cap', async () => {
		const res = await request(app)
			.patch(`/api/v1/recordings/${RECORDING_ID}`)
			.set(auth())
			.send({ durationSeconds: MAX_RECORDING_SECONDS + 1 });

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('VALIDATION_ERROR');
	});
});

// ─── R-07: the detail route's segment list ───────────────────────────────────

/** A detail-route store with `count` segments on one transcript. */
function detailStore(count: number): Record<string, Row[]> {
	return {
		audio_recordings: [recordingRow({ status: RECORDING_STATUS.completed })],
		transcripts: [
			{ id: 'tr-1', recordingId: RECORDING_ID, fullText: 'the whole meeting', language: 'en', createdAt: new Date() },
		],
		transcript_segments: Array.from({ length: count }, (_, index) => ({
			id: `seg-${index}`,
			transcriptId: 'tr-1',
			speakerIndex: 0,
			startMs: index * 1_000,
			endMs: index * 1_000 + 500,
			text: `segment ${index}`,
			confidence: 90,
		})),
		recording_summaries: [],
	};
}

describe('GET /api/v1/recordings/:id segments', () => {
	it('returns every segment when the transcript is small, and says it did not truncate', async () => {
		vi.mocked(getDb).mockReturnValue(makeDb(detailStore(3)));

		const res = await request(app).get(`/api/v1/recordings/${RECORDING_ID}`).set(auth());

		expect(res.status).toBe(200);
		expect(res.body.data.segments).toHaveLength(3);
		expect(res.body.data.segmentsTruncated).toBe(false);
	});

	it('caps the list at the limit and reports the truncation instead of silently dropping rows', async () => {
		const count = MAX_SEGMENTS_PER_RESPONSE + 100;
		vi.mocked(getDb).mockReturnValue(makeDb(detailStore(count)));

		const res = await request(app).get(`/api/v1/recordings/${RECORDING_ID}`).set(auth());

		expect(res.status).toBe(200);
		expect(res.body.data.segments).toHaveLength(MAX_SEGMENTS_PER_RESPONSE);
		expect(res.body.data.segmentsTruncated).toBe(true);
		// The rows returned are the earliest ones, which is how the query orders them.
		expect(res.body.data.segments[0].startMs).toBe(0);
	});

	it('reports truncation as false, not undefined, when there is no transcript at all', async () => {
		vi.mocked(getDb).mockReturnValue(
			makeDb({ audio_recordings: [recordingRow()], transcripts: [], transcript_segments: [], recording_summaries: [] }),
		);

		const res = await request(app).get(`/api/v1/recordings/${RECORDING_ID}`).set(auth());

		expect(res.status).toBe(200);
		expect(res.body.data.segments).toEqual([]);
		expect(res.body.data.segmentsTruncated).toBe(false);
	});
});
