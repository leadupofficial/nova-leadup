/**
 * NOVA API — the recording capture pipeline's HTTP surface.
 *
 * Three routes, split out of `recordings.ts` so neither file is longer than a
 * reviewer will read in one sitting. They are the write half of requirement 6b:
 *
 *   * `GET /capabilities` — what this deployment can honestly do (async only, no
 *     diarisation, whether object storage is configured). Registered before
 *     `/:id` in the parent router, which would otherwise match the literal
 *     "capabilities" and answer 400 INVALID_ID.
 *   * `POST /:id/audio` — stores the recorded bytes and moves the row to
 *     `uploaded`, and only after the store has confirmed the write.
 *   * `POST /:id/process` — starts transcription and summarisation **out of
 *     band** and answers 202 immediately (§4.1: post-hoc, not live).
 *
 * The work itself lives in `services/recording-pipeline.ts`.
 */
import express, { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { audioRecordings } from '@nova/database';
import { eq, and, isNull, notInArray } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import {
	RecordingAudioQuerySchema,
	ProcessRecordingSchema,
} from '../schemas/index.js';
import {
	AudioStorageError,
	MAX_AUDIO_BYTES,
	audioExists,
	audioStorageCapabilities,
	buildAudioKey,
	contentTypeForKey,
	getAudio,
	isSupportedAudioType,
	normaliseContentType,
	putAudio,
} from '../services/audio-storage.js';
import { MEETING_SUMMARY_CAPABILITIES } from '../services/meeting-summary.js';
import {
	RECORDING_STATUS,
	enqueueRecordingProcessing,
} from '../services/recording-pipeline.js';
import { parseRecordingId, toClientRecording } from './recordings-shared.js';

const router: ReturnType<typeof Router> = Router();

// ─── Capabilities ────────────────────────────────────────────────────────────
//
// Registered before `/:id`, which would otherwise match the literal
// "capabilities" and answer 400 INVALID_ID. The client renders §5.11/§5.12 from
// these flags, so the screen says "no speaker detection" rather than showing a
// number nobody measured.

router.get('/capabilities', authenticate, (_req: AuthenticatedRequest, res) => {
	const storage = audioStorageCapabilities();
	res.status(200).json({
		success: true,
		data: {
			...MEETING_SUMMARY_CAPABILITIES,
			objectStorage: storage.objectStorage,
			storageEndpoint: storage.endpoint,
			storageBucket: storage.bucket,
			maxUploadBytes: storage.maxUploadBytes,
			reason: {
				diarisation:
					'Speaker separation is a separately billed provider capability that is not configured here, so no speaker count or percentage is produced.',
				objectStorage: storage.objectStorage
					? null
					: 'Object storage is not configured on this server, so recorded audio cannot be uploaded or transcribed.',
			},
		},
	});
});

// ─── Audio upload ────────────────────────────────────────────────────────────

/**
 * Stores one recording's audio.
 *
 * The body is the **audio itself**, not JSON: a `Content-Type: audio/wav`
 * request is parsed by `express.raw` into a Buffer, which avoids base64's 33%
 * overhead and keeps a real meeting inside one request. Metadata that has
 * nowhere else to go rides in the query string
 * ([RecordingAudioQuerySchema]).
 *
 * The row is only moved to `uploaded` after the object store has confirmed the
 * write. A storage failure is a 503 with an honest message and **no** state
 * change, because marking a recording uploaded when it was not would be a lie
 * about the one thing the user cares about.
 */
router.post(
	'/:id/audio',
	authenticate,
	express.raw({
		type: ['audio/*', 'application/octet-stream'],
		limit: MAX_AUDIO_BYTES,
	}),
	validate(RecordingAudioQuerySchema, 'query'),
	async (req: AuthenticatedRequest, res, next) => {
		try {
			const id = parseRecordingId(req.params.id);
			const db = getDb();
			const userId = req.user!.id;

			const [existing] = await db.select().from(audioRecordings)
				.where(and(
					eq(audioRecordings.id, id),
					eq(audioRecordings.userId, userId),
					isNull(audioRecordings.deletedAt),
				))
				.limit(1);
			if (!existing) {
				throw new HttpError(404, 'Recording not found', 'NOT_FOUND');
			}

			const headerType = normaliseContentType(String(req.headers['content-type'] ?? ''));
			const contentType = headerType === 'application/octet-stream'
				? 'audio/wav'
				: headerType;
			if (!isSupportedAudioType(contentType)) {
				throw new HttpError(
					415,
					`Unsupported audio type "${headerType}". Send audio/wav, audio/mp4, audio/mpeg, audio/webm, audio/ogg or audio/flac.`,
					'UNSUPPORTED_MEDIA_TYPE',
				);
			}

			if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
				throw new HttpError(
					400,
					'Send the recorded audio as the raw request body with an audio Content-Type.',
					'EMPTY_AUDIO',
				);
			}

			const query = (req as unknown as { validatedQuery?: z.infer<typeof RecordingAudioQuerySchema> }).validatedQuery
				?? (req.query as unknown as z.infer<typeof RecordingAudioQuerySchema>);

			const key = buildAudioKey(userId, id, contentType);
			let stored;
			try {
				stored = await putAudio(key, req.body, contentType);
			} catch (err) {
				if (err instanceof AudioStorageError) {
					const status = err.code === 'too_large' ? 413 : 503;
					throw new HttpError(
						status,
						err.message,
						err.code === 'too_large' ? 'PAYLOAD_TOO_LARGE' : 'STORAGE_UNAVAILABLE',
					);
				}
				throw err;
			}

			const now = new Date();
			const [updated] = await db.update(audioRecordings)
				.set({
					storageKey: stored.key,
					storageChecksum: stored.checksum,
					status: RECORDING_STATUS.uploaded,
					...(typeof query.durationSeconds === 'number'
						? { durationSeconds: query.durationSeconds }
						: {}),
					...(query.language ? { language: query.language } : {}),
					updatedAt: now,
				})
				.where(and(eq(audioRecordings.id, id), eq(audioRecordings.userId, userId)))
				.returning();

			logger.info(
				{ recordingId: id, userId, bytes: stored.bytes, key: stored.key },
				'Recording audio uploaded',
			);

			res.status(200).json({
				success: true,
				data: {
					// Projected, not the raw row: `returning()` hands back every column,
					// including `storageKey` and `tenantId`. The `storage` envelope below
					// is the deliberate part of this contract; the extra columns were not.
					recording: toClientRecording(updated ?? existing),
					storage: {
						objectStorage: true,
						key: stored.key,
						bytes: stored.bytes,
						checksum: stored.checksum,
						contentType: stored.contentType,
					},
				},
			});
		} catch (err) { next(err); }
	},
);

// ─── Audio download ──────────────────────────────────────────────────────────

/**
 * Returns one recording's stored audio as raw bytes.
 *
 * The read half of [POST /:id/audio]. The mobile client's `readRecordingAudio`
 * (apps/mobile/lib/core/api/nova_api.dart) has always pointed at this path, but
 * no handler was ever registered — the route resolved to the 404 fallback, so
 * every download of audio the server demonstrably held failed. This is that
 * handler: it fetches the object with [getAudio] and returns exactly the bytes
 * that were stored, with the container type recovered from the key.
 *
 * Ownership is checked through the row, and a row that is missing, soft-deleted
 * or another user's is a 404 rather than a 403, so the endpoint never confirms
 * that someone else's recording exists. An object that the row points at but
 * the store does not hold is also a 404: the honest answer is that there is no
 * audio to return, not that the recording is forbidden.
 */
router.get('/:id/audio', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const id = parseRecordingId(req.params.id);
		const db = getDb();

		const [recording] = await db.select({ storageKey: audioRecordings.storageKey })
			.from(audioRecordings)
			.where(and(
				eq(audioRecordings.id, id),
				eq(audioRecordings.userId, req.user!.id),
				isNull(audioRecordings.deletedAt),
			))
			.limit(1);
		if (!recording) {
			throw new HttpError(404, 'Recording not found', 'NOT_FOUND');
		}

		const key = recording.storageKey;
		let audio: Buffer;
		try {
			audio = await getAudio(key);
		} catch (err) {
			if (err instanceof AudioStorageError) {
				if (err.code === 'not_found') {
					throw new HttpError(404, 'The stored audio for this recording is missing.', 'NOT_FOUND');
				}
				throw new HttpError(503, err.message, 'STORAGE_UNAVAILABLE');
			}
			throw err;
		}

		res.status(200);
		res.setHeader('Content-Type', contentTypeForKey(key));
		res.setHeader('Content-Length', String(audio.length));
		// The recording is the caller's own; a shared cache must not retain it.
		res.setHeader('Cache-Control', 'private, no-store');
		res.send(audio);
	} catch (err) { next(err); }
});

// ─── Async processing ────────────────────────────────────────────────────────

/**
 * Starts transcription and summarisation, and returns immediately.
 *
 * §4.1 specifies **asynchronous** meeting transcription: this endpoint answers
 * 202 with `processing` once that status is persisted, and the pipeline
 * (`services/recording-pipeline.ts`) finishes after the response. The client
 * polls `GET /:id` and watches `recording.status`.
 *
 * If no audio has been uploaded the request is refused with 409 rather than
 * queued: a recording with nothing behind it can only produce an invented
 * transcript, and this pipeline does not invent.
 */
router.post(
	'/:id/process',
	authenticate,
	validate(ProcessRecordingSchema),
	async (req: AuthenticatedRequest, res, next) => {
		try {
			const id = parseRecordingId(req.params.id);
			const body = (req as unknown as { validatedBody?: z.infer<typeof ProcessRecordingSchema> }).validatedBody ?? {};
			const db = getDb();
			const userId = req.user!.id;

			const [existing] = await db.select().from(audioRecordings)
				.where(and(
					eq(audioRecordings.id, id),
					eq(audioRecordings.userId, userId),
					isNull(audioRecordings.deletedAt),
				))
				.limit(1);
			if (!existing) {
				throw new HttpError(404, 'Recording not found', 'NOT_FOUND');
			}

			// A placeholder key (the `recordings/<uid>/<uuid>` the create route
			// synthesises) is not an object, so this asks storage rather than
			// trusting the column.
			if (!(await recordedAudioIsPresent(existing.storageKey))) {
				throw new HttpError(
					409,
					'No audio has been uploaded for this recording, so there is nothing to transcribe.',
					'NO_AUDIO',
				);
			}

			const now = new Date();
			// **Terminal statuses are never downgraded.** This wrote `processing`
			// unconditionally, before it knew whether the pipeline would actually run —
			// and `runRecordingPipeline` drops a run whose recording is already in its
			// `inFlight` set. So a second `POST /:id/process` arriving while the first run
			// was finishing could overwrite `completed` with `processing` and then be
			// dropped, leaving the row **permanently** at `processing` with the transcript
			// and summary already written. Nothing recovers it: the retention sweep never
			// reads `status`. Reproduced by holding the first run inside `deleteAudio`
			// while the route's UPDATE ran.
			//
			// The guard is the `WHERE`: a recording that has already finished is left
			// alone, so the dropped duplicate is a no-op rather than a corruption.
			await db.update(audioRecordings)
				.set({
					status: RECORDING_STATUS.processing,
					...(body.language ? { language: body.language } : {}),
					updatedAt: now,
				})
				.where(
					and(
						eq(audioRecordings.id, id),
						eq(audioRecordings.userId, userId),
						notInArray(audioRecordings.status, [
							RECORDING_STATUS.completed,
							RECORDING_STATUS.failed,
						]),
					),
				);

			// Fire-and-forget. `enqueueRecordingProcessing` never rejects, and the
			// status it needs is already committed, so the client sees
			// `processing` the moment this response lands.
			enqueueRecordingProcessing(id, userId);

			res.status(202).json({
				success: true,
				data: { recordingId: id, status: RECORDING_STATUS.processing },
			});
		} catch (err) { next(err); }
	},
);

/**
 * Whether the stored object exists.
 *
 * The check goes to object storage rather than to the column because
 * `POST /recordings` writes a scoped placeholder key before any bytes exist, so
 * a non-empty `storage_key` is not evidence of audio. Asking the store can only
 * ever refuse work; it can never fabricate a transcript from nothing.
 */
async function recordedAudioIsPresent(storageKey: string): Promise<boolean> {
	return audioExists(storageKey);
}

export { router as recordingCaptureRoutes };
