/**
 * NOVA API — the assistant's memory grounding is ranked against the current turn.
 *
 * The grounding block used to inject the top `maxMemories` rows by `importance`, so
 * with more than twelve saved memories a fact the user had just referred to fell out
 * of the prompt and NOVA answered as though it had never been told — "the client I
 * mentioned" retrieved nothing. These tests pin the three observable behaviours:
 *
 *  - a *relevant but low-importance* memory is pulled into the cap, and the row that
 *    only made it in by importance is dropped;
 *  - with no user turn (a briefing) the section is byte-for-byte what it always was;
 *  - when no embedding can be produced the ranking degrades, and says so — unless a
 *    provider-free term-overlap ranking can still separate the rows, in which case
 *    `mode` reports `'lexical'` rather than pretending nothing ranked. The
 *    lexical path itself, and the importance ordering it must preserve exactly when
 *    there is no signal, are covered by `memory-lexical-ranking.test.ts`.
 *
 * `getDb` is replaced the way `user-context.test.ts` replaces it, because the shared
 * mock in `./setup` ignores `where` and `orderBy` and so cannot express "these rows,
 * in this order". The relevance read itself is a single `db.execute` whose real SQL
 * is rendered here so the test can assert it targets `embedding_vec`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getDb } from '../db/connection.js';
import { buildUserContext } from '../services/user-context.js';
import type { EmbeddingResult } from '../services/ai.js';

interface MemoryRow {
	id: string;
	category: string;
	content: string;
	importance: number;
}

/**
 * The rows the importance query returns, already in the order that query produces
 * (`importance DESC, created_at DESC`).
 */
const IMPORTANCE_ORDER: MemoryRow[] = [
	{ id: 'mem-high', category: 'fact', content: 'The user lives in Chennai', importance: 90 },
	{ id: 'mem-mid', category: 'fact', content: 'The user works at Leadup', importance: 80 },
	{ id: 'mem-relevant', category: 'fact', content: 'The client is Acme Corp', importance: 10 },
];

const USED_VECTOR = new Array(1536).fill(0.5);

/**
 * A Drizzle-shaped double that keeps the query's own ordering: `select().from(memories)`
 * yields the importance-ordered pool, `execute` yields the relevance-ordered rows and
 * records the SQL it was handed.
 */
function makeGroundingDb(options: {
	importanceOrder?: MemoryRow[];
	relevanceOrder?: MemoryRow[];
	executeError?: Error;
}): { db: ReturnType<typeof getDb>; executed: string[] } {
	const dialect = new PgDialect();
	const executed: string[] = [];

	const select = (): unknown => {
		let rows: MemoryRow[] = [];
		let limit: number | null = null;
		const resolved = (): MemoryRow[] => (limit === null ? rows : rows.slice(0, limit));
		const q: Record<string, unknown> = {};
		q.from = (table: unknown) => {
			const name = getTableName(table as never);
			if (name === 'memories') rows = [...(options.importanceOrder ?? [])];
			return q;
		};
		for (const method of ['where', 'orderBy', 'offset', 'groupBy', 'having']) q[method] = () => q;
		q.limit = (count?: number) => {
			limit = typeof count === 'number' ? count : null;
			return q;
		};
		q.then = (ok: unknown, no: unknown) => Promise.resolve(resolved()).then(ok as never, no as never);
		q.catch = (no: unknown) => Promise.resolve(resolved()).catch(no as never);
		return q;
	};

	const execute = async (query: unknown) => {
		executed.push(dialect.sqlToQuery(query as never).sql);
		if (options.executeError) throw options.executeError;
		return { rows: [...(options.relevanceOrder ?? [])] };
	};

	return { db: { select, execute } as unknown as ReturnType<typeof getDb>, executed };
}

/** The turn NOVA is being asked to ground: it is about the client, not the rest. */
const CLIENT_TURN = 'what did I say about the client?';

const NOW = new Date('2026-05-01T09:00:00Z');

function embedAvailable(): () => Promise<EmbeddingResult> {
	return async () => ({
		available: true,
		embedding: USED_VECTOR,
		dimensions: 1536,
		model: 'text-embedding-3-small',
	});
}

/** Models the provider being absent — the shape `generateEmbedding` itself returns. */
function embedUnavailable(reason: string): () => Promise<EmbeddingResult> {
	return async () => ({ available: false, embedding: [], dimensions: 0, reason });
}

afterEach(() => {
	vi.mocked(getDb).mockReset();
});

describe('buildUserContext — memories are ranked against the user turn', () => {
	it('pulls a relevant low-importance memory into the cap and drops an importance-only one', async () => {
		const { db, executed } = makeGroundingDb({
			importanceOrder: IMPORTANCE_ORDER,
			relevanceOrder: [IMPORTANCE_ORDER[2]],
		});
		vi.mocked(getDb).mockReturnValue(db);

		const context = await buildUserContext('user-1', { maxMemories: 2 }, NOW, {
			userTurn: CLIENT_TURN,
			embed: embedAvailable(),
		});

		// The relevant memory (importance 10) is in, and first: the two slots are its
		// own, then the most important row not already selected.
		expect(context.facts.memories.map((memory) => memory.id)).toEqual(['mem-relevant', 'mem-high']);
		expect(context.text).toContain('The client is Acme Corp');
		// Previously in by importance; now out of the cap.
		expect(context.text).not.toContain('works at Leadup');
		expect(context.memoryRetrieval).toEqual({ mode: 'relevance' });

		// The ranking ran a real pgvector read against the indexed column.
		expect(executed).toHaveLength(1);
		expect(executed[0]).toContain('embedding_vec <=>');
		expect(executed[0]).toContain('embedding_vec IS NOT NULL');
		expect(executed[0]).not.toMatch(/memory_embeddings\.embedding\s*<=>/);
	});

	it('keeps a memory that has no stored vector reachable through the importance fill', async () => {
		const { db } = makeGroundingDb({
			importanceOrder: IMPORTANCE_ORDER,
			// Only one memory has an embedding yet, so the cap is not full.
			relevanceOrder: [IMPORTANCE_ORDER[2]],
		});
		vi.mocked(getDb).mockReturnValue(db);

		const context = await buildUserContext('user-1', { maxMemories: 3 }, NOW, {
			userTurn: CLIENT_TURN,
			embed: embedAvailable(),
		});

		expect(context.facts.memories.map((memory) => memory.id)).toEqual([
			'mem-relevant',
			'mem-high',
			'mem-mid',
		]);
	});

	it('treats a blank turn as no turn at all', async () => {
		const { db, executed } = makeGroundingDb({ importanceOrder: IMPORTANCE_ORDER });
		vi.mocked(getDb).mockReturnValue(db);

		const context = await buildUserContext('user-1', { maxMemories: 2 }, NOW, {
			userTurn: '   ',
			embed: embedAvailable(),
		});

		expect(context.facts.memories.map((memory) => memory.id)).toEqual(['mem-high', 'mem-mid']);
		expect(context.memoryRetrieval).toEqual({ mode: 'importance' });
		expect(executed).toEqual([]);
	});
});

describe('buildUserContext — no user turn (a briefing) is unchanged', () => {
	it('orders the memory section by importance exactly as it did before', async () => {
		const { db, executed } = makeGroundingDb({ importanceOrder: IMPORTANCE_ORDER });
		vi.mocked(getDb).mockReturnValue(db);

		const context = await buildUserContext('user-1', { maxMemories: 2 }, NOW);

		expect(context.facts.memories.map((memory) => memory.id)).toEqual(['mem-high', 'mem-mid']);
		expect(context.text).toContain('Things you remember about the user:');
		expect(context.text).toContain('- [fact] The user lives in Chennai');
		expect(context.text).toContain('- [fact] The user works at Leadup');
		expect(context.text).not.toContain('Acme Corp');

		// No ranking was attempted, so no degradation is claimed either.
		expect(context.memoryRetrieval).toEqual({ mode: 'importance' });
		expect(executed).toEqual([]);
	});
});

describe('buildUserContext — a ranking that cannot run says so', () => {
	it('ranks on term overlap when no provider is available, and says which ranking ran', async () => {
		const { db, executed } = makeGroundingDb({
			importanceOrder: IMPORTANCE_ORDER,
			relevanceOrder: [IMPORTANCE_ORDER[2]],
		});
		vi.mocked(getDb).mockReturnValue(db);

		const context = await buildUserContext('user-1', { maxMemories: 2 }, NOW, {
			userTurn: CLIENT_TURN,
			embed: embedUnavailable('No embeddings provider is configured (OPENAI_API_KEY is unset).'),
		});

		// This expectation changed when the lexical fallback landed. The turn says
		// "client" and one memory is "The client is Acme Corp", so a provider-free
		// ranking *can* discriminate here, and the fact that answers the question is
		// pulled into the cap and put first instead of being reported as unranked.
		// A vector search was still never attempted.
		expect(context.facts.memories.map((memory) => memory.id)).toEqual(['mem-relevant', 'mem-high']);
		expect(context.memoryRetrieval).toEqual({ mode: 'lexical' });
		expect(executed).toEqual([]);
	});

	it('falls back to the importance ordering, with the provider reason, when the turn shares no terms', async () => {
		const { db, executed } = makeGroundingDb({
			importanceOrder: IMPORTANCE_ORDER,
			relevanceOrder: [IMPORTANCE_ORDER[2]],
		});
		vi.mocked(getDb).mockReturnValue(db);

		const context = await buildUserContext('user-1', { maxMemories: 2 }, NOW, {
			userTurn: 'what is the capital of a country I have never mentioned',
			embed: embedUnavailable('No embeddings provider is configured (OPENAI_API_KEY is unset).'),
		});

		// Today's behaviour, exactly, when neither ranking could separate the rows.
		expect(context.facts.memories.map((memory) => memory.id)).toEqual(['mem-high', 'mem-mid']);
		// And it is not silent about it.
		expect(context.memoryRetrieval?.mode).toBe('importance');
		expect(context.memoryRetrieval?.degradedReason).toContain('OPENAI_API_KEY');
		// A vector search that could not be embedded was never attempted.
		expect(executed).toEqual([]);
	});

	it('uses the provider-free ranking when the vector read itself fails', async () => {
		const { db } = makeGroundingDb({
			importanceOrder: IMPORTANCE_ORDER,
			relevanceOrder: [IMPORTANCE_ORDER[2]],
			executeError: new Error('operator does not exist: jsonb <=> vector'),
		});
		vi.mocked(getDb).mockReturnValue(db);

		const context = await buildUserContext('user-1', { maxMemories: 2 }, NOW, {
			userTurn: CLIENT_TURN,
			embed: embedAvailable(),
		});

		// The vector read is broken, but the turn and one memory share the term
		// "client", so the fallback still selects the row that answers the question.
		expect(context.facts.memories.map((memory) => memory.id)).toEqual(['mem-relevant', 'mem-high']);
		expect(context.memoryRetrieval).toEqual({ mode: 'lexical' });
		// The section still rendered rather than collapsing to "unavailable".
		expect(context.text).toContain('The client is Acme Corp');
	});
});
