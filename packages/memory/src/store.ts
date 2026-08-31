/**
 * LEA-011 — MemoryStore
 *
 * CRUD operations for NOVA memories. Uses existing `memories` and
 * `memory_embeddings` tables from `@nova/database/schema`.
 * Server-side only.
 */

import { memories, memoryEmbeddings } from '@nova/database/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import type {
 MemoryCategory,
 MemoryVisibility,
 MemorySourceType,
 MemoryStatus,
 MemorySensitivity,
} from '@nova/shared-types';

export type CreateMemoryInput = {
 userId: string;
 tenantId?: string;
 category: MemoryCategory;
 content: string;
 sourceType: MemorySourceType;
 sourceIds?: readonly string[];
 visibility?: MemoryVisibility;
 confidence?: number;
 importance?: number;
 sensitivity?: MemorySensitivity;
};

export type UpdateMemoryInput = {
 category?: MemoryCategory;
 content?: string;
 normalizedFacts?: Record<string, unknown>;
 visibility?: MemoryVisibility;
 importance?: number;
 sensitivity?: MemorySensitivity;
 status?: MemoryStatus;
 expiresAt?: string | null;
};

// ─── MemoryStore ─────────────────────────────────────────────────────────────

export class MemoryStore {
 constructor(private readonly db: any) {}

 async create(input: CreateMemoryInput): Promise<any> {
 if (!input.content.trim()) {
 throw new Error('Memory content is required');
 }

 const [memory] = await this.db.insert(memories).values({
 userId: input.userId,
 tenantId: input.tenantId ?? null,
 visibility: input.visibility ?? 'private',
 category: input.category,
 content: input.content.trim(),
 sourceType: input.sourceType,
 sourceIds: input.sourceIds?.length ? [...input.sourceIds] : [],
 confidence: input.confidence ?? 50,
 importance: input.importance ?? 50,
 sensitivity: input.sensitivity ?? 'normal',
 status: 'proposed',
 }).returning();

 return memory;
 }

 async getById(userId: string, memoryId: string): Promise<any | null> {
 const [memory] = await this.db.select()
 .from(memories)
 .where(and(eq(memories.id, memoryId), eq(memories.userId, userId)))
 .limit(1);

 return memory ?? null;
 }

 async list(
 userId: string,
 options: {
 category?: MemoryCategory;
 status?: MemoryStatus;
 visibility?: MemoryVisibility;
 limit?: number;
 offset?: number;
 } = {},
 ): Promise<any[]> {
 const limit = Math.min(options.limit ?? 50, 100);
 const offset = options.offset ?? 0;

 const conditions = [eq(memories.userId, userId)];
 if (options.category) conditions.push(eq(memories.category, options.category));
 if (options.status) conditions.push(eq(memories.status, options.status));
 if (options.visibility) conditions.push(eq(memories.visibility, options.visibility));

 const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);

 return this.db.select()
 .from(memories)
 .where(whereClause)
 .orderBy(desc(memories.importance), desc(memories.createdAt))
 .limit(limit)
 .offset(offset);
 }

 async update(userId: string, memoryId: string, input: UpdateMemoryInput): Promise<any | null> {
 const existing = await this.getById(userId, memoryId);
 if (!existing) {
 return null;
 }

 const values: Record<string, unknown> = {
 updatedAt: new Date(),
 };

 if (input.category !== undefined) values.category = input.category;
 if (input.content !== undefined) values.content = input.content.trim();
 if (input.normalizedFacts !== undefined) values.normalizedFacts = input.normalizedFacts;
 if (input.visibility !== undefined) values.visibility = input.visibility;
 if (input.importance !== undefined) values.importance = input.importance;
 if (input.sensitivity !== undefined) values.sensitivity = input.sensitivity;
 if (input.status !== undefined) values.status = input.status;
 if (input.expiresAt !== undefined) values.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

 const [memory] = await this.db.update(memories)
 .set(values)
 .where(and(eq(memories.id, memoryId), eq(memories.userId, userId)))
 .returning();

 return memory ?? null;
 }

 async approve(userId: string, memoryId: string): Promise<any | null> {
 return this.update(userId, memoryId, { status: 'approved' });
 }

 async reject(userId: string, memoryId: string): Promise<any | null> {
 return this.update(userId, memoryId, { status: 'rejected' });
 }

 async correct(userId: string, memoryId: string, correctedContent: string): Promise<any | null> {
 return this.update(userId, memoryId, {
 content: correctedContent,
 status: 'approved',
 normalizedFacts: { corrected: true, correctedAt: new Date().toISOString() },
 });
 }

 async delete(userId: string, memoryId: string): Promise<void> {
 const existing = await this.getById(userId, memoryId);
 if (!existing) {
 throw new Error('Memory not found');
 }

 await this.db.delete(memories).where(and(eq(memories.id, memoryId), eq(memories.userId, userId)));
 }

 async count(userId: string, status?: MemoryStatus): Promise<number> {
 const conditions = [eq(memories.userId, userId)];
 if (status) conditions.push(eq(memories.status, status));

 const [result] = await this.db.select({ count: sql<number>`count(*)` })
 .from(memories)
 .where(conditions.length === 1 ? conditions[0] : and(...conditions));

 return Number(result?.count ?? 0);
 }
}
