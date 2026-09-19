/**
 * NOVA API — shared fixtures for the meeting-capture tests.
 *
 * Two suites exercise this feature from different ends. `meeting-summary.test.ts`
 * drives the guard and the composer with no transport at all, and
 * `recording-pipeline.test.ts` drives the pipeline and its HTTP surface against
 * an in-memory database and object store. Both need the same identities, the
 * same storage replacement and the same row shape, so it lives here once.
 *
 * The object store is replaced through the documented `setAudioStorageDriver`
 * seam rather than by mocking the module: the shared bootstrap (`setup.ts`)
 * imports the server — and therefore the routes — before any test file runs, so
 * `vi.mock` cannot reach their imports.
 */
import { createHash } from 'node:crypto';
import { getTableName } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/connection.js';
import {
	AudioStorageError,
	MAX_AUDIO_BYTES,
	setAudioStorageDriver,
	type AudioStorageCapabilities,
	type AudioStorageDriver,
	type StoredAudio,
} from '../../services/audio-storage.js';
import { RECORDING_STATUS } from '../../services/recording-pipeline.js';

// ─── Identities ─────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET!;

export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333';
export const RECORDING_ID = '22222222-2222-4222-8222-222222222222';
export const AUDIO_KEY = `recordings/${USER_ID}/${RECORDING_ID}.wav`;

function tokenFor(userId = USER_ID): string {
	return jwt.sign({ sub: userId, email: 'test@example.com', role: 'user' }, JWT_SECRET, {
		expiresIn: '1h',
	});
}

export const auth = (userId = USER_ID) => ({ Authorization: `Bearer ${tokenFor(userId)}` });

// ─── An in-memory object store ──────────────────────────────────────────────

/** Everything "stored" during a test, keyed by object key. */
export const objects = new Map<string, Buffer>();

/**
 * Mutable driver behaviour.
 *
 * An object rather than two module-level `let`s, because a test file can only
 * reassign what it owns; this is the one place a suite flips a behaviour.
 */
export const storageFlags: {
	capabilities: AudioStorageCapabilities;
	rejectReads: boolean;
} = {
	capabilities: {
		objectStorage: true,
		endpoint: 'http://minio:9000',
		bucket: 'nova-assets',
		maxUploadBytes: MAX_AUDIO_BYTES,
	},
	rejectReads: false,
};

export const memoryDriver: AudioStorageDriver = {
	async put(key, body, contentType): Promise<StoredAudio> {
		objects.set(key, body);
		return {
			key,
			bytes: body.length,
			checksum: createHash('sha256').update(body).digest('hex'),
			contentType,
		};
	},
	async get(key) {
		if (storageFlags.rejectReads) {
			throw new AudioStorageError('the store is unreachable', 'unavailable');
		}
		const body = objects.get(key);
		if (!body) throw new AudioStorageError('missing', 'not_found');
		return body;
	},
	async head(key) {
		return objects.has(key);
	},
	async remove(key) {
		return objects.delete(key);
	},
	capabilities: () => storageFlags.capabilities,
};

/** Puts the store back to its default, working state. */
export function resetStorageFixtures(): void {
	objects.clear();
	storageFlags.rejectReads = false;
	storageFlags.capabilities = {
		objectStorage: true,
		endpoint: 'http://minio:9000',
		bucket: 'nova-assets',
		maxUploadBytes: MAX_AUDIO_BYTES,
	};
	setAudioStorageDriver(memoryDriver);
}

// ─── A small in-memory Drizzle look-alike ───────────────────────────────────
//
// The shared builder in `setup.ts` ignores `where` and returns fixed fixtures,
// which is fine for "the route answered" but useless for "the pipeline wrote
// the right row". This one keeps a mutable store per table so a full pipeline
// run can be asserted end to end.

export type Row = Record<string, unknown>;

function tableNameOf(table: unknown): string {
	try {
		return getTableName(table as never);
	} catch {
		return '';
	}
}

export function makeDb(store: Record<string, Row[]>): ReturnType<typeof getDb> {
	const select = (selection?: Record<string, unknown>): unknown => {
		const state: { rows: Row[] } = { rows: [] };
		const resolved = (): Row[] =>
			selection && Object.prototype.hasOwnProperty.call(selection, 'count')
				? [{ count: state.rows.length }]
				: state.rows;
		const q: Record<string, unknown> = {};
		for (const method of ['from', 'where', 'orderBy', 'limit', 'offset', 'groupBy', 'having']) {
			q[method] = (table?: unknown) => {
				if (method === 'from' && table) state.rows = store[tableNameOf(table)] ?? [];
				return q;
			};
		}
		q.then = (ok: unknown, no: unknown) => Promise.resolve(resolved()).then(ok as never, no as never);
		q.catch = (no: unknown) => (q.then as (a: unknown, b: unknown) => Promise<unknown>)(undefined, no);
		return q;
	};

	const insert = (table: unknown): unknown => {
		const name = tableNameOf(table);
		let written: Row[] = [];
		const q: Record<string, unknown> = {
			values: (value: unknown) => {
				const list = Array.isArray(value) ? value : [value];
				written = list.map((row, index) => ({
					id: `${name}-${(store[name]?.length ?? 0) + index + 1}`,
					...(row as Row),
				}));
				store[name] = [...(store[name] ?? []), ...written];
				return q;
			},
			onConflictDoUpdate: () => q,
			onConflictDoNothing: () => q,
			returning: () => Promise.resolve(written),
		};
		q.then = (ok: unknown, no: unknown) => Promise.resolve(written).then(ok as never, no as never);
		q.catch = (no: unknown) => (q.then as (a: unknown, b: unknown) => Promise<unknown>)(undefined, no);
		return q;
	};

	const update = (table: unknown): unknown => {
		const name = tableNameOf(table);
		let patch: Row = {};
		let applied: Row[] = [];
		const q: Record<string, unknown> = {
			set: (value: Row) => {
				patch = value;
				return q;
			},
			where: () => {
				applied = (store[name] ?? []).map((row) => ({ ...row, ...patch }));
				store[name] = applied;
				return q;
			},
			returning: () => Promise.resolve(applied),
		};
		q.then = (ok: unknown, no: unknown) => Promise.resolve(applied).then(ok as never, no as never);
		q.catch = (no: unknown) => (q.then as (a: unknown, b: unknown) => Promise<unknown>)(undefined, no);
		return q;
	};

	const remove = (table: unknown): unknown => {
		const name = tableNameOf(table);
		const q: Record<string, unknown> = {
			where: () => {
				store[name] = [];
				return q;
			},
			returning: () => Promise.resolve([]),
		};
		q.then = (ok: unknown, no: unknown) => Promise.resolve([]).then(ok as never, no as never);
		q.catch = (no: unknown) => (q.then as (a: unknown, b: unknown) => Promise<unknown>)(undefined, no);
		return q;
	};

	return {
		select,
		insert,
		update,
		delete: remove,
		execute: async () => ({ rows: [] }),
	} as unknown as ReturnType<typeof getDb>;
}

/** A database that reports every lookup as empty, for the ownership-404 paths. */
export function emptyDb(): ReturnType<typeof getDb> {
	return {
		select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
	} as unknown as ReturnType<typeof getDb>;
}

/** One `audio_recordings` row, as the pipeline and the routes read it. */
export function recordingRow(overrides: Row = {}): Row {
	return {
		id: RECORDING_ID,
		userId: USER_ID,
		title: 'Client Discussion',
		language: 'en',
		status: RECORDING_STATUS.processing,
		storageKey: AUDIO_KEY,
		durationSeconds: 42,
		consentRecorded: true,
		deletedAt: null,
		...overrides,
	};
}
