/**
 * NOVA API — Realtime STT provider factory.
 *
 * Routing mirrors the REST voice route (`routes/voice.ts`): English → Deepgram,
 * Indian languages → Sarvam. `auto` also goes to Sarvam, whose `unknown`
 * language code performs auto-detection across en-IN plus the Indic languages.
 */
import { createDeepgramStt } from './deepgram.js';
import { createSarvamStt } from './sarvam.js';
import { resolveSttProvider } from './types.js';
import type { SttOptions, SttProviderName, SttSession } from './types.js';

export function createSttSession(options: SttOptions): SttSession {
	const provider: SttProviderName = resolveSttProvider(options.language);
	return provider === 'deepgram' ? createDeepgramStt(options) : createSarvamStt(options);
}

export { resolveSttProvider };
export type { SttHandlers, SttOptions, SttProviderName, SttSession } from './types.js';
