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
