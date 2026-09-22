/**
 * @nova/memory — embedding availability (FAB-1).
 *
 * `generateEmbedding` used to `return new Array(1024).fill(0)` for every input: a
 * *successful-looking* result carrying no vector. A caller could not tell "this is
 * the embedding" from "no embedding was computed", so a similarity search over the
 * zero vector reported success while ordering results meaninglessly.
 *
 * These tests pin the repaired contract: an unavailable embedding is representable
 * (`available: false` with a reason), a configured provider that answers with
 * nothing throws instead of returning a zero vector, and no code path ever hands
 * back an all-zero vector as though it were real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
 generateEmbedding,
 embeddingsAvailable,
 EmbeddingProviderError,
 isUsableEmbedding,
} from '../embedding.js';

const ZERO_VECTOR_1024 = new Array(1024).fill(0);

function fakeVectorResponse(values: number[], model = 'voyage-3') {
 return {
  ok: true,
  status: 200,
  json: async () => ({ data: [{ embedding: values }], model }),
  text: async () => '',
 } as unknown as Response;
}

describe('embeddingsAvailable', () => {
 const originalEnv = { ...process.env };

 afterEach(() => {
  process.env = { ...originalEnv };
 });

 it('reports false when no embeddings provider key is configured', () => {
  delete process.env.VOYAGE_API_KEY;
  delete process.env.OPENAI_API_KEY;
  expect(embeddingsAvailable('voyage-3')).toBe(false);
 });

 it('reports true once a provider key is configured', () => {
  delete process.env.OPENAI_API_KEY;
  process.env.VOYAGE_API_KEY = 'test-key';
  expect(embeddingsAvailable('voyage-3')).toBe(true);
 });
});

describe('generateEmbedding', () => {
 const originalEnv = { ...process.env };

 beforeEach(() => {
  delete process.env.VOYAGE_API_KEY;
  delete process.env.OPENAI_API_KEY;
 });

 afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
 });

 it('returns a discriminated unavailable result, never a zero vector', async () => {
  const result = await generateEmbedding('hello world');

  expect(result.available).toBe(false);
  if (result.available) throw new Error('expected unavailable');

  expect(result.dimensions).toBe(0);
  expect(result.embedding).toEqual([]);
  expect(typeof result.reason).toBe('string');
  expect(result.reason.length).toBeGreaterThan(0);

  // The specific FAB-1 regression: the old body was this exact array.
  expect(result.embedding).not.toEqual(ZERO_VECTOR_1024);
 });

 it('never reports success with an unusable vector', async () => {
  const result = await generateEmbedding('hello world');
  expect(isUsableEmbedding(result)).toBe(false);
 });

 it('returns the provider vector when one is configured and answers', async () => {
  process.env.VOYAGE_API_KEY = 'test-key';
  const vector = new Array(1024).fill(0.5);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeVectorResponse(vector)));

  const result = await generateEmbedding('hello world');

  expect(result.available).toBe(true);
  if (!result.available) throw new Error('expected available');
  expect(result.embedding).toEqual(vector);
  expect(result.dimensions).toBe(1024);
  expect(isUsableEmbedding(result)).toBe(true);
 });

 it('throws a typed error when a configured provider answers with nothing', async () => {
  process.env.VOYAGE_API_KEY = 'test-key';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeVectorResponse([])));

  await expect(generateEmbedding('hello world')).rejects.toBeInstanceOf(EmbeddingProviderError);
 });

 it('throws a typed error when a configured provider returns an all-zero vector', async () => {
  process.env.VOYAGE_API_KEY = 'test-key';
  vi.stubGlobal(
   'fetch',
   vi.fn().mockResolvedValue(fakeVectorResponse([...ZERO_VECTOR_1024])),
  );

  await expect(generateEmbedding('hello world')).rejects.toBeInstanceOf(EmbeddingProviderError);
 });

 it('throws a typed error when the provider request fails', async () => {
  process.env.VOYAGE_API_KEY = 'test-key';
  vi.stubGlobal(
   'fetch',
   vi.fn().mockResolvedValue({
    ok: false,
    status: 401,
    json: async () => ({}),
    text: async () => 'unauthorized',
   } as unknown as Response),
  );

  await expect(generateEmbedding('hello world')).rejects.toBeInstanceOf(EmbeddingProviderError);
 });
});
