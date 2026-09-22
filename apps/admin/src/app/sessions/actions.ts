'use server';

/**
 * Session operations for the Control Center.
 *
 * Revoking *one* session is the response to one compromised token. Until this route
 * existed the only lever was "revoke everything this user owns", which signs the victim
 * out of their own phone along with whoever stole the token — a correct action, but the
 * wrong one for this case. Both are audited; this one records the session id.
 *
 * The reason is required rather than optional for the same reason it is on every other
 * mutation: an audit row that says "revoked session abc" without saying why cannot be
 * reviewed later.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { revokeSession } from '../../lib/api';

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

function back(path: string, params: Record<string, string>): never {
	redirect(`${path}?${new URLSearchParams(params).toString()}`);
}

export async function revokeSessionAction(formData: FormData): Promise<void> {
	const id = text(formData, 'id');
	const reason = text(formData, 'reason');
	const returnTo = text(formData, 'returnTo') || '/sessions';

	if (!id) back('/sessions', { error: 'A session id is required.' });
	if (reason.length < 3) {
		back(returnTo, { error: 'A reason is required — revoking a session is audited.' });
	}

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await revokeSession(id, { reason });
		summary = result.alreadyRevoked
			? result.propagation
			: `Session revoked. ${result.propagation}`;
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not revoke the session.';
	}

	if (failure) back(returnTo, { error: failure });
	revalidatePath('/sessions');
	back(returnTo, { ok: summary });
}
