/**
 * NOVA API — the text comparison a provider-free memory ranking runs on.
 *
 * `rankMemoriesForTurn` in `memory.ts` ranks memories against the user's turn by
 * embedding both. That is the right ranking and it is the first choice, but it
 * needs an embeddings provider; with `OPENAI_API_KEY` unset the process has none,
 * so the ranking degraded to `importance` and a fact the user had just referred
 * to fell out of the grounding block's cap. The fallback has to decide "does this
 * turn share subject matter with this memory?" without a model, which is what
 * lives here.
 *
 * This is deliberately *not* the tokeniser the lifecycle writers use: those
 * compare two memories that state the same fact in different wording and want the
 * raw content words. This one compares a spoken question against a stored fact
 * and needs a little tolerance for English inflection ("plan" / "planning"), so
 * the two have different jobs even though both start from the same word list.
 */
import { MEMORY_STOP_WORDS, type RankedMemory } from './memory-tokens.js';

/**
 * Words that carry no subject matter *in a spoken turn*.
 *
 * The lifecycle list is the base — one word list, so a term can never be
 * insignificant for retrieval and significant for supersession. The additions are
 * request-shaped filler an English question is made of and that no stored fact is
 * usually made of ("please", "could you"). Kept to a handful on purpose: every
 * word added here is a word a memory can never be matched on, and the failure that
 * costs is a real fact silently dropped.
 */
const RETRIEVAL_STOP_WORDS: ReadonlySet<string> = new Set([
	...MEMORY_STOP_WORDS,
	'please', 'kindly', 'could', 'maybe',
]);

/**
 * The shortest token that can be significant on its own.
 *
 * Single characters are dropped: "a" and "I" are already stop words, and in a
 * Tamil-script turn a one-letter fragment — or a stray combining mark that
 * detached — would otherwise match everything. Everything at or above this length
 * is kept, Tamil and English alike.
 */
const MIN_TOKEN_LENGTH = 2;

/** Below this length a word is never treated as an inflected form of another. */
const MIN_STEM_INPUT_LENGTH = 7;
/** The shortest stem that may stand for a word. */
const MIN_STEM_LENGTH = 4;
/** The shortest shared term that can make a turn and a memory "about the same thing". */
const MIN_SHARED_TERM_LENGTH = 4;

/**
 * English endings that mark a different grammatical form of the *same* word.
 *
 * Longest first, so "planning" loses "ing" rather than "s". Bounded on purpose:
 * `building` and `buildings` must land on one form, while an unbounded suffix
 * stripper would collapse unrelated words and rank on noise.
 */
const ENGLISH_SUFFIXES = ['ings', 'ing', 'ies', 'ers', 'er', 'ed', 'es', 's'] as const;

/**
 * The normalised words of a piece of text that carry subject matter.
 *
 * Unicode-aware, because the assistant is spoken to in Tamil and Tanglish and a
 * Tamil sentence has to tokenise like an English one.
 *
 * `\p{M}` — combining marks — is part of a *word*, not decoration beside one. A
 * Tamil vowel sign is a combining mark, so a `[\p{L}\p{N}]+` match silently
 * shredded Tamil: an eight-codepoint word was cut into two- and three-character
 * fragments, and two unrelated Tamil sentences then "matched" on those fragments.
 * Latin diacritics are additionally folded to their base letters, so "café" and
 * "cafe" are one term. A token containing a digit is dropped: turns are full of
 * clock times and dates, which collide with unrelated memories that happen to
 * carry the same number.
 *
 * One property is load-bearing for the caller: the result is *empty* for a turn
 * made only of stop words or of single characters, which is how "do not reorder
 * on noise" is enforced rather than merely hoped for.
 */
export function contentWords(text: string): string[] {
	// NFC, not NFKC: Tamil vowel signs are canonically ordered, and compatibility
	// folding is a step towards reordering the marks of a real word.
	const normalized = text.normalize('NFC');
	const words = normalized.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
	return words
		.map(stripLatinAccents)
		.filter(
			(word) =>
				word.length >= MIN_TOKEN_LENGTH &&
				!/\d/u.test(word) &&
				!RETRIEVAL_STOP_WORDS.has(word),
		);
}

/**
 * Folds a Latin word's accents away, and leaves every other script alone.
 *
 * Applied per word and only when the whole word is Latin, which is what makes it
 * safe: a Tamil vowel sign is a combining mark too, and stripping marks from a
 * Tamil word would delete the vowels that make it a word. "Café" and "cafe"
 * becoming one term is the entire benefit, so the rule is kept to where it can
 * only mean that.
 */
function stripLatinAccents(word: string): string {
	if (!/^[a-z\p{Script=Latin}\p{M}]+$/u.test(word)) return word;
	return word.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
}

/**
 * The word itself, when it is long enough to stand as a stem.
 *
 * The length guards are what keep this from inventing matches: "as" must not
 * become a prefix of "ask", and "you" must not become one of "younger". Nothing
 * shorter than four characters is ever a stem.
 */
function stemOf(word: string): string | null {
	if (word.length < MIN_STEM_INPUT_LENGTH) return null;
	for (const suffix of ENGLISH_SUFFIXES) {
		if (!word.endsWith(suffix)) continue;
		const stem = word.slice(0, word.length - suffix.length);
		if (stem.length < MIN_STEM_LENGTH) continue;
		return stem;
	}
	return null;
}

/**
 * Every form of a text's terms that another text may legitimately match on.
 *
 * A word contributes itself and, when it is inflected, its stem — so "planning"
 * offers `planning` and `plan`, and "plans" offers `plans` and `plan`. The two
 * then share `plan`, which is the whole point: English marks a word's job with a
 * suffix, and a spoken turn and a stored fact need not agree on the suffix.
 *
 * Matching runs over this merged set rather than over stems alone. Stemming is
 * restricted to words of seven characters or more, so "day" is not mistaken for a
 * stem of "daily"; a stem-only comparison would therefore miss the literal word
 * the user said.
 */
export function memoryMatchKeys(text: string): Set<string> {
	const keys = new Set<string>();
	for (const word of contentWords(text)) {
		keys.add(word);
		const stem = stemOf(word);
		if (stem) keys.add(stem);
	}
	return keys;
}

/**
 * How much of the *shorter* side's subject matter the two sides share, in [0, 1].
 *
 * The overlap coefficient — shared terms over the smaller term set — rather than
 * Jaccard or a raw count. Raw counts let a long memory win by being long, and
 * Jaccard lets a long memory lose by being long; this one is symmetric in length
 * and answers the question that matters here: how much of what this memory is
 * made of is present in what the user just said?
 *
 * A shared term must be at least [MIN_SHARED_TERM_LENGTH] characters. Short terms
 * are exactly the ones most likely to coincide by accident, and this fallback has
 * to be conservative: ranking on noise is worse than not ranking. The
 * coefficient's own asymmetry is the other guard — a one-word memory that matches
 * scores 1, but a memory of five terms that matches on one scores 0.2.
 */
export function lexicalOverlap(text: string, query: string): number {
	const textKeys = memoryMatchKeys(text);
	const queryKeys = memoryMatchKeys(query);
	if (!textKeys.size || !queryKeys.size) return 0;

	let shared = 0;
	for (const key of textKeys) {
		if (key.length < MIN_SHARED_TERM_LENGTH) continue;
		if (queryKeys.has(key)) shared++;
	}
	return shared / Math.min(textKeys.size, queryKeys.size);
}

/**
 * Whether the turn is worth ranking against at all.
 *
 * A turn of one character, a turn of stop words, or a turn with no significant
 * term is *not*, and saying so here is what keeps a noise-only turn on the
 * importance ordering. `null` from [rankByLexicalOverlap] remains the per-memory
 * answer; this is the whole-turn one.
 */
export function hasRankableTerms(query: string): boolean {
	return contentWords(query).length > 0;
}

/**
 * The memories a lexical comparison can actually separate, or `null`.
 *
 * `null` is the "no signal" answer and it is the important half of this module: a
 * turn whose subject matter no memory shares must not reorder anything, and the
 * caller falls back to the importance ordering it would have used before this
 * existed. Scores of zero are dropped before the sort for the same reason, so a
 * row that matched nothing can never outrank one that matched something.
 *
 * Ties keep the incoming order, which is the importance ordering the query
 * produced — so among equally relevant rows the user still sees the important one
 * first, and a pool where nothing scores returns the same rows in the same order
 * as before.
 */
export function rankByLexicalOverlap(term: string, pool: readonly RankedMemory[]): RankedMemory[] | null {
	const scored = pool
		.map((memory) => ({ memory, score: lexicalOverlap(memory.content, term) }))
		.filter((entry) => entry.score > 0);
	if (!scored.length) return null;

	// `Array.prototype.sort` is spec-stable, so equal scores keep the pool order;
	// the index comparison states that rather than depending on it.
	const order = new Map(pool.map((memory, index) => [memory.id, index]));
	scored.sort((a, b) => b.score - a.score || (order.get(a.memory.id) ?? 0) - (order.get(b.memory.id) ?? 0));
	return scored.map((entry) => entry.memory);
}
