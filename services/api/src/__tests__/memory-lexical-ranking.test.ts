/**
 * NOVA API — the memory ranking that needs no embedding provider.
 *
 * Measured live, with `OPENAI_API_KEY` unset, so `rankMemoriesForTurn` took its
 * documented degradation path and the grounding block injected the top 12 rows by
 * `importance` alone:
 *
 *   Ask: "NOVA, I need to plan my day tomorrow. Remind me when I usually do my
 *         planning."
 *
 *   - "My preferred time for daily planning is 9 AM" at importance 5, under 13
 *     distractors at importance 90, produced *"I don't have that saved. When do
 *     you usually plan your day?"* — and on a second run a confabulation, the
 *     distractor about standup asserted as the user's own habit.
 *   - The same fact promoted to importance 99 was answered correctly.
 *
 * So the fact was reachable and merely outranked. These tests pin the lexical
 * path that closes the gap without a provider, and — just as importantly — pin
 * everything it must not change:
 *
 *  - the measured case: the relevant low-importance memory is pulled into the cap
 *    and a distractor drops out;
 *  - the negative space: a turn sharing no meaningful terms with any memory
 *    returns the *same rows in the same order* as the importance query, with
 *    `mode: 'importance'` and the degradation reason, because a ranking that
 *    reorders on noise is worse than no ranking;
 *  - the fill: a user with fewer memories than the cap gets all of them, and a
 *    lexical hit that does not fill the cap is topped up from importance order;
 *  - a configured provider still wins, and still reports `mode: 'relevance'`;
 *  - no turn at all is untouched (briefings and the follow-up engine).
 *
 * The database is replaced the way `memory-relevance-grounding.test.ts` replaces
 * it — the shared mock in `./setup` ignores `where` and `orderBy`, so it cannot
 * express "these rows, in this order".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getDb } from '../db/connection.js';
import { buildUserContext } from '../services/user-context.js';
import { rankMemoriesForTurn } from '../services/memory.js';
import type { EmbeddingResult } from '../services/ai.js';

interface MemoryRow {
	id: string;
	category: string;
	content: string;
	importance: number;
}

/**
 * The turn as the user asked it, verbatim from the measurement above.
 */
const PLANNING_TURN = 'NOVA, I need to plan my day tomorrow. Remind me when I usually do my planning.';

/** The one memory that answers the turn, at the importance that lost. */
const PLANNING_MEMORY: MemoryRow = {
	id: 'mem-planning',
	category: 'preference',
	content: 'My preferred time for daily planning is 9 AM',
	importance: 5,
};

/**
 * The thirteen distractors that filled the cap ahead of it, all at importance 90.
 *
 * The first is the standup fact that was confabulated as the user's own habit.
 * The second is *about planning too* but is not about the user's own day, so the
 * lexical ranking reaches the user's fact first: it is what makes "an unrelated
 * one is dropped" a statement about ranking rather than about the fill.
 */
const DISTRACTORS: MemoryRow[] = Array.from({ length: 13 }, (_, index) => ({
	id: `mem-distractor-${index + 1}`,
	category: 'fact',
	content:
		index === 0
			? 'The team standup meeting is at ten fifteen in the morning'
			: index === 1
				? 'The annual planning offsite is booked for December'
				: `Unrelated stored fact number ${index + 1} about invoices`,
	importance: 90,
}));

/**
 * Every memory, in the order the importance query produces it
 * (`importance DESC, created_at DESC`) — which puts the relevant row last.
 */
const MEASURED_POOL: MemoryRow[] = [
	...DISTRACTORS,
	PLANNING_MEMORY,
];

/**
 * A Drizzle-shaped double that keeps the query's own ordering: `select().from(memories)`
 * yields the importance-ordered pool (honouring `.limit`), `execute` yields the
 * relevance-ordered rows and records the SQL it was handed.
 */
function makeMemoryDb(options: {
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

const USED_VECTOR = new Array(1536).fill(0.5);
const NO_PROVIDER = 'No embeddings provider is configured (OPENAI_API_KEY is unset), and the Anthropic SDK exposes no embeddings endpoint.';

/** Models the deployment this defect was measured in: a valid turn, no provider. */
function embedUnavailable(reason = NO_PROVIDER): () => Promise<EmbeddingResult> {
	return async () => ({ available: false, embedding: [], dimensions: 0, reason });
}

function embedAvailable(): () => Promise<EmbeddingResult> {
	return async () => ({
		available: true,
		embedding: USED_VECTOR,
		dimensions: 1536,
		model: 'text-embedding-3-small',
	});
}

const ids = (memories: { id: string }[]): string[] => memories.map((memory) => memory.id);

afterEach(() => {
	vi.mocked(getDb).mockReset();
});

describe('rankMemoriesForTurn — a lexical ranking when no embedding can be obtained', () => {
	it('pulls the measured low-importance planning fact into the cap without a provider', async () => {
		const { db, executed } = makeMemoryDb({ importanceOrder: MEASURED_POOL });
		vi.mocked(getDb).mockReturnValue(db);

		const outcome = await rankMemoriesForTurn('user-1', PLANNING_TURN, 12, embedUnavailable());

		const selected = ids(outcome.memories);
		expect(selected).toContain('mem-planning');
		// The fact is not merely in the cap, it is the row the ranking put first —
		// where the importance ordering had it 14th of 14, outside the read.
		expect(selected[0]).toBe('mem-planning');
		// Both rows that are about planning outrank the standup distractor that was
		// confabulated as the user's own habit, and the lowest-importance unrelated
		// row — in the importance cap before — is out.
		expect(selected.indexOf('mem-distractor-2')).toBeLessThan(selected.indexOf('mem-distractor-1'));
		expect(selected).not.toContain('mem-distractor-13');
		expect(selected).toContain('mem-distractor-3');
		// The cap is filled to the same size the importance path produced.
		expect(outcome.memories).toHaveLength(12);
		// A provider-free ranking did run, and it is reported as such.
		expect(outcome.mode).toBe('lexical');
		// No vector read was attempted: there was nothing to compare a vector against.
		expect(executed).toEqual([]);
	});

	it('reaches the measured fact through buildUserContext, so the model is told it', async () => {
		const { db } = makeMemoryDb({ importanceOrder: MEASURED_POOL });
		vi.mocked(getDb).mockReturnValue(db);

		const context = await buildUserContext('user-1', { maxMemories: 12 }, new Date('2026-05-01T09:00:00Z'), {
			userTurn: PLANNING_TURN,
			embed: embedUnavailable(),
		});

		// The measured reply was "I don't have that saved. When do you usually plan
		// your day?" — the fact was not in the prompt at all.
		expect(context.text).toContain('My preferred time for daily planning is 9 AM');
		// And the measured confabulation, a distractor asserted as the user's own
		// habit, is now below both rows the turn is actually about.
		expect(context.text.indexOf('My preferred time for daily planning')).toBeLessThan(
			context.text.indexOf('standup meeting is at ten fifteen'),
		);
		expect(context.memoryRetrieval).toEqual({ mode: 'lexical' });
	});

	it('is stable across repeats: the same turn selects the same rows', async () => {
		const { db } = makeMemoryDb({ importanceOrder: MEASURED_POOL });
		vi.mocked(getDb).mockReturnValue(db);

		const first = await rankMemoriesForTurn('user-1', PLANNING_TURN, 12, embedUnavailable());
		const second = await rankMemoriesForTurn('user-1', PLANNING_TURN, 12, embedUnavailable());

		expect(ids(second.memories)).toEqual(ids(first.memories));
	});
});

describe('rankMemoriesForTurn — the lexical path is only taken when it discriminates', () => {
	it('keeps the importance ordering, order included, when the turn shares no terms', async () => {
		const pool: MemoryRow[] = [
			{ id: 'mem-a', category: 'fact', content: 'The user lives in Chennai', importance: 90 },
			{ id: 'mem-b', category: 'fact', content: 'The user works at Leadup', importance: 80 },
			{ id: 'mem-c', category: 'fact', content: 'Favourite colour is green', importance: 70 },
		];
		const { db } = makeMemoryDb({ importanceOrder: pool });
		vi.mocked(getDb).mockReturnValue(db);

		const outcome = await rankMemoriesForTurn(
			'user-1',
			'what time does the chemistry experiment finish',
			3,
			embedUnavailable(),
		);

		// Byte-for-byte the rows and the order the importance query returned.
		expect(ids(outcome.memories)).toEqual(['mem-a', 'mem-b', 'mem-c']);
		expect(outcome.mode).toBe('importance');
		// Nothing was ranked, so the reason a vector was not used is still reported.
		expect(outcome.degradedReason).toContain('OPENAI_API_KEY');
	});

	it('does not reorder on a stopword-only turn', async () => {
		const pool: MemoryRow[] = [
			{ id: 'mem-a', category: 'fact', content: 'The user lives in Chennai', importance: 90 },
			{ id: 'mem-b', category: 'preference', content: 'Would you like me to be there', importance: 10 },
		];
		const { db } = makeMemoryDb({ importanceOrder: pool });
		vi.mocked(getDb).mockReturnValue(db);

		const outcome = await rankMemoriesForTurn('user-1', 'could you do that for me please', 2, embedUnavailable());

		expect(ids(outcome.memories)).toEqual(['mem-a', 'mem-b']);
		expect(outcome.mode).toBe('importance');
	});

	it('does not reorder on a one-character turn', async () => {
		const pool: MemoryRow[] = [
			{ id: 'mem-a', category: 'fact', content: 'The user lives in Chennai', importance: 90 },
			{ id: 'mem-b', category: 'fact', content: 'The user works at Leadup', importance: 80 },
		];
		const { db } = makeMemoryDb({ importanceOrder: pool });
		vi.mocked(getDb).mockReturnValue(db);

		const outcome = await rankMemoriesForTurn('user-1', 'a', 2, embedUnavailable());

		expect(ids(outcome.memories)).toEqual(['mem-a', 'mem-b']);
		expect(outcome.mode).toBe('importance');
	});

	it('does not let a bare stop word shared with a memory rank it', async () => {
		const pool: MemoryRow[] = [
			{ id: 'mem-a', category: 'fact', content: 'The user lives in Chennai', importance: 90 },
			{ id: 'mem-b', category: 'fact', content: 'The user is working', importance: 10 },
		];
		const { db } = makeMemoryDb({ importanceOrder: pool });
		vi.mocked(getDb).mockReturnValue(db);

		// "is" is the only overlap, and it is a stop word.
		const outcome = await rankMemoriesForTurn('user-1', 'where is it', 2, embedUnavailable());

		expect(ids(outcome.memories)).toEqual(['mem-a', 'mem-b']);
		expect(outcome.mode).toBe('importance');
	});
});

describe('rankMemoriesForTurn — the cap is filled, never shrunk', () => {
	it('returns everything a user has when there is less than the cap', async () => {
		const pool: MemoryRow[] = [
			{ id: 'mem-a', category: 'fact', content: 'The user lives in Chennai', importance: 90 },
			{ id: 'mem-b', category: 'preference', content: 'My preferred time for daily planning is 9 AM', importance: 5 },
		];
		const { db } = makeMemoryDb({ importanceOrder: pool });
		vi.mocked(getDb).mockReturnValue(db);

		const outcome = await rankMemoriesForTurn('user-1', PLANNING_TURN, 12, embedUnavailable());

		expect(ids(outcome.memories).sort()).toEqual(['mem-a', 'mem-b']);
	});

	it('tops a single lexical hit up to the cap from the importance ordering', async () => {
		const pool: MemoryRow[] = [
			{ id: 'mem-a', category: 'fact', content: 'The user lives in Chennai', importance: 90 },
			{ id: 'mem-b', category: 'fact', content: 'The user works at Leadup', importance: 80 },
			{ id: 'mem-c', category: 'fact', content: 'Favourite colour is green', importance: 70 },
			{ id: 'mem-d', category: 'preference', content: 'My preferred time for daily planning is 9 AM', importance: 5 },
		];
		const { db } = makeMemoryDb({ importanceOrder: pool });
		vi.mocked(getDb).mockReturnValue(db);

		const outcome = await rankMemoriesForTurn('user-1', PLANNING_TURN, 4, embedUnavailable());

		// The hit first, then every remaining row in importance order: no slot lost.
		expect(ids(outcome.memories)).toEqual(['mem-d', 'mem-a', 'mem-b', 'mem-c']);
		expect(outcome.mode).toBe('lexical');
	});
});

describe('rankMemoriesForTurn — a provider that answers still wins', () => {
	it('keeps the vector ranking first choice and reports relevance', async () => {
		const pool: MemoryRow[] = [
			{ id: 'mem-a', category: 'fact', content: 'The user lives in Chennai', importance: 90 },
			{ id: 'mem-b', category: 'fact', content: 'The user works at Leadup', importance: 80 },
			PLANNING_MEMORY,
		];
		const { db, executed } = makeMemoryDb({
			importanceOrder: pool,
			relevanceOrder: [PLANNING_MEMORY],
		});
		vi.mocked(getDb).mockReturnValue(db);

		const outcome = await rankMemoriesForTurn('user-1', PLANNING_TURN, 2, embedAvailable());

		expect(outcome.mode).toBe('relevance');
		expect(ids(outcome.memories)).toEqual(['mem-planning', 'mem-a']);
		// The vector path is the one that ran — not the lexical fallback.
		expect(executed).toHaveLength(1);
		expect(executed[0]).toContain('embedding_vec <=>');
	});
});

describe('rankMemoriesForTurn — no turn is unchanged', () => {
	it('runs the importance query and claims no degradation when no turn is supplied', async () => {
		const { db, executed } = makeMemoryDb({ importanceOrder: MEASURED_POOL });
		vi.mocked(getDb).mockReturnValue(db);

		const outcome = await rankMemoriesForTurn('user-1', '', 12, embedUnavailable());

		expect(outcome.memories).toHaveLength(12);
		expect(ids(outcome.memories)).toEqual(DISTRACTORS.slice(0, 12).map((row) => row.id));
		expect(outcome.mode).toBe('importance');
		// Nothing was attempted, so nothing is claimed.
		expect(outcome.degradedReason).toBeUndefined();
		expect(executed).toEqual([]);
	});
});

/**
 * Tamil and Tanglish — what the tokeniser does, stated rather than assumed.
 *
 * The tokeniser is Unicode-aware, so Tamil script tokenises rather than falling
 * out of an ASCII word split, and it does not stem Tamil at all. The honest
 * limitation is stated by the last case here: it matches *terms*, so a Tamil turn
 * finds a Tamil memory and a Tanglish turn finds the English loan words it
 * carries, but it cannot know that "தினசரி திட்டம்" and "daily planning" are the
 * same subject. That gap is the embeddings path's job, and it is reachable the
 * moment a provider is configured.
 */
describe('rankMemoriesForTurn — Tamil and Tanglish turns', () => {
	it('ranks a Tamil-script memory against a Tamil-script turn', async () => {
		const pool: MemoryRow[] = [
			{ id: 'mem-standup', category: 'fact', content: 'காலை பத்து மணிக்கு கூட்டம்', importance: 90 },
			{ id: 'mem-plan', category: 'preference', content: 'நான் தினமும் திட்டமிடல் செய்கிறேன்', importance: 5 },
		];
		const { db } = makeMemoryDb({ importanceOrder: pool });
		vi.mocked(getDb).mockReturnValue(db);

		const outcome = await rankMemoriesForTurn('user-1', 'நான் தினமும் திட்டமிடல் செய்கிறேன், நினைவூட்டு', 1, embedUnavailable());

		expect(ids(outcome.memories)).toEqual(['mem-plan']);
		expect(outcome.mode).toBe('lexical');
	});

	it('ranks a Tanglish turn against an English memory through the terms they share', async () => {
		const pool: MemoryRow[] = [
			{ id: 'mem-standup', category: 'fact', content: 'காலை பத்து மணிக்கு கூட்டம்', importance: 90 },
			{ id: 'mem-plan', category: 'preference', content: 'My preferred time for daily planning is 9 AM', importance: 5 },
		];
		const { db } = makeMemoryDb({ importanceOrder: pool });
		vi.mocked(getDb).mockReturnValue(db);

		// Romanised Tanglish, which is Latin script: the words "daily" and
		// "planning" are the memory's own words, so they match.
		const outcome = await rankMemoriesForTurn('user-1', 'daily planning எப்போது பண்றது?', 1, embedUnavailable());

		expect(ids(outcome.memories)).toEqual(['mem-plan']);
		expect(outcome.mode).toBe('lexical');
	});

	it('cannot match across scripts: a Tamil turn does not find an English memory', async () => {
		const pool: MemoryRow[] = [
			{ id: 'mem-standup', category: 'fact', content: 'The team standup meeting is at ten fifteen', importance: 90 },
			{ id: 'mem-plan', category: 'preference', content: 'My preferred time for daily planning is 9 AM', importance: 5 },
		];
		const { db } = makeMemoryDb({ importanceOrder: pool });
		vi.mocked(getDb).mockReturnValue(db);

		// The same *question* as PLANNING_TURN, in Tamil script. The lexical
		// fallback has no shared term to work with, so it does not guess: it returns
		// the importance ordering and keeps reporting the degradation. This is the
		// documented limitation — Tamil script in, English out is the embeddings
		// path's job, and it is reachable the moment a provider is configured.
		const outcome = await rankMemoriesForTurn('user-1', 'நான் தினமும் திட்டமிடல் செய்கிறேன், நினைவூட்டு', 1, embedUnavailable());

		expect(ids(outcome.memories)).toEqual(['mem-standup']);
		expect(outcome.mode).toBe('importance');
		expect(outcome.degradedReason).toBeTruthy();
	});
});
