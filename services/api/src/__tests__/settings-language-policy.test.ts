/**
 * The persona's `languagePolicy` is what pins the assistant to a language, and it
 * is validated by one schema in `schemas/index.ts`. It used to be a hand-written
 * `['auto','en','ta','tanglish']` duplicated in two files, which refused every
 * other Indian language the voice pipeline already routes on — a user could not
 * select Hindi, Telugu or Bengali at all, and the two copies could drift.
 */
import { describe, it, expect } from 'vitest';
import { SUPPORTED_LANGUAGES, MIXED_LANGUAGE_CODES } from '@nova/shared-types';

import { LanguagePolicySchema, PersonaSchema } from '../schemas/index.js';

describe('languagePolicy', () => {
	it('accepts auto, every catalogue language, and every mixed style', () => {
		for (const code of [
			'auto',
			...SUPPORTED_LANGUAGES.map((l) => l.code),
			...MIXED_LANGUAGE_CODES,
		]) {
			expect(LanguagePolicySchema.safeParse(code).success, code).toBe(true);
		}
	});

	it('accepts the minimum language list the product spec names', () => {
		for (const code of [
			'hi',
			'bn',
			'te',
			'mr',
			'ta',
			'gu',
			'kn',
			'ml',
			'pa',
			'or',
			'as',
			'ur',
			'en',
		]) {
			expect(LanguagePolicySchema.safeParse(code).success, code).toBe(true);
		}
	});

	it('accepts code-switching styles', () => {
		for (const code of ['hinglish', 'tanglish', 'benglish', 'gujlish']) {
			expect(LanguagePolicySchema.safeParse(code).success, code).toBe(true);
		}
	});

	it('still refuses a language nobody serves', () => {
		const result = LanguagePolicySchema.safeParse('klingon');
		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).toContain('Unsupported language policy');
	});

	it('is the schema the persona endpoint validates with', () => {
		// Guards the wiring, not just the helper: a persona update carrying Hindi
		// must pass the same schema the route applies.
		const parsed = PersonaSchema.safeParse({ name: 'Nova', languagePolicy: 'te' });
		expect(parsed.success).toBe(true);
		expect(PersonaSchema.safeParse({ languagePolicy: 'klingon' }).success).toBe(false);
	});
});
