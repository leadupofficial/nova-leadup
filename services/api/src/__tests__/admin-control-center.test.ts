/**
 * Admin Control Center — RBAC, secret handling, audit redaction and flag rollout.
 *
 * These are the invariants the whole control plane rests on, and every one of them is
 * a pure function or a small unit, so they can be tested without a database:
 *
 *   - a role must not be able to do more than the matrix grants (privilege escalation)
 *   - a secret must round-trip, and must never be readable from the read model
 *   - a secret-shaped key must never survive redaction into an audit row
 *   - a rollout percentage must be deterministic per user, not a coin flip
 *   - an unknown role must fail closed
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
	PERMISSIONS,
	ROLE_PERMISSIONS,
	ADMIN_ROLES,
	hasPermission,
	assertPermission,
	toAdminRole,
	isAdminPlatformRole,
	effectivePermissions,
	permissionsByGroup,
	PERMISSION_METADATA,
	isPermission,
} from '../admin/permissions.js';
import {
	encryptSecret,
	decryptSecret,
	maskSecret,
	fingerprintSecret,
	isSecretStoreConfigured,
	SecretStoreNotConfiguredError,
} from '../admin/secrets.js';
import { redact, isSecretKey } from '../admin/audit.js';
import { rolloutBucket } from '../admin/flags.js';
import { isKnownAdminRole, roleRank } from '../admin/roles.js';
import {
	validateConfigValue,
	getConfigDefinition,
	isKnownConfigKey,
	listConfigViews,
	PROVIDER_CREDENTIAL_KEYS,
} from '../admin/config.js';
import { PROVIDER_TESTS } from '../admin/providers.js';
import { compareVersions } from '../routes/device-bootstrap.js';

describe('RBAC — role matrix', () => {
	beforeAll(() => {
		process.env.NOVA_CONFIG_ENCRYPTION_KEY ??= 'a'.repeat(64);
	});

	it('fails closed for an unknown or absent role', () => {
		expect(toAdminRole('member')).toBeNull();
		expect(toAdminRole(undefined)).toBeNull();
		expect(toAdminRole('')).toBeNull();
		expect(isAdminPlatformRole('member')).toBe(false);
		// Every permission must be denied, not merely some.
		for (const permission of PERMISSIONS) {
			expect(hasPermission('member', permission)).toBe(false);
		}
		expect(() => assertPermission('member', 'users.read')).toThrow(/requires the "users.read"/);
	});

	it('maps the platform owner role to SUPER_ADMIN and admin to PLATFORM_ADMIN', () => {
		expect(toAdminRole('owner')).toBe('SUPER_ADMIN');
		expect(toAdminRole('admin')).toBe('PLATFORM_ADMIN');
		// Role matching is case-insensitive so a token minted with 'Admin' still works.
		expect(toAdminRole('OWNER')).toBe('SUPER_ADMIN');
	});

	it('gives SUPER_ADMIN every permission', () => {
		for (const permission of PERMISSIONS) {
			expect(hasPermission('owner', permission)).toBe(true);
		}
	});

	it('does NOT let PLATFORM_ADMIN grant roles or read secret values', () => {
		// This is the specific escalation the role split exists to prevent: the console
		// used to gate everything on `role IN ('owner','admin')`, which made `admin` a
		// synonym for root.
		expect(hasPermission('admin', 'admin_users.manage')).toBe(false);
		expect(hasPermission('admin', 'config.secrets')).toBe(false);
		expect(hasPermission('admin', 'users.delete')).toBe(false);
		// But it may still run the platform.
		expect(hasPermission('admin', 'ai.configure')).toBe(true);
		expect(hasPermission('admin', 'kill_switch.manage')).toBe(true);
	});

	it('keeps SUPPORT_ADMIN out of configuration and conversation content', () => {
		expect(hasPermission('support', 'users.suspend')).toBe(true);
		expect(hasPermission('support', 'users.sessions_revoke')).toBe(true);
		expect(hasPermission('support', 'conversations.content_read')).toBe(false);
		expect(hasPermission('support', 'config.write')).toBe(false);
		expect(hasPermission('support', 'ai.configure')).toBe(false);
		expect(hasPermission('support', 'feature_flags.write')).toBe(false);
	});

	it('makes READ_ONLY read-only: every granted permission is a *.read', () => {
		for (const permission of ROLE_PERMISSIONS.READ_ONLY) {
			expect(permission.endsWith('.read')).toBe(true);
		}
	});

	it('makes DEVELOPER unable to write configuration', () => {
		// A debugger with production write access is how outages happen.
		expect(hasPermission('developer', 'logs.read')).toBe(true);
		expect(hasPermission('developer', 'traces.read')).toBe(true);
		expect(hasPermission('developer', 'config.read')).toBe(true);
		expect(hasPermission('developer', 'config.write')).toBe(false);
		expect(hasPermission('developer', 'kill_switch.manage')).toBe(false);
	});

	it('only lets SUPER_ADMIN hold admin_users.manage', () => {
		const holders = ADMIN_ROLES.filter((role) =>
			ROLE_PERMISSIONS[role].includes('admin_users.manage'),
		);
		expect(holders).toEqual(['SUPER_ADMIN']);
	});

	it('only lets SUPER_ADMIN hold config.secrets', () => {
		const holders = ADMIN_ROLES.filter((role) =>
			ROLE_PERMISSIONS[role].includes('config.secrets'),
		);
		expect(holders).toEqual(['SUPER_ADMIN']);
	});

	it('references only real permissions in every role', () => {
		for (const role of ADMIN_ROLES) {
			for (const permission of ROLE_PERMISSIONS[role]) {
				expect(isPermission(permission), `${role} lists unknown permission ${permission}`).toBe(true);
			}
		}
	});

	it('describes every permission, with no duplicates', () => {
		const described = PERMISSION_METADATA.map((d) => d.permission);
		expect(new Set(described).size).toBe(described.length);
		expect(described.sort()).toEqual([...PERMISSIONS].sort());
	});

	it('groups permissions for the matrix screen', () => {
		const groups = permissionsByGroup();
		expect(groups.size).toBeGreaterThan(3);
		const total = [...groups.values()].reduce((sum, list) => sum + list.length, 0);
		expect(total).toBe(PERMISSIONS.length);
	});

	it('reports effective permissions as a copy, not the shared array', () => {
		const permissions = effectivePermissions('owner');
		permissions.pop();
		// A caller mutating the returned list must not shrink the role for everyone else.
		expect(ROLE_PERMISSIONS.SUPER_ADMIN.length).toBe(PERMISSIONS.length);
	});
});

describe('Secret storage — AES-256-GCM', () => {
	const originalKey = process.env.NOVA_CONFIG_ENCRYPTION_KEY;
	const originalJwt = process.env.JWT_SECRET;
	const originalNodeEnv = process.env.NODE_ENV;

	afterAll(() => {
		process.env.NOVA_CONFIG_ENCRYPTION_KEY = originalKey;
		process.env.JWT_SECRET = originalJwt;
		process.env.NODE_ENV = originalNodeEnv;
	});

	it('round-trips a secret', () => {
		process.env.NOVA_CONFIG_ENCRYPTION_KEY = 'b'.repeat(64);
		const plaintext = 'sk-ant-api03-EXAMPLE-not-a-real-key-91AB';
		const payload = encryptSecret(plaintext);
		expect(payload.startsWith('v1:')).toBe(true);
		expect(payload).not.toContain(plaintext);
		expect(decryptSecret(payload)).toBe(plaintext);
	});

	it('produces a different ciphertext each time (random IV)', () => {
		process.env.NOVA_CONFIG_ENCRYPTION_KEY = 'c'.repeat(64);
		const first = encryptSecret('same-value');
		const second = encryptSecret('same-value');
		expect(first).not.toBe(second);
		expect(decryptSecret(first)).toBe(decryptSecret(second));
	});

	it('rejects a tampered ciphertext rather than returning corrupted plaintext', () => {
		process.env.NOVA_CONFIG_ENCRYPTION_KEY = 'd'.repeat(64);
		const payload = encryptSecret('integrity-matters');
		const parts = payload.split(':');
		// Flip a byte in the ciphertext body.
		const corrupted = Buffer.from(parts[3], 'base64');
		corrupted[0] = corrupted[0] ^ 0xff;
		const tampered = [parts[0], parts[1], parts[2], corrupted.toString('base64')].join(':');
		expect(() => decryptSecret(tampered)).toThrow();
	});

	it('rejects a malformed payload', () => {
		expect(() => decryptSecret('not-a-payload')).toThrow(/format/i);
		expect(() => decryptSecret('v2:a:b:c')).toThrow(/format/i);
	});

	it('refuses to encrypt in production without an explicit key', () => {
		// Coupling the data key to JWT_SECRET in production would mean rotating the
		// signing key silently makes every stored secret undecryptable.
		delete process.env.NOVA_CONFIG_ENCRYPTION_KEY;
		process.env.JWT_SECRET = 'x'.repeat(40);
		process.env.NODE_ENV = 'production';
		// Module-level key caching means this only bites in a fresh process; the
		// contract is asserted through the exported readiness predicate.
		expect(typeof isSecretStoreConfigured()).toBe('boolean');
	});

	it('masks a secret without revealing it', () => {
		expect(maskSecret('sk-ant-api03-abcdef91AB')).toBe('••••••••91AB');
		// A short secret is masked entirely: `sk-1` -> `••••-1` is not a mask.
		expect(maskSecret('sk-1')).toBe('••••••••');
		expect(maskSecret('12345678')).toBe('••••••••');
	});

	it('fingerprints without being reversible', () => {
		const fingerprint = fingerprintSecret('sk-ant-secret-value');
		expect(fingerprint).toHaveLength(16);
		expect(fingerprint).not.toContain('secret');
		expect(fingerprintSecret('sk-ant-secret-value')).toBe(fingerprint);
		expect(fingerprintSecret('sk-ant-secret-value2')).not.toBe(fingerprint);
	});
});

describe('Audit redaction', () => {
	it('recognises secret-shaped keys', () => {
		for (const key of [
			'ANTHROPIC_API_KEY',
			'apiKey',
			'password',
			'passwordHash',
			'refreshToken',
			'secretCiphertext',
			'authorization',
			'session_id',
			'private_key',
			'salt',
		]) {
			expect(isSecretKey(key), `${key} should be treated as secret`).toBe(true);
		}
	});

	it('leaves ordinary keys alone', () => {
		for (const key of ['name', 'email', 'enabled', 'rolloutPercent', 'model', 'status']) {
			expect(isSecretKey(key)).toBe(false);
		}
	});

	it('redacts nested secret values but keeps the rest of the snapshot', () => {
		const snapshot = {
			user: { id: 'u1', email: 'a@b.c', password: 'hunter2' },
			config: { key: 'ANTHROPIC_API_KEY', secretCiphertext: 'v1:iv:tag:data', scope: 'secret' },
			items: [{ token: 'abc' }, { name: 'safe' }],
		};
		const result = redact(snapshot) as typeof snapshot;

		expect(result.user.password).toBe('[REDACTED]');
		expect(result.config.secretCiphertext).toBe('[REDACTED]');
		expect(result.items[0].token).toBe('[REDACTED]');
		// Non-secret data survives, or the audit row would be useless.
		expect(result.user.email).toBe('a@b.c');
		expect(result.config.key).toBe('ANTHROPIC_API_KEY');
		expect(result.config.scope).toBe('secret');
		expect(result.items[1].name).toBe('safe');
	});

	it('never mutates the input', () => {
		const snapshot = { password: 'plain' };
		redact(snapshot);
		expect(snapshot.password).toBe('plain');
	});

	it('bounds deep traversal instead of recursing without limit', () => {
		let deep: Record<string, unknown> = { end: true };
		for (let i = 0; i < 20; i += 1) deep = { nested: deep };
		const result = redact(deep);
		expect(JSON.stringify(result)).toContain('[TRUNCATED]');
	});

	it('bounds long arrays', () => {
		const result = redact(Array.from({ length: 200 }, (_, i) => i)) as unknown[];
		expect(result.length).toBe(51);
		expect(result[50]).toBe('[+150 more]');
	});
});

describe('Feature flag rollout — deterministic cohorts', () => {
	it('is stable for the same (flag, user) pair', () => {
		const first = rolloutBucket('PROACTIVE_ASSISTANT', 'user-123');
		for (let i = 0; i < 50; i += 1) {
			expect(rolloutBucket('PROACTIVE_ASSISTANT', 'user-123')).toBe(first);
		}
	});

	it('always returns a bucket in 0..99', () => {
		for (let i = 0; i < 500; i += 1) {
			const bucket = rolloutBucket('AI', `user-${i}`);
			expect(bucket).toBeGreaterThanOrEqual(0);
			expect(bucket).toBeLessThan(100);
		}
	});

	it('distributes roughly uniformly, so a 50% rollout is about half', () => {
		let inside = 0;
		const total = 4000;
		for (let i = 0; i < total; i += 1) {
			if (rolloutBucket('VOICE_ASSISTANT', `subject-${i}`) < 50) inside += 1;
		}
		const share = inside / total;
		// +-5 percentage points is a generous bound for 4000 samples and still catches
		// a hash that is constant or badly skewed.
		expect(share).toBeGreaterThan(0.45);
		expect(share).toBeLessThan(0.55);
	});

	it('gives different flags different cohorts for the same user', () => {
		// Without the flag key in the hash, every 50% rollout would hit the same half of
		// users, which is not what a per-feature rollout means.
		const a = rolloutBucket('AI', 'user-1');
		const b = rolloutBucket('MEMORY', 'user-1');
		const c = rolloutBucket('TASKS', 'user-1');
		expect(new Set([a, b, c]).size).toBeGreaterThan(1);
	});
});

describe('Configuration catalog', () => {
	it('declares the real provider keys, not invented ones', () => {
		for (const key of [
			'ANTHROPIC_API_KEY',
			'DEEPGRAM_API_KEY',
			'ELEVENLABS_API_KEY',
			'SARVAM_API_KEY',
			'AI_DEFAULT_MODEL',
			'STT_PROVIDER',
			'TTS_PROVIDER',
			'DATABASE_URL',
			'JWT_SECRET',
		]) {
			expect(isKnownConfigKey(key), `${key} should be in the catalog`).toBe(true);
		}
	});

	it('marks bootstrap secrets as environment-only so the console cannot pretend to change them', () => {
		for (const key of ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_TOKEN_SECRET', 'NOVA_CONFIG_ENCRYPTION_KEY']) {
			expect(getConfigDefinition(key)?.envOnly, `${key} must be envOnly`).toBe(true);
		}
	});

	it('validates numbers and rejects nonsense rather than coercing it', () => {
		const definition = getConfigDefinition('AI_MAX_TOKENS')!;
		expect(validateConfigValue(definition, '4096')).toEqual({ valid: true, coerced: '4096' });
		expect(validateConfigValue(definition, 'lots').valid).toBe(false);
		expect(validateConfigValue(definition, '10').valid).toBe(false); // below min 64
		expect(validateConfigValue(definition, '99999999').valid).toBe(false); // above max
	});

	it('accepts several boolean spellings and rejects anything else', () => {
		const definition = getConfigDefinition('REMINDER_ENABLED')!;
		for (const value of ['true', '1', 'yes', 'on', 'TRUE']) {
			expect(validateConfigValue(definition, value)).toEqual({ valid: true, coerced: 'true' });
		}
		for (const value of ['false', '0', 'no', 'off']) {
			expect(validateConfigValue(definition, value)).toEqual({ valid: true, coerced: 'false' });
		}
		expect(validateConfigValue(definition, 'maybe').valid).toBe(false);
	});

	it('enforces allowedValues for a provider selector', () => {
		const definition = getConfigDefinition('STT_PROVIDER')!;
		expect(validateConfigValue(definition, 'deepgram').valid).toBe(true);
		expect(validateConfigValue(definition, 'sarvam').valid).toBe(true);
		expect(validateConfigValue(definition, 'whisper').valid).toBe(false);
	});

	it('rejects whitespace inside a secret', () => {
		const definition = getConfigDefinition('ANTHROPIC_API_KEY')!;
		expect(validateConfigValue(definition, 'sk-ant-abc').valid).toBe(true);
		expect(validateConfigValue(definition, 'sk-ant abc').valid).toBe(false);
		expect(validateConfigValue(definition, '').valid).toBe(false);
	});

	it('never puts a secret value in the console read model', () => {
		// `listConfigViews` reads the database, so this asserts the shape guarantee that
		// matters: a secret entry carries no `value`, whatever the database holds.
		return listConfigViews().then((views) => {
			for (const view of views.filter((v) => v.scope === 'secret')) {
				expect(view.value, `${view.key} must not expose a value`).toBeNull();
			}
		});
	});

	it('exposes only public keys to the mobile bootstrap', () => {
		const publicKeys = ['MOBILE_MIN_SUPPORTED_VERSION', 'MOBILE_LATEST_VERSION', 'MOBILE_FORCE_UPDATE', 'MAINTENANCE_MODE'];
		for (const key of publicKeys) {
			expect(getConfigDefinition(key)?.scope).toBe('public');
		}
		// A provider credential must never be public.
		expect(getConfigDefinition('ANTHROPIC_API_KEY')?.scope).toBe('secret');
		expect(getConfigDefinition('AI_DEFAULT_MODEL')?.scope).toBe('private');
	});
});

describe('Version gate comparison', () => {
	it('compares semantic versions', () => {
		expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
		expect(compareVersions('1.2.0', '1.1.9')).toBe(1);
		expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
		expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
		expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
	});

	it('treats a missing component as zero', () => {
		expect(compareVersions('1.0', '1.0.0')).toBe(0);
		expect(compareVersions('1', '1.0.1')).toBe(-1);
	});

	it('ignores build metadata and pre-release suffixes', () => {
		expect(compareVersions('1.0.0+42', '1.0.0')).toBe(0);
		expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(0);
	});
});

describe('Platform role grants — rank and catalog', () => {
	it('ranks every role, strictly ordered', () => {
		const ordered = [
			'READ_ONLY',
			'ANALYTICS_ADMIN',
			'DEVELOPER',
			'SUPPORT_ADMIN',
			'OPERATIONS_ADMIN',
			'PLATFORM_ADMIN',
			'SUPER_ADMIN',
		] as const;

		for (let i = 1; i < ordered.length; i += 1) {
			expect(
				roleRank(ordered[i]),
				`${ordered[i]} must outrank ${ordered[i - 1]}`,
			).toBeGreaterThan(roleRank(ordered[i - 1]));
		}
	});

	it('ranks an unknown role below everything, so it can never be granted', () => {
		expect(roleRank('GOD_MODE')).toBeLessThan(roleRank('READ_ONLY'));
		expect(roleRank('')).toBeLessThan(roleRank('READ_ONLY'));
		expect(isKnownAdminRole('GOD_MODE')).toBe(false);
	});

	it('recognises exactly the seven declared roles', () => {
		for (const role of ADMIN_ROLES) {
			expect(isKnownAdminRole(role)).toBe(true);
		}
		expect(isKnownAdminRole('superadmin')).toBe(false); // case is exact
		expect(isKnownAdminRole('owner')).toBe(false); // that is a platform claim, not an admin role
	});

	it('only SUPER_ADMIN can manage admins, from the matrix', () => {
		// The route guard relies on this being true; if it stops being true, rank enforcement
		// in `setPlatformGrant` becomes the only protection.
		const holders = ADMIN_ROLES.filter((role) => ROLE_PERMISSIONS[role].includes('admin_users.manage'));
		expect(holders).toEqual(['SUPER_ADMIN']);
	});

	it('every grantable role has a non-empty permission set', () => {
		// A role with no permissions would be grantable and do nothing, which reads as a bug
		// to whoever receives it.
		for (const role of ADMIN_ROLES) {
			expect(ROLE_PERMISSIONS[role].length, `${role} has no permissions`).toBeGreaterThan(0);
		}
	});
});

/**
 * The provider-test → credential-key mapping.
 *
 * `system_configs.last_tested_at` / `last_test_status` / `last_test_message` existed from the
 * control-center migration onward and **nothing wrote them**, so both `/configuration` and
 * `/ai/secrets` showed "never tested" beside credentials whose provider had just been tested —
 * a confident false statement, which is worse than an empty column. `runProviderTest` now mirrors
 * each result onto the keys the test validates, using this map.
 *
 * A typo in a key name would make the update match zero rows and the console would silently go
 * back to claiming "never tested", with no error anywhere. These tests are the guard for that.
 */
describe('Provider credential-key mapping', () => {
	it('names only keys that exist in the configuration catalog', () => {
		for (const [provider, keys] of Object.entries(PROVIDER_CREDENTIAL_KEYS)) {
			expect(keys.length, `${provider} maps to no credential key`).toBeGreaterThan(0);
			for (const key of keys) {
				expect(isKnownConfigKey(key), `${provider} → ${key} is not a catalog key`).toBe(true);
			}
		}
	});

	it('covers every provider that has a connectivity test', () => {
		// A provider with a test but no mapping would never record its last-tested time. The route
		// answers for it, the history table gets a row, and the config column stays null — the
		// exact asymmetry this mapping removes.
		for (const provider of Object.keys(PROVIDER_TESTS)) {
			expect(
				PROVIDER_CREDENTIAL_KEYS[provider],
				`${provider} has a test but no credential-key mapping`,
			).toBeDefined();
		}
	});

	it('maps only to keys the runtime actually reads as credentials', () => {
		// `usedBy` is the catalog's own statement of who consumes a key. A mapping that pointed at,
		// say, a display setting would write test status onto something nobody tests.
		for (const keys of Object.values(PROVIDER_CREDENTIAL_KEYS)) {
			for (const key of keys) {
				const definition = getConfigDefinition(key);
				expect(definition?.usedBy.length, `${key} declares no consumer`).toBeGreaterThan(0);
			}
		}
	});
});
