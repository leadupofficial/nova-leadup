/**
 * NOVA API — the memory vocabulary, in one place.
 *
 * Three comparisons in the memory service need the same definition of "a word
 * that carries no subject matter", and they must not drift apart:
 *
 *  - the lifecycle writers (`supersedesMemory`, `namesMemory` in `memory.ts`)
 *    decide whether a new fact replaces an old one by weighing the *content*
 *    words two statements share;
 *  - the retrieval fallback (`lexicalOverlap` in `memory-text.ts`) decides
 *    whether a turn and a memory are about the same thing at all.
 *
 * A word insignificant for one and significant for the other is a contradiction,
 * and two copies of a list like this is exactly how that happens. `memory.ts`
 * re-exports [MEMORY_STOP_WORDS] so no importer of it had to move.
 *
 * `memoryTokens` in `memory.ts` still owns the *policy* built on top of this set
 * — it falls back to every word when a statement is nothing but stop words — so
 * putting the list here changed no behaviour.
 */

/**
 * The memory fields a ranking reads and the grounding block renders.
 *
 * Also declared here rather than in `memory.ts`, because `memory-text.ts`
 * imports it and `memory.ts` imports `memory-text.ts`: keeping the shape in this
 * leaf module leaves those two with a single, non-circular dependency.
 * `memory.ts` re-exports it, so every existing importer is unaffected.
 */
export interface RankedMemory {
	id: string;
	category: string;
	content: string;
	importance: number | null;
}

export const MEMORY_STOP_WORDS: ReadonlySet<string> = new Set([
	'a', 'about', 'actually', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be',
	'been', 'but', 'by', 'can', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'he',
	'her', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'mine',
	'more', 'most', 'my', 'no', 'not', 'now', 'of', 'on', 'or', 'our', 'out', 'over', 'really',
	'she', 'should', 'so', 'some', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
	'these', 'they', 'this', 'those', 'to', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
	'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your', 'yours',
]);
