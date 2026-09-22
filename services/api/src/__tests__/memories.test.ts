/**
 * NOVA API — memory writes, embeddings and keyword search.
 *
 * Three defects this file pins down, all of the same shape: code that reported
 * success for work it had not done.
 *
 *  - `generateEmbedding()` returned `{ embedding: [], dimensions: 0 }` for every
 *    input. That is a *successful-looking* result carrying nothing, and
 *    `storeEmbedding` persisted it, labelled `text-embedding-3-small`, into a
 *    `jsonb` column — a record of an embedding that no model had produced.
 *  - `POST /memories` and the assistant's `save_memory` tool inserted their own
 *    rows, so `createMemory` — the only caller of `storeEmbedding` — was dead code
 *    on both real write paths.
 *  - `?search=` on the list route was silently stripped by the query schema, while
 *    the mobile client documented it as supported; and the search routes passed the
 *    raw term into the `LIKE` pattern, so `%` or `_` in a search box changed what
 *    the query meant.
 *
 * The database is the suite's in-memory Drizzle mock (see `setup.ts`), but these
 * tests need to see *which* tables a request touched and what the `WHERE` clause
 * carried, so they install a recording database for the duration of a test.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getTableName } from 'drizzle-orm';
import './setup.js';

import app from '../server.js';
import { getDb } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import {
	escapeLikeTerm,
	memoryContentMatches,
	persistEmbedding,
	searchMemories,
} from '../services/memory.js';
import { generateEmbedding, embeddingsAvailable } from '../services/ai.js';
// The namespace import is what `vi.spyOn` can replace: the suite's provider mock
// (`setup.ts`) spreads the real module, so `generateEmbedding` is a plain property
// of the mocked namespace rather than one of the explicitly-stubbed `vi.fn`s.
import * as ai from '../services/ai.js';
import { executeAssistantTool } from '../services/assistant-tool-executor.js';
import { MemoryListQuerySchema } from '../schemas/index.js';

const JWT_SECRET = process.env.JWT_SECRET!;

function auth(): string {
	const token = jwt.sign({ sub: 'user-1', email: 'user-1@example.com', role: 'user' }, JWT_SECRET, {
		expiresIn: '1h',
	});
	return `Bearer ${token}`;
}

/** The row `getPrivacyPreferences` reads; everything switched on. */
const PRIVACY_ROW = {
	saveConversations: true,
	saveRecordings: true,
	saveTranscripts: true,
	saveMemories: true,
	cloudProcessing: true,
	localProcessing: false,
};

/**
 * Renders a drizzle `SQL` object to its text, so a test can assert what a query
 * actually asked for. Recursive for the same reason the keyset tests need it: raw
 * SQL segments and bound values arrive as child objects (`StringChunk`, `Param`,
 * nested `SQL`) rather than as one flat string.
 */
function render(query: unknown): { text: string } {
	let text = '';
	const walk = (node: unknown): void => {
		if (typeof node === 'string') {
			text += node;
			return;
		}
		if (!node || typeof node !== 'object') return;
		const c = node as { queryChunks?: unknown[]; value?: unknown; name?: string };
		if (Array.isArray(c.queryChunks)) {
			for (const child of c.queryChunks) walk(child);
			return;
		}
		if (Array.isArray(c.value)) {
			text += c.value.map((v) => String(v)).join('');
			return;
		}
		if (typeof c.value === 'string') {
			text += c.value;
			return;
		}
		if (typeof c.name === 'string') text += `:${c.name}`;
	};
	walk(query);
	return { text };
}

interface RecordingDb {
	inserts: string[];
	/** The values each `insert()` was called with, so a column can be asserted. */
	insertRows: { table: string; values: Record<string, unknown> }[];
	updates: { table: string; patch: Record<string, unknown> }[];
	wheres: unknown[];
	limits: unknown[];
	restore: () => void;
}

/**
 * A Drizzle-shaped database that records the tables and clauses a request uses.
 *
 * `setup.ts`'s builder ignores `where` and `limit` entirely, which is fine for
 * asserting a status code and useless for asserting that a search term reached the
 * query at all.
 */
function installRecordingDb(privacyRow: Record<string, unknown> = PRIVACY_ROW): RecordingDb {
	const inserts: string[] = [];
	const insertRows: { table: string; values: Record<string, unknown> }[] = [];
	const updates: { table: string; patch: Record<string, unknown> }[] = [];
	const wheres: unknown[] = [];
	const limits: unknown[] = [];

	const rowsFor = (table: unknown): any[] => {
		return getTableName(table as never) === 'privacy_preferences' ? [privacyRow] : [];
	};

	const selectChain = (selection?: Record<string, unknown>): any => {
		let rows: any[] = [];
		const q: any = {};
		q.from = (table: unknown) => {
			rows = rowsFor(table);
			return q;
		};
		q.where = (w: unknown) => {
			wheres.push(w);
			return q;
		};
		q.limit = (n: unknown) => {
			limits.push(n);
			return q;
		};
		for (const method of ['orderBy', 'offset', 'groupBy', 'having']) q[method] = () => q;
		const resolve = (): any[] =>
			selection && Object.prototype.hasOwnProperty.call(selection, 'count')
				? [{ count: rows.length }]
				: rows;
		q.then = (ok: any, no?: any) => Promise.resolve(resolve()).then(ok, no);
		q.catch = (no: any) => Promise.resolve(resolve()).catch(no);
		return q;
	};

	const insertChain = (table: unknown): any => {
		const name = getTableName(table as never);
		inserts.push(name);
		let values: any = {};
		const q: any = {
			values: (v: any) => {
				values = Array.isArray(v) ? { ...v[0] } : { ...v };
				insertRows.push({ table: name, values: { ...values } });
				return q;
			},
			onConflictDoUpdate: () => q,
			onConflictDoNothing: () => q,
			returning: () => Promise.resolve([{ id: `${name}-new`, ...values }]),
		};
		q.then = (ok: any, no?: any) => Promise.resolve([{ id: `${name}-new`, ...values }]).then(ok, no);
		q.catch = (no: any) => Promise.resolve([{ id: `${name}-new`, ...values }]).catch(no);
		return q;
	};

	const updateChain = (table: unknown): any => {
		const name = getTableName(table as never);
		let patch: any = {};
		const q: any = {
			set: (v: any) => {
				patch = { ...v };
				updates.push({ table: name, patch });
				return q;
			},
			where: () => q,
			returning: () => Promise.resolve([{ id: `${name}-updated`, ...patch }]),
		};
		q.then = (ok: any, no?: any) => Promise.resolve([{ id: `${name}-updated`, ...patch }]).then(ok, no);
		q.catch = (no: any) => Promise.resolve([]).catch(no);
		return q;
	};

	const db = {
		select: (selection?: Record<string, unknown>) => selectChain(selection),
		insert: (table: unknown) => insertChain(table),
		update: (table: unknown) => updateChain(table),
		delete: () => ({ where: () => Promise.resolve([]) }),
		execute: async () => ({ rows: [] }),
	} as never;

	const mockedGetDb = vi.mocked(getDb);
	const original = mockedGetDb.getMockImplementation();
	mockedGetDb.mockReturnValue(db);

	return {
		inserts,
		insertRows,
		updates,
		wheres,
		limits,
		restore: () => {
			if (original) mockedGetDb.mockImplementation(original);
			else mockedGetDb.mockReset();
		},
	};
}

let recorder: RecordingDb | undefined;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
	errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
});

afterEach(() => {
	recorder?.restore();
	recorder = undefined;
	warnSpy.mockRestore();
	errorSpy.mockRestore();
});

describe('generateEmbedding when no provider is configured', () => {
	it('says so instead of returning an empty success', async () => {
		// The exact defect: this used to resolve `{ embedding: [], dimensions: 0 }`,
		// which every caller read as "a vector was produced".
		const result = await generateEmbedding('I like filter coffee');

		expect(result.available).toBe(false);
		expect(result.dimensions).toBe(0);
		expect(result.embedding).toEqual([]);
		expect(result.available ? '' : result.reason).toMatch(/OPENAI_API_KEY/);
	});

	it('reports the same availability the capability endpoint reports', () => {
		expect(embeddingsAvailable()).toBe(false);
	});
});

describe('persisting an embedding', () => {
	it('refuses to store one, and logs, when no provider answered', async () => {
		recorder = installRecordingDb();

		const outcome = await persistEmbedding('mem-1', {
			available: false,
			embedding: [],
			dimensions: 0,
			reason: 'no provider configured',
		});

		expect(outcome).toEqual({ stored: false, reason: 'no provider configured' });
		// Nothing was written, and nothing was linked.
		expect(recorder.inserts).not.toContain('memory_embeddings');
		expect(recorder.updates).toEqual([]);
		// The old `catch` was empty beneath a "Log but don't fail" comment, so this
		// left no trace at any level.
		expect(warnSpy).toHaveBeenCalledWith(
			expect.objectContaining({ memoryId: 'mem-1', reason: 'no provider configured' }),
			expect.stringContaining('no embeddings provider'),
		);
	});

	it('refuses a zero-dimension vector even when the result claims to be available', async () => {
		// A provider that answers with an empty vector is a failure, not a
		// zero-dimension success. This is the case that put `[]`/`dimensions: 0` rows
		// labelled `text-embedding-3-small` into the table.
		recorder = installRecordingDb();

		const outcome = await persistEmbedding('mem-1', {
			available: true,
			embedding: [],
			dimensions: 0,
			model: 'text-embedding-3-small',
		});

		expect(outcome).toEqual({ stored: false, reason: 'empty_embedding' });
		expect(recorder.inserts).not.toContain('memory_embeddings');
		expect(errorSpy).toHaveBeenCalledWith(
			expect.objectContaining({ memoryId: 'mem-1', model: 'text-embedding-3-small' }),
			expect.stringContaining('no usable vector'),
		);
	});

	it('stores a real vector under the model that produced it, and links it', async () => {
		recorder = installRecordingDb();

		const outcome = await persistEmbedding('mem-1', {
			available: true,
			embedding: [0.1, 0.2, 0.3],
			dimensions: 3,
			model: 'text-embedding-3-small',
		});

		expect(outcome).toEqual({
			stored: true,
			embeddingId: 'memory_embeddings-new',
			model: 'text-embedding-3-small',
		});
		expect(recorder.inserts).toContain('memory_embeddings');
		// The same vector goes into `embedding_vec`, the real `vector(1536)` column
		// the HNSW index is built on. `embedding` is jsonb and can never be indexed,
		// so a row that only filled that column could never be found by an
		// approximate-nearest-neighbour search.
		const embeddingRow = recorder.insertRows.find((row) => row.table === 'memory_embeddings');
		expect(embeddingRow?.values.embeddingVec).toEqual([0.1, 0.2, 0.3]);
		// Both columns carry the same vector — the jsonb one is still read by the
		// existing similarity queries, so it must not be dropped in favour of the
		// new one.
		expect(embeddingRow?.values.embedding).toEqual([0.1, 0.2, 0.3]);
		// M-03: `memories.embedding_id` is what `memoriesRelations.embedding` reads.
		// Nothing wrote it, so the relation was null even when the row existed.
		expect(recorder.updates).toHaveLength(1);
		expect(recorder.updates[0].table).toBe('memories');
		expect(recorder.updates[0].patch.embeddingId).toBe('memory_embeddings-new');
	});
});

describe('POST /memories', () => {
	it('writes through createMemory, so the embedding hook actually runs', async () => {
		// Before: this route (and the assistant tool) inserted directly, which made
		// `createMemory`'s embedding hook unreachable on every real write path. The
		// observable proof that the hook now runs is that it *considered* an
		// embedding — and, with no provider configured, correctly declined to write
		// one rather than inserting an empty vector.
		recorder = installRecordingDb();

		const res = await request(app)
			.post('/api/v1/memories')
			.set('Authorization', auth())
			.send({ content: 'I like filter coffee', category: 'preference', sourceType: 'manual' });

		expect(res.status).toBe(201);
		expect(res.body?.data?.content).toBe('I like filter coffee');

		await vi.waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith(
				expect.objectContaining({ reason: expect.stringContaining('OPENAI_API_KEY') }),
				expect.stringContaining('no embeddings provider'),
			);
		});

		expect(recorder.inserts).toEqual(['memories']);
		expect(recorder.inserts).not.toContain('memory_embeddings');
		// The new `embedding_vec` column is nullable for exactly this case, and this
		// is the caveat that matters: a NULL must never be written in place of a
		// vector. An all-zero or empty `vector` would be indexed by HNSW as a real
		// point with no direction, so every similarity ordering it produced would be
		// meaningless while reporting success.
		expect(recorder.insertRows).toEqual([{ table: 'memories', values: expect.any(Object) }]);
		expect(JSON.stringify(recorder.insertRows)).not.toContain('embeddingVec');
	});

	it('persists the vector into embedding_vec when a provider answers', async () => {
		// The other branch of the same hook: a real provider result must reach the
		// indexed column, not only the jsonb one.
		recorder = installRecordingDb();
		const spy = vi.spyOn(ai, 'generateEmbedding').mockResolvedValueOnce({
			available: true,
			embedding: [0.5, 0.25, 0.125],
			dimensions: 3,
			model: 'mock-embedding-model',
		});

		const res = await request(app)
			.post('/api/v1/memories')
			.set('Authorization', auth())
			.send({ content: 'I like filter coffee', category: 'preference', sourceType: 'manual' });

		expect(res.status).toBe(201);

		await vi.waitFor(() => {
			const row = recorder!.insertRows.find((r) => r.table === 'memory_embeddings');
			expect(row?.values.embeddingVec).toEqual([0.5, 0.25, 0.125]);
			expect(row?.values.embedding).toEqual([0.5, 0.25, 0.125]);
			expect(row?.values.model).toBe('mock-embedding-model');
		});
		spy.mockRestore();
	});

	it('still refuses the write when the privacy switch is off', async () => {
		// The check moved into `createMemory` rather than being duplicated in the
		// route; the contract (409 + MEMORY_SAVING_DISABLED) has to survive the move.
		recorder = installRecordingDb({ ...PRIVACY_ROW, saveMemories: false });

		const res = await request(app)
			.post('/api/v1/memories')
			.set('Authorization', auth())
			.send({ content: 'must not be stored', category: 'preference', sourceType: 'manual' });

		expect(res.status).toBe(409);
		expect(JSON.stringify(res.body)).toContain('MEMORY_SAVING_DISABLED');
		expect(recorder.inserts).toEqual([]);
	});
});

describe('keyword search', () => {
	it('escapes the LIKE metacharacters the user typed', () => {
		expect(escapeLikeTerm('100%')).toBe('100\\%');
		expect(escapeLikeTerm('a_b')).toBe('a\\_b');
		expect(escapeLikeTerm('back\\slash')).toBe('back\\\\slash');
	});

	it('treats a bare `%` as a literal, not as "every memory"', async () => {
		recorder = installRecordingDb();

		const res = await request(app)
			.get('/api/v1/memories/search')
			.query({ query: '%' })
			.set('Authorization', auth());

		expect(res.status).toBe(200);
		const { text } = render(recorder.wheres[0]);
		expect(text).toContain('%\\%%');
		// The unescaped pattern was `'%' + '%' + '%'` — a match-everything scan.
		expect(text).not.toContain('%%%');
	});

	it('rejects a whitespace-only term rather than scanning the whole table', async () => {
		recorder = installRecordingDb();

		const res = await request(app)
			.get('/api/v1/memories/search')
			.query({ query: '   ' })
			.set('Authorization', auth());

		expect(res.status).toBe(400);
		expect(JSON.stringify(res.body)).toContain('INVALID_SEARCH_TERM');
	});

	it('bounds the limit in the service, not only at the route', async () => {
		recorder = installRecordingDb();

		await searchMemories('user-1', 'coffee', 1_000_000);
		expect(recorder.limits).toEqual([50]);

		await searchMemories('user-1', 'coffee', 5);
		expect(recorder.limits[1]).toBe(5);
	});

	it('does not query at all for a blank term', async () => {
		recorder = installRecordingDb();

		const result = await searchMemories('user-1', '   ', 10);

		expect(result).toMatchObject({ memories: [], total: 0 });
		expect(recorder.wheres).toEqual([]);
	});

	it('aliases a content match to the escaped ILIKE clause', () => {
		const { text } = render(memoryContentMatches('coffee'));
		expect(text).toContain('%coffee%');
		expect(text).toContain('ilike');
	});
});

describe("the assistant's save_memory tool", () => {
	const toolUse = {
		id: 'tool-use-1',
		name: 'save_memory',
		input: { content: 'Prefers morning meetings', category: 'preference' },
	};

	it('writes through createMemory and keeps its tool-result contract', async () => {
		// Same defect as POST /memories: the tool inserted its own row, so the
		// embedding hook never ran for anything the assistant remembered. The
		// contract that has to survive the change is the return shape — `ok`, the
		// one-line summary and `data.memory_id` — because the model reads it.
		recorder = installRecordingDb();

		const call = await executeAssistantTool('user-1', toolUse);

		expect(call.ok).toBe(true);
		expect(call.summary).toBe('Saved to memory (preference).');
		expect(call.data).toEqual({ memory_id: 'memories-new', category: 'preference' });
		expect(recorder.inserts).toEqual(['memories']);

		await vi.waitFor(() => {
			expect(warnSpy).toHaveBeenCalledWith(
				expect.objectContaining({ reason: expect.stringContaining('OPENAI_API_KEY') }),
				expect.stringContaining('no embeddings provider'),
			);
		});
	});

	it('reports the privacy refusal as a tool result, not a thrown error', async () => {
		// The model has to be able to tell the user; a thrown error would fail the
		// whole turn instead.
		recorder = installRecordingDb({ ...PRIVACY_ROW, saveMemories: false });

		const call = await executeAssistantTool('user-1', toolUse);

		expect(call.ok).toBe(false);
		expect(call.error).toMatch(/switched off in the user’s privacy controls/);
		expect(recorder.inserts).toEqual([]);
	});
});

describe('GET /memories?search=', () => {
	it('accepts the field the mobile list documents', () => {
		// `validate()` strips unknown query keys, which is how `?search=` came to be
		// silently ignored while `nova_api.dart` documented it as supported.
		expect(MemoryListQuerySchema.parse({ search: 'coffee' }).search).toBe('coffee');
		expect(MemoryListQuerySchema.safeParse({ search: 'x'.repeat(201) }).success).toBe(false);
	});

	it('applies the filter instead of returning the unfiltered list', async () => {
		recorder = installRecordingDb();

		const res = await request(app)
			.get('/api/v1/memories')
			.query({ search: 'coffee' })
			.set('Authorization', auth());

		expect(res.status).toBe(200);
		const { text } = render(recorder.wheres[0]);
		expect(text).toContain('%coffee%');
		expect(text).toContain('ilike');
	});

	it('does not add a filter when the term is blank', async () => {
		recorder = installRecordingDb();

		const res = await request(app)
			.get('/api/v1/memories')
			.query({ search: '   ' })
			.set('Authorization', auth());

		expect(res.status).toBe(200);
		const { text } = render(recorder.wheres[0]);
		expect(text).not.toContain('ilike');
	});
});
