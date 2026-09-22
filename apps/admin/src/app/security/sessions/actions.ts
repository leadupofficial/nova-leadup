'use server';

/**
 * Ending an administrator session.
 *
 * One action, one reason, one audit row. The reason is required rather than optional because this
 * is a security action taken *against a person*: without it the audit log answers "who ended whose
 * session" and not "why", which is the question asked afterwards.
 *
 * The refusal for a caller's own session is left to the API (`409 SELF_SESSION`) rather than
 * duplicated here, so there is one definition of the guard and the server's message — which names
 * the action to use instead — reaches the operator verbatim.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { revokeAdminSession } from '../../../lib/api';

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

/**
 * Redirects back to the listing with a message.
 *
 * The filter state travels in `returnTo` as a full query string, so the separator is chosen from
 * what is already there — appending a second `?` produced a URL whose later filters were silently
 * part of the first value.
 */
function back(returnTo: string, params: Record<string, string>): never {
	const separator = returnTo.includes('?') ? '&' : '?';
	redirect(`${returnTo}${separator}${new URLSearchParams(params).toString()}`);
}

export async function revokeAdminSessionAction(formData: FormData): Promise<void> {
	const id = text(formData, 'id');
	const reason = text(formData, 'reason');
	const returnTo = text(formData, 'returnTo') || '/security/sessions';

	if (!id) back(returnTo, { error: 'A session id is required.' });
	if (reason.length < 3) back(returnTo, { error: 'A reason is required — ending an operator session is audited.' });

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await revokeAdminSession(id, { reason });
		summary = result.alreadyRevoked ? result.propagation : `Session ended. ${result.propagation}`;
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not end the session.';
	}

	if (failure) back(returnTo, { error: failure });
	revalidatePath('/security/sessions');
	back(returnTo, { ok: summary });
}
