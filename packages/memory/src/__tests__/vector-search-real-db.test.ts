/**
 * @nova/memory — the vector search, run against the real pgvector database.
 *
 * A test that only asserts a SQL string was built cannot tell whether Postgres
 * accepts the query. `ORDER BY memory_embeddings.embedding <=> $1::vector` compiled
 * fine and passed such a test while the live database answered
 * `ERROR: operator does not exist: jsonb <=> vector`, and a writer that fills only
 * the jsonb column passes one too while leaving every row it writes unindexable.
 *
 * So this suite runs `MemorySearch.search` end to end against the database named by
 * `DATABASE_URL` — the embedding provider is stubbed at `fetch` (the same seam the
 * unit tests use), everything below it is real: real jsonb rows, real
 * `vector(1536)` values, the real HNSW index and the real `<=>` ordering.
 *
 * It skips itself when `DATABASE_URL` is unset or unreachable, so a checkout with no
 * database does not fail; the focused command names the database explicitly:
 *
 *   DATABASE_URL=postgres://nova_user:nova_secure_2026@127.0.0.1:5433/nova \
 *     npx vitest run --root packages/memory src/__tests__/vector-search-real-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, getPool } from '@nova/database';
import { MemorySearch } from '../search.js';

const DIMENSIONS = 1536;

/** A vector that is `1` in one position and `0` elsewhere. */
function oneHot(index: number, weight = 1): number[] {
 const vector = new Array(DIMENSIONS).fill(0);
 vector[index] = weight;
 return vector;
}

const QUERY_VECTOR = oneHot(0);
/** Same direction as the query: cosine distance ≈ 0.005. */
const NEAR_VECTOR = oneHot(0, 1);
NEAR_VECTOR[1] = 0.1;
/** A different direction: cosine distance ≈ 0.9. */
const FAR_VECTOR = oneHot(1, 1);
FAR_VECTOR[0] = 0.1;

const USER_ID = randomUUID();
const NEAR_MEMORY_ID = randomUUID();
const FAR_MEMORY_ID = randomUUID();
/** The row whose `embedding_vec` is NULL — it must never be ranked. */
const NULL_VECTOR_MEMORY_ID = randomUUID();

let reachable = false;
if (process.env.DATABASE_URL) {
 try {
  await getPool().query('SELECT 1');
  reachable = true;
 } catch {
  reachable = false;
 }
}

describe.skipIf(!reachable)('MemorySearch.search — real pgvector ordering', () => {
 beforeAll(async () => {
  const db = getDb();
  await db.execute(sql`
   INSERT INTO users (id, email, name)
   VALUES (${USER_ID}, ${`vector-search-${USER_ID}@example.test`}, 'NOVA vector search test')
  `);
  // Deliberately anti-correlated with importance: the *near* memory is the least
  // important row and the far one is the most important, so an ordering that
  // consulted `importance` (what the live grounding path does) would return them
  // the wrong way round.
  await db.execute(sql`
   INSERT INTO memories (id, user_id, category, content, source_type, status, importance)
   VALUES
    (${NEAR_MEMORY_ID}, ${USER_ID}, 'fact', 'The client is Acme Corp', 'manual', 'proposed', 5),
    (${FAR_MEMORY_ID}, ${USER_ID}, 'fact', 'The client is someone else entirely', 'manual', 'proposed', 95),
    (${NULL_VECTOR_MEMORY_ID}, ${USER_ID}, 'fact', 'No vector at all', 'manual', 'proposed', 100)
  `);
  await db.execute(sql`
   INSERT INTO memory_embeddings (memory_id, embedding, embedding_vec, model, dimensions)
   VALUES
    (${NEAR_MEMORY_ID}, ${JSON.stringify(NEAR_VECTOR)}::jsonb, ${JSON.stringify(NEAR_VECTOR)}::vector, 'test-model', ${DIMENSIONS}),
    (${FAR_MEMORY_ID}, ${JSON.stringify(FAR_VECTOR)}::jsonb, ${JSON.stringify(FAR_VECTOR)}::vector, 'test-model', ${DIMENSIONS})
  `);
  // A row written the old way: jsonb filled, `embedding_vec` NULL, and a jsonb
  // vector identical to the query — the "nearest" row if a NULL were ever ranked.
  await db.execute(sql`
   INSERT INTO memory_embeddings (memory_id, embedding, embedding_vec, model, dimensions)
   VALUES (${NULL_VECTOR_MEMORY_ID}, ${JSON.stringify(QUERY_VECTOR)}::jsonb, NULL, 'test-model', ${DIMENSIONS})
  `);
 });

 afterAll(async () => {
  if (!reachable) return;
  // `users` cascades to `memories` and `memories` cascades to `memory_embeddings`,
  // so this removes every row this suite wrote and nothing else.
  await getDb().execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
  await closeDb();
 });

 it('returns the nearer vector first and skips rows with no vector', async () => {
  process.env.VOYAGE_API_KEY = 'test-key';
  vi.stubGlobal(
   'fetch',
   vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: QUERY_VECTOR }], model: 'voyage-3' }),
    text: async () => '',
   })),
  );

  try {
   const outcome = await new MemorySearch(getDb()).search(USER_ID, {
    query: 'the client I mentioned',
    limit: 10,
   });

   // The real query ran: the mode is only `vector` when the pgvector read succeeded.
   expect(outcome.searchMode).toBe('vector');
   expect(outcome.results.map((row) => row.id)).toEqual([NEAR_MEMORY_ID, FAR_MEMORY_ID]);
   // The NULL-vector row would be "nearest" if a NULL were mixed into the ordering.
   expect(outcome.results.map((row) => row.id)).not.toContain(NULL_VECTOR_MEMORY_ID);
  } finally {
   delete process.env.VOYAGE_API_KEY;
   vi.unstubAllGlobals();
  }
 });
});
