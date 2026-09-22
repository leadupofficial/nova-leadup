/**
 * NOVA API — the writing-system check that stands between a model's text and the
 * user's ear.
 *
 * This exists because of a measured defect, not a hypothesis. Scanning every reply
 * the live spoken route produced across five models, `claude-haiku-4-5` — the
 * configured voice model — put **55 letters from other writing systems inside Tamil
 * sentences**: 51 Malayalam, 2 Devanagari, 1 Bengali and one CJK ideograph (U+51E0).
 * The four other models produced none. Sarvam TTS reads those letters as garbage,
 * and a wrong character is *heard*, not seen, so nothing between the model and the
 * user can correct it. A prompt instruction was added afterwards and reduced the
 * letter count to zero on two later runs; the third run below still carries a
 * Bengali vowel sign through it, because that instruction is a mitigation of a model
 * behaviour and not a check.
 *
 * Every reply embedded below is the raw capture from
 * `/tmp/nova-model-matrix/matrix-*.json` — the output of
 * `services/api/scripts/probe-voice-model-matrix.mjs` driven against the live
 * `/api/v1/voice/chat` route. The captures are byte-for-byte: the newlines and the
 * spacing are part of what the indices and counts below measure, so the fixture
 * lines deliberately start at column zero rather than being re-indented to the
 * surrounding code.
 *
 * Two definitions of "the defect" appear here and they are both correct:
 *
 *  - **55 letters.** `str.isalpha()` is true for a letter and false for a combining
 *    vowel sign, so a letters-only scan counts 55 across these replies.
 *  - **101 code points.** Counting every code point that belongs to another writing
 *    system gives 99 here plus 2 in the acknowledgement, because Malayalam and
 *    Devanagari vowel signs and the virama are combining marks. Those marks are the
 *    same defect — a Bengali vowel sign attached to a Tamil letter is as unreadable
 *    as a Malayalam consonant — so the validator reports both and labels which is
 *    which.
 */
import { describe, expect, it } from 'vitest';
import {
	allowedScriptsForLanguage,
	checkReplyScript,
	summarizeScriptViolations,
	SCRIPT_MISMATCH_CORRECTION,
	type ScriptViolation,
} from '../services/script-validator.js';

// ─── The replies the live route actually produced ───────────────────────────

/**
 * `matrix-haiku-langfix-1.json` → `tanglish-query`. The big one: 51 Malayalam
 * letters, 2 Devanagari, 1 Bengali, plus the combining marks that carry them — 99
 * code points from other writing systems inside a Tamil answer.
 */
const MEASURED_TANGLISH_QUERY = `இன்னைக்கு உனக்கு pending இருக்குற tasks:

- **Send the invoice to ABC** — இன்னும் pending
- **Finish the website proposal** — இன்னும் pending

அப்ப reminders-ல் ന്ദാനും:
- **Today, நौ மണി இரண்டு मिनिট evening-ல്** — Pay the plumber (ഇത് ഈ വെച്ചേ വരാണ്)
- **നാളെ കാലെ പതിനൊരു മണിക്ക് — Call Kumar
- **നാളെ എട്ട് മണി രണ്ട് മിനിറ്റ് evening-ല്** — Call the client about the website

ഒരേയുമെ തീരാൻ തുടങ്ങ്?`;

/**
 * `matrix-haiku-langfix-1.json` → `tanglish-action`. The CJK ideograph U+51E0
 * standing in for "how many" (`எத்தனை`), and a Bengali vowel sign U+09BF.
 */
const MEASURED_TANGLISH_ACTION = `நாளைக்கு காலை client-க்கு call பண்ண remind set பண்ணিட்டேன். Specific time சொல்லு —几மணைக்கு? Morning-ல் எந்த time-ல் remind பண்ணனும்?`;

/**
 * `matrix-haiku-langfix-2.json` → `tanglish-query`. A second run of the same model:
 * a single Devanagari letter U+092E inside the Tamil word `இல்லாம`.
 */
const MEASURED_DEVANAGARI_MIDWORD = `என்னிட்ட இருக்க pending tasks:

1. **Send the invoice to ABC** — due date இல்லாம இருக்கு
2. **Finish the website proposal** — due date இல்லாम இருக்கு

அப்புறம் reminders:
- **Today, 9:02 pm** — Pay the plumber
- **Tomorrow, 11:00 am** — Call Kumar
- **Tomorrow, 8:02 pm** — Call the client about the website

Innaiku invoice send pannum kumbalam irukku? Website proposal finish panna ozhiyen?`;

/**
 * `matrix-kimi-k2.6.json` → `tanglish-query`. A different model, and the reason
 * the check cannot be letters-only: both intruders are combining marks (Bengali
 * U+09BE, Devanagari U+0941), so a scan that counts letters calls this reply clean.
 */
const MEASURED_KIMI_MARKS = `இன்னைக்கு (today, Monday) உனக்கு pending இருக்குற tasks:

1. **Send the invoice to ABC** — இதுக்கு due date இல்ல
2. **Finish the website proposal** — இதுக்கும் due date இல்ல

Reminders-ல:
- **Pay the plumber** — இன்னைக்கு (today) 9:01 pm-ல (9 o'clock 1 minute in the evening)

அத solo handle பண்ணிட்டு, other tasks தাங்க schedule-ல இருக்கु. Invoicing போ, proposal finish பண்ணு, plumber-க்கு call பண்ணு — seri?`;

/**
 * `matrix-haiku-fix3.json` → `tanglish-query`. Produced *after* the prompt
 * instruction was added, and reported as zero letters — correctly, because the one
 * intruder is the Bengali vowel sign U+09C7 written where Tamil `ே` belongs in
 * `மேலே`. The mitigation did not cover it; a runtime check does.
 */
const AFTER_MITIGATION_STILL_DIRTY = `இன்னைக்கு உனக்கு pending இருக்குற tasks:
- Send the invoice to ABC
- Finish the website proposal

அதுக்கு மேலে reminder இருக்கு: "Pay the plumber" - today at half past nine in the evening.`;

/** `matrix-haiku-fix4.json` → `tanglish-query`. Clean, and must stay clean. */
const AFTER_MITIGATION_CLEAN = `இன்னைக்கு உனக்கு இரண்டு tasks pending இருக்கு:

1. **Send the invoice to ABC** — இதுக்கு due date இல்ல
2. **Finish the website proposal** — இதுக்கும் due date இல்ல

And reminders:
- **Today, nine oh four in the evening** — Pay the plumber
- **Tomorrow, eleven in the morning** — Call Kumar
- **Tomorrow, eight oh four in the evening** — Call the client about the website

Tomorrow client-க்கு call பண்ணணும்-ல, அதுக்கு reminder வேணுமா?`;

/** `matrix-glm-5.3-flash.json` → `tanglish-query`. Clean Tamil + Latin + emoji. */
const MATRIX_CLEAN_TAMIL = `இன்னைக்கு இருக்கிறது இதுதான்:

- **Plumber-க்கு pay பண்ணணும்** — இன்னைக்கு இரவு எட்டு மணி ஏறக்குறைய ஐம்பது அக்கதுக்கு reminder இருக்கு
- **ABC-க்கு invoice அனுப்பணும்** — task ஆ பெந்திங் இருக்கு
- **Website proposal finish பண்ணணும்** — இதுவும் பெந்திங் தான்

நாளைக்கு ரெண்டு reminders உண்டு — காலை ஒன்பது மணிக்கு client call, பதினொரு மணிக்கு Kumar call. 👍`;

/** `matrix-glm-5.3-budget1024.json` → `en-action`. Clean English. */
const MATRIX_CLEAN_ENGLISH = `Done — I'll remind you to call Kumar tomorrow, Tuesday the twenty-second, at eleven in the morning.`;

// ─── Small helpers, so an assertion reads as the claim it makes ─────────────

function lettersOf(violations: readonly ScriptViolation[]): ScriptViolation[] {
	return violations.filter((v) => v.kind === 'letter');
}

function marksOf(violations: readonly ScriptViolation[]): ScriptViolation[] {
	return violations.filter((v) => v.kind === 'mark');
}

function byScript(violations: readonly ScriptViolation[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const v of violations) counts[v.script] = (counts[v.script] ?? 0) + 1;
	return counts;
}

function codePointsOf(violations: readonly ScriptViolation[]): string[] {
	return violations.map((v) => v.codePoint);
}

function only(text: string, language: string): ScriptViolation {
	const { violations } = checkReplyScript(text, language);
	expect(violations).toHaveLength(1);
	return violations[0];
}

// ─── The measured defect ────────────────────────────────────────────────────

describe('the measured defect', () => {
	it('reports the 55 letters the incident counted, from these two replies', () => {
		const query = checkReplyScript(MEASURED_TANGLISH_QUERY, 'tanglish');
		const action = checkReplyScript(MEASURED_TANGLISH_ACTION, 'tanglish');

		expect(query.clean).toBe(false);
		expect(action.clean).toBe(false);

		const letters = lettersOf([...query.violations, ...action.violations]);
		expect(letters).toHaveLength(55);
		expect(byScript(lettersOf(query.violations))).toEqual({
			Malayalam: 51,
			Devanagari: 2,
			Bengali: 1,
		});
		expect(byScript(lettersOf(action.violations))).toEqual({ Han: 1 });
	});

	it('reports the 101 code points too, because the vowel signs are the same defect', () => {
		const query = checkReplyScript(MEASURED_TANGLISH_QUERY, 'tanglish');
		const action = checkReplyScript(MEASURED_TANGLISH_ACTION, 'tanglish');

		// 99 + 2: every non-Latin, non-Tamil letter *and* combining mark.
		expect(query.violations).toHaveLength(99);
		expect(action.violations).toHaveLength(2);
		expect(marksOf(query.violations)).toHaveLength(45);
		expect(marksOf(action.violations)).toHaveLength(1);
		expect(byScript(query.violations)).toEqual({
			Malayalam: 93,
			Devanagari: 5,
			Bengali: 1,
		});
	});

	it('names each offender with its code point, script and kind', () => {
		const { violations } = checkReplyScript(MEASURED_TANGLISH_QUERY, 'tanglish');
		const codePoints = codePointsOf(violations);

		// The characters the incident report listed by code point.
		expect(codePoints).toContain('U+0D28');
		expect(codePoints).toContain('U+0D26');
		expect(codePoints).toContain('U+0D23');
		expect(codePoints).toContain('U+0D07');
		expect(codePoints).toContain('U+092E');
		expect(codePoints).toContain('U+0928');
		expect(codePoints).toContain('U+099F');

		const first = violations[0];
		expect(first.char).toBe('ന');
		expect(first.codePoint).toBe('U+0D28');
		expect(first.script).toBe('Malayalam');
		expect(first.kind).toBe('letter');
		expect(first.index).toBe(161);

		// Every index points at the character it names, in this exact string.
		for (const v of violations) {
			expect(MEASURED_TANGLISH_QUERY.slice(v.index, v.index + v.char.length)).toBe(v.char);
		}
	});

	it('reports the CJK ideograph and the Bengali vowel sign in the acknowledgement', () => {
		const { violations } = checkReplyScript(MEASURED_TANGLISH_ACTION, 'tanglish');

		const cjk = violations.find((v) => v.codePoint === 'U+51E0');
		expect(cjk).toMatchObject({ char: '几', script: 'Han', kind: 'letter', index: 82 });

		const bengali = violations.find((v) => v.codePoint === 'U+09BF');
		expect(bengali).toMatchObject({ script: 'Bengali', kind: 'mark', index: 51 });
	});

	it('reports a Devanagari letter written inside an otherwise Tamil word', () => {
		const violation = only(MEASURED_DEVANAGARI_MIDWORD, 'tanglish');

		expect(violation).toMatchObject({
			char: 'म',
			codePoint: 'U+092E',
			script: 'Devanagari',
			kind: 'letter',
			index: 140,
		});
		// `இல்லாம`: the word is Tamil for its first five code points and Devanagari for
		// the last — `\u092E` is spelled as an escape because it is visually identical
		// to the Tamil `ம` (U+0BAE) that belongs there.
		expect(MEASURED_DEVANAGARI_MIDWORD.slice(135, 141)).toBe('இல்லா\u092E');
	});

	it('reports combining marks alone, which a letters-only scan calls clean', () => {
		const { clean, violations } = checkReplyScript(MEASURED_KIMI_MARKS, 'tanglish');

		expect(clean).toBe(false);
		expect(lettersOf(violations)).toHaveLength(0);
		expect(byScript(violations)).toEqual({ Bengali: 1, Devanagari: 1 });
		expect(codePointsOf(violations)).toEqual(['U+09BE', 'U+0941']);
		expect(violations.every((v) => v.kind === 'mark')).toBe(true);
	});

	it('fires on the post-mitigation reply a letters-only scanner reports as zero', () => {
		const { clean, violations } = checkReplyScript(AFTER_MITIGATION_STILL_DIRTY, 'tanglish');

		expect(clean).toBe(false);
		expect(violations).toHaveLength(1);
		expect(lettersOf(violations)).toHaveLength(0);
		expect(violations[0]).toMatchObject({
			char: 'ে',
			codePoint: 'U+09C7',
			script: 'Bengali',
			kind: 'mark',
			index: 109,
		});
	});

	it('leaves the clean post-mitigation reply alone', () => {
		const { clean, violations } = checkReplyScript(AFTER_MITIGATION_CLEAN, 'tanglish');

		expect(violations).toEqual([]);
		expect(clean).toBe(true);
	});
});

// ─── Every writing system the defect appeared as ────────────────────────────

describe('a foreign letter inside a Tamil sentence is reported', () => {
	/**
	 * One carrier sentence, each intruder in the same position, so a failure names
	 * the script at fault rather than a difference in the sentence.
	 */
	const cases: ReadonlyArray<[string, string, string]> = [
		['Malayalam', 'ന', 'U+0D28'],
		['Devanagari', 'न', 'U+0928'],
		['Bengali', 'ন', 'U+09A8'],
		['Han', '几', 'U+51E0'],
		['Hiragana', 'な', 'U+306A'],
		['Katakana', 'ナ', 'U+30CA'],
		['Hangul', '나', 'U+B098'],
		['Telugu', 'న', 'U+0C28'],
		['Kannada', 'ನ', 'U+0CA8'],
		['Gujarati', 'ન', 'U+0AA8'],
		['Gurmukhi', 'ਨ', 'U+0A28'],
		['Oriya', 'ନ', 'U+0B28'],
		['Sinhala', 'න', 'U+0DB1'],
		['Thai', 'น', 'U+0E19'],
		['Arabic', 'ن', 'U+0646'],
		['Cyrillic', 'н', 'U+043D'],
		['Greek', 'ν', 'U+03BD'],
		['Meetei Mayek', 'ꯅ', 'U+ABC5'],
	];

	for (const [script, letter, codePoint] of cases) {
		it(`reports ${script} (${codePoint})`, () => {
			const violation = only(`நாளைக்கு காலை ${letter} பண்ணனும்`, 'ta');

			expect(violation.script).toBe(script);
			expect(violation.codePoint).toBe(codePoint);
			expect(violation.kind).toBe('letter');
		});
	}

	it('reports every offending script in one reply, and only those', () => {
		// Written with an escape for the Devanagari letter on purpose: `\u0928` and
		// the Tamil `ந` (U+0BA8) are near-identical on screen, and a fixture that
		// silently swapped them would assert the opposite of what it says.
		const text = 'நாளைக்கு \u0928 മ ক 几 பண்ணனும்';
		const { violations } = checkReplyScript(text, 'ta');

		expect(byScript(violations)).toEqual({
			Malayalam: 1,
			Devanagari: 1,
			Bengali: 1,
			Han: 1,
		});
	});
});

// ─── English ────────────────────────────────────────────────────────────────

describe('English replies', () => {
	it('reports a Devanagari letter inside an English sentence', () => {
		const violation = only('I will call the client tomorrow at न nine.', 'en');

		expect(violation).toMatchObject({ char: 'न', script: 'Devanagari', kind: 'letter' });
	});

	it('reports a CJK letter and a Tamil letter in English, because English allows Latin only', () => {
		expect(only('Your task is几 done.', 'en').script).toBe('Han');
		expect(only('Your task is ம now.', 'en').script).toBe('Tamil');
	});

	it('leaves clean English alone, including the real captured reply', () => {
		expect(checkReplyScript(MATRIX_CLEAN_ENGLISH, 'en').clean).toBe(true);
		expect(checkReplyScript('Done — I will remind you to call Kumar tomorrow at 9 AM.', 'en').clean).toBe(true);
		expect(checkReplyScript('The ABC-Software proposal is ready. OK?', 'en').clean).toBe(true);
	});
});

// ─── The negative space, which is the point ─────────────────────────────────

describe('legitimate content is never flagged', () => {
	/**
	 * The strongest single false positive to rule out is the Tamil sentence that
	 * borrows English words, because it is the shape every real reply has: Tamil
	 * letters, Latin letters, a product name with a hyphen, markdown, an em dash.
	 */
	const CLEAN_TAMIL_AND_TANGLISH = [
		'நாளைக்கு காலை client-க்கு call பண்ண remind set பண்ணனும்.',
		'அதுக்கு மேலே reminder இருக்கு: "Pay the plumber" — today at half past nine in the evening.',
		'இன்னைக்கு உனக்கு pending இருக்குற tasks-ல client, reminder, OK எல்லாம் இருக்கு.',
		'naan innum edhayum maathavillai — endha action-um nadakkavillai.',
		'Send the invoice to ABC, finish the Website proposal, then call Kumar.',
		'இரண்டு மணி நேரத்தில் நான் உங்களை அழைக்கிறேன்.',
		'சரி, நாளைக்கு பார்க்கலாம்.',
	];

	for (const text of CLEAN_TAMIL_AND_TANGLISH) {
		it(`leaves alone: ${text.slice(0, 40)}`, () => {
			expect(checkReplyScript(text, 'ta').clean).toBe(true);
			expect(checkReplyScript(text, 'tanglish').clean).toBe(true);
		});
	}

	it('leaves a real captured clean Tamil reply alone, emoji and markdown included', () => {
		const { clean, violations } = checkReplyScript(MATRIX_CLEAN_TAMIL, 'tanglish');

		expect(violations).toEqual([]);
		expect(clean).toBe(true);
	});

	it('ignores digits, clock times and currency', () => {
		const neutral = [
			'9 AM',
			'Today, 9:02 pm',
			'Tomorrow, 11:00 am',
			'Tomorrow, 8:02 pm',
			'2026-09-21',
			'₹1,200',
			'+91 98765 43210',
			'Reminder at 9:02 pm — Call the client',
		];
		for (const text of neutral) {
			expect(checkReplyScript(text, 'ta').clean).toBe(true);
			expect(checkReplyScript(text, 'en').clean).toBe(true);
		}
		// A clock time inside a Tamil sentence asks only the Tamil rule: the sentence
		// is Tamil, so English would be right to call it foreign.
		expect(checkReplyScript('இன்னைக்கு 9:02 pm-ல Pay the plumber', 'ta').clean).toBe(true);
	});

	it('ignores emoji, including the ones built from combining marks', () => {
		const neutral = [
			'Done 👍',
			'Call the client 📞⏰✅',
			'1️⃣ first',
			'👍🏽',
			'❤️',
			'🇮🇳',
			'👨‍👩‍👧',
		];
		for (const text of neutral) {
			expect(checkReplyScript(text, 'ta').clean).toBe(true);
			expect(checkReplyScript(text, 'en').clean).toBe(true);
		}
		expect(checkReplyScript('நாளைக்கு call பண்ணு 📞', 'ta').clean).toBe(true);
	});

	it('ignores Tamil combining marks, the zero-width joiners and Tamil digits', () => {
		const clean = [
			'கா', // vowel sign
			'ஸ்ரீ', // virama
			'கொண்டு',
			'தமிழ்\u200cநாடு',
			'தமிழ்\u200dநாடு',
			'௧௨௩',
			'நாளைக்கு காலை',
		];
		for (const text of clean) {
			expect(checkReplyScript(text, 'ta').clean).toBe(true);
		}
	});

	it('ignores markdown, quotes and dashes', () => {
		const clean = [
			'**Send the invoice to ABC** — இன்னும் pending',
			'- **Today, 9:02 pm** — Pay the plumber',
			'"Pay the plumber" — Call Kumar',
			"it's fine, don't worry",
		];
		for (const text of clean) expect(checkReplyScript(text, 'ta').clean).toBe(true);
	});
});

// ─── Language handling ──────────────────────────────────────────────────────

describe('the expected script comes from the language', () => {
	it('allows Tamil and Latin for Tamil, in every spelling of the code', () => {
		for (const language of ['ta', 'ta-IN', 'ta_IN', 'TA', 'tamil', 'tanglish', 'Tanglish']) {
			expect(allowedScriptsForLanguage(language)).toEqual(['Latin', 'Tamil']);
			expect(checkReplyScript('நாளைக்கு காலை client-க்கு call', language).clean).toBe(true);
			expect(checkReplyScript('நாளைக்கு காலை न call', language).clean).toBe(false);
		}
	});

	it('allows Latin only for English', () => {
		for (const language of ['en', 'en-IN', 'en_IN', 'EN', 'english']) {
			expect(allowedScriptsForLanguage(language)).toEqual(['Latin']);
			expect(checkReplyScript('Done. I will call the client.', language).clean).toBe(true);
			expect(checkReplyScript('Done. I will call the मिनिट.', language).clean).toBe(false);
		}
	});

	it('knows the script of the other languages the product ships', () => {
		expect(checkReplyScript('यह काम आज पूरा होगा', 'hi').clean).toBe(true);
		expect(checkReplyScript('यह काम आज పూర్తవుతుంది', 'hi').clean).toBe(false);
		expect(checkReplyScript('ഇത് ഇന്ന് പൂർത്തിയാകും', 'ml').clean).toBe(true);
		expect(checkReplyScript('ಇದು ಇಂದು ಮುಗಿಯುತ್ತದೆ', 'kn').clean).toBe(true);
		expect(checkReplyScript('ఇది ఈ రోజు పూర్తవుతుంది', 'te').clean).toBe(true);
	});

	it('fails open for a language whose script nobody has verified here', () => {
		// A check that guesses the script for an unknown language would flag correct
		// replies, and a validator that cries wolf is worse than none.
		expect(allowedScriptsForLanguage(undefined)).toBeNull();
		expect(allowedScriptsForLanguage('auto')).toBeNull();
		expect(allowedScriptsForLanguage('zz')).toBeNull();
		expect(checkReplyScript(MEASURED_TANGLISH_QUERY, 'auto').clean).toBe(true);
		expect(checkReplyScript(MEASURED_TANGLISH_QUERY, undefined).clean).toBe(true);
	});

	it('treats an empty reply as clean for every language', () => {
		for (const language of ['ta', 'en', 'auto', undefined]) {
			expect(checkReplyScript('', language)).toEqual({ clean: true, violations: [] });
		}
	});
});

// ─── The metric line ────────────────────────────────────────────────────────

describe('summarizeScriptViolations', () => {
	it('is undefined when there is nothing to log', () => {
		expect(summarizeScriptViolations([])).toBeUndefined();
		expect(summarizeScriptViolations(checkReplyScript('நாளைக்கு காலை', 'ta').violations)).toBeUndefined();
	});

	it('names the scripts, the letters, the combining marks and the first offender', () => {
		const { violations } = checkReplyScript('நாளைக்கு காலை न பண்ணனும்', 'ta');

		expect(summarizeScriptViolations(violations)).toBe(
			'1 code point from another writing system (Devanagari 1); 1 letter, 0 combining marks; first U+0928 Devanagari at 14',
		);
	});

	it('summarises the measured reply with its two definitions intact', () => {
		const { violations } = checkReplyScript(MEASURED_TANGLISH_QUERY, 'tanglish');
		const line = summarizeScriptViolations(violations);

		expect(line).toContain('99 code points');
		expect(line).toContain('Malayalam 93, Devanagari 5, Bengali 1');
		expect(line).toContain('54 letters, 45 combining marks');
		expect(line).toContain('first U+0D28 Malayalam at 161');
	});

	it('exports a corrective instruction the wiring can send back to the model', () => {
		expect(SCRIPT_MISMATCH_CORRECTION).toMatch(/writing system/i);
		expect(SCRIPT_MISMATCH_CORRECTION.length).toBeGreaterThan(80);
	});
});

// ─── Cheap enough to run on every spoken turn ───────────────────────────────

describe('cost', () => {
	it('checks the 402-character measured reply a thousand times well inside a turn', () => {
		const startedAt = performance.now();
		for (let i = 0; i < 1000; i++) checkReplyScript(MEASURED_TANGLISH_QUERY, 'tanglish');
		const elapsed = performance.now() - startedAt;

		// The reply is dirty, so this loop also pays for naming 99 scripts each time.
		// A regression that rebuilt a RegExp per character, or scanned with a
		// backtracking pattern, would not finish anywhere near this bound.
		expect(elapsed).toBeLessThan(3000);
	});
});
