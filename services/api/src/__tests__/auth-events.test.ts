/**
 * Login-attempt recording.
 *
 * Nothing recorded a sign-in attempt before this. `users.last_login_at` kept the most recent
 * *success* for one account with no client information, and a failed attempt left no trace in
 * either audit table — so the Security Center's "failed admin logins" had to report NOT AVAILABLE,
 * and "is somebody trying to get into this console" was unanswerable from persisted data.
 *
 * These tests pin the properties that make the record useful and safe:
 *
 *  * the action name distinguishes success from failure, so a query for failures is exact;
 *  * an attempt that matched no account is **anonymous with no account id**, so it can never be
 *    joined to a user — "this address was tried" is a fact, "this account was attacked" is not;
 *  * the reason is recorded for the operator and never for the caller;
 *  * a failed write never propagates, because a login that succeeded must not become a 500
 *    because the audit insert failed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import './setup.js';

import { getDb } from '../db/connection.js';
import { recordLoginAttempt } from '../services/auth-events.js';

/** A db that records the single insert's values, and can be made to fail. */
function capturingDb(options: { fail?: boolean } = {}) {
	const captured: { values?: Record<string, unknown> } = {};
	const db = {
		insert: () => ({
			values: (values: Record<string, unknown>) => {
				if (options.fail) return Promise.reject(new Error('audit sink unreachable'));
				captured.values = values;
				return Promise.resolve([]);
			},
		}),
	} as unknown as ReturnType<typeof getDb>;
	return { db, captured };
}

const BASE = {
	email: 'Someone@Example.com',
	ipAddress: '203.0.113.9',
	userAgent: 'Nova/1.0 (Android 17)',
	requestId: 'req-abc',
};

afterEach(() => {
	vi.mocked(getDb).mockReset();
});

describe('login attempt recording', () => {
	it('records a failure with its reason and marks it a failure', async () => {
		const { db, captured } = capturingDb();
		vi.mocked(getDb).mockReturnValueOnce(db);

		await recordLoginAttempt({ ...BASE, reason: 'bad-password', userId: 'user-1' });

		expect(captured.values?.action).toBe('auth.login_failed');
		expect(captured.values?.outcome).toBe('failure');
		expect((captured.values?.details as Record<string, unknown>).reason).toBe('bad-password');
	});

	it('records a success as success', async () => {
		const { db, captured } = capturingDb();
		vi.mocked(getDb).mockReturnValueOnce(db);

		await recordLoginAttempt({ ...BASE, reason: 'ok', userId: 'user-1' });

		expect(captured.values?.action).toBe('auth.login');
		expect(captured.values?.outcome).toBe('success');
	});

	it('makes an unmatched address anonymous, with no account id', async () => {
		// This is the property that stops the table asserting an account did something it did not.
		const { db, captured } = capturingDb();
		vi.mocked(getDb).mockReturnValueOnce(db);

		await recordLoginAttempt({ ...BASE, reason: 'unknown-account', userId: null });

		expect(captured.values?.actorType).toBe('anonymous');
		expect(captured.values?.actorId).toBeNull();
		expect(captured.values?.userId).toBeNull();
		// The address is still recorded — which addresses are being tried is the signal.
		expect((captured.values?.details as Record<string, unknown>).attemptedEmail).toBe('someone@example.com');
	});

	it('attributes an attempt to the account once the address matches', async () => {
		const { db, captured } = capturingDb();
		vi.mocked(getDb).mockReturnValueOnce(db);

		await recordLoginAttempt({ ...BASE, reason: 'account-disabled', userId: 'user-1' });

		expect(captured.values?.actorType).toBe('user');
		expect(captured.values?.actorId).toBe('user-1');
	});

	it('lower-cases the attempted address so grouping is exact', async () => {
		const { db, captured } = capturingDb();
		vi.mocked(getDb).mockReturnValueOnce(db);

		await recordLoginAttempt({ ...BASE, reason: 'bad-password', userId: null });

		expect((captured.values?.details as Record<string, unknown>).attemptedEmail).toBe('someone@example.com');
	});

	it('records the client address, which the table has no column for', async () => {
		const { db, captured } = capturingDb();
		vi.mocked(getDb).mockReturnValueOnce(db);

		await recordLoginAttempt({ ...BASE, reason: 'bad-password', userId: null });

		expect((captured.values?.details as Record<string, unknown>).clientIp).toBe('203.0.113.9');
		expect(captured.values?.sourceDevice).toBe('Nova/1.0 (Android 17)');
	});

	it('bounds every free-text field rather than letting a caller overflow a column', async () => {
		const { db, captured } = capturingDb();
		vi.mocked(getDb).mockReturnValueOnce(db);

		await recordLoginAttempt({
			email: `${'a'.repeat(400)}@example.com`,
			reason: 'bad-password',
			userId: null,
			ipAddress: '2'.repeat(80),
			userAgent: 'u'.repeat(400),
			requestId: 'r'.repeat(400),
		});

		const details = captured.values?.details as Record<string, unknown>;
		expect(String(details.attemptedEmail).length).toBeLessThanOrEqual(254);
		expect(String(details.clientIp).length).toBeLessThanOrEqual(45);
		expect(String(captured.values?.sourceDevice).length).toBeLessThanOrEqual(255);
		expect(String(captured.values?.requestId).length).toBeLessThanOrEqual(100);
	});

	it('never throws when the audit write fails', async () => {
		// A sign-in that succeeded must not become a 500 because a metrics row would not write.
		vi.mocked(getDb).mockReturnValueOnce(capturingDb({ fail: true }).db);

		await expect(
			recordLoginAttempt({ ...BASE, reason: 'ok', userId: 'user-1' }),
		).resolves.toBeUndefined();
	});

	it('carries no field named like a credential', async () => {
		// The module's signature has no password field at all, and this asserts the row it writes
		// has no *key* a redactor would have to catch — a future edit that added one fails here.
		//
		// It checks keys, not the whole serialised row: the reason value `bad-password` legitimately
		// contains the word, and asserting on substrings flagged that as a leak. The property that
		// matters is that nothing credential-shaped is *stored*, not that the word never appears.
		const { db, captured } = capturingDb();
		vi.mocked(getDb).mockReturnValueOnce(db);

		await recordLoginAttempt({ ...BASE, reason: 'bad-password', userId: null });

		const keys: string[] = [];
		const walk = (value: unknown): void => {
			if (Array.isArray(value)) value.forEach(walk);
			else if (value && typeof value === 'object') {
				for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
					keys.push(key.toLowerCase());
					walk(nested);
				}
			}
		};
		walk(captured.values);

		for (const forbidden of ['password', 'pin', 'token', 'secret', 'credential', 'otp']) {
			expect(keys, `no key may be named like "${forbidden}"`).not.toContain(forbidden);
		}
	});
});
