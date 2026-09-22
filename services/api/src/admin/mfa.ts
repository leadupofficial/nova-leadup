/**
 * NOVA — administrator two-factor authentication.
 *
 * ## What this adds, and what it does not
 *
 * Before this, an operator's account was protected by a password alone, and **that password also
 * unlocks every other NOVA surface, including the mobile app**. A second factor on the control
 * plane is what stops a password found in a breach dump from becoming control of the platform.
 *
 * It is **opt-in per account, and only for administrators**. Nothing is enforced globally, so an
 * account that has not enrolled behaves exactly as it did; the mobile client is unaffected because
 * its accounts never enrol. That is deliberate — the alternative, enforcing a factor for every
 * NOVA account, would break the app for every user who has no authenticator.
 *
 * ## The rules that make it safe to turn on
 *
 * 1. **Enrolment does not gate anything until it is confirmed.** The secret is written immediately,
 *    but `confirmed_at` stays NULL until the operator proves they can generate a code from it, and
 *    only a confirmed row requires a factor at sign-in. An abandoned or mistyped enrolment therefore
 *    cannot lock anybody out — the property that matters most, because the alternative failure mode
 *    is an operator locked out of the platform that holds the recovery path.
 * 2. **Ten single-use recovery codes, issued once.** A lost phone must not mean a lost platform.
 *    They are shown exactly once, at confirmation, and stored only as hashes.
 * 3. **A code cannot be replayed.** The accepted TOTP step is recorded, and the verifier rejects any
 *    step at or before it — otherwise the ±1-step drift window is also a 90-second replay window.
 * 4. **Disabling requires the account, not a role.** Any operator may remove their own factor; the
 *    audit row records who did it. A SUPER_ADMIN cannot silently strip another operator's.
 *
 * ## The secret at rest
 *
 * Encrypted with the existing AES-256-GCM path in `admin/secrets.ts`, the same one
 * `system_configs.secret_ciphertext` uses. A TOTP secret is a long-lived credential: whoever reads
 * one can generate valid codes forever, so plaintext storage would make the second factor weaker
 * than the password it guards. The migration's `CHECK` means a row cannot exist without ciphertext.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { adminMfa } from '@nova/database';
import { getDb, getDbPool } from '../db/connection.js';
import { decryptSecret, encryptSecret } from './secrets.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

/** How many single-use recovery codes enrolment issues. */
export const RECOVERY_CODE_COUNT = 10;

/** Where enrolment sends the operator. Named so the URI carries something recognisable. */
const ISSUER = 'NOVA Admin';

type RecoveryCode = { hash: string; usedAt: string | null };

export type MfaStatus = {
	/** True when a row exists at all — enrolment started, possibly not finished. */
	enrolled: boolean;
	/** True when a factor is actually required at sign-in. */
	confirmed: boolean;
	confirmedAt: string | null;
	/** How many recovery codes have not been used. Count only; never the codes. */
	remainingRecoveryCodes: number;
	/** The last TOTP step accepted, as a proxy for "when was it last used". Null if never. */
	lastUsedCounter: number | null;
};

function hashRecoveryCode(code: string): string {
	// Domain-separated like `fingerprintSecret`, and normalised so a pasted code with spaces or
	// lower case still matches — the user is copying it from a printed list.
	const normalised = code.replace(/[\s-]/g, '').toUpperCase();
	return createHash('sha256').update(`nova-mfa-recovery:${normalised}`).digest('hex');
}

/** `XXXX-XXXX-XXXX`, easy to read from a printout without ambiguity. */
function generateRecoveryCode(): string {
	const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
	const bytes = randomBytes(12);
	let out = '';
	for (let index = 0; index < 12; index += 1) {
		out += alphabet[bytes[index] % alphabet.length];
	}
	return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

function parseRecoveryCodes(value: unknown): RecoveryCode[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is RecoveryCode => !!entry && typeof entry === 'object' && typeof (entry as RecoveryCode).hash === 'string')
		.map((entry) => ({ hash: entry.hash, usedAt: entry.usedAt ?? null }));
}

/** The raw row, or null. */
async function readRow(userId: string) {
	const db = getDb();
	const [row] = await db.select().from(adminMfa).where(eq(adminMfa.userId, userId)).limit(1);
	return row ?? null;
}

/**
 * True when this account must supply a second factor to sign in.
 *
 * Used by the login route, so it is written to be cheap and to fail **closed**: a read error
 * propagates rather than returning false, because a database problem must not be the thing that
 * silently removes a second factor. (The caller turns that into a 500; an operator retries.)
 */
export async function requiresSecondFactor(userId: string): Promise<boolean> {
	// Read through the pool rather than Drizzle on purpose. This is on the **login** path, which
	// almost every route test exercises; a Drizzle `getDb()` read here consumes the scripted mock
	// that the surrounding test set up for its own route, which is how a `META`-style change to
	// authentication once broke eighteen unrelated tests. A single existence check does not need the
	// query builder, and the shared harness already answers `getDbPool()` queries.
	const { rows } = await getDbPool().query<{ confirmed: boolean }>(
		`SELECT (confirmed_at IS NOT NULL) AS confirmed FROM admin_mfa WHERE user_id = $1 LIMIT 1`,
		[userId],
	);
	return rows[0]?.confirmed === true;
}

export async function mfaStatusFor(userId: string): Promise<MfaStatus> {
	const row = await readRow(userId);
	if (!row) {
		return { enrolled: false, confirmed: false, confirmedAt: null, remainingRecoveryCodes: 0, lastUsedCounter: null };
	}
	const codes = parseRecoveryCodes(row.recoveryCodes);
	return {
		enrolled: true,
		confirmed: row.confirmedAt !== null,
		confirmedAt: row.confirmedAt ? new Date(row.confirmedAt).toISOString() : null,
		remainingRecoveryCodes: codes.filter((code) => code.usedAt === null).length,
		lastUsedCounter: row.lastUsedCounter ?? null,
	};
}

export type EnrolmentStart = {
	/** Shown once, for manual entry. Never returned again. */
	secret: string;
	/** What an authenticator app scans. */
	otpauthUri: string;
};

/**
 * Starts (or restarts) enrolment.
 *
 * **Restarting replaces an unconfirmed enrolment and refuses to replace a confirmed one.** A
 * confirmed factor is only removable through `disableMfa`, which is audited and takes the account's
 * own password — otherwise this endpoint would be a way to re-enrol an account whose factor you
 * already control, or to silently displace one you do not.
 */
export async function beginEnrolment(
	userId: string,
	email: string,
): Promise<EnrolmentStart | { blocked: 'already-confirmed' }> {
	const existing = await readRow(userId);
	if (existing?.confirmedAt) return { blocked: 'already-confirmed' };

	const secret = generateTotpSecret();
	const ciphertext = encryptSecret(secret);
	const db = getDb();

	if (existing) {
		await db
			.update(adminMfa)
			.set({ secretCiphertext: ciphertext, recoveryCodes: [], lastUsedCounter: null, updatedAt: new Date() })
			.where(eq(adminMfa.userId, userId));
	} else {
		await db.insert(adminMfa).values({ userId, secretCiphertext: ciphertext });
	}

	return { secret, otpauthUri: otpauthUri({ secret, account: email, issuer: ISSUER }) };
}

/**
 * Confirms enrolment with a code from the new secret, and issues the recovery codes.
 *
 * The codes are returned **once**. Nothing can re-read them: the table holds only hashes, so a lost
 * printout means regenerating the set, which is an audited action.
 */
export async function confirmEnrolment(
	userId: string,
	code: string,
): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; reason: 'not-started' | 'already-confirmed' | 'invalid-code' }> {
	const row = await readRow(userId);
	if (!row) return { ok: false, reason: 'not-started' };
	if (row.confirmedAt) return { ok: false, reason: 'already-confirmed' };

	let secret: string;
	try {
		secret = decryptSecret(row.secretCiphertext);
	} catch {
		// A secret that cannot be decrypted is unusable; say the code is invalid rather than
		// leaking which part of the pipeline failed.
		return { ok: false, reason: 'invalid-code' };
	}

	if (!verifyTotp(secret, code).valid) return { ok: false, reason: 'invalid-code' };

	const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
	await getDb()
		.update(adminMfa)
		.set({
			confirmedAt: new Date(),
			recoveryCodes: codes.map((value) => ({ hash: hashRecoveryCode(value), usedAt: null })),
			updatedAt: new Date(),
		})
		.where(eq(adminMfa.userId, userId));

	return { ok: true, recoveryCodes: codes };
}

export type SecondFactorResult =
	| { ok: true; method: 'totp' | 'recovery'; remainingRecoveryCodes: number }
	| { ok: false; reason: 'not-enrolled' | 'invalid-code' | 'replayed' };

/**
 * Verifies a submitted factor — a TOTP code or a recovery code.
 *
 * TOTP is tried first because it is the common path and a recovery code cannot be confused with a
 * six-digit number (they are twelve characters with dashes).
 *
 * Both paths are single-use. TOTP records the accepted step and rejects anything at or before it;
 * a recovery code is struck off the list. Neither is logged: the only thing written is a counter or
 * a `usedAt` timestamp.
 */
export async function verifySecondFactor(userId: string, code: string): Promise<SecondFactorResult> {
	const row = await readRow(userId);
	if (!row || !row.confirmedAt) return { ok: false, reason: 'not-enrolled' };

	let secret: string;
	try {
		secret = decryptSecret(row.secretCiphertext);
	} catch {
		return { ok: false, reason: 'invalid-code' };
	}

	const attempt = verifyTotp(secret, code, { lastUsedCounter: row.lastUsedCounter });
	if (attempt.valid) {
		await getDb()
			.update(adminMfa)
			.set({ lastUsedCounter: attempt.counter, updatedAt: new Date() })
			.where(eq(adminMfa.userId, userId));
		const remaining = parseRecoveryCodes(row.recoveryCodes).filter((entry) => entry.usedAt === null).length;
		return { ok: true, method: 'totp', remainingRecoveryCodes: remaining };
	}
	if (attempt.reason === 'replayed') return { ok: false, reason: 'replayed' };

	// Recovery codes: compare against every unused hash in constant time, without short-circuiting,
	// so the number of comparisons does not reveal which entry matched (or how many remain).
	const submitted = Buffer.from(hashRecoveryCode(code), 'utf8');
	const codes = parseRecoveryCodes(row.recoveryCodes);
	let matchedIndex = -1;
	for (let index = 0; index < codes.length; index += 1) {
		const entry = codes[index];
		if (entry.usedAt !== null) continue;
		const stored = Buffer.from(entry.hash, 'utf8');
		if (stored.length === submitted.length && timingSafeEqual(stored, submitted) && matchedIndex === -1) {
			matchedIndex = index;
		}
	}
	if (matchedIndex === -1) return { ok: false, reason: 'invalid-code' };

	const updated = codes.map((entry, index) =>
		index === matchedIndex ? { ...entry, usedAt: new Date().toISOString() } : entry,
	);
	await getDb()
		.update(adminMfa)
		.set({ recoveryCodes: updated, updatedAt: new Date() })
		.where(eq(adminMfa.userId, userId));

	return {
		ok: true,
		method: 'recovery',
		remainingRecoveryCodes: updated.filter((entry) => entry.usedAt === null).length,
	};
}

/** Removes the factor entirely. Returns false when there was nothing to remove. */
export async function disableMfa(userId: string): Promise<boolean> {
	const db = getDb();
	const existing = await readRow(userId);
	if (!existing) return false;
	await db.delete(adminMfa).where(eq(adminMfa.userId, userId));
	return true;
}

/**
 * Replaces the recovery-code set.
 *
 * **Requires a currently valid factor.** Without that, a stolen session could mint itself ten
 * permanent bypass codes, which would be a strictly worse position than not having MFA at all.
 */
export async function regenerateRecoveryCodes(
	userId: string,
	code: string,
): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; reason: string }> {
	const verified = await verifySecondFactor(userId, code);
	if (!verified.ok) return { ok: false, reason: verified.reason };

	const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
	await getDb()
		.update(adminMfa)
		.set({
			recoveryCodes: codes.map((value) => ({ hash: hashRecoveryCode(value), usedAt: null })),
			updatedAt: new Date(),
		})
		.where(eq(adminMfa.userId, userId));

	return { ok: true, recoveryCodes: codes };
}

/**
 * How many administrators have a confirmed factor.
 *
 * Reported on the Security Center so "MFA is available" cannot be mistaken for "MFA is in use" —
 * the honest figure is the count of operators actually covered.
 */
export async function countEnrolledAdmins(): Promise<{ confirmed: number; pending: number; adminsWithout: number }> {
	const { rows } = await getDbPool().query<{ confirmed: string; pending: string; admins_without: string }>(
		`SELECT
			count(m.id) FILTER (WHERE m.confirmed_at IS NOT NULL)::int AS confirmed,
			count(m.id) FILTER (WHERE m.confirmed_at IS NULL)::int AS pending,
			(SELECT count(*) FROM platform_admin_roles r
			  WHERE NOT EXISTS (
				SELECT 1 FROM admin_mfa m2 WHERE m2.user_id = r.user_id AND m2.confirmed_at IS NOT NULL
			  ))::int AS admins_without
		 FROM admin_mfa m`,
	);
	const row = rows[0];
	return {
		confirmed: Number(row?.confirmed ?? 0),
		pending: Number(row?.pending ?? 0),
		adminsWithout: Number(row?.admins_without ?? 0),
	};
}
