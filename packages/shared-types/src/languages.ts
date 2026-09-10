/**
 * @nova/shared-types — Indian Language Support
 *
 * Comprehensive language definitions for all 22 Indian languages plus
 * English, with provider routing metadata and mixed-language detection.
 */

// ─── Supported Languages ──────────────────────────────────────────────────────

export interface SupportedLanguage {
	readonly code: string;
	readonly name: string;
	readonly native: string;
	readonly voiceProvider: 'elevenlabs' | 'sarvam' | 'google' | 'azure';
	readonly sttProvider: 'deepgram' | 'sarvam' | 'google' | 'azure';
}

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
	{ code: 'en', name: 'English', native: 'English', voiceProvider: 'elevenlabs', sttProvider: 'deepgram' },
	{ code: 'hi', name: 'Hindi', native: 'हिंदी', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'ta', name: 'Tamil', native: 'தமிழ்', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'te', name: 'Telugu', native: 'తెలుగు', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'ml', name: 'Malayalam', native: 'മലയാളം', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'mr', name: 'Marathi', native: 'मराठी', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'bn', name: 'Bengali', native: 'বাংলা', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'gu', name: 'Gujarati', native: 'ગુજરાતી', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'ur', name: 'Urdu', native: 'اردو', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'or', name: 'Odia', native: 'ଓଡ଼ିଆ', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'as', name: 'Assamese', native: 'অসমীয়া', voiceProvider: 'google', sttProvider: 'google' },
	{ code: 'mai', name: 'Maithili', native: 'मैथिली', voiceProvider: 'google', sttProvider: 'google' },
	{ code: 'sa', name: 'Sanskrit', native: 'संस्कृतम्', voiceProvider: 'google', sttProvider: 'google' },
	{ code: 'ne', name: 'Nepali', native: 'नेपाली', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'sd', name: 'Sindhi', native: 'سنڌي', voiceProvider: 'google', sttProvider: 'google' },
	{ code: 'ks', name: 'Kashmiri', native: 'कॉशुर', voiceProvider: 'google', sttProvider: 'google' },
	{ code: 'doi', name: 'Dogri', native: 'डोगरी', voiceProvider: 'google', sttProvider: 'google' },
	{ code: 'mni', name: 'Manipuri', native: 'মৈতৈলোন্', voiceProvider: 'google', sttProvider: 'google' },
	{ code: 'bho', name: 'Bhojpuri', native: 'भोजपुरी', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
	{ code: 'awa', name: 'Awadhi', native: 'अवधी', voiceProvider: 'sarvam', sttProvider: 'sarvam' },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

// ─── Mixed Language Support ───────────────────────────────────────────────────

export type MixedLanguageCode = 'hinglish' | 'tanglish' | 'benglish' | 'gujlish';

export interface LanguageDetectionResult {
	readonly code: LanguageCode | MixedLanguageCode;
	readonly confidence: number;
	readonly isMixed: boolean;
	readonly primary: LanguageCode;
}

const DEVANAGARI_RANGE = /[ऀ-ॿ]/;
const TAMIL_RANGE = /[஀-௿]/;
const TELUGU_RANGE = /[ఀ-౿]/;
const KANNADA_RANGE = /[ಀ-೿]/;
const MALAYALAM_RANGE = /[ഀ-ൿ]/;
const BENGALI_RANGE = /[ঀ-৿]/;
const GUJARATI_RANGE = /[઀-૿]/;
const GURMUKHI_RANGE = /[਀-੿]/;
const URDU_RANGE = /[؀-ۿ]/;
const ORIYA_RANGE = /[଀-୿]/;
const ASSAMESE_RANGE = /[ঀ-৿]/; // overlaps Bengali — handled by context

const HINGLISH_KEYWORDS = /\b(na|hai|tha|kya|kaise|kyun|mat|bhai|didi|ji|nahi|toh|aur|par|lekin|bas|thoda|jaldi|kal|aaj|abhi)\b/i;
const TANGLISH_KEYWORDS = /\b(enna|illa|vandhuten|seri|apo|apo|paathu|sollu|varava|pannu|thungu|thooki|kaasu|vettu|vaalthukal)\b/i;
const GUENGLISH_KEYWORDS = /\b( kem|shu|kya|karo|nathi|have|thi|bhai)\b/i;
const BENGLISH_KEYWORDS = /\b(ki|ache|kore|kono|na|achhe|thik|bhalo|kemon|ache)\b/i;

const ROMAN_HINGLISH_PATTERNS = /\b(maine|karna|hai|nahi|kya|kaise|bhai|thoda|jaldi)\b/i;
const ROMAN_TANGLISH_PATTERNS = /\b(enna|illa|seri|apo|sollu|pannu|thungu)\b/i;

function detectScript(text: string): LanguageCode | null {
	if (DEVANAGARI_RANGE.test(text)) {
		// Could be Hindi, Marathi, Nepali, Sanskrit, Kashmiri, Dogri, Maithili — infer from context
		if (/\b[A-Za-z]/.test(text)) {
			// Mixed Devanagari + Latin
			if (ROMAN_HINGLISH_PATTERNS.test(text)) return 'hi';
			if (/[ऀ-ॿ]/.test(text)) return 'hi'; // default Devanagari → Hindi
		}
		return 'hi';
	}
	if (TAMIL_RANGE.test(text)) return 'ta';
	if (TELUGU_RANGE.test(text)) return 'te';
	if (KANNADA_RANGE.test(text)) return 'kn';
	if (MALAYALAM_RANGE.test(text)) return 'ml';
	if (BENGALI_RANGE.test(text) || ASSAMESE_RANGE.test(text)) {
		// Distinguish Bengali from Assamese by common words
		if (/অসমীয়া|অসম|নেপাল/i.test(text)) return 'as';
		return 'bn';
	}
	if (GUJARATI_RANGE.test(text)) return 'gu';
	if (GURMUKHI_RANGE.test(text)) return 'pa';
	if (URDU_RANGE.test(text)) return 'ur';
	if (ORIYA_RANGE.test(text)) return 'or';
	return null;
}

export function detectMixedLanguage(text: string): MixedLanguageCode | null {
	const lower = text.toLowerCase();

	// Tanglish: Tamil keywords or Tamil script + English
	if (TANGLISH_KEYWORDS.test(text) || (TAMIL_RANGE.test(text) && /[A-Za-z]{2,}/.test(text))) {
		return 'tanglish';
	}

	// Hinglish: Hinglish keywords or Devanagari + English
	if (HINGLISH_KEYWORDS.test(text) || (DEVANAGARI_RANGE.test(text) && /[A-Za-z]{2,}/.test(text))) {
		return 'hinglish';
	}

	// Benglish: Bengali keywords or Bengali script + English
	if (BENGLISH_KEYWORDS.test(text) || (BENGALI_RANGE.test(text) && /[A-Za-z]{2,}/.test(text))) {
		return 'benglish';
	}

	// Gujlish: Gujarati keywords or Gujarati script + English
	if (GUENGLISH_KEYWORDS.test(text) || (GUJARATI_RANGE.test(text) && /[A-Za-z]{2,}/.test(text))) {
		return 'gujlish';
	}

	// Romanized Hinglish / Tanglish detection (no native script)
	if (ROMAN_HINGLISH_PATTERNS.test(text) && !ROMAN_TANGLISH_PATTERNS.test(text)) {
		return 'hinglish';
	}
	if (ROMAN_TANGLISH_PATTERNS.test(text)) {
		return 'tanglish';
	}

	return null;
}

export function detectLanguage(text: string): LanguageDetectionResult {
	// Step 1: Check for mixed-language patterns
	const mixed = detectMixedLanguage(text);
	if (mixed) {
		let primary: LanguageCode = 'en';
		if (mixed === 'hinglish') primary = 'hi';
		else if (mixed === 'tanglish') primary = 'ta';
		else if (mixed === 'benglish') primary = 'bn';
		else if (mixed === 'gujlish') primary = 'gu';

		return {
			code: mixed,
			confidence: 0.85,
			isMixed: true,
			primary,
		};
	}

	// Step 2: Detect via Unicode script
	const scriptLang = detectScript(text);
	if (scriptLang) {
		return {
			code: scriptLang,
			confidence: 0.95,
			isMixed: false,
			primary: scriptLang,
		};
	}

	// Step 3: Default to English
	return {
		code: 'en',
		confidence: 0.7,
		isMixed: false,
		primary: 'en',
	};
}

// ─── Provider Routing Helpers ─────────────────────────────────────────────────

export function getLanguageByCode(code: string): SupportedLanguage | undefined {
	return SUPPORTED_LANGUAGES.find((l) => l.code === code);
}

export function getVoiceProviderForLanguage(
	language: LanguageCode | MixedLanguageCode,
): SupportedLanguage['voiceProvider'] {
	if (language === 'tanglish') return 'sarvam';
	const lang = SUPPORTED_LANGUAGES.find((l) => l.code === language);
	return lang?.voiceProvider ?? 'elevenlabs';
}

export function getSttProviderForLanguage(
	language: LanguageCode | MixedLanguageCode,
): SupportedLanguage['sttProvider'] {
	if (language === 'tanglish') return 'sarvam';
	const lang = SUPPORTED_LANGUAGES.find((l) => l.code === language);
	return lang?.sttProvider ?? 'deepgram';
}

export function getLanguageName(code: LanguageCode | MixedLanguageCode): string {
	const lang = SUPPORTED_LANGUAGES.find((l) => l.code === code);
	if (lang) return `${lang.native} (${lang.name})`;
	const mixedNames: Record<string, string> = {
		hinglish: 'Hinglish (हिंग्लिश)',
		tanglish: 'Tanglish (தங்கிலிஷ்)',
		benglish: 'Benglish (বெংগ্লিশ)',
		gujlish: 'Gujlish (ગુજલિશ)',
	};
	return mixedNames[code] ?? code;
}

export function getLanguageCodeMap(): Record<string, string> {
	const map: Record<string, string> = {};
	for (const lang of SUPPORTED_LANGUAGES) {
		map[lang.code] = lang.code;
	}
	// Mixed-language codes
	map['hinglish'] = 'hi';
	map['tanglish'] = 'ta';
	map['benglish'] = 'bn';
	map['gujlish'] = 'gu';
	return map;
}
