/**
 * NOVA API — Memory management service.
 *
 * Business logic for memory CRUD, search, embedding, and lifecycle.
 */
import { getDb } from '../db/connection.js';
import { getPrivacyPreferences } from './privacy-preferences.js';
import { HttpError } from '../middleware/error-handler.js';
import { memories, memoryEmbeddings } from '@nova/database';
import { eq, desc, and, inArray, sql, ilike } from 'drizzle-orm';
import { generateEmbedding as generateEmbeddingVector, type EmbeddingResult } from './ai.js';
import { logger } from '../utils/logger.js';
import { MEMORY_STOP_WORDS, type RankedMemory } from './memory-tokens.js';
import { hasRankableTerms, rankByLexicalOverlap } from './memory-text.js';

// Re-exported, not merely imported: this is the vocabulary the lifecycle writers
// below and the retrieval fallback in `memory-text.ts` both weigh words against,
// and every existing importer of it names this module.
export { MEMORY_STOP_WORDS } from './memory-tokens.js';
export type { RankedMemory } from './memory-tokens.js';

const MAX_CONTENT_LENGTH = 100_000;

/** Mirrors `MemorySearchSchema.query.max(500)` — kept here so the service bounds itself. */
const MAX_SEARCH_TERM_LENGTH = 500;
/** Mirrors `MemorySearchSchema.limit.max(50)`. */
const MAX_SEARCH_LIMIT = 50;

export interface CreateMemoryInput {
	userId: string;
	tenantId?: string;
	category: string;
	content: string;
	sourceType: string;
	visibility?: string;
	sensitivity?: string;
	importance?: number;
	confidence?: number;
	normalizedFacts?: Record<string, unknown>;
	sourceIds?: string[];
}

export interface MemoryFilters {
	category?: string;
	visibility?: string;
	status?: string;
	minConfidence?: number;
	limit?: number;
	offset?: number;
}

export async function createMemory(input: CreateMemoryInput) {
	const trimmedContent = input.content.trim().slice(0, MAX_CONTENT_LENGTH);
	const db = getDb();

	// "Save memories" in Profile → Privacy controls. Until this check existed the switch
	// stored a preference and the server wrote the memory anyway.
	const prefs = await getPrivacyPreferences(db, input.userId);
	if (!prefs.saveMemories) {
		throw new HttpError(
			409,
			'Memory saving is switched off in your privacy controls, so nothing was saved. Turn "Save memories" back on to keep this.',
			'MEMORY_SAVING_DISABLED',
		);
	}

	const [memory] = await db.insert(memories).values({
		userId: input.userId,
		tenantId: input.tenantId ?? null,
		category: input.category,
		content: trimmedContent,
		sourceType: input.sourceType,
		visibility: input.visibility ?? 'private',
		sensitivity: input.sensitivity ?? 'normal',
		importance: input.importance ?? 50,
		confidence: input.confidence ?? 50,
		normalizedFacts: input.normalizedFacts ?? {},
		sourceIds: input.sourceIds ?? [],
		// `memories` has no deletedAt — it is archived through `status`, and the
		// grounding block reads 'proposed', so a new memory is immediately visible
		// to NOVA. This default is why the embedding hook below is not conditional
		// on anything but `status`.
		status: 'proposed',
	}).returning();

	// Embedding generation is deliberately not awaited: the memory is already
	// committed and the response must not wait on a network call to a provider.
	// `storeEmbedding` never throws and logs its own outcome — this `catch` only
	// covers the impossible case, so a rejection cannot become an unhandled one.
	if (memory.status === 'proposed') {
		storeEmbedding(memory.id, trimmedContent).catch((err) => {
			logger.warn({ err, memoryId: memory.id }, 'Background embedding generation failed');
		});
	}

	return memory;
}

export async function getMemory(id: string, userId: string) {
	const db = getDb();
	const [memory] = await db.select().from(memories).where(and(eq(memories.id, id), eq(memories.userId, userId)));
	return memory ?? null;
}

export async function listMemories(userId: string, filters: MemoryFilters = {}) {
	const db = getDb();
	const limit = filters.limit ?? 20;
	const offset = filters.offset ?? 0;

	const whereClauses = [eq(memories.userId, userId)];
	if (filters.category) whereClauses.push(eq(memories.category, filters.category));
	if (filters.visibility) whereClauses.push(eq(memories.visibility, filters.visibility));
	if (filters.status) whereClauses.push(eq(memories.status, filters.status));
	if (filters.minConfidence !== undefined) {
		whereClauses.push(sql`${memories.confidence} >= ${filters.minConfidence}`);
	}

	const rows = await db.select().from(memories)
		.where(and(...whereClauses))
		.orderBy(desc(memories.createdAt))
		.limit(limit).offset(offset);

	const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(memories).where(and(...whereClauses));
	const total = Number(countRow?.count ?? 0);

	return { memories: rows, total, page: Math.floor(offset / limit) + 1, pageSize: limit };
}

export async function updateMemory(id: string, userId: string, patch: Record<string, unknown>) {
	const db = getDb();
	const [memory] = await db.update(memories)
		.set({ ...patch, updatedAt: new Date() })
		.where(and(eq(memories.id, id), eq(memories.userId, userId)))
		.returning();
	return memory ?? null;
}

export async function deleteMemory(id: string, userId: string) {
	const db = getDb();
	const [memory] = await db.delete(memories).where(and(eq(memories.id, id), eq(memories.userId, userId))).returning();
	return memory ?? null;
}

// ─── Lifecycle: supersession and forgetting ──────────────────────────

/**
 * The statuses `user-context.ts` renders into the assistant's grounding block.
 *
 * This is the *observable* definition of a memory being live: it is the set that
 * module filters `memories` on before the model is told anything, so a row moved
 * out of it cannot reach the assistant. It lives here, beside the writers that
 * move rows in and out of it, so a correction and a forgetting are decided
 * against the same list the reader uses rather than a copy that can drift.
 */
export const LIVE_MEMORY_STATUSES: readonly string[] = ['proposed', 'approved', 'active', 'corrected'];

/**
 * Where a superseded or forgotten memory goes.
 *
 * `memories` has no `deletedAt`, so the lifecycle is the `status` column — and
 * `archived` is already a value the status enum in `schemas/index.ts` and the
 * memories routes accept. Nothing hard-deletes: a row moved here stops being
 * live, which is the whole observable requirement, while the user's history
 * survives a misheard "forget that".
 */
export const ARCHIVED_MEMORY_STATUS = 'archived';

/**
 * Words that carry no subject matter.
 *
 * Without this list "Lives in Chennai" and "Works in Chennai" share two of three
 * tokens, and an overlap rule keyed on raw words would archive a fact the user
 * never contradicted. The content words are what make two statements about the
 * same thing, so they are what the comparison runs on.
 *
 * The list itself lives in `memory-tokens.ts` because the retrieval fallback
 * needs the same one; see the note there.
 */

/**
 * The significant words of a memory.
 *
 * Falls back to every word when a statement is *all* stop words ("Not now"), so a
 * short memory is never left with an empty token set that silently matches
 * nothing. Unicode-aware, because the assistant answers in the user's language
 * and a Tamil fact has to tokenise like an English one.
 */
export function memoryTokens(content: string): Set<string> {
	const words = content.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
	const significant = words.filter((word) => !MEMORY_STOP_WORDS.has(word));
	return new Set(significant.length ? significant : words);
}

/**
 * How much of an existing memory the new fact must repeat before it is treated
 * as a correction to *that* memory rather than a new fact beside it.
 *
 * Measured against the two real phrasings: "My favourite colour is blue" →
 * "My favourite colour is green" shares two of the old row's three content words
 * (0.67), and the fuller "Actually my favourite colour is green, not blue" shares
 * all three (1.0). Both clear 0.6; "Lives in Chennai" → "Works in Chennai" (0.5)
 * does not, which is the false positive this guards.
 */
const SUPERSEDE_OVERLAP_SAME_CATEGORY = 0.6;

/**
 * The bar when the two rows were filed under different categories.
 *
 * Higher because the category is the model's own choice and therefore the least
 * trustworthy field on the row: it may file the same fact as `fact` on one turn
 * and `preference` on the next, which is exactly how a correction would slip
 * through if the rule demanded the categories match. Demanding less of a
 * cross-category match is the other failure — a preference about spicy food
 * quietly archived by an unrelated event — so a *near-total* restatement is
 * required to cross the boundary.
 */
const SUPERSEDE_OVERLAP_CROSS_CATEGORY = 0.8;

/**
 * True when `incoming` restates `existing` rather than adding a fact beside it.
 *
 * Deliberately a lexical rule over content words, not a model decision: the
 * measured defect is precisely that the model said "Updated!" while nothing was
 * superseded, so the guarantee cannot be delegated back to it. The cost is that
 * a correction phrased with no shared wording ("I go by green these days" after
 * "Favourite colour is blue") is not caught — the tradeoff is documented here so
 * the missed case is visible rather than surprising.
 */
export function supersedesMemory(
	existing: { content: string; category: string },
	incoming: { content: string; category: string },
): boolean {
	const before = memoryTokens(existing.content);
	const after = memoryTokens(incoming.content);
	if (!before.size || !after.size) return false;
	let shared = 0;
	for (const token of before) if (after.has(token)) shared++;
	const threshold =
		existing.category === incoming.category
			? SUPERSEDE_OVERLAP_SAME_CATEGORY
			: SUPERSEDE_OVERLAP_CROSS_CATEGORY;
	return shared / before.size >= threshold;
}

/** One row this module moved out of the live set. */
export interface ArchivedMemory {
	id: string;
	content: string;
}

/** How many live rows are considered for a supersession or a forgetting. */
const LIFECYCLE_CANDIDATE_LIMIT = 50;

/**
 * Archives the live memories a new fact replaces, so exactly one live row is
 * left stating it.
 *
 * Called by the `save_memory` tool *after* the new row is written, and never
 * delegated to the model: "the new fact supersedes an older one" is a property
 * of the two rows, not an intention the model has to remember to express. The
 * order matters — if the archive fails, the user still has their new memory and
 * a truthful tool result, whereas archiving first and failing to insert would
 * lose the fact.
 *
 * Only rows this call actually moved are returned. A row that stayed live is not
 * reported as superseded, because a confirmation built on this list is the one
 * thing the user reads.
 */
export async function archiveSupersededMemories(input: {
	userId: string;
	category: string;
	content: string;
	/** The row just written, so it can never supersede itself. */
	keepId?: string;
}): Promise<ArchivedMemory[]> {
	const db = getDb();
	// No category predicate: `supersedesMemory` weighs the categories itself,
	// because the interesting case is precisely a row filed under a different one.
	const rows = await db
		.select({ id: memories.id, content: memories.content, category: memories.category })
		.from(memories)
		.where(and(eq(memories.userId, input.userId), inArray(memories.status, [...LIVE_MEMORY_STATUSES])))
		.orderBy(desc(memories.createdAt))
		.limit(LIFECYCLE_CANDIDATE_LIMIT);

	const superseded: ArchivedMemory[] = [];
	for (const row of rows) {
		if (row.id === input.keepId) continue;
		if (!supersedesMemory(row, input)) continue;
		const updated = await updateMemory(row.id, input.userId, { status: ARCHIVED_MEMORY_STATUS });
		if (updated) superseded.push({ id: row.id, content: row.content });
	}
	return superseded;
}

/**
 * True when `query` names the fact `content` states.
 *
 * Both directions, because the user's phrasing can be either side of the fact:
 * "forget my favourite colour" is a subset of "Favourite colour is blue", and
 * "forget that my favourite colour is blue" is a superset of it. Every content
 * word on the shorter side must appear on the longer one, which is what stops a
 * single shared word from dragging an unrelated memory along.
 */
export function namesMemory(content: string, query: string): boolean {
	const fact = memoryTokens(content);
	const ask = memoryTokens(query);
	if (!fact.size || !ask.size) return false;
	let shared = 0;
	for (const token of fact) if (ask.has(token)) shared++;
	return shared === Math.min(fact.size, ask.size);
}

/**
 * Takes the memories the user asked to forget out of the live set.
 *
 * A status change, not a `DELETE`. `deleteMemory` exists — the memories screen
 * uses it — but reaching for it here would destroy the row on a misheard name,
 * and the user's "forget" is not a request to lose the history. Archiving is the
 * same reversibility every other assistant verb has (`cancel_reminder` sets
 * `dismissed` rather than deleting), and it satisfies the observable requirement:
 * `user-context.ts` filters on [LIVE_MEMORY_STATUSES], so an archived row cannot
 * reach the model.
 *
 * Scoped by `userId` in the query, so an identical fact on somebody else's
 * account is not reachable from this user's turn.
 */
export async function forgetMatchingMemories(userId: string, query: string): Promise<ArchivedMemory[]> {
	const db = getDb();
	const rows = await db
		.select({ id: memories.id, content: memories.content })
		.from(memories)
		.where(and(eq(memories.userId, userId), inArray(memories.status, [...LIVE_MEMORY_STATUSES])))
		.orderBy(desc(memories.createdAt))
		.limit(LIFECYCLE_CANDIDATE_LIMIT);

	const forgotten: ArchivedMemory[] = [];
	for (const row of rows) {
		if (!namesMemory(row.content, query)) continue;
		const updated = await updateMemory(row.id, userId, { status: ARCHIVED_MEMORY_STATUS });
		if (updated) forgotten.push({ id: row.id, content: row.content });
	}
	return forgotten;
}

/**
 * Escapes the characters `LIKE`/`ILIKE` reads as wildcards.
 *
 * Without this the term the user typed was not the term that ran: `?query=%`
 * matched every row and `?query=_` matched any single character, so a search box
 * containing `%` returned the user's entire memory history. Postgres uses
 * backslash as the default LIKE escape character and the value stays a bound
 * parameter, so escaping here is sufficient.
 */
export function escapeLikeTerm(term: string): string {
	return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The `ILIKE` clause for a keyword search over memory content.
 *
 * Substring ("contains") semantics are deliberate, which is why the pattern keeps
 * its leading wildcard and cannot use an ordinary btree index — bounding it needs
 * a `pg_trgm` GIN index in `packages/database` (not creatable from here) plus the
 * term and limit caps below.
 */
export function memoryContentMatches(term: string) {
	return ilike(memories.content, `%${escapeLikeTerm(term)}%`);
}

export async function searchMemories(userId: string, query: string, limit = 10): Promise<{ memories: unknown[]; total: number; latencyMs: number }> {
	const start = Date.now();

	// Bounded here as well as at the route, because this is a domain function:
	// nothing stopped a caller passing `limit = 1_000_000`, and a whitespace-only
	// term built the pattern `'%' || '' || '%'`, which matches every row the user
	// owns — an unbounded sequential scan returning the whole table.
	const term = query.trim().slice(0, MAX_SEARCH_TERM_LENGTH);
	const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 10;
	const boundedLimit = Math.min(Math.max(1, requestedLimit), MAX_SEARCH_LIMIT);

	if (!term) {
		return { memories: [], total: 0, latencyMs: Date.now() - start };
	}

	const db = getDb();
	const rows = await db.select().from(memories)
		.where(and(eq(memories.userId, userId), memoryContentMatches(term)))
		.orderBy(desc(memories.importance))
		.limit(boundedLimit);

	return {
		memories: rows as unknown[],
		total: rows.length,
		latencyMs: Date.now() - start,
	};
}

// ─── Relevance ranking for the assistant's grounding ──────────────────

/** How a memory section was actually ordered. */
export type MemoryRankingMode = 'relevance' | 'lexical' | 'importance';

export interface MemoryRankingOutcome {
	memories: RankedMemory[];
	/**
	 * `relevance` means the turn ranked them on embeddings, `lexical` that it ranked
	 * them on term overlap because no embedding was available, and `importance` is
	 * the ordering the grounding block used before any of this existed.
	 */
	mode: MemoryRankingMode;
	/** Set when a relevance ranking was wanted but could not run. */
	degradedReason?: string;
}

/** Produces an embedding for a piece of text, or says why it cannot. */
export type MemoryEmbedder = (text: string) => Promise<EmbeddingResult>;

/** A memory no longer than this can be ranked; mirrors the search term cap. */
const MAX_RANKING_QUERY_LENGTH = 500;

/**
 * How many rows are read to rank against, as a multiple of what will be rendered.
 *
 * The importance query used to fetch exactly `limit` rows, which is what made the
 * measured defect unrecoverable: the planning fact sat at position 14 behind
 * thirteen distractors, so it was not merely outranked, it was never *read*, and
 * no ranking of the fetched rows could have found it. The pool has to be wider
 * than the cap for a fallback to have anything to promote.
 *
 * Bounded, because this is a per-turn read: `4 × maxMemories` is 48 rows at the
 * shipped default of 12, and `MAX_SEARCH_LIMIT` (50) caps it for any caller that
 * asks for more. The extra rows are a single indexed read and are never rendered.
 */
const RANKING_POOL_MULTIPLIER = 4;

/**
 * The user's memories, ordered by relevance to their current turn.
 *
 * The grounding block used to inject the top `maxMemories` rows by `importance`
 * alone, so with more than that many saved, a fact the user had just referred to
 * fell out of the prompt and NOVA answered as though it had never been told. This
 * ranks the same rows against the turn instead, keeping the existing cap.
 *
 * Three properties are deliberate:
 *
 *  - It never silently degrades. When no embedding can be produced — no provider,
 *    a provider that failed, or a user with no stored vectors — it tries the
 *    provider-free lexical ranking, and only then, when *that* finds nothing the
 *    turn and the memories share, returns the importance ordering *and* a
 *    `degradedReason`. A ranking that quietly stopped ranking reads to the user
 *    as "NOVA ignored what I told it".
 *  - It is bounded even when a ranking works. The ranked rows are capped at
 *    `limit`, and any room left is filled from the importance ordering, so a
 *    memory that no ranking could reach is still visible rather than lost.
 *  - It never returns fewer memories than the old path did, and never reorders on
 *    noise: a turn with no significant terms, or with no term any memory shares,
 *    is the importance ordering exactly.
 *
 * `embedder` is a seam: the default is the platform provider, and a caller (or a
 * test) can supply one without touching the provider configuration.
 */
export async function rankMemoriesForTurn(
	userId: string,
	query: string,
	limit: number,
	embedder: MemoryEmbedder = generateEmbeddingVector,
): Promise<MemoryRankingOutcome> {
	const db = getDb();
	const requested = Number.isFinite(limit) ? Math.trunc(limit) : 0;
	const boundedLimit = Math.min(Math.max(0, requested), MAX_SEARCH_LIMIT);
	// A caller that asked for no memories gets none, whichever path is taken —
	// the importance-only path already behaved this way via `.limit(0)`.
	if (boundedLimit === 0) return { memories: [], mode: 'importance' };

	// Today's ordering, fetched even on the relevance path: it is the fallback when
	// no ranking can run, and the fill when one can. Read wider than the cap so a
	// relevant row behind a wall of high-importance rows is reachable at all.
	const candidatePool = Math.min(boundedLimit * RANKING_POOL_MULTIPLIER, MAX_SEARCH_LIMIT);
	const importanceOrdered = (await db
		.select({
			id: memories.id,
			category: memories.category,
			content: memories.content,
			importance: memories.importance,
		})
		.from(memories)
		.where(and(eq(memories.userId, userId), inArray(memories.status, [...LIVE_MEMORY_STATUSES])))
		.orderBy(desc(memories.importance), desc(memories.createdAt))
		.limit(candidatePool)) as RankedMemory[];

	const term = query.trim().slice(0, MAX_RANKING_QUERY_LENGTH);
	// No turn to rank against (a briefing sweep): today's behaviour, and no
	// degradation to report, because nothing was asked for and not delivered.
	if (!term) return { memories: importanceOrdered.slice(0, boundedLimit), mode: 'importance' };

	/**
	 * Ranks on term overlap when the embedding path cannot run, or reports that
	 * there was nothing to rank on.
	 *
	 * `reason` is the truth about why no vector was used, and it is carried into
	 * the outcome only when the lexical ranking could not discriminate either. A
	 * lexical ranking that *did* run is a ranking, not a degradation, so `mode`
	 * says `lexical` and nothing is claimed to have failed.
	 */
	const lexicalFallback = (reason: string): MemoryRankingOutcome => {
		if (hasRankableTerms(term)) {
			const lexicallyRanked = rankByLexicalOverlap(term, importanceOrdered);
			if (lexicallyRanked) {
				return { memories: fillToCap(lexicallyRanked, importanceOrdered, boundedLimit), mode: 'lexical' };
			}
		}
		return { memories: importanceOrdered.slice(0, boundedLimit), mode: 'importance', degradedReason: reason };
	};

	let embedded: EmbeddingResult;
	try {
		embedded = await embedder(term);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		logger.warn({ err, userId }, 'Memory relevance ranking fell back to importance');
		return lexicalFallback(
			`the embedding provider failed, so memories were ordered by importance: ${detail}`,
		);
	}

	if (!embedded.available) {
		return lexicalFallback(embedded.reason);
	}

	let relevant: RankedMemory[];
	try {
		// `embedding_vec` is the real `vector(1536)` column the HNSW index covers.
		// `embedding` is jsonb, and `jsonb <=> vector` is an error rather than a slow
		// query, so the two are not interchangeable. NULL vectors are excluded: a
		// NULL has no direction, and ranking one would report a hit that was never
		// compared.
		const result = await db.execute(sql`
			SELECT memories.id, memories.category, memories.content, memories.importance
			FROM memories
			INNER JOIN memory_embeddings ON memory_embeddings.memory_id = memories.id
			WHERE memories.user_id = ${userId}
			AND ${inArray(memories.status, [...LIVE_MEMORY_STATUSES])}
			AND memory_embeddings.embedding_vec IS NOT NULL
			ORDER BY memory_embeddings.embedding_vec <=> ${JSON.stringify(embedded.embedding)}::vector
			LIMIT ${boundedLimit}
		`);
		// The projection above is exactly `RankedMemory`; `execute` is typed as loose
		// rows, so the cast is the contract.
		relevant = (result?.rows ?? []) as unknown as RankedMemory[];
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		logger.warn({ err, userId }, 'The memory relevance read failed; using importance order');
		return lexicalFallback(
			`the memory relevance read failed, so memories were ordered by importance: ${detail}`,
		);
	}

	if (!relevant.length) {
		// A provider answered but there is nothing to compare against. That is a
		// ranking that did not happen, so it is reported rather than dressed up as a
		// relevance result — unless the provider-free comparison can still separate
		// these rows, which is exactly the user with no stored vectors at all.
		return lexicalFallback(
			'a vector was produced, but none of this user\'s memories have a stored vector yet, ' +
				'so memories were ordered by importance',
		);
	}

	return { memories: fillToCap(relevant, importanceOrdered, boundedLimit), mode: 'relevance' };
}

/**
 * The ranked rows first, then the importance fill, deduplicated and capped.
 *
 * A ranked row that is also important appears once — in the position its ranking
 * earned. The fill is what keeps the cap full for a memory no ranking could reach,
 * so this path never hands the model fewer memories than the importance query did.
 */
function fillToCap(
	ranked: readonly RankedMemory[],
	importanceOrdered: readonly RankedMemory[],
	limit: number,
): RankedMemory[] {
	const seen = new Set<string>();
	const selected: RankedMemory[] = [];
	for (const row of [...ranked, ...importanceOrdered]) {
		if (selected.length >= limit) break;
		if (seen.has(row.id)) continue;
		seen.add(row.id);
		selected.push(row);
	}
	return selected;
}

/** What `storeEmbedding` / `persistEmbedding` did, and why not when they did nothing. */
export type EmbeddingStoreOutcome =
	| { stored: true; embeddingId: string; model: string }
	| { stored: false; reason: string };

/**
 * Persists an embedding that has already been obtained, and links it from
 * `memories.embedding_id`.
 *
 * Split out from acquisition so the refusal below is reachable in a test without
 * configuring a provider — the refusal is the point, and a seam that only allowed
 * the happy path to be exercised would let it regress unnoticed.
 *
 * A zero-dimension vector is refused outright. Storing one wrote a row whose
 * `embedding` was `[]` and whose `model` named a model that never ran: a record of
 * an embedding that does not exist, which every later similarity search silently
 * compares against and matches nothing.
 */
export async function persistEmbedding(memoryId: string, result: EmbeddingResult): Promise<EmbeddingStoreOutcome> {
	if (!result.available) {
		logger.warn(
			{ memoryId, reason: result.reason },
			'No memory embedding stored: no embeddings provider is available',
		);
		return { stored: false, reason: result.reason };
	}

	if (result.embedding.length === 0 || result.dimensions <= 0 || result.dimensions !== result.embedding.length) {
		logger.error(
			{ memoryId, model: result.model, dimensions: result.dimensions, values: result.embedding.length },
			'Refusing to store a memory embedding with no usable vector',
		);
		return { stored: false, reason: 'empty_embedding' };
	}

	try {
		const db = getDb();
		const [row] = await db.insert(memoryEmbeddings).values({
			memoryId,
			embedding: result.embedding,
			// The same vector in the real `vector(1536)` column the HNSW index is built on.
			// Only ever reached with a usable vector: everything above returns early when no
			// provider answered or the vector is empty, so a NULL (or an all-zero stand-in)
			// is never written here. A NULL is the honest representation of "no embedding",
			// and writing one deliberately would put a meaningless point into the index that
			// every cosine ordering would then rank.
			embeddingVec: result.embedding,
			// The provider's own model name — never a hard-coded label for a model that
			// did not run.
			model: result.model,
			dimensions: result.dimensions,
		}).returning();

		if (!row?.id) {
			logger.error({ memoryId }, 'Storing the memory embedding returned no row to link');
			return { stored: false, reason: 'store_failed' };
		}

		// `memoriesRelations.embedding` reads this column and nothing ever wrote it, so
		// the relation was null forever even once an embedding row existed.
		await db.update(memories)
			.set({ embeddingId: row.id, updatedAt: new Date() })
			.where(eq(memories.id, memoryId));

		logger.info(
			{ memoryId, embeddingId: row.id, model: result.model, dimensions: result.dimensions },
			'Stored memory embedding',
		);
		return { stored: true, embeddingId: row.id, model: result.model };
	} catch (err) {
		// Logged, not swallowed. This `catch` used to be empty directly beneath its own
		// "Log but don't fail" comment, so a failed embedding left no trace at any
		// level. The memory row is already committed and is unaffected.
		logger.error({ err, memoryId }, 'Could not store the memory embedding; the memory is unaffected');
		return { stored: false, reason: 'store_failed' };
	}
}

/** Generates and persists a memory's embedding. Never throws; reports what happened. */
export async function storeEmbedding(memoryId: string, content: string): Promise<EmbeddingStoreOutcome> {
	try {
		return await persistEmbedding(memoryId, await generateEmbeddingVector(content));
	} catch (err) {
		logger.error({ err, memoryId }, 'Embedding generation failed; the memory is stored without one');
		return { stored: false, reason: 'generation_failed' };
	}
}
