/**
 * @nova/memory — the vector search must target the column the HNSW index is on.
 *
 * `memory_embeddings.embedding` is `jsonb`; the real `vector(1536)` column is
 * `memory_embeddings.embedding_vec`. Ordering by `embedding <=> $1::vector` does not
 * fail softly — against the live database it raises
 * `operator does not exist: jsonb <=> vector`, so the class could not run at all,
 * and any "fix" that compared against the jsonb column would be an unindexable
 * sequential scan over a column no ANN index can ever cover.
 *
 * `storeEmbedding` had the mirror-image defect: it wrote `embedding`, `model` and
 * `dimensions` and left `embedding_vec` NULL, so every row it wrote was invisible to
 * an HNSW search. These tests pin both halves — the column the query orders by, and
 * the columns the writer fills.
 */
import { describe, it, expect, vi } from 'vitest';
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

const REAL_VECTOR = new Array(1536).fill(0.5);

describe('MemorySearch.vectorSearch — the indexed column, not the jsonb one', () => {
 it('orders by embedding_vec and never by the jsonb embedding column', async () => {
  const execute = vi.fn(async () => ({ rows: [{ id: 'vector-hit' }] }));
  const search = new MemorySearch({ execute });

  await (search as any).vectorSearch('user-1', REAL_VECTOR, 5);

  expect(execute).toHaveBeenCalledTimes(1);
  const { raw } = collectSql(execute.mock.calls[0][0]);

  // The ordering has to be on the `vector(1536)` column the HNSW index covers.
  expect(raw).toContain('memory_embeddings.embedding_vec <=>');
  // `memory_embeddings.embedding` is jsonb: `jsonb <=> vector` is a hard error in
  // Postgres, so this exact ordering can never appear again.
  expect(raw).not.toMatch(/memory_embeddings\.embedding\s*<=>/);
  // A NULL vector has no direction; ordering it would silently mix non-answers into
  // the results, so it must be excluded rather than ranked.
  expect(raw).toContain('memory_embeddings.embedding_vec IS NOT NULL');
 });

 it('only searches rows that have a vector, so the probe cannot report one that is not there', async () => {
  const execute = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }));
  const search = new MemorySearch({ execute });

  // The probe answers "no" outright when no provider is configured, without
  // touching the database, so a provider has to exist for this read to happen.
  process.env.VOYAGE_API_KEY = 'test-key';
  try {
   await (search as any).hasEmbeddingsForUser('user-1');
  } finally {
   delete process.env.VOYAGE_API_KEY;
  }

  const { raw } = collectSql(execute.mock.calls[0][0]);
  expect(raw).toContain('embedding_vec IS NOT NULL');
 });
});

describe('MemorySearch.storeEmbedding — both columns, or nothing', () => {
 it('refuses an unusable (all-zero) vector', async () => {
  const values = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values }));
  const search = new MemorySearch({ insert });

  await expect(
   search.storeEmbedding('memory-1', {
    available: true,
    embedding: new Array(1536).fill(0),
    dimensions: 1536,
    model: 'voyage-3',
   }),
  ).rejects.toBeInstanceOf(EmbeddingProviderError);

  expect(insert).not.toHaveBeenCalled();
 });

 it('writes the vector to embedding_vec as well as to the jsonb embedding column', async () => {
  const values = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values }));
  const search = new MemorySearch({ insert });

  await search.storeEmbedding('memory-1', {
   available: true,
   embedding: REAL_VECTOR,
   dimensions: 1536,
   model: 'voyage-3',
  });

  expect(values).toHaveBeenCalledWith(
   expect.objectContaining({
    memoryId: 'memory-1',
    embedding: REAL_VECTOR,
    // The column the HNSW index is built on. Without it the row this writer
    // stores is unreachable by the search above.
    embeddingVec: REAL_VECTOR,
    model: 'voyage-3',
    dimensions: 1536,
   }),
  );
 });
});
