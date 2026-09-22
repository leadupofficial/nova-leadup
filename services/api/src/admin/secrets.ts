/**
 * NOVA — Secret encryption at rest.
 *
 * Secrets are stored AES-256-GCM encrypted in `system_configs.secret_ciphertext`.
 * The plaintext is never written to the database, never returned by any API and
 * never logged. The only readable remnant is `secret_hint` — the last four
 * characters — which exists so an operator can answer "is this the key I think it
 * is" after a rotation without the value being recoverable.
 *
 * **Why AES-256-GCM and not a bespoke scheme.** Node's `crypto` is the standard
 * primitive; GCM is authenticated, so a tampered ciphertext fails to decrypt
 * rather than yielding attacker-influenced plaintext. The repo previously had no
 * runtime secret storage at all, so there was no established mechanism to reuse —
 * this is the established mechanism, used correctly.
 *
 * **Key management.** The data-encryption key comes from
 * `NOVA_CONFIG_ENCRYPTION_KEY` (32 bytes, hex or base64). It is read from the
 * environment because the environment is the only secret store a process can
 * trust before it has read any secret. When it is absent:
 *
 *   - in production the module refuses to encrypt, and the API surfaces
 *     `SECRET_STORE_NOT_CONFIGURED` rather than silently storing plaintext;
 *   - outside production a key is derived from `JWT_SECRET` so local development
 *     works, and a loud warning is logged once. That fallback is deliberately
 *     unavailable in production.
 *
 * Rotating the key is supported per-record: `decryptSecret` tries the current key
 * first, then any key in `NOVA_CONFIG_ENCRYPTION_KEY_PREVIOUS` (comma-separated),
 * so a rotation does not require a coordinated re-encrypt of every row.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;
const FORMAT_VERSION = 'v1';

let cachedKey: Buffer | null = null;
let warnedAboutDerivedKey = false;

function parseKey(raw: string): Buffer | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	// Hex (64 chars for 32 bytes) first, then base64, then raw utf-8 of the right
	// length. Order matters: a 64-character base64 string is also valid hex-shaped
	// input, so hex is tried only when it really is hex.
	if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
	try {
		const b64 = Buffer.from(trimmed, 'base64');
		if (b64.length === KEY_BYTES) return b64;
	} catch {
		/* fall through */
	}
	const utf8 = Buffer.from(trimmed, 'utf8');
	if (utf8.length === KEY_BYTES) return utf8;
	// Any other length: derive deterministically so a passphrase still works, but
	// this is a derivation, not the key itself.
	return createHash('sha256').update(trimmed).digest();
}

function currentKey(): Buffer | null {
	if (cachedKey) return cachedKey;

	const configured = process.env.NOVA_CONFIG_ENCRYPTION_KEY;
	if (configured) {
		cachedKey = parseKey(configured);
		if (cachedKey) return cachedKey;
	}

	if (process.env.NODE_ENV === 'production') {
		// Fail closed. Do not derive from JWT_SECRET in production: the two secrets
		// have different rotation schedules and blast radii, and coupling them means
		// rotating the signing key silently makes every stored secret undecryptable.
		return null;
	}

	const fallbackSource = process.env.JWT_SECRET;
	if (!fallbackSource) return null;

	if (!warnedAboutDerivedKey) {
		warnedAboutDerivedKey = true;
		// eslint-disable-next-line no-console
		console.warn(
			'[nova/secrets] NOVA_CONFIG_ENCRYPTION_KEY is not set — deriving a development-only ' +
				'key from JWT_SECRET. Set NOVA_CONFIG_ENCRYPTION_KEY before storing real credentials.',
		);
	}
	cachedKey = createHash('sha256').update(`nova-config-dev:${fallbackSource}`).digest();
	return cachedKey;
}

/** Previous keys, for decrypting records written before a rotation. */
function previousKeys(): Buffer[] {
	const raw = process.env.NOVA_CONFIG_ENCRYPTION_KEY_PREVIOUS;
	if (!raw) return [];
	return raw
		.split(',')
		.map((part) => parseKey(part))
		.filter((key): key is Buffer => key !== null);
}

/** True when a usable encryption key exists in this process. */
export function isSecretStoreConfigured(): boolean {
	return currentKey() !== null;
}

export class SecretStoreNotConfiguredError extends Error {
	readonly code = 'SECRET_STORE_NOT_CONFIGURED';
	constructor() {
		super(
			'No secret encryption key is available. Set NOVA_CONFIG_ENCRYPTION_KEY (32 bytes, hex or base64).',
		);
	}
}

/**
 * Encrypts a secret. Returns `v1:<iv>:<tag>:<ciphertext>`, all base64.
 *
 * The version prefix is what makes a future algorithm change possible without
 * guessing at the format of existing rows.
 */
export function encryptSecret(plaintext: string): string {
	const key = currentKey();
	if (!key) throw new SecretStoreNotConfiguredError();

	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();

	return [
		FORMAT_VERSION,
		iv.toString('base64'),
		tag.toString('base64'),
		ciphertext.toString('base64'),
	].join(':');
}

/**
 * Decrypts a stored secret.
 *
 * Throws on a malformed payload or an authentication failure — never returns a
 * partial or unauthenticated value. Tries the current key, then each previous key
 * so a rotation does not invalidate existing rows.
 */
export function decryptSecret(payload: string): string {
	const parts = payload.split(':');
	if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
		throw new Error('Unsupported secret payload format');
	}
	const [, ivB64, tagB64, dataB64] = parts;
	const iv = Buffer.from(ivB64, 'base64');
	const tag = Buffer.from(tagB64, 'base64');
	const data = Buffer.from(dataB64, 'base64');

	if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
		throw new Error('Malformed secret payload');
	}

	const keys = [currentKey(), ...previousKeys()].filter((key): key is Buffer => key !== null);
	if (keys.length === 0) throw new SecretStoreNotConfiguredError();

	let lastError: unknown = null;
	for (const key of keys) {
		try {
			const decipher = createDecipheriv(ALGORITHM, key, iv);
			decipher.setAuthTag(tag);
			return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
		} catch (error) {
			lastError = error;
		}
	}

	throw new Error(
		`Unable to decrypt secret with any configured key: ${
			lastError instanceof Error ? lastError.message : 'authentication failed'
		}`,
	);
}

/**
 * A masked, non-reversible display form.
 *
 * Shows at most the last four characters, and only when the secret is long enough
 * that four characters are not the whole thing. A short secret is masked entirely,
 * because `sk-1` → `***-1` is not a mask.
 */
export function maskSecret(plaintext: string): string {
	if (plaintext.length <= 8) return '••••••••';
	return `••••••••${plaintext.slice(-4)}`;
}

/**
 * A stable, non-reversible fingerprint of a secret.
 *
 * Lets the console answer "did the stored value change" and lets a duplicate
 * credential be detected, without the value being recoverable. Salted with a
 * constant so the digest cannot be looked up in a precomputed table of common keys.
 */
export function fingerprintSecret(plaintext: string): string {
	return createHash('sha256').update(`nova-secret-fingerprint:${plaintext}`).digest('hex').slice(0, 16);
}

/** Constant-time comparison, for any future secret equality check. */
export function secretsEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, 'utf8');
	const bufB = Buffer.from(b, 'utf8');
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}
