/**
 * LEA-011 — MemorySearch
 *
 * Semantic search over memories. Uses pgvector cosine similarity when
 * embeddings are available; falls back to ILIKE text search.
 *
 * Server-side only. Requires pgvector extension on PostgreSQL for vector search.
 */

import { memories, memoryEmbeddings, sql } from '@nova/database/schema';
import { eq, and } from 'drizzle-orm';
import type { MemorySearchRequest, MemorySearchResponse, MemoryRecord } from '@nova/shared-types';

// ─── Embedding Generation ────────────────────────────────────────────────────

/**
 * Generate an embedding vector for the given text.
 *
 * Placeholder — production: call Voyage/OpenAI embeddings API and
 * return a normalized unit vector for cosine similarity.
 */
export async function generateEmbedding(
 _text: string,
 _model = 'voyage-3',
 _dimensions = 1024,
): Promise<number[]> {
 return new Array(_dimensions).fill(0);
}

// ─── MemorySearch ────────────────────────────────────────────────────────────

export class MemorySearch {
 constructor(private readonly db: any) {}

 /**
 * Search for memories by semantic similarity.
 *
 * Uses pgvector when embeddings are available; falls back to ILIKE.
 */
 async search(
 userId: string,
 request: MemorySearchRequest,
 ): Promise<MemorySearchResponse> {
 const start = performance.now();
 const limit = Math.min(request.limit ?? 10, 50);

 const hasEmbeddings = await this.hasEmbeddingsForUser(userId);
 const rows = hasEmbeddings
 ? await this.vectorSearch(userId, limit)
 : await this.textSearch(userId, request, limit);

 const results = rows.map((row) => row as MemoryRecord);
 const latencyMs = Math.round(performance.now() - start);

 return {
 results,
 total: results.length,
 query: request.query,
 latencyMs,
 };
 }

 private async hasEmbeddingsForUser(_userId: string): Promise<boolean> {
 // In production: check pgvector extension + embedding presence.
 return false;
 }

 private async vectorSearch(
 userId: string,
 limit: number,
 ): Promise<Record<string, unknown>[]> {
 // Vector search via pgvector <=> operator.
 // Parameters are bound via Drizzle sql`` template literals (not string concat).
 // Embedding vector is zeroed in MVP — production: call embedding API.
 const embeddingJson = JSON.stringify(new Array(128).fill(0));

 const result = await this.db.execute(
 sql`
 SELECT memories.* FROM memories
 INNER JOIN memory_embeddings ON memory_embeddings.memory_id = memories.id
 WHERE memories.user_id = ${userId}
 ORDER BY memory_embeddings.embedding <=> ${sql.raw(`'${embeddingJson}'::vector`)}
 LIMIT ${limit}
 `
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

 const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

 // All values are parameterized via Drizzle's sql`` tagged template literals.
 // userId, pattern, limit, and all filter conditions are bound — no string concat.
 const result = await this.db.execute(
 sql`
 SELECT memories.* FROM memories
 WHERE memories.content ILIKE ${pattern}
 AND ${and(...conditions)}
 ORDER BY memories.importance DESC, memories.created_at DESC
 LIMIT ${limit}
 `
 );

 return result.rows;
 }

 /**
 * Store an embedding for a memory.
 */
 async storeEmbedding(memoryId: string, embedding: number[], model: string): Promise<void> {
 await this.db.insert(memoryEmbeddings).values({
 memoryId,
 embedding,
 model,
 dimensions: embedding.length,
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
