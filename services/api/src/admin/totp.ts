/**
 * NOVA — TOTP (RFC 6238), built on `node:crypto`.
 *
 * ## Why this is hand-written rather than a dependency
 *
 * TOTP is HMAC + a truncation rule that fits in fifty lines, and it is the one piece of the second
 * factor that must be exactly right — a subtly wrong implementation rejects valid codes and, worse,
 * accepts codes outside the window it claims. The alternative was adding a package for it. Written
 * here it is checked directly against **RFC 6238 Appendix B's published vectors**, which a
 * dependency's own tests would not be checking on our behalf.
 *
 * The crypto is not hand-rolled: HMAC-SHA1 comes from `node:crypto`, and comparison is constant
 * time (`timingSafeEqual`) so a wrong code cannot be narrowed by timing.
 *
 * ## The two decisions worth knowing about
 *
 *  * **SHA-1, 6 digits, 30-second steps** — the interoperable defaults. Every authenticator app
 *    supports them, and the algorithm is not the security margin here: the code is a second factor
 *    behind a password, rate-limited, and valid for one step.
 *  * **A verifier returns the step it matched, not a boolean.** The caller records that step, so the
 *    same code cannot be replayed inside its own validity window — a replay is a real attack when
 *    the attacker has read the code over a shoulder and the window is 90 seconds wide.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 4648 base32, the encoding every authenticator app expects for a shared secret. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
	let bits = 0;
	let value = 0;
	let output = '';

	for (const byte of buffer) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	}
	return output;
}

export function base32Decode(input: string): Buffer {
	// Authenticator apps vary on padding, and users paste secrets with spaces and lower case.
	const cleaned = input.replace(/[\s=]/g, '').toUpperCase();
	let bits = 0;
	let value = 0;
	const bytes: number[] = [];

	for (const character of cleaned) {
		const index = BASE32_ALPHABET.indexOf(character);
		if (index === -1) throw new Error(`Invalid base32 character: ${character}`);
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Buffer.from(bytes);
}

/** 160 bits, the RFC 4226 recommendation, encoded for an authenticator app. */
export function generateTotpSecret(): string {
	return base32Encode(randomBytes(20));
}

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

const DIGEST_BY_ALGORITHM: Record<TotpAlgorithm, string> = {
	sha1: 'sha1',
	sha256: 'sha256',
	sha512: 'sha512',
};

/**
 * HOTP (RFC 4226 §5.3) — the counter-based primitive TOTP builds on.
 *
 * Exported because the RFC's test vectors are for this function, and testing it directly is how the
 * truncation rule is proven rather than assumed.
 */
export function hotp(secret: Buffer, counter: number, digits = 6, algorithm: TotpAlgorithm = 'sha1'): string {
	const buffer = Buffer.alloc(8);
	// The counter is 64-bit big-endian. `writeBigUInt64BE` needs a BigInt; the counter is a step
	// number, so it fits comfortably, but the API requires the conversion.
	buffer.writeBigUInt64BE(BigInt(counter));

	const digest = createHmac(DIGEST_BY_ALGORITHM[algorithm], secret).update(buffer).digest();

	// Dynamic truncation: the low nibble of the last byte picks the 4-byte window, and the top bit
	// is masked so the result is positive regardless of sign handling.
	const offset = digest[digest.length - 1] & 0x0f;
	const binary =
		((digest[offset] & 0x7f) << 24) |
		((digest[offset + 1] & 0xff) << 16) |
		((digest[offset + 2] & 0xff) << 8) |
		(digest[offset + 3] & 0xff);

	return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export const TOTP_STEP_SECONDS = 30;

/** The counter for an instant. Exported so a test can drive a fixed clock. */
export function totpCounter(instant: Date, stepSeconds: number = TOTP_STEP_SECONDS): number {
	return Math.floor(instant.getTime() / 1000 / stepSeconds);
}

/** The code for one instant. */
export function totp(
	secret: string,
	instant: Date = new Date(),
	options: { digits?: number; algorithm?: TotpAlgorithm; stepSeconds?: number } = {},
): string {
	const decoded = base32Decode(secret);
	return hotp(
		decoded,
		totpCounter(instant, options.stepSeconds ?? TOTP_STEP_SECONDS),
		options.digits ?? 6,
		options.algorithm ?? 'sha1',
	);
}

/** Constant-time string comparison that tolerates different lengths. */
function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, 'utf8');
	const bufB = Buffer.from(b, 'utf8');
	// `timingSafeEqual` throws on a length mismatch, so equalise first. The length is not a secret.
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

export type TotpVerification =
	| { valid: true; counter: number }
	| { valid: false; reason: 'malformed' | 'no-match' | 'replayed' };

/**
 * Verifies a submitted code against a window of steps.
 *
 * `window: 1` accepts the previous, current and next step — three opportunities a minute, which
 * absorbs clock drift without meaningfully widening the guessing surface (the rate limiter caps
 * attempts long before 3-in-a-million becomes reachable).
 *
 * `lastUsedCounter` is what makes a code single-use. Passing the step recorded from the previous
 * successful verification means a code read over a shoulder cannot be replayed while it is still
 * valid; without it, the window that exists to tolerate drift is also a 90-second replay window.
 */
export function verifyTotp(
	secret: string,
	code: string,
	options: {
		instant?: Date;
		window?: number;
		digits?: number;
		algorithm?: TotpAlgorithm;
		stepSeconds?: number;
		lastUsedCounter?: number | null;
	} = {},
): TotpVerification {
	const digits = options.digits ?? 6;
	const trimmed = code.replace(/\s/g, '');
	// Refuse anything that is not the expected shape before touching crypto: a code with letters in
	// it is a paste error or a probe, and neither should reach the comparison.
	if (!new RegExp(`^\\d{${digits}}$`).test(trimmed)) return { valid: false, reason: 'malformed' };

	const stepSeconds = options.stepSeconds ?? TOTP_STEP_SECONDS;
	const instant = options.instant ?? new Date();
	const window = options.window ?? 1;
	const decoded = base32Decode(secret);
	const current = totpCounter(instant, stepSeconds);

	// Checked from the current step outwards so the most likely match is found first.
	for (let offset = 0; offset <= window; offset += 1) {
		const candidates = offset === 0 ? [current] : [current - offset, current + offset];
		for (const counter of candidates) {
			if (counter < 0) continue;
			if (!safeEqual(hotp(decoded, counter, digits, options.algorithm ?? 'sha1'), trimmed)) continue;
			if (options.lastUsedCounter !== null && options.lastUsedCounter !== undefined && counter <= options.lastUsedCounter) {
				// A code at or before the last accepted step has already been used. Rejecting it is
				// the difference between "valid for 90 seconds" and "valid once".
				return { valid: false, reason: 'replayed' };
			}
			return { valid: true, counter };
		}
	}
	return { valid: false, reason: 'no-match' };
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The label and issuer are percent-encoded: an account email contains an `@`, and an unencoded one
 * makes the URI ambiguous — some apps read everything after the `@` as the issuer.
 */
export function otpauthUri(options: {
	secret: string;
	account: string;
	issuer?: string;
	digits?: number;
	stepSeconds?: number;
}): string {
	const issuer = options.issuer ?? 'NOVA Admin';
	const label = encodeURIComponent(`${issuer}:${options.account}`);
	const params = new URLSearchParams({
		secret: options.secret,
		issuer,
		algorithm: 'SHA1',
		digits: String(options.digits ?? 6),
		period: String(options.stepSeconds ?? TOTP_STEP_SECONDS),
	});
	return `otpauth://totp/${label}?${params.toString()}`;
}
