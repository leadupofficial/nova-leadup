import { describe, it, expect } from 'vitest';
import { HttpError } from '../../src/middleware.js';

// The path here used to be `../src/middleware.ts`, which from `tests/utils/` resolves to
// `tests/src/middleware.ts` — a file that has never existed. The suite could not load,
// and nobody noticed because `services/admin` had no `test` script at all, so Turbo
// never ran these tests.
describe('HttpError', () => {
	it('exposes status and message', () => {
		const err = new HttpError(404, 'Not found');
		expect(err.status).toBe(404);
		expect(err.message).toBe('Not found');
		expect(err.name).toBe('HttpError');
		expect(err instanceof Error).toBe(true);
	});
});
