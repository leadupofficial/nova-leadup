/**
 * NOVA-Leadup — RAG (Retrieval-Augmented Generation) context assembly.
 *
 * Implements **token-budget-aware context assembly** with a hard ceiling
 * of 100 000 tokens. The assembler:
 *
 * 1. Scores each candidate chunk with BM25-ish keyword overlap +
 * (optionally) an embedding cosine-similarity score.
 * 2. Sorts descending by score.
 * 3. Greedily adds chunks until the running token total hits the
 * budget, honouring per-source caps so one knowledge-base article
 * can't drown out everything else.
 * 4. Returns a trimmed context ready for an LLM prompt, plus a
 * `truncated` flag so the caller knows some candidates were
 * dropped.
 *
 * Token estimation uses the standard heuristic:
 * tokens ≈ ceil(characters / 4)
 * which is accurate enough for budget enforcement without requiring a
 * live tokenizer.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface Chunk {
	id: string;
	sourceId: string;
	text: string;
	metadata?: Record<string, unknown>;
	// Optional pre-computed scores (filled in by the embedding pipeline)
	keywordScore?: number;
	embeddingScore?: number;
}

export interface AssemblyOptions {
	/** Maximum total tokens across all assembled chunks. Default 100 000. */
	maxTokens?: number;
	/** Maximum tokens from any single source. Default 20 000. */
	maxTokensPerSource?: number;
	/** Minimum relevance score (0–1) for a chunk to be considered. */
	minScore?: number;
	/** Hard cap on number of chunks returned regardless of token count. */
	maxChunks?: number;
	/** Tokens reserved for the system / user prompt (subtracted from budget). */
	reservedTokens?: number;
}

export interface AssembledContext {
	chunks: Chunk[];
	totalTokens: number;
	truncated: boolean;
	droppedCount: number;
	sourcesUsed: string[];
}

// ─── Defaults ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 100_000;
const DEFAULT_MAX_TOKENS_PER_SOURCE = 20_000;
const DEFAULT_MIN_SCORE = 0.15;
const DEFAULT_MAX_CHUNKS = 500;
const DEFAULT_RESERVED_TOKENS = 2_000;

// ─── Token estimation ─────────────────────────────────────────────────────

/**
 * Rough token count using the characters ÷ 4 heuristic.
 * For CJK-heavy text divide by 2; for ASCII-heavy by 4.
 */
export function estimateTokens(text: string): number {
	// Detect CJK characters
	const cjkCount = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
	const nonCjkLen = text.length - cjkCount;
	// CJK: ~1 token per char; ASCII: ~1 token per 4 chars
	return Math.ceil(cjkCount + nonCjkLen / 4);
}

// ─── Scoring ──────────────────────────────────────────────────────────────

/**
 * Compute a simple BM25-style keyword score between the query and
 * a chunk of text.
 */
function keywordScore(query: string, text: string): number {
	const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const textLower = text.toLowerCase();
	if (queryTerms.length === 0) return 0;

	let matched = 0;
	for (const term of queryTerms) {
		if (textLower.includes(term)) matched++;
	}
	return matched / queryTerms.length;
}

/**
 * Compute the combined relevance score for a chunk.
 * Combines an optional pre-computed embedding score with a keyword
 * overlap score, normalised to [0, 1].
 */
function computeScore(
	chunk: Chunk,
	query: string,
	alpha = 0.5 // weight for embedding vs keyword
): number {
	const kw = keywordScore(query, chunk.text);
	const emb = chunk.embeddingScore ?? 0;
	const combined = alpha * emb + (1 - alpha) * kw;
	return Math.min(combined, 1);
}

// ─── Core assembly ────────────────────────────────────────────────────────

/**
 * Assemble a token-budget-aware RAG context from candidate chunks.
 *
 * @param query — the user query used to score chunks
 * @param chunks — candidate chunks (already retrieved from the index)
 * @param options — assembly tuning parameters
 *
 * @returns assembled context with metadata about truncation
 */
export function assembleContext(
	query: string,
	chunks: Chunk[],
	options: AssemblyOptions = {}
): AssembledContext {
	const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
	const maxTokensPerSource = options.maxTokensPerSource ?? DEFAULT_MAX_TOKENS_PER_SOURCE;
	const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
	const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
	const reservedTokens = options.reservedTokens ?? DEFAULT_RESERVED_TOKENS;

	// Effective budget after reserving space for the prompt itself
	const budget = Math.max(maxTokens - reservedTokens, 0);

	// 1. Score all candidates
	const scored = chunks
		.map((chunk) => ({
			chunk,
			score: computeScore(chunk, query),
		}))
		.filter(({ score }) => score >= minScore)
		.sort((a, b) => b.score - a.score)
		.slice(0, maxChunks);

	// 2. Greedily pack chunks into budget, respecting per-source caps
	const selected: Chunk[] = [];
	const sourceTokens: Record<string, number> = {};
	let totalTokens = 0;
	let droppedCount = 0;

	for (const { chunk } of scored) {
		const chunkTokens = estimateTokens(chunk.text);

		// Per-source cap
		const sourceUsage = sourceTokens[chunk.sourceId] ?? 0;
		if (sourceUsage + chunkTokens > maxTokensPerSource) {
			droppedCount++;
			continue;
		}

		// Global budget check
		if (totalTokens + chunkTokens > budget) {
			droppedCount++;
			continue;
		}

		selected.push(chunk);
		totalTokens += chunkTokens;
		sourceTokens[chunk.sourceId] = sourceUsage + chunkTokens;
	}

	const sourcesUsed = Array.from(new Set(selected.map((c) => c.sourceId)));

	return {
		chunks: selected,
		totalTokens,
		truncated: droppedCount > 0,
		droppedCount,
		sourcesUsed,
	};
}

// ─── Prompt builder ───────────────────────────────────────────────────────

/**
 * Format assembled chunks into a RAG prompt context block that can be
 * injected into an LLM .
 */
export function buildPromptContext(assembled: AssembledContext): string {
	if (assembled.chunks.length === 0) {
		return '[No relevant knowledge-base content found.]';
	}

	const parts = assembled.chunks.map((chunk, idx) => {
		const meta = chunk.metadata
			? `\n[source: ${chunk.sourceId}]`
			: `\n[source: ${chunk.sourceId}]`;
		return `---\n[#${idx + 1}]${meta}\n${chunk.text}`;
	});

	const header = [
		`# Knowledge Base Context`,
		`_Sources: ${assembled.sourcesUsed.join(', ')}`,
		`_Chunks: ${assembled.chunks.length} / ~${assembled.droppedCount + assembled.chunks.length} candidates_`,
		`_Tokens: ~${assembled.totalTokens.toLocaleString()}`,
		assembled.truncated ? `_⚠ Some content was omitted due to token budget._` : '',
	].filter(Boolean).join('\n');

	return `${header}\n\n${parts.join('\n\n')}\n---`;
}
