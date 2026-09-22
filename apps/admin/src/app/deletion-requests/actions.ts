'use server';

/**
 * Completing a web-filed account-deletion request.
 *
 * The published policy on `/delete-account` says the request will be verified and
 * completed within 30 days. Until this action existed there was no way to do that from
 * the console: `POST /api/v1/account/deletion-request` files rows into
 * `deletion_requests` and nothing ever read them back.
 *
 * It is deliberately **not** a background job. That endpoint is public and accepts any
 * email address without authentication, so a job acting on the queue would let anyone
 * delete anyone's account — file a request for a victim's address, wait out the
 * schedule, and the account is gone. A person has to check that the requester owns the
 * account, and then say so here.
 *
 * The account is removed through the same statements as the in-app path, including the
 * literal `confirm: "DELETE"` the API requires.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { completeAccountDeletionRequest } from '../../lib/api';

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

function fail(message: string): never {
	redirect(`/deletion-requests?error=${encodeURIComponent(message)}`);
}

export async function completeDeletionRequestAction(formData: FormData): Promise<void> {
	const id = text(formData, 'id');
	if (!id) fail('A request id is required.');

	// The operator has to have typed the word. This is the same guard the API enforces
	// and the same one the mobile app uses, repeated here so a mis-click on a table row
	// cannot delete an account.
	if (text(formData, 'confirm').toUpperCase() !== 'DELETE') {
		fail('Type DELETE to confirm — this permanently removes the account.');
	}

	let failure: string | null = null;
	try {
		await completeAccountDeletionRequest(id);
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not complete the request.';
	}

	if (failure) fail(failure);
	revalidatePath('/deletion-requests');
	redirect('/deletion-requests?ok=deleted');
}
