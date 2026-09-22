/**
 * `eleven_flash_v2_5` has no voice for Urdu or Nepali, and asking it for them
 * produced audio that read the script in English phonetics. Measured against the
 * account's `/v1/models` on 2026-09-23: Flash covers 32 languages, `eleven_v3`
 * covers 74, and `ur` and `ne` are in v3 and absent from Flash.
 *
 * `eleven_v3` is the costlier model, so only the languages Flash cannot speak are
 * routed to it — a table that would silently grow the bill if it were wrong.
 */
import { describe, it, expect } from 'vitest';

import { ELEVENLABS_V3_ONLY_LANGUAGES } from '../services/ai.js';

describe('ElevenLabs language routing', () => {
	it('routes the languages Flash has no voice for', () => {
		// Verified against the account's own model list.
		expect(ELEVENLABS_V3_ONLY_LANGUAGES.ur).toBe('ur');
		expect(ELEVENLABS_V3_ONLY_LANGUAGES.ne).toBe('ne');
	});

	it('does NOT route languages Flash already speaks', () => {
		// These work today on Flash, which is cheaper and lower-latency. Routing
		// them to v3 would be an unmeasured cost with no measured benefit.
		for (const code of ['hi', 'ta', 'en']) {
			expect(ELEVENLABS_V3_ONLY_LANGUAGES[code]).toBeUndefined();
		}
	});

	it('leaves the languages no model has a voice for alone', () => {
		// Bhojpuri, Awadhi and Kashmiri are in neither Flash nor v3. Listing them
		// would send a language_code v3 rejects, turning audio into an error.
		for (const code of ['bho', 'awa', 'ks']) {
			expect(ELEVENLABS_V3_ONLY_LANGUAGES[code]).toBeUndefined();
		}
	});

	it('maps every entry to a language code v3 announces', () => {
		for (const [key, value] of Object.entries(ELEVENLABS_V3_ONLY_LANGUAGES)) {
			expect(value).toBe(key);
		}
	});
});
