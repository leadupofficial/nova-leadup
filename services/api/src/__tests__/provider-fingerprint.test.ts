/**
 * The credential fingerprint, and the mistake that made every result stale.
 *
 * `provider_health_checks` recorded a test result but not *which value* it tested, so after a
 * rotation a `pass` kept asserting that a credential works for a value that had already been
 * replaced — and a `fail` kept asserting a failure the operator had already fixed.
 *
 * The first implementation of the fix fingerprinted `"KEY=value"` when a test ran and a bare `value`
 * when comparing, so the two sides could never agree and **every** result read stale, including one
 * from a test that had run a moment earlier against the value in force. Only the live check caught
 * it: a unit test on one side would have passed.
 *
 * These tests therefore pin the property that was actually wrong — that one definition is used on
 * both sides — by asserting the function's output is stable, value-sensitive, source-insensitive and
 * unambiguous across key/value boundaries.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import './setup.js';

import { providerConfigurationFingerprint } from '../admin/config.js';

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'];

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('provider configuration fingerprint', () => {
	it('is null for a provider that reads no credential', async () => {
		// Not "stale" and not "matching": there is nothing to describe. The read model renders it as
		// "no credential involved", and `null` is what makes that distinguishable.
		expect(await providerConfigurationFingerprint('not-a-provider')).toBeNull();
	});

	it('is deterministic for the same value', async () => {
		vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-same');
		const first = await providerConfigurationFingerprint('anthropic');
		const second = await providerConfigurationFingerprint('anthropic');
		expect(first).not.toBeNull();
		expect(first).toBe(second);
	});

	it('changes when the value changes', async () => {
		vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-one');
		const before = await providerConfigurationFingerprint('anthropic');
		vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-two');
		const after = await providerConfigurationFingerprint('anthropic');
		expect(after).not.toBe(before);
	});

	it('distinguishes configured from unconfigured', async () => {
		// A provider that loses its key has changed state, so the previous result must stop being
		// shown as current rather than being reported as `null` (which would read as "not stale").
		vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-present');
		const configured = await providerConfigurationFingerprint('anthropic');
		vi.stubEnv('ANTHROPIC_API_KEY', '');
		const unconfigured = await providerConfigurationFingerprint('anthropic');
		expect(unconfigured).not.toBe(configured);
		expect(unconfigured).not.toBeNull();
	});

	it('cannot be confused across a key/value boundary', async () => {
		// `A=ab, B=c` and `A=a, B=bc` must not hash the same. Without a separator they would.
		vi.stubEnv('S3_ACCESS_KEY', 'ab');
		vi.stubEnv('S3_SECRET_KEY', 'c');
		const first = await providerConfigurationFingerprint('object-storage');
		vi.stubEnv('S3_ACCESS_KEY', 'a');
		vi.stubEnv('S3_SECRET_KEY', 'bc');
		const second = await providerConfigurationFingerprint('object-storage');
		expect(second).not.toBe(first);
	});

	it('covers every key the provider reads, so either changing is a change', async () => {
		vi.stubEnv('S3_ACCESS_KEY', 'key-a');
		vi.stubEnv('S3_SECRET_KEY', 'secret-a');
		const baseline = await providerConfigurationFingerprint('object-storage');
		vi.stubEnv('S3_SECRET_KEY', 'secret-b');
		expect(await providerConfigurationFingerprint('object-storage')).not.toBe(baseline);
	});

	it('is a truncated digest, never the value', async () => {
		vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-a-very-recognisable-value');
		const fingerprint = (await providerConfigurationFingerprint('anthropic')) as string;
		expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
		expect(fingerprint).not.toContain('recognisable');
	});

	it('is unaffected by keys it does not read', async () => {
		// Otherwise an unrelated credential change would invalidate every provider's result.
		vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-stable');
		const before = await providerConfigurationFingerprint('anthropic');
		for (const key of ENV_KEYS.filter((entry) => entry !== 'ANTHROPIC_API_KEY')) {
			vi.stubEnv(key, `unrelated-${key}`);
		}
		expect(await providerConfigurationFingerprint('anthropic')).toBe(before);
	});
});
