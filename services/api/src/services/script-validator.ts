/**
 * NOVA API — the writing-system check that stands between a model's text and the
 * user's ear.
 *
 * Spoken replies are synthesised by Sarvam TTS, so a wrong character is **heard, not
 * seen**: there is no spell-checker between the model and the user. That is what
 * makes this a runtime check rather than a prompt instruction. The incident that
 * motivated it is measured, not hypothetical — scanning every reply the live spoken
 * route produced across five models, `claude-haiku-4-5` (the configured voice model)
 * put **55 letters from other writing systems inside Tamil sentences**: 51 Malayalam,
 * 2 Devanagari, 1 Bengali and one CJK ideograph (U+51E0). The other four models
 * produced none. A one-script instruction was then added to the system prompt, and it
 * is a mitigation of a model behaviour, not a check: the third capture after it still
 * carries a Bengali vowel sign inside a Tamil word (`மேலே` written with U+09C7), which
 * a letters-only scanner reports as zero.
 *
 * ─── What is checked ────────────────────────────────────────────────────────
 *
 * A code point is reported when it is a **letter or a combining mark** and its script
 * is not one the language allows:
 *
 *   - Tamil (`ta`, `ta-IN`, `tanglish`) allows **Tamil and Latin**. English words and
 *     product names inside a Tamil sentence are expected, and digits, punctuation and
 *     emoji are not letters in any case.
 *   - English (`en`) allows **Latin only**. A Devanagari or CJK letter in an English
 *     reply is the same class of defect as a Malayalam letter in a Tamil one.
 *
 * Combining marks are included because the real intrusions are whole words: a
 * Malayalam consonant carries Malayalam vowel signs, and a Bengali vowel sign attached
 * to a Tamil letter is exactly as unreadable as a Malayalam consonant. Excluding them
 * would make the check blind to the one defect that survived the prompt mitigation.
 *
 * ─── What is deliberately not checked ───────────────────────────────────────
 *
 * `Inherited` and `Common` are excluded from the "foreign" side of the test, and this
 * is the difference between a check that runs in production and one that gets turned
 * off:
 *
 *   - `Inherited` covers the combining marks that belong to no script in particular —
 *     the acute accent in `café`, variation selectors, the skin-tone modifiers.
 *   - `Common` covers the combining enclosing keycap U+20E3, so `1️⃣` is not reported,
 *     along with the zero-width joiners and variation selectors that build emoji.
 *
 * Being conservative is a feature: a validator that cries wolf on emoji or on an
 * accented English word is worse than no validator, because the first false positive
 * gets it switched off.
 *
 * ─── Cost and purity ────────────────────────────────────────────────────────
 *
 * Pure: no imports, no I/O, no clock, no configuration. One cached regular expression
 * per distinct allowed-script set, built lazily on first use and reused for every later
 * turn, plus a single pass over the text with `matchAll`; the per-character script
 * lookup runs only for a code point that has already been found offending, so a clean
 * reply pays for the one scan and nothing else.
 *
 * ─── Where this is meant to be called ───────────────────────────────────────
 *
 * `services/api/src/realtime/reply.ts` hands each finished sentence to TTS from
 * `enqueue()` while the model is still generating, so a check on the whole reply at
 * the end of `runReply` can only describe what has already been spoken. The call
 * belongs in `enqueue`, on `speakable`, before `openSpeechStream` — see the report for
 * the exact two lines. Nothing in this module is wired yet.
 */

/** Whether the offending code point is a base letter or a combining mark. */
export type ScriptKind = 'letter' | 'mark';

/** One code point that does not belong to the expected writing system. */
export interface ScriptViolation {
	/** The offending code point, as written in the reply. */
	readonly char: string;
	/** `U+0D28` — deterministic where a Unicode name lookup would need a dependency. */
	readonly codePoint: string;
	/** Writing system the code point belongs to, e.g. `Malayalam`. */
	readonly script: string;
	/** `letter` for a base character, `mark` for a combining (vowel sign, virama…). */
	readonly kind: ScriptKind;
	/** UTF-16 offset of the code point in the reply, for logging and reconstruction. */
	readonly index: number;
}

/** The whole answer: `clean` is the boolean the caller branches on. */
export interface ScriptCheckResult {
	readonly clean: boolean;
	readonly violations: readonly ScriptViolation[];
}

// ─── Language → allowed writing systems ─────────────────────────────────────

const LATIN_ONLY: readonly string[] = ['Latin'];
const TAMIL_AND_LATIN: readonly string[] = ['Latin', 'Tamil'];
const DEVANAGARI_AND_LATIN: readonly string[] = ['Latin', 'Devanagari'];
const TELUGU_AND_LATIN: readonly string[] = ['Latin', 'Telugu'];
const KANNADA_AND_LATIN: readonly string[] = ['Latin', 'Kannada'];
const MALAYALAM_AND_LATIN: readonly string[] = ['Latin', 'Malayalam'];
const BENGALI_AND_LATIN: readonly string[] = ['Latin', 'Bengali'];
const GUJARATI_AND_LATIN: readonly string[] = ['Latin', 'Gujarati'];
const GURMUKHI_AND_LATIN: readonly string[] = ['Latin', 'Gurmukhi'];
const ARABIC_AND_LATIN: readonly string[] = ['Latin', 'Arabic'];

/**
 * The writing systems each language is written in, using the same names ICU accepts
 * for `\p{Script=…}`. Latin is allowed everywhere: every one of these languages
 * borrows English words in ordinary speech, and the spoken prompt explicitly tells the
 * model to keep them in Latin script.
 *
 * A language that is not listed here is **unrestricted**, not "Latin only" — see
 * [allowedScriptsForLanguage]. Guessing the script of a language nobody has verified
 * is how a check starts reporting correct replies.
 */
const SCRIPTS_BY_LANGUAGE: Readonly<Record<string, readonly string[]>> = {
	// The requested pair. English is the one language with no second script.
	en: LATIN_ONLY,
	english: LATIN_ONLY,
	ta: TAMIL_AND_LATIN,
	tamil: TAMIL_AND_LATIN,
	tanglish: TAMIL_AND_LATIN,

	// The rest of the languages the product ships voices for, so the same check
	// covers them instead of only the language the defect happened to appear in.
	hi: DEVANAGARI_AND_LATIN,
	mr: DEVANAGARI_AND_LATIN,
	ne: DEVANAGARI_AND_LATIN,
	sa: DEVANAGARI_AND_LATIN,
	mai: DEVANAGARI_AND_LATIN,
	bho: DEVANAGARI_AND_LATIN,
	awa: DEVANAGARI_AND_LATIN,
	doi: DEVANAGARI_AND_LATIN,
	hinglish: DEVANAGARI_AND_LATIN,
	te: TELUGU_AND_LATIN,
	kn: KANNADA_AND_LATIN,
	ml: MALAYALAM_AND_LATIN,
	bn: BENGALI_AND_LATIN,
	as: BENGALI_AND_LATIN,
	benglish: BENGALI_AND_LATIN,
	gu: GUJARATI_AND_LATIN,
	gujlish: GUJARATI_AND_LATIN,
	pa: GURMUKHI_AND_LATIN,
	ur: ARABIC_AND_LATIN,
	sd: ARABIC_AND_LATIN,
	// Kashmiri and Manipuri are each written in more than one script, so both are
	// allowed rather than making the check pick a side and flag a correct reply.
	ks: ['Latin', 'Devanagari', 'Arabic'],
	mni: ['Latin', 'Bengali', 'Meetei_Mayek'],
};

/**
 * The scripts [language] is expected to be written in, or `null` when the language is
 * not one whose script has been verified here.
 *
 * `null` means **do not check**. `auto`, an empty language and an unlisted code all
 * land here, and that is the conservative answer: the alternative is to assume Latin
 * and report a correct Hindi or Malayalam reply as broken.
 */
export function allowedScriptsForLanguage(language?: string | null): readonly string[] | null {
	if (!language) return null;
	// `ta-IN` and `ta_IN` both name Tamil; `TA` is the same code.
	const normalized = language.trim().toLowerCase().replace(/_/g, '-');
	if (!normalized) return null;
	return SCRIPTS_BY_LANGUAGE[normalized] ?? SCRIPTS_BY_LANGUAGE[normalized.split('-')[0]] ?? null;
}

// ─── The scan ───────────────────────────────────────────────────────────────

/**
 * The writing systems the check can *name*. Ordered, but only for readability: the
 * scripts are disjoint, so at most one entry ever matches a code point. Anything
 * outside this table is reported as `Other` with its code point, which is still
 * enough to act on.
 */
const SCRIPT_NAMES: ReadonlyArray<readonly [string, RegExp]> = [
	['Malayalam', /\p{Script=Malayalam}/u],
	['Devanagari', /\p{Script=Devanagari}/u],
	['Bengali', /\p{Script=Bengali}/u],
	['Tamil', /\p{Script=Tamil}/u],
	['Telugu', /\p{Script=Telugu}/u],
	['Kannada', /\p{Script=Kannada}/u],
	['Gujarati', /\p{Script=Gujarati}/u],
	['Gurmukhi', /\p{Script=Gurmukhi}/u],
	['Oriya', /\p{Script=Oriya}/u],
	['Sinhala', /\p{Script=Sinhala}/u],
	['Meetei Mayek', /\p{Script=Meetei_Mayek}/u],
	['Arabic', /\p{Script=Arabic}/u],
	['Hebrew', /\p{Script=Hebrew}/u],
	['Syriac', /\p{Script=Syriac}/u],
	['Thaana', /\p{Script=Thaana}/u],
	['Thai', /\p{Script=Thai}/u],
	['Lao', /\p{Script=Lao}/u],
	['Myanmar', /\p{Script=Myanmar}/u],
	['Khmer', /\p{Script=Khmer}/u],
	['Tibetan', /\p{Script=Tibetan}/u],
	['Georgian', /\p{Script=Georgian}/u],
	['Armenian', /\p{Script=Armenian}/u],
	['Ethiopic', /\p{Script=Ethiopic}/u],
	['Cyrillic', /\p{Script=Cyrillic}/u],
	['Greek', /\p{Script=Greek}/u],
	['Han', /\p{Script=Han}/u],
	['Hiragana', /\p{Script=Hiragana}/u],
	['Katakana', /\p{Script=Katakana}/u],
	['Hangul', /\p{Script=Hangul}/u],
	['Bopomofo', /\p{Script=Bopomofo}/u],
	['Mongolian', /\p{Script=Mongolian}/u],
	['Cherokee', /\p{Script=Cherokee}/u],
];

const LETTER = /\p{L}/u;

/** Built lazily, one per distinct allowed-script set, and reused for every later turn. */
const PATTERNS = new Map<string, RegExp>();

/**
 * A global pattern matching exactly the code points the check reports: a letter or a
 * combining mark whose script is neither allowed nor script-neutral.
 *
 * The negative lookahead is doing the work that a character class cannot (JavaScript
 * has no class subtraction): at each position it refuses to match when the next code
 * point is one of the allowed scripts, `Inherited` (accented Latin, variation
 * selectors, skin-tone modifiers) or `Common` (the emoji keycap mark, the zero-width
 * joiners). What is left of `\p{L}|\p{M}` is a foreign letter or a foreign vowel sign.
 */
function foreignCodePointPattern(allowed: readonly string[]): RegExp {
	const key = allowed.join('|');
	const cached = PATTERNS.get(key);
	if (cached) return cached;

	const neutral = [...allowed, 'Inherited', 'Common'].map((script) => `\\p{Script=${script}}`).join('');
	const pattern = new RegExp(`(?![${neutral}])(?:\\p{L}|\\p{M})`, 'gu');
	PATTERNS.set(key, pattern);
	return pattern;
}

function codePointLabel(char: string): string {
	return `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`;
}

function scriptNameOf(char: string): string {
	for (const [name, pattern] of SCRIPT_NAMES) {
		if (pattern.test(char)) return name;
	}
	return 'Other';
}

/**
 * Every letter or combining mark in [text] that does not belong to the writing systems
 * [language] is written in.
 *
 * `clean` is the only thing a caller needs to branch on; `violations` carries enough
 * detail to log a metric (which script, how many, which code point, and where).
 * A language whose script has not been verified is not checked at all.
 */
export function checkReplyScript(text: string, language?: string | null): ScriptCheckResult {
	const allowed = allowedScriptsForLanguage(language);
	if (allowed === null || text.length === 0) return { clean: true, violations: [] };

	const violations: ScriptViolation[] = [];
	// `matchAll` clones the cached pattern, so this cannot leave `lastIndex` dirty for
	// the next spoken turn.
	for (const match of text.matchAll(foreignCodePointPattern(allowed))) {
		const char = match[0];
		violations.push({
			char,
			codePoint: codePointLabel(char),
			script: scriptNameOf(char),
			kind: LETTER.test(char) ? 'letter' : 'mark',
			index: match.index ?? 0,
		});
	}

	return { clean: violations.length === 0, violations };
}

// ─── The log line ───────────────────────────────────────────────────────────

function plural(count: number): string {
	return count === 1 ? '' : 's';
}

/**
 * One line for the log, or `undefined` when there is nothing to report.
 *
 * Both numbers are stated because both are true and they disagree: the incident's
 * "55 letters" is `str.isalpha()`-shaped, while the code points that will actually be
 * read aloud are 101. A metric that reports only one of them invites the other to be
 * declared fixed.
 */
export function summarizeScriptViolations(
	violations: readonly ScriptViolation[],
): string | undefined {
	if (violations.length === 0) return undefined;

	const byScript = new Map<string, number>();
	for (const violation of violations) {
		byScript.set(violation.script, (byScript.get(violation.script) ?? 0) + 1);
	}
	const scripts = [...byScript].map(([script, count]) => `${script} ${count}`).join(', ');
	const letters = violations.filter((violation) => violation.kind === 'letter').length;
	const marks = violations.length - letters;
	const first = violations[0];

	return (
		`${violations.length} code point${plural(violations.length)} from another writing system ` +
		`(${scripts}); ${letters} letter${plural(letters)}, ${marks} combining mark${plural(marks)}; ` +
		`first ${first.codePoint} ${first.script} at ${first.index}`
	);
}

/**
 * The corrective turn to send back to the model when a reply cannot be spoken as
 * written — the same shape as `UNBACKED_CLAIM_CORRECTION` in `assistant-tools.ts`.
 *
 * It is only usable where the whole reply exists before synthesis. On the streaming
 * voice path the sentences are already being spoken by the time the full text is
 * known, so there the honest remedy is the metric plus a fallback, not a re-prompt.
 */
export const SCRIPT_MISMATCH_CORRECTION =
	'Your last reply mixed letters from another writing system into the user’s language. ' +
	'That text is read aloud by a speech engine, so those characters are heard as garbage. ' +
	'Rewrite the reply using only the writing system the user’s language requires, keep ' +
	'borrowed English words in Latin script, and do not substitute letters or vowel signs ' +
	'from any other script.';
