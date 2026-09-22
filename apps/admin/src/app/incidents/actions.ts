'use server';

/**
 * Incident mutations.
 *
 * The Resolve button posted to `/incidents/{id}/resolve`, a route that does not exist
 * in this app — `find apps/admin/src -name route.ts` returns nothing. The
 * `resolveIncident` helper was imported by the page and never called. Wired here as a
 * server action so the request carries the server-side session cookie.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { resolveIncident } from '../../lib/api';

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

function fail(message: string): never {
	redirect(`/incidents?error=${encodeURIComponent(message)}`);
}

export async function resolveIncidentAction(formData: FormData): Promise<void> {
	const id = text(formData, 'id');
	if (!id) fail('An incident id is required.');

	let failure: string | null = null;
	try {
		await resolveIncident(id);
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not resolve the incident.';
	}

	if (failure) fail(failure);
	revalidatePath('/incidents');
	redirect('/incidents?ok=resolved');
}
