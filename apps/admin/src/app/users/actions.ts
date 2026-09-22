'use server';

/**
 * User operations for the Control Center.
 *
 * Each action calls the permissioned route under `/control` and redirects back with the
 * API's own message. That matters: a 403 ("this action requires users.suspend") and a 404
 * ("user not found") need different responses from an operator, and flattening both into
 * "something went wrong" removes the only information they had.
 *
 * Suspension is reversible and revokes refresh sessions by default — a disabled account
 * whose access token is still live would keep working for up to 15 minutes, so the two
 * belong together unless the operator deliberately opts out.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { revokeUserSessions, setUserSuspended } from '../../lib/api';

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

function back(path: string, params: Record<string, string>): never {
	redirect(`${path}?${new URLSearchParams(params).toString()}`);
}

function fail(path: string, message: string): never {
	back(path, { error: message });
}

export async function suspendUserAction(formData: FormData): Promise<void> {
	const id = text(formData, 'id');
	const disabled = text(formData, 'disabled') === 'true';
	const reason = text(formData, 'reason');
	const revokeSessions = text(formData, 'revokeSessions') !== 'false';
	const returnTo = text(formData, 'returnTo') || `/users/${id}`;

	if (!id) fail('/users', 'A user id is required.');
	if (reason.length < 3) {
		fail(returnTo, 'A reason is required — suspending an account is audited.');
	}

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await setUserSuspended(id, { disabled, ...(reason ? { reason } : {}), revokeSessions });
		summary = disabled
			? `Account suspended. ${result.propagation ?? ''}`.trim()
			: 'Account reactivated. The user can sign in again.';
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not change the account status.';
	}

	if (failure) fail(returnTo, failure);
	revalidatePath('/users');
	revalidatePath(`/users/${id}`);
	back(returnTo, { ok: summary });
}

export async function revokeSessionsAction(formData: FormData): Promise<void> {
	const id = text(formData, 'id');
	const reason = text(formData, 'reason');
	const returnTo = text(formData, 'returnTo') || `/users/${id}`;

	if (!id) fail('/users', 'A user id is required.');
	if (reason.length < 3) fail(returnTo, 'A reason is required — revoking sessions is audited.');

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await revokeUserSessions(id, { ...(reason ? { reason } : {}) });
		summary = `Revoked ${result.revoked ?? 0} session(s). ${result.propagation ?? ''}`.trim();
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not revoke the sessions.';
	}

	if (failure) fail(returnTo, failure);
	revalidatePath('/users');
	revalidatePath(`/users/${id}`);
	back(returnTo, { ok: summary });
}
