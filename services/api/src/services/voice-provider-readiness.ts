/**
 * Which voice providers the catalogue routes to but this deployment cannot reach.
 *
 * `SUPPORTED_LANGUAGES` names a provider per language, and the catalogue is right
 * to name the *best* one — Google serves Urdu and Nepali natively, and a
 * deployment that can pay for it should use it. But a missing credential is
 * invisible at runtime: `synthesizeSpeechGoogle` throws, `routes/voice.ts` walks
 * its fallback chain, and the user simply gets a different voice. Nobody is told.
 *
 * Measured 2026-09-23: `GOOGLE_CLOUD_API_KEY` was not set while Sarvam,
 * ElevenLabs and Deepgram were, so **seven** languages fell through the chain —
 * and for four of them (`ur`, `ne`, `bho`, `awa`) the chain ends at ElevenLabs'
 * multilingual model, which reads them aloud in English. A third of the
 * catalogue was degrading with no signal anywhere.
 *
 * This turns that into one line at boot. It does not change routing: if the key
 * is added, the catalogue is already correct.
 */
import { SUPPORTED_LANGUAGES } from '@nova/shared-types';

/** The credential each voice provider needs, as the deployment names it. */
export const VOICE_PROVIDER_CREDENTIALS: Record<string, string> = {
	sarvam: 'SARVAM_API_KEY',
	elevenlabs: 'ELEVENLABS_API_KEY',
	google: 'GOOGLE_CLOUD_API_KEY',
	azure: 'AZURE_SPEECH_KEY',
};

export interface VoiceProviderGap {
	readonly provider: string;
	readonly envVar: string;
	/** Languages the catalogue routes to this provider. */
	readonly languages: string[];
}

/**
 * Providers the catalogue uses that have no credential, with the languages
 * affected. Empty when every routed provider is configured.
 */
export function voiceProviderGaps(
	env: Record<string, string | undefined> = process.env,
): VoiceProviderGap[] {
	const byProvider = new Map<string, string[]>();
	for (const language of SUPPORTED_LANGUAGES) {
		const provider = language.voiceProvider;
		const list = byProvider.get(provider) ?? [];
		list.push(language.code);
		byProvider.set(provider, list);
	}

	const gaps: VoiceProviderGap[] = [];
	for (const [provider, languages] of byProvider) {
		const envVar = VOICE_PROVIDER_CREDENTIALS[provider];
		// An unknown provider is not reported here: the catalogue is the authority
		// on what it routes to, and inventing a credential name for it would be a
		// guess.
		if (!envVar) continue;
		const value = env[envVar];
		if (value && value.trim().length > 0) continue;
		gaps.push({ provider, envVar, languages });
	}
	return gaps;
}

/** One line per missing provider, ready to log. */
export function voiceProviderGapWarnings(
	env: Record<string, string | undefined> = process.env,
): string[] {
	return voiceProviderGaps(env).map(
		(gap) =>
			`Voice provider "${gap.provider}" is routed for ${gap.languages.length} language(s) ` +
			`[${gap.languages.join(', ')}] but ${gap.envVar} is not set — every one of them will ` +
			'fall through the TTS chain to whichever provider is configured.',
	);
}
