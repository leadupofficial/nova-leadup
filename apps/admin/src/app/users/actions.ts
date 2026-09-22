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
import { resetUserState, revokeUserSessions, setUserSuspended, updateUser } from '../../lib/api';

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

/**
 * Correct the safe per-account fields.
 *
 * Only fields the operator actually filled in are sent: an empty input means "leave this alone",
 * not "set it to empty". Sending `name: ''` would replace a person's name with a blank, and the
 * API's schema would reject the empty string anyway — turning an untouched field into a 400 that
 * looks like the edit failed.
 */
export async function updateUserAction(formData: FormData): Promise<void> {
	const id = text(formData, 'id');
	const returnTo = text(formData, 'returnTo') || `/users/${id}`;
	if (!id) fail('/users', 'A user id is required.');

	const body: Parameters<typeof updateUser>[1] = {};
	const name = text(formData, 'name');
	const locale = text(formData, 'locale');
	const timezone = text(formData, 'timezone');
	const reason = text(formData, 'reason');

	if (name) body.name = name;
	if (locale) body.locale = locale;
	if (timezone) body.timezone = timezone;
	if (reason) body.reason = reason;

	// Checkboxes only appear in FormData when ticked, so an unticked box is indistinguishable from
	// an untouched one. Reading them as tri-state (`''` = untouched) keeps "don't change this"
	// and "set this to false" different operations.
	for (const field of ['emailVerified', 'phoneVerified'] as const) {
		const raw = text(formData, field);
		if (raw === 'true') body[field] = true;
		if (raw === 'false') body[field] = false;
	}

	if (Object.keys(body).filter((key) => key !== 'reason').length === 0) {
		fail(returnTo, 'Nothing to change — fill in at least one field.');
	}

	let failure: string | null = null;
	try {
		await updateUser(id, body);
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not update the account.';
	}

	if (failure) fail(returnTo, failure);
	revalidatePath('/users');
	revalidatePath(`/users/${id}`);
	back(returnTo, { ok: 'Account updated. The change is in the audit log with your reason.' });
}

/**
 * Clear stored memory and/or cancel pending reminders for a user.
 *
 * Both are destructive and irreversible, so the form requires a reason and the confirmation is
 * typed: the operator must write CLEAR in the box. The API already requires the reason; the typed
 * word is what stops a mis-click on a page that also contains routine actions.
 */
export async function resetUserStateAction(formData: FormData): Promise<void> {
	const id = text(formData, 'id');
	const returnTo = text(formData, 'returnTo') || `/users/${id}`;
	const reason = text(formData, 'reason');
	const confirm = text(formData, 'confirm');
	const clearMemories = text(formData, 'clearMemories') === 'on';
	const cancelReminders = text(formData, 'cancelReminders') === 'on';

	if (!id) fail('/users', 'A user id is required.');
	if (!clearMemories && !cancelReminders) fail(returnTo, 'Choose at least one thing to reset.');
	if (confirm !== 'CLEAR') fail(returnTo, 'Type CLEAR to confirm — this cannot be undone.');
	if (reason.length < 3) fail(returnTo, 'A reason is required — this action is audited.');

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await resetUserState(id, { reason, clearMemories, cancelReminders });
		const parts = [
			clearMemories ? `${result.memoriesCleared ?? 0} memor${(result.memoriesCleared ?? 0) === 1 ? 'y' : 'ies'} cleared` : null,
			cancelReminders ? `${result.remindersCancelled ?? 0} reminder(s) cancelled` : null,
		].filter(Boolean);
		summary = `Reset state: ${parts.join(', ')}.`;
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not reset the account state.';
	}

	if (failure) fail(returnTo, failure);
	revalidatePath('/users');
	revalidatePath(`/users/${id}`);
	back(returnTo, { ok: summary });
}
