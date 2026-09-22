/**
 * TOTP — checked against the RFC's own test vectors.
 *
 * RFC 6238 Appendix B publishes the expected code for a known secret at known instants. Those are
 * the only assertions that actually prove an implementation, because every mistake in the algorithm
 * — a wrong byte order for the counter, a truncation offset taken from the wrong nibble, a
 * modulo applied to the wrong width — still produces plausible six-digit numbers. A round-trip test
 * ("generate then verify") passes for all of them.
 *
 * The vectors use the ASCII secret `12345678901234567890`, which is 20 bytes and therefore base32
 * encodes to `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`.
 */
import { describe, it, expect } from 'vitest';

import {
	base32Decode,
	base32Encode,
	generateTotpSecret,
	hotp,
	otpauthUri,
	totp,
	totpCounter,
	verifyTotp,
} from '../admin/totp.js';

/** RFC 6238's shared secret, in the base32 form an authenticator app would receive. */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('base32', () => {
	it('round-trips arbitrary bytes', () => {
		const buffer = Buffer.from([0x00, 0xff, 0x7f, 0x80, 0x01, 0xab, 0xcd]);
		expect(base32Decode(base32Encode(buffer)).equals(buffer)).toBe(true);
	});

	it('encodes the RFC secret to the value the spec quotes', () => {
		// RFC 4226 §4 example secrets; this is the 20-byte one the TOTP vectors use.
		expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
	});

	it('tolerates the formatting an operator pastes', () => {
		// Lower case, spaces and padding all appear in the wild, and rejecting them makes enrolment
		// fail for a reason the user cannot see.
		expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').length).toBe(20);
		expect(base32Decode(`${RFC_SECRET}====`).length).toBe(20);
	});

	it('refuses a character outside the alphabet rather than skipping it', () => {
		// '1' and '0' are the classic transcription errors (they are not in the RFC 4648 alphabet);
		// silently dropping them would produce a different secret and a code that never works.
		expect(() => base32Decode('ABC1DEF')).toThrow(/Invalid base32/);
		expect(() => base32Decode('ABC0DEF')).toThrow(/Invalid base32/);
	});

	it('generates a 160-bit secret', () => {
		// RFC 4226 recommends 160 bits, which is 20 bytes and 32 base32 characters.
		const secret = generateTotpSecret();
		expect(base32Decode(secret).length).toBe(20);
		expect(secret).toMatch(/^[A-Z2-7]{32}$/);
	});

	it('generates a different secret every time', () => {
		expect(generateTotpSecret()).not.toBe(generateTotpSecret());
	});
});

describe('HOTP (RFC 4226 Appendix D)', () => {
	// The spec's own vectors, which pin the truncation rule exactly.
	const secret = Buffer.from('12345678901234567890', 'ascii');

	it('matches the published codes for counters 0-9', () => {
		const expected = [
			'755224', '287082', '359152', '969429', '338314',
			'254676', '287922', '162583', '399871', '520489',
		];
		expect(expected.map((_, counter) => hotp(secret, counter))).toEqual(expected);
	});
});

describe('TOTP (RFC 6238 Appendix B)', () => {
	it('matches the published eight-digit SHA-1 vectors', () => {
		const vectors: Array<[number, string]> = [
			[59, '94287082'],
			[1111111109, '07081804'],
			[1111111111, '14050471'],
			[1234567890, '89005924'],
			[2000000000, '69279037'],
			[20000000000, '65353130'],
		];
		for (const [seconds, expected] of vectors) {
			expect(totp(RFC_SECRET, new Date(seconds * 1000), { digits: 8 }), `T=${seconds}`).toBe(expected);
		}
	});

	it('matches the published SHA-256 vectors', () => {
		// The RFC's SHA-256 rows use a **32-byte** secret, not the 20-byte one the SHA-1 rows use —
		// the spec lengthens the seed to match the digest. Reusing the short secret produced codes
		// that were correctly computed and correctly different, which is how this test failed the
		// first time: the implementation was right and the vector was paired with the wrong seed.
		const sha256Secret = base32Encode(Buffer.from('12345678901234567890123456789012', 'ascii'));
		const vectors: Array<[number, string]> = [
			[59, '46119246'],
			[1111111109, '68084774'],
			[1234567890, '91819424'],
		];
		for (const [seconds, expected] of vectors) {
			expect(
				totp(sha256Secret, new Date(seconds * 1000), { digits: 8, algorithm: 'sha256' }),
				`T=${seconds}`,
			).toBe(expected);
		}
	});

	it('uses a 30-second step', () => {
		// Two instants inside the same step produce the same code; one step apart does not.
		//
		// The base is chosen to sit exactly on a step boundary (1_700_000_010 s is a multiple of 30).
		// The first version used 1_700_000_000 s, which is 20 s *into* a step — so +10 s crossed the
		// boundary and the two codes correctly differed. The test was wrong, not the clock arithmetic.
		const base = new Date(1_700_000_010_000);
		expect(totpCounter(base)).toBe(base.getTime() / 1000 / 30);
		const inStep = new Date(base.getTime() + 10_000);
		const nextStep = new Date(base.getTime() + 30_000);
		expect(totp(RFC_SECRET, base)).toBe(totp(RFC_SECRET, inStep));
		expect(totp(RFC_SECRET, base)).not.toBe(totp(RFC_SECRET, nextStep));
	});

	it('computes the counter from the instant', () => {
		expect(totpCounter(new Date(0))).toBe(0);
		expect(totpCounter(new Date(59_000))).toBe(1);
		expect(totpCounter(new Date(60_000))).toBe(2);
	});
});

describe('verification', () => {
	const instant = new Date(1_700_000_000_000);
	const code = totp(RFC_SECRET, instant);

	it('accepts the current code and reports the step it matched', () => {
		const result = verifyTotp(RFC_SECRET, code, { instant });
		expect(result.valid).toBe(true);
		expect(result).toMatchObject({ counter: totpCounter(instant) });
	});

	it('tolerates one step of clock drift in either direction', () => {
		// A phone whose clock is 20 seconds out must still work; this is the whole point of a window.
		const previous = totp(RFC_SECRET, new Date(instant.getTime() - 30_000));
		const next = totp(RFC_SECRET, new Date(instant.getTime() + 30_000));
		expect(verifyTotp(RFC_SECRET, previous, { instant }).valid).toBe(true);
		expect(verifyTotp(RFC_SECRET, next, { instant }).valid).toBe(true);
	});

	it('rejects a code two steps away in either direction', () => {
		const old = totp(RFC_SECRET, new Date(instant.getTime() - 90_000));
		const future = totp(RFC_SECRET, new Date(instant.getTime() + 90_000));
		expect(verifyTotp(RFC_SECRET, old, { instant }).valid).toBe(false);
		expect(verifyTotp(RFC_SECRET, future, { instant }).valid).toBe(false);
	});

	it('refuses a code that is not the expected shape, without touching crypto', () => {
		expect(verifyTotp(RFC_SECRET, 'abcdef', { instant })).toEqual({ valid: false, reason: 'malformed' });
		expect(verifyTotp(RFC_SECRET, '12345', { instant })).toEqual({ valid: false, reason: 'malformed' });
		expect(verifyTotp(RFC_SECRET, '1234567', { instant })).toEqual({ valid: false, reason: 'malformed' });
		expect(verifyTotp(RFC_SECRET, '', { instant })).toEqual({ valid: false, reason: 'malformed' });
	});

	it('accepts a code pasted with spaces', () => {
		const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
		expect(verifyTotp(RFC_SECRET, spaced, { instant }).valid).toBe(true);
	});

	it('rejects a wrong code', () => {
		const wrong = code === '000000' ? '111111' : '000000';
		expect(verifyTotp(RFC_SECRET, wrong, { instant }).valid).toBe(false);
	});

	it('refuses to accept the same code twice when the last step is supplied', () => {
		// Without this, the drift window is also a 90-second replay window for a code somebody read
		// over a shoulder.
		const first = verifyTotp(RFC_SECRET, code, { instant });
		expect(first.valid).toBe(true);
		const replayed = verifyTotp(RFC_SECRET, code, {
			instant,
			lastUsedCounter: (first as { counter: number }).counter,
		});
		expect(replayed).toEqual({ valid: false, reason: 'replayed' });
	});

	it('still accepts the next step after a code has been used', () => {
		const used = verifyTotp(RFC_SECRET, code, { instant }) as { counter: number };
		const nextInstant = new Date(instant.getTime() + 30_000);
		const nextCode = totp(RFC_SECRET, nextInstant);
		expect(verifyTotp(RFC_SECRET, nextCode, { instant: nextInstant, lastUsedCounter: used.counter }).valid).toBe(true);
	});

	it('rejects a code generated from a different secret', () => {
		const other = generateTotpSecret();
		expect(verifyTotp(other, code, { instant }).valid).toBe(false);
	});
});

describe('otpauth URI', () => {
	it('encodes the issuer and account so a URI parser cannot misread the label', () => {
		const uri = otpauthUri({ secret: RFC_SECRET, account: 'owner@example.com' });
		expect(uri.startsWith('otpauth://totp/')).toBe(true);
		// The `@` and the `:` must be percent-encoded: an app that splits on `@` otherwise reads
		// "example.com" as the issuer.
		expect(uri).toContain('NOVA%20Admin%3Aowner%40example.com');
		expect(uri).toContain(`secret=${RFC_SECRET}`);
		expect(uri).toContain('algorithm=SHA1');
		expect(uri).toContain('digits=6');
		expect(uri).toContain('period=30');
	});

	it('honours a custom issuer', () => {
		const uri = otpauthUri({ secret: RFC_SECRET, account: 'a@b.c', issuer: 'NOVA Staging' });
		expect(uri).toContain('issuer=NOVA+Staging');
	});
});
