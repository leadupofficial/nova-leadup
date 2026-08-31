/**
 * LEA-011 — Embedding utilities
 *
 * Placeholder for production embedding generation. In production, replace
 * with a call to an embedding API (Voyage, OpenAI, etc.).
 */

/**
 * Generate an embedding vector for the given text.
 */
export async function generateEmbedding(
 _text: string,
 _model = 'voyage-3',
 _dimensions = 1024,
): Promise<number[]> {
 return new Array(_dimensions).fill(0);
}

/**
 * Compute cosine similarity between two vectors.
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
