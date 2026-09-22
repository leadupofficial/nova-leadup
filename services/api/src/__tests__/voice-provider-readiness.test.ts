/**
 * A voice provider the catalogue routes to but this deployment cannot reach is
 * otherwise invisible: `synthesizeSpeechGoogle` throws, `routes/voice.ts` walks
 * its fallback chain, and the user simply hears a different voice.
 *
 * Measured 2026-09-23: `GOOGLE_CLOUD_API_KEY` was not set while Sarvam,
 * ElevenLabs and Deepgram were, so seven catalogue languages fell through the
 * chain — and four of them (`ur`, `ne`, `bho`, `awa`) ended at ElevenLabs'
 * multilingual model, which reads them aloud in English. A third of the
 * catalogue was degrading with nothing said anywhere.
 */
import { describe, it, expect } from 'vitest';
import { SUPPORTED_LANGUAGES } from '@nova/shared-types';

import {
	VOICE_PROVIDER_CREDENTIALS,
	voiceProviderGaps,
	voiceProviderGapWarnings,
} from '../services/voice-provider-readiness.js';

const ALL = {
	SARVAM_API_KEY: 'x',
	ELEVENLABS_API_KEY: 'x',
	GOOGLE_CLOUD_API_KEY: 'x',
	AZURE_SPEECH_KEY: 'x',
};

describe('voice provider readiness', () => {
	it('reports nothing when every routed provider has a credential', () => {
		expect(voiceProviderGaps(ALL)).toEqual([]);
	});

	it('names the provider, the env var and every affected language', () => {
		const gaps = voiceProviderGaps({ ...ALL, GOOGLE_CLOUD_API_KEY: undefined });

		expect(gaps).toHaveLength(1);
		const google = gaps[0]!;
		expect(google.provider).toBe('google');
		expect(google.envVar).toBe('GOOGLE_CLOUD_API_KEY');
		// Every language the catalogue routes to google, and only those.
		const routed = SUPPORTED_LANGUAGES.filter((l) => l.voiceProvider === 'google').map(
			(l) => l.code,
		);
		expect([...google.languages].sort()).toEqual([...routed].sort());
		expect(google.languages.length).toBeGreaterThan(0);
	});

	it('treats an empty or blank credential as missing', () => {
		expect(voiceProviderGaps({ ...ALL, SARVAM_API_KEY: '' })).toHaveLength(1);
		expect(voiceProviderGaps({ ...ALL, SARVAM_API_KEY: '   ' })).toHaveLength(1);
	});

	it('reports every gap, not just the first', () => {
		const gaps = voiceProviderGaps({ SARVAM_API_KEY: 'x' });
		const providers = gaps.map((g) => g.provider).sort();
		expect(providers).toContain('elevenlabs');
		expect(providers).toContain('google');
	});

	it('writes one line per gap naming the languages and the variable', () => {
		const lines = voiceProviderGapWarnings({ ...ALL, GOOGLE_CLOUD_API_KEY: undefined });

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('GOOGLE_CLOUD_API_KEY');
		expect(lines[0]).toContain('ur');
		expect(lines[0]).toMatch(/fall through/i);
	});

	it('maps every provider the catalogue names to a credential', () => {
		// A provider with no entry could never be reported, which is the silent
		// degradation this exists to prevent.
		for (const language of SUPPORTED_LANGUAGES) {
			expect(
				VOICE_PROVIDER_CREDENTIALS[language.voiceProvider],
				language.voiceProvider,
			).toBeTruthy();
		}
	});
});
