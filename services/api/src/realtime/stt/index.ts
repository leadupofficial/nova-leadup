/**
 * NOVA API — Realtime STT provider factory.
 *
 * Routing mirrors the REST voice route (`routes/voice.ts`): English → Deepgram,
 * Indian languages → Sarvam. `auto` also goes to Sarvam, whose `unknown`
 * language code performs auto-detection across en-IN plus the Indic languages.
 *
 * `provider` is an override used only by the controller to open a *fallback*
 * session after the routed provider rejects a turn. Normal routing never passes
 * it, so the language → provider contract above is unchanged.
 */
import { createDeepgramStt } from './deepgram.js';
import { createSarvamStt } from './sarvam.js';
import { resolveSttProvider } from './types.js';
import type { SttOptions, SttProviderName, SttSession } from './types.js';

export function createSttSession(options: SttOptions, provider?: SttProviderName): SttSession {
	const resolved: SttProviderName = provider ?? resolveSttProvider(options.language);
	return resolved === 'deepgram' ? createDeepgramStt(options) : createSarvamStt(options);
}

export { resolveSttProvider };
export type { SttHandlers, SttOptions, SttProviderName, SttSession } from './types.js';
