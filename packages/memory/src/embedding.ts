/**
 * LEA-011 — Embedding utilities
 *
 * The single source of truth for embeddings in this package: whether a provider is
 * configured, how a vector is obtained, and how the *absence* of a vector is
 * represented.
 *
 * This module used to `return new Array(dimensions).fill(0)` for every input — a
 * zero vector wearing the shape of a real embedding. A caller could not distinguish
 * "this is the embedding" from "no embedding was computed", so a similarity search
 * over it reported success while ordering results meaninglessly. It now returns a
 * discriminated result (`available: false` plus a reason) when no provider is
 * configured, and throws `EmbeddingProviderError` when a configured provider cannot
 * produce a usable vector. No path returns a zero vector as though it were real.
 *
 * Server-side only.
 */

/** The embedding model asked for when the caller does not name one. */
export const DEFAULT_EMBEDDING_MODEL = 'voyage-3';

/** No usable embedding was produced. Always carries a reason; never a bare success. */
export interface EmbeddingUnavailable {
 available: false;
 /** Always empty. Present so callers can read the field without narrowing first. */
 embedding: number[];
 dimensions: 0;
 /** Why there is no vector. Always populated. */
 reason: string;
}

/** A real, usable vector from a provider. */
export interface EmbeddingVector {
 available: true;
 embedding: number[];
 dimensions: number;
 /** The model the provider actually reported running. */
 model: string;
}

export type EmbeddingResult = EmbeddingVector | EmbeddingUnavailable;

/**
 * A configured provider was asked for a vector and could not supply a usable one.
 *
 * Thrown rather than returned so the failure travels the caller's error path and
 * can never be mistaken for a successful embedding.
 */
export class EmbeddingProviderError extends Error {
 readonly provider: string;

 constructor(message: string, provider: string) {
  super(message);
  this.name = 'EmbeddingProviderError';
  this.provider = provider;
 }
}

interface ProviderConfig {
 id: string;
 keyEnv: string;
 endpoint: string;
 /** Whether the provider accepts a `dimensions` request field. */
 supportsDimensions: boolean;
}

const VOYAGE: ProviderConfig = {
 id: 'voyage',
 keyEnv: 'VOYAGE_API_KEY',
 endpoint: 'https://api.voyageai.com/v1/embeddings',
 supportsDimensions: false,
};

const OPENAI: ProviderConfig = {
 id: 'openai',
 keyEnv: 'OPENAI_API_KEY',
 endpoint: 'https://api.openai.com/v1/embeddings',
 supportsDimensions: true,
};

/** Route a model name to the provider that serves it. */
export function providerFor(model: string = DEFAULT_EMBEDDING_MODEL): ProviderConfig {
 return model.toLowerCase().includes('voyage') ? VOYAGE : OPENAI;
}

/**
 * Whether an embeddings provider is configured at all.
 *
 * The single source of truth for this question, so callers, this module, and any
 * capability report cannot drift apart and disagree about whether vectors are
 * obtainable. A key being present does not promise the provider is reachable — only
 * `generateEmbedding` can answer that, and it answers with a throw when it cannot.
 */
export function embeddingsAvailable(model: string = DEFAULT_EMBEDDING_MODEL): boolean {
 return Boolean(process.env[providerFor(model).keyEnv]);
}

/** A vector is usable only if it is non-empty and not the zero vector. */
export function isUsableVector(vector: unknown): vector is number[] {
 if (!Array.isArray(vector) || vector.length === 0) return false;
 return vector.some((value) => typeof value === 'number' && Number.isFinite(value) && value !== 0);
}

/** Narrow a result to the case that actually carries an embedding. */
export function isUsableEmbedding(result: EmbeddingResult): result is EmbeddingVector {
 return result.available && isUsableVector(result.embedding);
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Generate an embedding vector for the given text.
 *
 * Returns `{ available: false, reason }` when no provider is configured. Throws
 * `EmbeddingProviderError` when a configured provider fails, answers with nothing,
 * or answers with a vector that cannot be used. Never returns a zero vector.
 *
 * @param text The text to embed. Must be non-empty.
 * @param model The provider model to ask for.
 * @param dimensions Optional expected vector width; validated against the response.
 */
export async function generateEmbedding(
 text: string,
 model: string = DEFAULT_EMBEDDING_MODEL,
 dimensions?: number,
): Promise<EmbeddingResult> {
 const provider = providerFor(model);
 const apiKey = process.env[provider.keyEnv];

 if (!apiKey) {
  return {
   available: false,
   embedding: [],
   dimensions: 0,
   reason:
    `No embeddings provider is configured (${provider.keyEnv} is unset), so no vector ` +
    `can be produced for model "${model}". This is an unavailable embedding, not a zero vector.`,
  };
 }

 if (typeof text !== 'string' || text.trim().length === 0) {
  throw new EmbeddingProviderError(
   'Cannot embed empty text: an empty input has no embedding.',
   provider.id,
  );
 }

 const fetchImpl = globalThis.fetch;
 if (typeof fetchImpl !== 'function') {
  throw new EmbeddingProviderError(
   `No fetch implementation is available in this runtime, so ${provider.id} cannot be called.`,
   provider.id,
  );
 }

 const body: Record<string, unknown> = { input: text, model };
 if (dimensions !== undefined && provider.supportsDimensions) {
  body.dimensions = dimensions;
 }

 let response: Response;
 try {
  response = await fetchImpl(provider.endpoint, {
   method: 'POST',
   headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
   },
   body: JSON.stringify(body),
   signal:
    typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
     ? AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
     : undefined,
  });
 } catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new EmbeddingProviderError(
   `The ${provider.id} embeddings request failed: ${detail}`,
   provider.id,
  );
 }

 if (!response.ok) {
  const detail = await response.text().catch(() => '');
  throw new EmbeddingProviderError(
   `The ${provider.id} embeddings request returned HTTP ${response.status}` +
    (detail ? `: ${detail.slice(0, 200)}` : ''),
   provider.id,
  );
 }

 const payload: any = await response.json().catch(() => null);
 const vector: unknown = payload?.data?.[0]?.embedding;

 if (!isUsableVector(vector)) {
  // A configured provider that answers with nothing (or with an all-zero vector) is
  // a failure, not a zero-dimension success. Throw so the caller's error path — not
  // its persistence path — handles it.
  throw new EmbeddingProviderError(
   `The ${provider.id} embeddings provider returned no usable vector for model "${model}".`,
   provider.id,
  );
 }

 if (dimensions !== undefined && vector.length !== dimensions) {
  throw new EmbeddingProviderError(
   `The ${provider.id} embeddings provider returned ${vector.length} dimensions, ` +
    `but ${dimensions} were expected.`,
   provider.id,
  );
 }

 return {
  available: true,
  embedding: vector,
  dimensions: vector.length,
  model: typeof payload?.model === 'string' && payload.model ? payload.model : model,
 };
}

/**
 * Compute cosine similarity between two vectors.
 *
 * Returns 0 when either vector is empty or has zero magnitude — a zero vector has no
 * direction, so this number means "not comparable", not "similar". Callers must not
 * reach this function with an unavailable embedding: check `isUsableEmbedding` first,
 * otherwise the 0 returned here is indistinguishable from a real "no similarity".
 */
export function cosineSimilarity(a: number[], b: number[]): number {
 if (a.length !== b.length || a.length === 0) return 0;

 let dot = 0;
 let magA = 0;
 let magB = 0;

 for (let i = 0; i < a.length; i++) {
  const av = a[i] ?? 0;
  const bv = b[i] ?? 0;
  dot += av * bv;
  magA += av * av;
  magB += bv * bv;
 }

 const denom = Math.sqrt(magA) * Math.sqrt(magB);
 return denom === 0 ? 0 : dot / denom;
}
