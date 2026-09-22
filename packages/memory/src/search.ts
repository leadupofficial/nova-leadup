/**
 * LEA-011 — MemorySearch
 *
 * Semantic search over memories. Uses pgvector cosine similarity when a real
 * embedding can be obtained; falls back to ILIKE text search when it cannot.
 *
 * Server-side only. Requires pgvector extension on PostgreSQL for vector search.
 */

import { memories, memoryEmbeddings } from '@nova/database/schema';
import { eq, and, sql } from 'drizzle-orm';
import type { MemorySearchRequest, MemorySearchResponse, MemoryRecord } from '@nova/shared-types';
import {
 DEFAULT_EMBEDDING_MODEL,
 EmbeddingProviderError,
 embeddingsAvailable,
 generateEmbedding,
 isUsableEmbedding,
 isUsableVector,
 type EmbeddingResult,
 type EmbeddingVector,
} from './embedding.js';

// ─── Embedding Generation ────────────────────────────────────────────────────

// Re-exported from the single source of truth in `./embedding.js`. This module used
// to declare its own `generateEmbedding` that also returned a zero vector; two
// copies of a fabrication is two places to fix and two places to drift. There is now
// exactly one implementation, and it returns a discriminated result.
export {
 DEFAULT_EMBEDDING_MODEL,
 EmbeddingProviderError,
 embeddingsAvailable,
 generateEmbedding,
 isUsableEmbedding,
 isUsableVector,
};
export type { EmbeddingResult, EmbeddingVector };

// ─── MemorySearch ────────────────────────────────────────────────────────────

/** How a search actually ran. `vector` requires a real embedding. */
export type MemorySearchMode = 'vector' | 'text';

/**
 * Search outcome.
 *
 * Extends the shared `MemorySearchResponse` with the mode that actually ran, so a
 * caller can tell a semantic result from a degraded text result. Previously the
 * unavailable case was invisible: a zero vector was searched and the response
 * reported an ordinary success.
 */
export interface MemorySearchOutcome extends MemorySearchResponse {
 readonly searchMode: MemorySearchMode;
 /** Set when a semantic search was wanted but could not run. */
 readonly degradedReason?: string;
}

export class MemorySearch {
 constructor(private readonly db: any) {}

 /**
  * Search for memories by semantic similarity.
  *
  * Embeds the query for real and searches pgvector when a provider is configured and
  * the user has stored embeddings; otherwise falls back to ILIKE and says so in
  * `searchMode`. A fabricated vector is never searched.
  */
 async search(
  userId: string,
  request: MemorySearchRequest,
  ): Promise<MemorySearchOutcome> {
  const start = performance.now();
  const limit = Math.min(request.limit ?? 10, 50);

  let rows: Record<string, unknown>[];
  let searchMode: MemorySearchMode = 'text';
  let degradedReason: string | undefined;

  if (await this.hasEmbeddingsForUser(userId)) {
   const embedded = await generateEmbedding(request.query, DEFAULT_EMBEDDING_MODEL);
   if (isUsableEmbedding(embedded)) {
    rows = await this.vectorSearch(userId, embedded.embedding, limit);
    searchMode = 'vector';
   } else {
    // A semantic search was possible in principle but no vector exists, so say so
    // in the response instead of searching a fabricated one.
    degradedReason = embedded.reason;
    rows = await this.textSearch(userId, request, limit);
   }
  } else {
   rows = await this.textSearch(userId, request, limit);
  }

  const results = rows.map((row) => row as unknown as MemoryRecord);
  const latencyMs = Math.round(performance.now() - start);

  return {
   results,
   total: results.length,
   query: request.query,
   latencyMs,
   searchMode,
   ...(degradedReason ? { degradedReason } : {}),
  };
 }

 /**
  * Whether this user has any stored embeddings worth searching.
  *
  * Also requires a configured provider: without one the query cannot be embedded, so
  * there is nothing to compare against and the caller must fall back to text.
  */
 private async hasEmbeddingsForUser(userId: string): Promise<boolean> {
  if (!embeddingsAvailable(DEFAULT_EMBEDDING_MODEL)) return false;

  // Requires `embedding_vec`, not just an embedding row. `embedding` is jsonb and
  // carries no vector an ANN search can use, so a user whose rows were written
  // before `embedding_vec` existed has nothing to search — and this probe
  // answering "yes" would send them down the vector path to return zero rows
  // while the outcome claimed a semantic search had run.
  const result = await this.db.execute(
   sql`
   SELECT 1 FROM memory_embeddings
   INNER JOIN memories ON memories.id = memory_embeddings.memory_id
   WHERE memories.user_id = ${userId}
   AND memory_embeddings.embedding_vec IS NOT NULL
   LIMIT 1
   `,
  );

  return (result?.rows?.length ?? 0) > 0;
 }

 private async vectorSearch(
  userId: string,
  embedding: number[],
  limit: number,
  ): Promise<Record<string, unknown>[]> {
  // Vector search via pgvector <=> operator.
  //
  // The embedding is bound as a parameter and cast in SQL, never interpolated with
  // `sql.raw()`. `raw()` bypasses Drizzle's escaping entirely, so this line becomes
  // an injection point the moment the value stops being a constant — and the comment
  // here used to promise exactly that ("production: call embedding API"), which would
  // have fed a real vector through it. A bound parameter is safe whatever it holds,
  // so completing this stub can no longer open the hole.
  //
  // `embedding` is a real vector supplied by the caller. This used to be
  // `new Array(128).fill(0)` — a fabricated embedding that made every ordering
  // meaningless while the search reported success. Refuse it explicitly.
  if (!isUsableVector(embedding)) {
   throw new EmbeddingProviderError(
    'Refusing to run a vector search with an unusable embedding (empty or all-zero). ' +
     'Fall back to text search instead: a zero vector has no direction, so any ' +
     'ordering it produces is meaningless.',
    'memory-search',
   );
  }

  const embeddingJson = JSON.stringify(embedding);

  // Ordered by `embedding_vec`, the real `vector(1536)` column the HNSW index is
  // built on — NOT by `embedding`, which is jsonb. The previous version ordered by
  // `memory_embeddings.embedding <=> $1::vector`, which Postgres rejects outright
  // ("operator does not exist: jsonb <=> vector"), so this method could not run at
  // all; and even with the right operator, an ordering over jsonb can never use the
  // index while looking exactly like a search that did.
  //
  // Rows with a NULL vector are excluded rather than sorted. A NULL has no
  // direction, so `<=>` on it is not a similarity: including those rows would let
  // the result list claim hits that were never compared, and it would drag
  // un-indexed rows into every result set.
  const result = await this.db.execute(
   sql`
   SELECT memories.* FROM memories
   INNER JOIN memory_embeddings ON memory_embeddings.memory_id = memories.id
   WHERE memories.user_id = ${userId}
   AND memory_embeddings.embedding_vec IS NOT NULL
   ORDER BY memory_embeddings.embedding_vec <=> ${embeddingJson}::vector
   LIMIT ${limit}
   `,
  );

  return result.rows;
 }

 private async textSearch(
  userId: string,
  request: MemorySearchRequest,
  limit: number,
  ): Promise<Record<string, unknown>[]> {
  // Escape ILIKE wildcard characters in user query to prevent unintended glob matches.
  const pattern = `%${request.query.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

  // Build parameterized conditions. eq()/and() produce SQL nodes that Drizzle
  // resolves when used inside a sql`` template — all values are bound, never
  // concatenated into the SQL string.
  const conditions = [eq(memories.userId, userId)];
  if (request.category) conditions.push(eq(memories.category, request.category));
  if (request.visibility) conditions.push(eq(memories.visibility, request.visibility));
  if (request.minConfidence !== undefined) {
   conditions.push(sql`${memories.confidence} >= ${request.minConfidence}`);
  }
  if (request.status) conditions.push(eq(memories.status, request.status));

  // All values are parameterized via Drizzle's sql`` tagged template literals.
  // userId, pattern, limit, and all filter conditions are bound — no string concat.
  const result = await this.db.execute(
   sql`
   SELECT memories.* FROM memories
   WHERE memories.content ILIKE ${pattern}
   AND ${and(...conditions)}
   ORDER BY memories.importance DESC, memories.created_at DESC
   LIMIT ${limit}
   `,
  );

  return result.rows;
 }

 /**
  * Store a real embedding for a memory.
  *
  * Takes the narrowed `EmbeddingVector`, so an unavailable embedding is rejected by
  * the type system as well as at runtime. This used to accept any `number[]`,
  * including the all-zero vector the old `generateEmbedding` returned, and wrote a
  * row labelled with a model that had never run.
  */
 async storeEmbedding(memoryId: string, result: EmbeddingVector): Promise<void> {
  if (result?.available !== true || !isUsableVector(result.embedding)) {
   throw new EmbeddingProviderError(
    `Refusing to persist an embedding for memory ${memoryId}: no usable vector was produced.`,
    'memory-search',
   );
  }

  await this.db.insert(memoryEmbeddings).values({
   memoryId,
   embedding: result.embedding,
   // The same vector in the real `vector(1536)` column the HNSW index is built on.
   // Without this the row would be written with a NULL vector — visible to a
   // `SELECT *` and invisible to every HNSW search, which is how a "stored"
   // embedding can be stored and still be unfindable. Same convention as the live
   // writer, `services/api/src/services/memory.ts#persistEmbedding`.
   embeddingVec: result.embedding,
   // The provider's own model name — never a hard-coded label for a model that
   // did not run.
   model: result.model,
   dimensions: result.dimensions,
  });
 }

 /**
  * Delete embeddings for a memory.
  */
 async deleteEmbedding(memoryId: string): Promise<void> {
  await this.db.delete(memoryEmbeddings)
   .where(eq(memoryEmbeddings.memoryId, memoryId));
 }
}
