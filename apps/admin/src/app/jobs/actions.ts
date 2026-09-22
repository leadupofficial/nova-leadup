'use server';

/**
 * Job operations for the Control Center.
 *
 * Only retry exists, because it is the only one the queue implements: there is no cancel route and
 * no purge route, and inventing a console button for either would be a control that appears to
 * work. The API refuses to retry a job that is still queued or running, and that refusal is passed
 * through verbatim — "wait for it to finish" and "the retry failed" are different messages.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { retryJob } from '../../lib/api';

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

function back(params: Record<string, string>): never {
	redirect(`/jobs?${new URLSearchParams(params).toString()}`);
}

export async function retryJobAction(formData: FormData): Promise<void> {
	const id = text(formData, 'id');
	if (!id) back({ error: 'A job id is required.' });

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await retryJob(id);
		summary = `Requeued "${result.jobName ?? id}" — attempt ${result.attempt ?? 1} of ${result.maxAttempts ?? '?'}.${result.note ? ` ${result.note}` : ''}`;
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not retry the job.';
	}

	if (failure) back({ error: failure });
	revalidatePath('/jobs');
	back({ ok: summary });
}
