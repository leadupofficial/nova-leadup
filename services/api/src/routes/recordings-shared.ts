/**
 * NOVA API — helpers shared by the two recording routers.
 *
 * `recordings.ts` (list, create, detail, patch, delete) and
 * `recordings-capture.ts` (capabilities, audio upload, async processing) must
 * agree on how a path parameter is validated and how a list cursor is decoded,
 * or one of them answers a differently-shaped 400 for the same bad input. Two
 * copies of that logic would drift, so it lives here.
 */
import { z } from 'zod';
import { audioRecordings } from '@nova/database';
import { HttpError } from '../middleware/error-handler.js';
import { decodeCursor } from '../schemas/index.js';

const IdSchema = z.object({ id: z.string().uuid() });

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates a `:id` path parameter as a UUID.
 *
 * Rejecting a non-UUID here is what keeps `id = 'not-a-uuid'` from reaching
 * Postgres and surfacing as a 500 instead of a 400.
 */
export function parseRecordingId(raw: string): string {
	const parsed = IdSchema.safeParse({ id: raw });
	if (!parsed.success) {
		throw new HttpError(400, 'Invalid recording ID format', 'INVALID_ID');
	}
	return parsed.data.id;
}

/**
 * Decodes a list cursor and rejects a non-UUID payload before it reaches
 * Postgres, where `id > 'not-a-uuid'` would surface as a 500 rather than a 400.
 */
export function parseCursor(raw: string): string {
	let id: string;
	try {
		id = decodeCursor(raw);
	} catch {
		throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
	}
	if (!UUID_RE.test(id)) {
		throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
	}
	return id;
}

/**
 * The columns of a recording a client is allowed to see.
 *
 * The list, detail and upload routes returned the whole row, which carries `storageKey` —
 * the object-storage path `recordings/<userId>/<recordingId><ext>` — and `tenantId`.
 * Neither is read by any client (checked across the Dart and TypeScript consumers), and
 * both are internal addressing rather than data the app asked for. Selecting explicitly
 * also means a column added to the table later does not silently become public API.
 *
 * This is not about the *deliberate* `storage` envelope on the upload response, which
 * tells the client where its bytes went and is part of that endpoint's contract. It is
 * about not dumping the row and hoping the extra fields are harmless.
 */
export const RECORDING_COLUMNS = {
	id: audioRecordings.id,
	title: audioRecordings.title,
	durationSeconds: audioRecordings.durationSeconds,
	language: audioRecordings.language,
	status: audioRecordings.status,
	participants: audioRecordings.participants,
	consentRecorded: audioRecordings.consentRecorded,
	// Why a run failed, as the pipeline's own failure path recorded it. Without a
	// reason the client can only say "failed", so the user cannot tell a retryable
	// provider error from an upload that never arrived.
	failureReason: audioRecordings.failureReason,
	completedAt: audioRecordings.completedAt,
	createdAt: audioRecordings.createdAt,
	updatedAt: audioRecordings.updatedAt,
} as const;

/** The same projection applied to a row that was already read in full. */
export function toClientRecording<T extends Record<string, unknown>>(row: T) {
	const picked: Record<string, unknown> = {};
	for (const key of Object.keys(RECORDING_COLUMNS)) picked[key] = row[key];
	return picked as Pick<T, keyof typeof RECORDING_COLUMNS>;
}
