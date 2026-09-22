/**
 * Which languages are actually *spoken*, as opposed to configured.
 *
 * `voiceProvider` records the provider that is tried, and a chain of fallbacks
 * means a language with no voice can still return audio: the request falls
 * through Sarvam, Deepgram and a Sarvam fallback and is finally served by
 * ElevenLabs' multilingual model — an English voice reading the correct script.
 *
 * Measured 2026-09-23 by reading the `provider` field of `/voice/tts` for each
 * language rather than trusting the catalogue:
 *
 *   hi  → sarvam                 ur  → elevenlabs-fallback
 *   ks  → sarvam-fallback        ne  → elevenlabs-fallback
 *                                bho → elevenlabs-fallback
 *                                awa → elevenlabs-fallback
 *
 * `ks` is *not* in the list: Google did not serve it, but the Sarvam fallback
 * did, so Kashmiri is spoken by an Indic voice even though the catalogue names a
 * provider that failed. That is a degraded route, not a wrong-language one.
 *
 * Marking these honestly is the point. The mandate is explicit that a language
 * must not be presented as supported when it is not, and a user who picks Urdu
 * and hears English has been misled by the picker, not by the model.
 */
import { describe, it, expect } from 'vitest';
import { SUPPORTED_LANGUAGES, VOICE_FALLBACK_CODES, isVoiceFallback } from '@nova/shared-types';

describe('languages whose voice is a fallback', () => {
	it('flags exactly the languages measured as English-voiced', () => {
		expect([...VOICE_FALLBACK_CODES].sort()).toEqual(['awa', 'bho', 'ne']);
	});

	it('does not flag a language that a provider genuinely serves', () => {
		for (const code of ['hi', 'ta', 'te', 'kn', 'bn', 'ml', 'mr', 'gu', 'pa', 'en']) {
			expect(isVoiceFallback(code), code).toBe(false);
		}
	});

	it('does not flag Kashmiri, which the Sarvam fallback does speak', () => {
		// Google fails for ks, but the fallback serves it with an Indic voice. It is
		// a degraded route, not one that reads the wrong language aloud.
		expect(isVoiceFallback('ks')).toBe(false);
	});

	it('marks the flag only inside the catalogue', () => {
		for (const language of SUPPORTED_LANGUAGES) {
			expect(typeof language.code).toBe('string');
			if (language.voiceFallback) expect(isVoiceFallback(language.code)).toBe(true);
		}
	});
});
