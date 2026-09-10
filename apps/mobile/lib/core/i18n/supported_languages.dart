/// NOVA mobile — supported Indian languages (mirror of packages/shared-types/src/languages.ts).
///
/// 22 Indian languages + English, with mixed-language detection and
/// provider routing metadata. Any change here must be reflected in the
/// shared-types TypeScript module so server and client agree.

/// Provider identifiers used by the voice pipeline.
enum VoiceProvider { elevenlabs, sarvam, google, azure }

enum SttProvider { deepgram, sarvam, google, azure }

class SupportedLanguage {
 final String code;
  final String name;
 final String nativeName;
 final VoiceProvider voiceProvider;
 final SttProvider sttProvider;

 const SupportedLanguage({
 required this.code,
 required this.name,
 required this.nativeName,
 required this.voiceProvider,
 required this.sttProvider,
  });
}

/// Canonical list. The 22 Indian languages covered by the 8th Schedule
/// of the Indian Constitution + English.
const List<SupportedLanguage> kSupportedLanguages = <SupportedLanguage>[
 SupportedLanguage(
 code: 'en',
 name: 'English',
 nativeName: 'English',
 voiceProvider: VoiceProvider.elevenlabs,
  sttProvider: SttProvider.deepgram,
  ),
 SupportedLanguage(
 code: 'hi',
 name: 'Hindi',
 nativeName: 'हिंदी',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
 ),
 SupportedLanguage(
 code: 'ta',
 name: 'Tamil',
 nativeName: 'தமிழ்',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
 ),
 SupportedLanguage(
 code: 'te',
 name: 'Telugu',
  nativeName: 'తెలుగు',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
 ),
 SupportedLanguage(
 code: 'kn',
 name: 'Kannada',
 nativeName: 'ಕನ್ನಡ',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
 ),
 SupportedLanguage(
 code: 'ml',
 name: 'Malayalam',
 nativeName: 'മലയാളം',
  voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
  ),
 SupportedLanguage(
 code: 'mr',
 name: 'Marathi',
 nativeName: 'मराठी',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
 ),
 SupportedLanguage(
 code: 'bn',
 name: 'Bengali',
 nativeName: 'বাংলা',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
 ),
 SupportedLanguage(
 code: 'gu',
 name: 'Gujarati',
 nativeName: 'ગુજરાતી',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
 ),
 SupportedLanguage(
 code: 'pa',
 name: 'Punjabi',
 nativeName: 'ਪੰਜਾਬੀ',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
 ),
 SupportedLanguage(
 code: 'ur',
 name: 'Urdu',
 nativeName: 'اردو',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
  ),
 SupportedLanguage(
 code: 'or',
 name: 'Odia',
 nativeName: 'ଓଡ଼ିଆ',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
  ),
 SupportedLanguage(
 code: 'as',
  name: 'Assamese',
 nativeName: 'অসমীয়া',
 voiceProvider: VoiceProvider.google,
 sttProvider: SttProvider.google,
 ),
 SupportedLanguage(
  code: 'mai',
 name: 'Maithili',
 nativeName: 'मैथिली',
 voiceProvider: VoiceProvider.google,
 sttProvider: SttProvider.google,
 ),
  SupportedLanguage(
 code: 'sa',
 name: 'Sanskrit',
 nativeName: 'संस्कृतम्',
 voiceProvider: VoiceProvider.google,
 sttProvider: SttProvider.google,
 ),
 SupportedLanguage(
 code: 'ne',
 name: 'Nepali',
 nativeName: 'नेपाली',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
  ),
 SupportedLanguage(
 code: 'sd',
 name: 'Sindhi',
 nativeName: 'سنڌي',
 voiceProvider: VoiceProvider.google,
 sttProvider: SttProvider.google,
 ),
 SupportedLanguage(
  code: 'ks',
 name: 'Kashmiri',
 nativeName: 'कॉशुर',
 voiceProvider: VoiceProvider.google,
 sttProvider: SttProvider.google,
 ),
 SupportedLanguage(
 code: 'doi',
 name: 'Dogri',
 nativeName: 'डोगरी',
 voiceProvider: VoiceProvider.google,
 sttProvider: SttProvider.google,
 ),
 SupportedLanguage(
 code: 'mni',
 name: 'Manipuri',
 nativeName: 'মৈতৈলোন্',
 voiceProvider: VoiceProvider.google,
 sttProvider: SttProvider.google,
 ),
 SupportedLanguage(
 code: 'bho',
 name: 'Bhojpuri',
 nativeName: 'भोजपुरी',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
 ),
 SupportedLanguage(
 code: 'awa',
 name: 'Awadhi',
 nativeName: 'अवधी',
 voiceProvider: VoiceProvider.sarvam,
 sttProvider: SttProvider.sarvam,
 ),
];

/// Union of all valid language codes.
typedef LanguageCode = String;

/// Subset of [LanguageCode] values that represent mixed-language text.
enum MixedLanguageCode { hinglish, tanglish, benglish, gujlish }

class LanguageDetectionResult {
 final String code;
 final double confidence;
 final bool isMixed;
 final String primary;

 const LanguageDetectionResult({
 required this.code,
 required this.confidence,
 required this.isMixed,
 required this.primary,
 });
}

// ─── Unicode script regexes (mirror of shared-types) ──────────────────

final RegExp _devanagari = RegExp(r'[ऀ-ॿ]');
final RegExp _tamil = RegExp(r'[஀-௿]');
final RegExp _telugu = RegExp(r'[ఀ-౿]');
final RegExp _kannada = RegExp(r'[ಀ-೿]');
final RegExp _malayalam = RegExp(r'[ഀ-ൿ]');
final RegExp _bengali = RegExp(r'[ঀ-৿]');
final RegExp _gujarati = RegExp(r'[઀-૿]');
final RegExp _gurmukhi = RegExp(r'[਀-੿]');
final RegExp _urdu = RegExp(r'[؀-ۿ]');
final RegExp _oriya = RegExp(r'[଀-୿]');

final RegExp _hinglishKw = RegExp(
 r'\b(na|hai|tha|kya|kaise|kyun|mat|bhai|didi|ji|nahi|toh|aur|par|lekin|bas|thoda|jaldi|kal|aaj|abhi)\b',
 caseSensitive: false,
);
final RegExp _tanglishKw = RegExp(
 r'\b(enna|illa|vandhuten|seri|apo|paathu|sollu|varava|pannu|thungu|kaasu|vettu|vaalthukal)\b',
 caseSensitive: false,
);
final RegExp _benglishKw = RegExp(
 r'\b(ki|ache|kore|kono|na|achhe|thik|bhalo|kemon|ache)\b',
 caseSensitive: false,
);
final RegExp _guenglishKw = RegExp(
 r'\b(kem|shu|kya|karo|nathi|have|thi|bhai)\b',
 caseSensitive: false,
);

final RegExp _latinWord = RegExp(r'[a-zA-Z]{2,}');

/// Look up a language entry by its [code]. Returns null if not found.
SupportedLanguage? getLanguageByCode(String code) {
 for (final l in kSupportedLanguages) {
 if (l.code == code) return l;
 }
 return null;
}

/// Return the voice provider that should service the given [code].
VoiceProvider getVoiceProviderForLanguage(String code) {
 final lang = getLanguageByCode(code);
  return lang?.voiceProvider ?? VoiceProvider.elevenlabs;
}

/// Return the STT provider that should service the given [code].
SttProvider getSttProviderForLanguage(String code) {
 final lang = getLanguageByCode(code);
 return lang?.sttProvider ?? SttProvider.deepgram;
}

/// Return a human-friendly name for the given [code] in the format
/// "Native (English)".
String getLanguageName(String code) {
 final lang = getLanguageByCode(code);
 if (lang != null) return '${lang.nativeName} (${lang.name})';
  switch (code) {
 case 'hinglish':
 return 'Hinglish (हिंग्लिश)';
 case 'tanglish':
 return 'Tanglish (தங்கிலிஷ்)';
 case 'benglish':
 return 'Benglish (বেঙ্গলিশ)';
 case 'gujlish':
 return 'Gujlish (ગુજલિશ)';
 }
 return code;
}

/// Detect whether [text] is a mixed-language string.
/// Returns the matching [MixedLanguageCode] or null if it's pure.
MixedLanguageCode? detectMixedLanguage(String text) {
 // Tanglish: Tamil keywords or Tamil script + English
 if (_tanglishKw.hasMatch(text) ||
 (_tamil.hasMatch(text) && _latinWord.hasMatch(text))) {
 return MixedLanguageCode.tanglish;
 }

 // Hinglish: Hinglish keywords or Devanagari + English
 if (_hinglishKw.hasMatch(text) ||
 (_devanagari.hasMatch(text) && _latinWord.hasMatch(text))) {
 return MixedLanguageCode.hinglish;
 }

 // Benglish: Bengali keywords or Bengali script + English
  if (_benglishKw.hasMatch(text) ||
 (_bengali.hasMatch(text) && _latinWord.hasMatch(text))) {
 return MixedLanguageCode.benglish;
 }

 // Gujlish: Gujarati keywords or Gujarati script + English
 if (_guenglishKw.hasMatch(text) ||
 (_gujarati.hasMatch(text) && _latinWord.hasMatch(text))) {
 return MixedLanguageCode.gujlish;
 }

 return null;
}

String? _detectScript(String text) {
 if (_devanagari.hasMatch(text)) return 'hi';
 if (_tamil.hasMatch(text)) return 'ta';
 if (_telugu.hasMatch(text)) return 'te';
  if (_kannada.hasMatch(text)) return 'kn';
 if (_malayalam.hasMatch(text)) return 'ml';
 if (_bengali.hasMatch(text)) {
 if (RegExp(r'অসমীয়া|অসম|নেপাল', caseSensitive: false).hasMatch(text)) {
 return 'as';
 }
  return 'bn';
 }
 if (_gujarati.hasMatch(text)) return 'gu';
 if (_gurmukhi.hasMatch(text)) return 'pa';
 if (_urdu.hasMatch(text)) return 'ur';
 if (_oriya.hasMatch(text)) return 'or';
  return null;
}

/// Detect the language of [text], returning a [LanguageDetectionResult].
LanguageDetectionResult detectLanguage(String text) {
 // Step 1: mixed-language check
 final mixed = detectMixedLanguage(text);
  if (mixed != null) {
 String primary = 'en';
 switch (mixed) {
 case MixedLanguageCode.hinglish:
 primary = 'hi';
 break;
 case MixedLanguageCode.tanglish:
 primary = 'ta';
 break;
 case MixedLanguageCode.benglish:
 primary = 'bn';
 break;
 case MixedLanguageCode.gujlish:
 primary = 'gu';
 break;
  }
 return LanguageDetectionResult(
 code: mixed.name,
 confidence: 0.85,
 isMixed: true,
 primary: primary,
 );
 }

 // Step 2: script-based detection
 final scriptLang = _detectScript(text);
 if (scriptLang != null) {
 return LanguageDetectionResult(
 code: scriptLang,
 confidence: 0.95,
 isMixed: false,
 primary: scriptLang,
 );
 }

  // Step 3: default English
 return const LanguageDetectionResult(
 code: 'en',
 confidence: 0.7,
 isMixed: false,
  primary: 'en',
 );
}
