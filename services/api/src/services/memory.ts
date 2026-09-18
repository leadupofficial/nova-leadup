/**
 * NOVA API — Memory management service.
 *
 * Business logic for memory CRUD, search, embedding, and lifecycle.
 */
import { getDb } from '../db/connection.js';
import { memories, memoryEmbeddings } from '@nova/database';
import { eq, desc, and, sql } from 'drizzle-orm';
import { generateEmbedding as generateEmbeddingVector } from './ai.js';
import { logger } from '../utils/logger.js';

const MAX_CONTENT_LENGTH = 100_000;

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
 status: 'proposed',
 }).returning();

 // Trigger embedding generation (fire-and-forget with error handling)
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

export async function searchMemories(userId: string, query: string, limit = 10): Promise<{ memories: unknown[]; total: number; latencyMs: number }> {
 const start = Date.now();
 const db = getDb();

 // Simple keyword search fallback (replace with pgvector similarity when available)
 const rows = await db.select().from(memories)
 .where(and(eq(memories.userId, userId), sql`${memories.content} ILIKE ${'%' + query + '%'}`))
 .orderBy(desc(memories.importance))
 .limit(limit);

 return {
 memories: rows as unknown[],
 total: rows.length,
 latencyMs: Date.now() - start,
 };
}

async function storeEmbedding(memoryId: string, content: string) {
 try {
 const { embedding } = await generateEmbeddingVector(content);
 const db = getDb();
 await db.insert(memoryEmbeddings).values({
 memoryId,
 embedding,
 model: 'text-embedding-3-small',
 dimensions: embedding.length,
 });
 } catch {
 // Log but don't fail the memory creation
 }
}
