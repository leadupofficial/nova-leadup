/**
 * NOVA API — did the user's own turn state a clock time?
 *
 * This module exists because the model invented an hour the user never gave, and
 * a prompt asking it not to was not enough. Measured in a live §31 run: the user
 * said only *"tomorrow I need to finish the website proposal and call the
 * client"*, NOVA answered *"Both tasks are set for tomorrow by six o'clock in
 * the evening"*, and both rows were written with `due_at` 18:00 IST. A time in
 * the database is indistinguishable from a time the user did give, so the claim
 * and the row reinforce each other and neither can be told apart afterwards.
 *
 * The distinction this file makes is the load-bearing one:
 *
 *   * a **day** is not a time — "tomorrow", "Wednesday", "22/09";
 *   * a **count** is not a time — "2 tasks", "5 reminders", "call Kumar 2";
 *   * a **part of the day** is not an hour — "morning", "காலை";
 *   * a **clock time** is — "6pm", "18:00", "half past nine", "9 மணிக்கு".
 *
 * It reads the user's words only. Deciding whether the *model's* date-time
 * carries an hour is the other half of the same question and is answered by
 * `clockTimeInDateTime`, so both sides of the comparison live in one place.
 *
 * Everything here is pure: no clock, no database, no prompt.
 */

/** What the user's own words said about when. */
export type StatedTimeKind = 'clock_time' | 'part_of_day' | 'none';

export interface StatedTime {
	kind: StatedTimeKind;
	/**
	 * The exact words that decided it, so a refusal can name what the user
	 * actually said rather than paraphrasing it. Empty when `kind` is `none`.
	 */
	evidence: string;
}

/**
 * A number that is really a duration or a count, not an hour.
 *
 * Only the preposition-anchored bare hour needs this ("at 6" is a time, "after 3
 * days" is not), but it is applied there because that is the one pattern whose
 * hour could otherwise come from an ordinary count.
 */
const NOT_AN_HOUR =
	'(?!\\s*(?:st|nd|rd|th|days?|hours?|hrs?|minutes?|mins?|weeks?|months?|years?|tasks?|items?|reminders?|times?|people|things?)\\b)';

const HOUR_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';

/**
 * The word for "o'clock" in the Indian languages NOVA can actually transcribe.
 *
 * This list is load-bearing, not decoration. Sarvam returns a Hindi turn as
 * "कल सुबह 8 बजे का रिमाइंडर लगा दो", and while "बजे" was absent the hour was
 * invisible to `statedTimeIn`: the user *had* named a time, the guard read the
 * turn as naming none, and it refused the model's correct `trigger_at` as an
 * invention. Measured on a real handset on 2026-09-22, `create_reminder` failed
 * on every Hindi, Telugu, Kannada and Bengali turn for exactly this reason —
 * three times each, to the iteration cap — while Tamil succeeded. A guard that
 * reads only English and Tamil does not protect other-language users from
 * invented times; it stops them setting reminders at all, and the reminder they
 * asked for is the one thing they came for.
 */
const CLOCK_MARKERS_INDIC = [
	// Hindi / Urdu
	'बजे', 'बजकर', 'بجے',
	// Bengali / Assamese
	'টায়', 'টার', 'টা', 'বজে', 'বাজে',
	// Tamil
	'மணிக்கு', 'மணி',
	// Telugu
	'గంటలకు', 'గంటకు', 'గంటలకి',
	// Kannada
	'ಗಂಟೆಗೆ', 'ಗಂಟೆಗೂ', 'ಗಂಟೆ',
	// Malayalam
	'മണിക്ക്', 'മണി',
	// Marathi
	'वाजता', 'वाजून',
	// Gujarati
	'વાગ્યે', 'વાગ્યા',
	// Punjabi
	'ਵਜੇ', 'ਵਜਕੇ',
	// Odia
	'ଟାରେ', 'ଟା',
];

/** The same marker in Latin script, which is how Hinglish/Tanglish is typed. */
const CLOCK_MARKERS_LATIN = [
	'baje', 'bajey', 'bajkar', 'vaje', 'vagye', 'vajata', 'manikku', 'mani',
];

/**
 * A part of the day, in the same languages.
 *
 * English and the Latin transliterations are separated from the Indic scripts
 * because the ASCII half wants `\b` and the other half must not have it: `\b` is
 * defined over ASCII word characters, so it anchors on nothing inside Devanagari
 * or Tamil and would quietly disable the whole alternation.
 */
const PART_OF_DAY_ASCII = [
	'morning', 'afternoon', 'evening', 'night', 'tonight',
	'subah', 'dopahar', 'shaam', 'sham', 'raat', 'raathiri', 'rathiri',
	'kaalai', 'maalai', 'iravu', 'madhiyam',
];

const PART_OF_DAY_INDIC = [
	// Hindi / Urdu
	'सुबह', 'दोपहर', 'शाम', 'रात', 'صبح', 'شام', 'رات',
	// Bengali / Assamese
	'সকাল', 'দুপুর', 'বিকাল', 'বিকেল', 'সন্ধ্যা', 'রাত',
	// Tamil
	'காலை', 'மாலை', 'இரவு', 'மதியம்', 'அதிகாலை', 'நண்பகல்',
	// Telugu
	'ఉదయం', 'మధ్యాహ్నం', 'సాయంత్రం', 'రాత్రి',
	// Kannada
	'ಬೆಳಿಗ್ಗೆ', 'ಮಧ್ಯಾಹ್ನ', 'ಸಂಜೆ', 'ರಾತ್ರಿ',
	// Malayalam
	'രാവിലെ', 'ഉച്ചയ്ക്ക്', 'വൈകുന്നേരം', 'രാത്രി',
	// Marathi
	'सकाळ', 'दुपार', 'संध्याकाळ', 'रात्र', 'पहाट',
	// Gujarati
	'સવારે', 'બપોરે', 'સાંજે', 'રાત્રે',
	// Punjabi
	'ਸਵੇਰੇ', 'ਦੁਪਹਿਰ', 'ਸ਼ਾਮ', 'ਰਾਤ',
	// Odia
	'ସକାଳ', 'ଅପରାହ୍ନ', 'ସନ୍ଧ୍ୟା', 'ରାତି',
];

/**
 * The ways a turn states a clock time. Group 1 is the evidence, so a refusal can
 * quote it.
 *
 * Ordered most explicit first; the first pattern to match wins, which is why
 * "tomorrow morning at 9" is a clock time and not a part of the day.
 */
const CLOCK_TIME_PATTERNS: RegExp[] = [
	// 18:00, 10:30, 9:05, and the time half of an ISO stamp ("…T12:30:00").
	// The hour must not itself be the tail of a longer run of digits (which is
	// what keeps a phone number out), and the minutes must not start one.
	/(?:^|[^\d:])((?:[01]?\d|2[0-4]):[0-5]\d)(?!\d)/,
	// 6pm, 6 pm, 6:30 p.m., 10 a.m., 6.30pm.
	/\b((?:1[0-2]|0?[1-9])(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))(?!\w)/i,
	// "half past nine", "quarter to seven".
	new RegExp(`\\b((?:half|quarter)\\s+(?:past|to)\\s+(?:${HOUR_WORDS}))\\b`, 'i'),
	// "7 o'clock", "seven o'clock" — the apostrophe is typed both ways.
	/\b((?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*o['’]?clock)\b/i,
	// Tamil: "9 மணிக்கு", "ஒரு மணிக்கு". `\b` is deliberately absent — it is
	// defined over ASCII word characters, so it would anchor on nothing here.
	/((?:\d{1,2}|ஒரு|இரண்டு|ரெண்டு|மூன்று|மூணு|நான்கு|நாலு|ஐந்து|அஞ்சு|ஆறு|ஏழு|எட்டு|ஒன்பது|ஒம்பது|பத்து|பதினொரு|பன்னிரண்டு)\s*மணி[\p{L}\p{M}]*)/u,
	// Tanglish: "9 manikku", "7 mani".
	/\b(\d{1,2}\s*mani(?:kku|ku)?)\b/i,
	// Every other Indian language's "o'clock": an hour — a digit, or a number
	// word such as Telugu "ఎనిమిది" — followed by that language's marker. No
	// `\b`, for the reason given on the Tamil pattern above. The hour may be a
	// word rather than a digit because Sarvam returns "ఎనిమిది గంటలకు" for
	// "eight o'clock" and "8 ಗಂಟೆಗೆ" for the same thing in Kannada.
	new RegExp(
		`((?:\\d{1,2}|[\\p{L}\\p{M}]{2,})\\s*(?:${CLOCK_MARKERS_INDIC.join('|')}))`,
		'u',
	),
	// The same markers typed in Latin script — "8 baje", "saat vaje".
	new RegExp(
		`\\b((?:\\d{1,2}|${HOUR_WORDS})\\s*(?:${CLOCK_MARKERS_LATIN.join('|')}))\\b`,
		'i',
	),
	// Tamil writes the English word phonetically, so a Tamil transcript of
	// "eight o'clock" arrives as "8 ஓ கிளாக்" and matches neither "மணி" nor
	// "manikku". Refusing that turn is refusing a time the user did state.
	/((?:\d{1,2}|[\p{L}\p{M}]{2,})\s*(?:ஓ\s*கிளாக்|ஓ['’]?\s*க்ளாக்|ஓ\s*க்ளாக்))/u,
	// A bare hour anchored by a time preposition — "at 6", "by 7", "around 8" —
	// which is how "remind me at 7" is actually spoken. The lookahead is what
	// keeps "at 3 days" a duration and "add 2 tasks" a count.
	new RegExp(`\\b((?:at|by|around)\\s+(?:1[0-2]|0?[1-9]))(?!\\d)${NOT_AN_HOUR}`, 'i'),
	new RegExp(`\\b((?:at|by|around)\\s+(?:${HOUR_WORDS}))${NOT_AN_HOUR}`, 'i'),
	// Each of these names one hour exactly, so they are times rather than parts
	// of the day — and refusing them would refuse a time the user did state.
	/\b(noon|midday|midnight)\b/i,
];

/**
 * The ways a turn names a part of the day without naming an hour.
 *
 * A part of the day narrows *when* but not *what time*, and nothing in NOVA
 * stores which hour it means for a given user — so an hour supplied against one
 * of these is as invented as an hour supplied against a bare day.
 */
const PART_OF_DAY_PATTERNS: RegExp[] = [
	new RegExp(`\\b(${PART_OF_DAY_ASCII.join('|')})\\b`, 'i'),
	// Every other language's part of the day, again without `\b`.
	new RegExp(`(${PART_OF_DAY_INDIC.join('|')})`, 'u'),
];

/** The evidence of the first pattern that matches, or null. */
function firstMatch(patterns: RegExp[], text: string): string | null {
	for (const pattern of patterns) {
		const match = pattern.exec(text);
		// `match[1]` is the time expression itself; the fallback covers a pattern
		// that ever grows without a capture group.
		if (match) return match[1] ?? match[0];
	}
	return null;
}

/**
 * What the user's own turn stated: a clock time, a part of the day, or neither.
 *
 * A clock time wins over a part of the day when the turn has both, because the
 * hour *was* given — "tomorrow morning at 9" is refuse-nothing.
 */
export function statedTimeIn(turn: string | null | undefined): StatedTime {
	const text = typeof turn === 'string' ? turn : '';

	const clock = firstMatch(CLOCK_TIME_PATTERNS, text);
	if (clock) return { kind: 'clock_time', evidence: clock };

	const partOfDay = firstMatch(PART_OF_DAY_PATTERNS, text);
	if (partOfDay) return { kind: 'part_of_day', evidence: partOfDay };

	return { kind: 'none', evidence: '' };
}

/**
 * The hour inside a date-time the model sent, or null when it sent a date only.
 *
 * This is deliberately about the *shape of the string*, not about the instant it
 * resolves to. `parseDateTime` reads a bare date as midnight, so "midnight" is
 * not evidence that the user gave a time: a date on its own is exactly the
 * "leave it unset" the guard asks for, and treating its midnight as an hour
 * would make every such record refusable.
 */
export function clockTimeInDateTime(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	const match = /[t ](\d{1,2}(?::\d{2})?)/i.exec(value);
	return match ? match[1] : null;
}
