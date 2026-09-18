/**
 * NOVA API — Realtime sentence chunker.
 *
 * This is the latency trick behind "speech starts before the reply exists".
 * LLM tokens arrive one or a few characters at a time; waiting for the whole
 * reply before calling TTS would add the entire generation time to the wait
 * before the first word is heard. Instead tokens are buffered here and every
 * time a sentence boundary is complete the sentence is handed to TTS
 * immediately, while the model keeps generating the rest.
 *
 * Boundaries: `. ` `? ` `! ` and newline — plus the Devanagari danda (`।`) and
 * double danda (`॥`) that end sentences in Hindi, Marathi, Nepali and Sanskrit.
 * A hard length cap (~200 chars) bounds how long the reader waits when the
 * model writes a run-on paragraph or a bulleted list.
 */

/** Boundary characters, each of which ends a sentence when followed by space/EOS. */
const TERMINATORS = new Set(['.', '?', '!', '।', '॥']);

/**
 * Words that end in a period without ending a sentence. Without this, "Dr."
 * and "e.g." would each trigger a TTS call and split a spoken sentence in two.
 */
const ABBREVIATIONS = new Set([
	'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'eg', 'ie',
	'no', 'fig', 'approx', 'inc', 'ltd', 'gov', 'capt', 'sgt', 'rev', 'hon',
	'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

/**
 * Longest sentence handed to TTS before we force a split at a word boundary.
 * Smaller = lower latency, more TTS round trips; 200 chars is roughly 12
 * seconds of speech and comfortably below Sarvam's per-request text limit.
 */
export const MAX_SENTENCE_CHARS = 200;

/** Do not emit a fragment shorter than this unless it is the tail of the reply. */
const MIN_SENTENCE_CHARS = 8;

function lastWordBefore(text: string, index: number): string {
	let i = index - 1;
	while (i >= 0 && !/\s/.test(text[i])) i--;
	return text.slice(i + 1, index).replace(/\.+$/, '').toLowerCase();
}

/**
 * Returns the index just past a sentence boundary found in `text`, or -1.
 * `atEnd` allows the final character to be a boundary even though no whitespace
 * has arrived after it yet (the next token may still turn out to be "5" in
 * "3.5", which the digit guard below rejects).
 */
function findBoundary(text: string, atEnd: boolean): number {
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		// A newline ends a sentence on its own (list items, paragraphs) and
		// does not need the following-whitespace check below.
		if (ch === '\n') return i + 1;

		if (!TERMINATORS.has(ch)) continue;

		const next = text[i + 1];
		const followedBySpace = next !== undefined && /\s/.test(next);
		if (!followedBySpace && !(atEnd && i === text.length - 1)) continue;

		// "3.5", "1.2 million" — a period between digits is not a sentence end.
		if (ch === '.' && /\d/.test(text[i - 1] ?? '') && /\d/.test(next ?? '')) continue;
		// "Dr." / "e.g." — a known abbreviation is not a sentence end.
		if (ch === '.' && ABBREVIATIONS.has(lastWordBefore(text, i))) continue;

		const end = i + 1;
		if (end < MIN_SENTENCE_CHARS && !(atEnd && i === text.length - 1)) continue;
		return end;
	}
	return -1;
}

/** Forced split point for an over-long buffer: the last space before the cap. */
function findLongSplit(text: string, cap: number): number {
	const window = text.slice(0, cap);
	const space = window.lastIndexOf(' ');
	// Never hand TTS an empty string; a single unbroken token longer than the
	// cap is split at the cap rather than dropped.
	return space > MIN_SENTENCE_CHARS ? space + 1 : cap;
}

export class SentenceChunker {
	private buffer = '';
	private nextIndex = 0;

	/** Feed an LLM delta; returns every sentence that became complete. */
	push(token: string): string[] {
		if (!token) return [];
		this.buffer += token;
		return this.drain(false);
	}

	/** End of stream: returns the trailing fragment, if any. */
	flush(): string | null {
		const parts = this.drain(true);
		if (parts.length) {
			// `drain(true)` can only produce one part; keep the signature simple.
			return parts[0];
		}
		return null;
	}

	/** Sentences emitted so far — the index the next one will carry. */
	get emitted(): number {
		return this.nextIndex;
	}

	private drain(atEnd: boolean): string[] {
		const out: string[] = [];
		for (;;) {
			if (this.buffer.length > MAX_SENTENCE_CHARS) {
				const cut = findLongSplit(this.buffer, MAX_SENTENCE_CHARS);
				const sentence = this.buffer.slice(0, cut).trim();
				this.buffer = this.buffer.slice(cut);
				if (sentence) out.push(sentence);
				this.nextIndex++;
				continue;
			}

			const boundary = findBoundary(this.buffer, atEnd);
			if (boundary === -1) break;

			const sentence = this.buffer.slice(0, boundary).trim();
			this.buffer = this.buffer.slice(boundary);
			if (sentence) {
				out.push(sentence);
				this.nextIndex++;
			}
		}

		if (atEnd) {
			const tail = this.buffer.trim();
			this.buffer = '';
			if (tail) {
				out.push(tail);
				this.nextIndex++;
			}
		}
		return out;
	}
}
