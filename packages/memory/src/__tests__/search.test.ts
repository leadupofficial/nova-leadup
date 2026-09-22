/**
 * @nova/memory — MemorySearch consumer handling (FAB-1).
 *
 * The repaired embedding contract is only worth anything if its consumers honour it.
 * `MemorySearch.vectorSearch` used to bind `JSON.stringify(new Array(128).fill(0))`
 * as the query vector and `storeEmbedding` used to persist whatever `number[]` it was
 * handed — including the all-zero vector the old `generateEmbedding` returned. These
 * tests pin the consumer behaviour: a fabricated vector is neither searched nor
 * persisted, and a degraded text search says so in the response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemorySearch } from '../search.js';
import { EmbeddingProviderError } from '../embedding.js';

/** Flatten a Drizzle `sql` node into its static text and its bound parameters. */
function collectSql(node: any): { raw: string; params: unknown[] } {
 const raw: string[] = [];
 const params: unknown[] = [];

 const walk = (chunk: any): void => {
  if (chunk === null || chunk === undefined) return;
  if (Array.isArray(chunk)) {
   chunk.forEach(walk);
   return;
  }
  if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') {
   params.push(chunk);
   return;
  }
  if (typeof chunk === 'object') {
   // A Drizzle Column/Table identifier serializes with a `name`; it is not a param.
   if (typeof chunk.name === 'string') return;
   if ('queryChunks' in chunk) {
    walk(chunk.queryChunks);
    return;
   }
   if (Array.isArray(chunk.value) && chunk.value.every((v: unknown) => typeof v === 'string')) {
    raw.push(...chunk.value);
    return;
   }
   if ('value' in chunk) {
    params.push(chunk.value);
   }
  }
 };

 walk(node?.queryChunks ?? node);
 return { raw: raw.join(''), params };
}

/** Any bound parameter that is an all-zero JSON vector, as the old code produced. */
function zeroVectorParams(params: unknown[]): unknown[] {
 return params.filter((p) => {
  if (typeof p !== 'string' || !p.startsWith('[')) return false;
  try {
   const parsed = JSON.parse(p);
   return Array.isArray(parsed) && parsed.length > 0 && parsed.every((n) => n === 0);
  } catch {
   return false;
  }
 });
}

const REAL_VECTOR = new Array(1024).fill(0.5);

describe('MemorySearch — embedding handling', () => {
 const originalEnv = { ...process.env };
 let executed: { raw: string; params: unknown[] }[];
 let execute: ReturnType<typeof vi.fn>;
 let insert: ReturnType<typeof vi.fn>;
 let values: ReturnType<typeof vi.fn>;

 beforeEach(() => {
  executed = [];
  execute = vi.fn(async (query: any) => {
   const collected = collectSql(query);
   executed.push(collected);

   // `hasEmbeddingsForUser` probe.
   if (collected.raw.includes('SELECT 1 FROM memory_embeddings')) {
    return { rows: [{ '?column?': 1 }] };
   }
   if (collected.raw.includes('<=>')) {
    return { rows: [{ id: 'vector-hit' }] };
   }
   return { rows: [{ id: 'text-hit' }] };
  });

  values = vi.fn(async () => undefined);
  insert = vi.fn(() => ({ values }));
 });

 afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
 });

 describe('storeEmbedding', () => {
  it('refuses to persist the all-zero vector FAB-1 produced', async () => {
   const search = new MemorySearch({ insert });

   await expect(
    search.storeEmbedding('memory-1', {
     available: true,
     embedding: new Array(1024).fill(0),
     dimensions: 1024,
     model: 'voyage-3',
    }),
   ).rejects.toBeInstanceOf(EmbeddingProviderError);

   expect(insert).not.toHaveBeenCalled();
  });

  it('persists a real vector with the model that actually produced it', async () => {
   const search = new MemorySearch({ insert });

   await search.storeEmbedding('memory-1', {
    available: true,
    embedding: REAL_VECTOR,
    dimensions: 1024,
    model: 'voyage-3',
   });

   expect(values).toHaveBeenCalledWith({
    memoryId: 'memory-1',
    embedding: REAL_VECTOR,
    // The vector(1536) column the HNSW index covers. Writing only the jsonb column
    // left every row this writer stored unreachable by a vector search.
    embeddingVec: REAL_VECTOR,
    model: 'voyage-3',
    dimensions: 1024,
   });
  });
 });

 describe('search', () => {
  it('falls back to text search and reports the degraded mode when no provider is configured', async () => {
   delete process.env.VOYAGE_API_KEY;
   delete process.env.OPENAI_API_KEY;
   const search = new MemorySearch({ execute });

   const outcome = await search.search('user-1', { query: 'dentist' });

   expect(outcome.searchMode).toBe('text');
   expect(outcome.results).toHaveLength(1);
   // No vector query was attempted at all.
   expect(executed.some((q) => q.raw.includes('<=>'))).toBe(false);
   // And no all-zero vector was bound on the text path either.
   expect(zeroVectorParams(executed.flatMap((q) => q.params))).toEqual([]);
  });

  it('searches pgvector with the real embedded query when a provider is configured', async () => {
   process.env.VOYAGE_API_KEY = 'test-key';
   vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
     ok: true,
     status: 200,
     json: async () => ({ data: [{ embedding: REAL_VECTOR }], model: 'voyage-3' }),
     text: async () => '',
    }),
   );
   const search = new MemorySearch({ execute });

   const outcome = await search.search('user-1', { query: 'dentist' });

   expect(outcome.searchMode).toBe('vector');

   const vectorQuery = executed.find((q) => q.raw.includes('<=>'));
   expect(vectorQuery).toBeDefined();

   const boundVectors = vectorQuery!.params.filter(
    (p) => typeof p === 'string' && p.startsWith('['),
   );
   expect(boundVectors).toHaveLength(1);
   expect(JSON.parse(boundVectors[0] as string)).toEqual(REAL_VECTOR);
   expect(zeroVectorParams(vectorQuery!.params)).toEqual([]);
  });

  it('throws instead of searching when the provider answers with an all-zero vector', async () => {
   process.env.VOYAGE_API_KEY = 'test-key';
   vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
     ok: true,
     status: 200,
     json: async () => ({ data: [{ embedding: new Array(1024).fill(0) }], model: 'voyage-3' }),
     text: async () => '',
    }),
   );
   const search = new MemorySearch({ execute });

   await expect(search.search('user-1', { query: 'dentist' })).rejects.toBeInstanceOf(
    EmbeddingProviderError,
   );

   // The fabricated vector never reached the database.
   expect(executed.some((q) => q.raw.includes('<=>'))).toBe(false);
  });
 });
});
