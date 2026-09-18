/**
 * NOVA API — Realtime STT provider contract.
 *
 * A streaming STT session is a *socket*, not a call: audio is pushed in as it
 * arrives from the client and events come back as the provider detects them.
 * Both providers are wrapped in the same small interface so the voice session
 * does not care which one is behind it.
 */
import type { LanguageCode, MixedLanguageCode } from '@nova/shared-types';
import { getSttProviderForLanguage } from '@nova/shared-types';

export type SttProviderName = 'deepgram' | 'sarvam';

export interface SttHandlers {
	/** Interim transcript — the text so far, already trimmed. */
	onPartial?: (text: string) => void;
	/** The provider decided the utterance ended; this is the turn transcript. */
	onFinal?: (text: string) => void;
	/**
	 * Provider VAD reports the user started speaking. While NOVA is producing a
	 * reply this is the authoritative barge-in cue.
	 */
	onSpeechStart?: () => void;
	onSpeechEnd?: () => void;
	onError?: (err: Error) => void;
	/**
	 * The provider socket closed. `fatal` means the code is an auth/quota/
	 * parameter problem that must not be retried blindly.
	 */
	onClose?: (code: number, reason: string, fatal: boolean) => void;
}

export interface SttSession {
	readonly provider: SttProviderName;
	readonly closed: boolean;
	sendAudio(pcm: Buffer): void;
	/** Force-finalise the buffered utterance (client pressed stop). */
	requestFinal(): void;
	/** Keep the provider socket alive while the client sends no audio. */
	keepAlive(): void;
	close(): void;
}

export interface SttOptions {
	/** Bare ISO code (`en`, `ta`) or `auto`. */
	language: string;
	sampleRate: number;
	handlers: SttHandlers;
}

/** Languages the monorepo supports, plus the mixed-code pseudo-languages. */
export type SttLanguage = LanguageCode | MixedLanguageCode;

/**
 * Pick the streaming provider for a language, mirroring the REST STT route.
 *
 * English → Deepgram. Everything else → Sarvam. `@nova/shared-types` also names
 * `google` (and `azure`) for the long-tail Indian languages, but there is no
 * streaming Google/azure STT in this service, and Sarvam's streaming model
 * catalog covers those languages, so `google`/`azure` route to Sarvam here
 * rather than to a provider that does not exist.
 *
 * `auto` → Sarvam with `language_code=unknown`, the platform's documented
 * auto-detect mode (it covers en-IN plus the 22 Indic languages). The trade-off
 * is that Sarvam's *legacy* streaming endpoint emits utterance finals only, so
 * `auto` turns get no interim transcripts; see sarvam.ts.
 */
export function resolveSttProvider(language: string): SttProviderName {
	const bare = (language || 'en').trim().toLowerCase();
	if (bare === 'auto' || bare === 'unknown') return 'sarvam';
	const provider = getSttProviderForLanguage(bare as SttLanguage);
	return provider === 'deepgram' ? 'deepgram' : 'sarvam';
}
