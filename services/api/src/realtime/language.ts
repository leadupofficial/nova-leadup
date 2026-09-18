/**
 * NOVA API — language normalisation for the realtime voice socket.
 *
 * The client sends bare ISO codes (`en`, `ta`, `hi`), `auto`, or occasionally a
 * region-tagged code. Providers want different spellings, so the session keeps
 * one canonical bare code and each provider layer translates it.
 */
import {
	SUPPORTED_LANGUAGES,
	type LanguageCode,
	type MixedLanguageCode,
} from '@nova/shared-types';
import { DEFAULT_LANGUAGE } from './protocol.js';

/** Mixed-language pseudo-codes the app supports on top of the 22 languages. */
export const MIXED_CODES: MixedLanguageCode[] = ['hinglish', 'tanglish', 'benglish', 'gujlish'];

/** `ta-IN` → `ta`, `EN` → `en`, missing/empty → the default. */
export function normalizeLanguage(value: string | undefined): string {
	const bare = (value || DEFAULT_LANGUAGE).trim().toLowerCase();
	if (!bare) return DEFAULT_LANGUAGE;
	if (bare === 'auto') return 'auto';
	if (bare.includes('-')) return bare.split('-')[0];
	return bare;
}

export function isSupportedLanguage(code: string): boolean {
	if (code === 'auto') return true;
	if (MIXED_CODES.includes(code as MixedLanguageCode)) return true;
	return SUPPORTED_LANGUAGES.some((l) => l.code === code);
}

export type { LanguageCode, MixedLanguageCode };
