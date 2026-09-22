'use server';

/**
 * Two-factor enrolment for the signed-in operator.
 *
 * Each action returns the value the page needs to show **once** — the secret at enrolment, the
 * recovery codes at confirmation — rather than storing it anywhere. That is the point: the secret is
 * ciphertext at rest and the recovery codes are hashes, so this is the only moment either can be
 * read, and the console keeps them in the page's own state rather than in a cookie or a cache.
 *
 * The API owns every rule (an unconfirmed enrolment does not gate sign-in, disabling needs the
 * password *and* a code, a confirmed account cannot be silently re-enrolled). Nothing is
 * re-implemented here, so a change to those rules cannot drift from what the console shows.
 */

import { revalidatePath } from 'next/cache';
import {
	beginMfaEnrolment,
	confirmMfaEnrolment,
	disableMfa,
	regenerateMfaRecoveryCodes,
	type MfaEnrolmentStart,
} from '../../../lib/api';

export type MfaActionState =
	| { kind: 'idle' }
	| { kind: 'enrolling'; enrolment: MfaEnrolmentStart }
	| { kind: 'confirmed'; recoveryCodes: string[] }
	| { kind: 'regenerated'; recoveryCodes: string[] }
	| { kind: 'error'; message: string };

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

function message(error: unknown, fallback: string): string {
	if (!(error instanceof Error)) return fallback;
	// The API's message is more specific than anything this layer could invent, and it is written
	// for an operator. The status prefix `request()` adds is stripped so the operator reads a
	// sentence rather than "Admin API 409 Conflict on ...".
	return error.message.replace(/^Admin API \d+ [^:]*: /, '') || fallback;
}

/** Starts enrolment. Returns the secret and the `otpauth://` URI, both shown once. */
export async function beginMfaEnrolmentAction(
	_prev: MfaActionState,
	form: FormData,
): Promise<MfaActionState> {
	void form;
	try {
		return { kind: 'enrolling', enrolment: await beginMfaEnrolment() };
	} catch (error) {
		return { kind: 'error', message: message(error, 'Could not start enrolment.') };
	}
}

/** Confirms with a code from the new secret, and returns the recovery codes once. */
export async function confirmMfaEnrolmentAction(
	_prev: MfaActionState,
	form: FormData,
): Promise<MfaActionState> {
	const code = text(form, 'code');
	if (!code) return { kind: 'error', message: 'Enter the code your authenticator app shows.' };
	try {
		const result = await confirmMfaEnrolment(code);
		revalidatePath('/security/mfa');
		return { kind: 'confirmed', recoveryCodes: result.recoveryCodes };
	} catch (error) {
		return { kind: 'error', message: message(error, 'That code was not accepted.') };
	}
}

/** Replaces the recovery codes. Requires a currently valid factor. */
export async function regenerateMfaCodesAction(
	_prev: MfaActionState,
	form: FormData,
): Promise<MfaActionState> {
	const code = text(form, 'code');
	if (!code) return { kind: 'error', message: 'Enter a current code to replace your recovery codes.' };
	try {
		const result = await regenerateMfaRecoveryCodes(code);
		revalidatePath('/security/mfa');
		return { kind: 'regenerated', recoveryCodes: result.recoveryCodes };
	} catch (error) {
		return { kind: 'error', message: message(error, 'Could not replace the recovery codes.') };
	}
}

/**
 * Disables the factor. Needs the account password **and** a current code.
 *
 * Both, not either: the password proves the person at the keyboard is the account holder and the
 * code proves they still hold the second factor. Requiring only the password would make a phished
 * password sufficient to remove the control installed against phishing.
 */
export async function disableMfaAction(_prev: MfaActionState, form: FormData): Promise<MfaActionState> {
	const password = text(form, 'password');
	const code = text(form, 'code');
	if (!password || !code) {
		return { kind: 'error', message: 'Both your password and a current code are required to disable two-factor authentication.' };
	}
	try {
		await disableMfa(password, code);
		revalidatePath('/security/mfa');
		return { kind: 'idle' };
	} catch (error) {
		return { kind: 'error', message: message(error, 'Could not disable two-factor authentication.') };
	}
}
