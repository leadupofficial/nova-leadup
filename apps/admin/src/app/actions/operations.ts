'use server';

/**
 * Task and reminder operations for the Control Center.
 *
 * Both routes audit the change with the operator's reason and record a before/after
 * snapshot, so the reason is required here rather than optional: an operator adjusting a
 * user's task or reminder is acting inside that user's data, and the audit row is what
 * makes the action explicable afterwards.
 *
 * The reminder route is notable for what it does *not* promise. Moving a reminder's
 * trigger time updates the database, but the mobile client reconciles its OS alarms on
 * its next fetch or resume — there is no push — so the response says so instead of
 * implying the device already knows.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { deleteMemory, updateReminder, updateTask } from '../../lib/api';

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

function back(path: string, params: Record<string, string>): never {
	redirect(`${path}?${new URLSearchParams(params).toString()}`);
}

export async function updateTaskAction(formData: FormData): Promise<void> {
	const id = text(formData, 'id');
	const status = text(formData, 'status');
	const priority = text(formData, 'priority');
	const dueAt = text(formData, 'dueAt');
	const reason = text(formData, 'reason');
	const returnTo = text(formData, 'returnTo') || '/tasks';

	if (!id) back('/tasks', { error: 'A task id is required.' });
	if (reason.length < 3) back(returnTo, { error: 'A reason is required — task changes are audited.' });

	const body: { status?: string; priority?: string; dueAt?: string | null; reason?: string } = { reason };
	if (status) body.status = status;
	if (priority) body.priority = priority;
	// An empty due-date field means "clear it", which the API accepts as null.
	if (dueAt === '') body.dueAt = null;
	else if (dueAt) body.dueAt = new Date(dueAt).toISOString();

	let failure: string | null = null;
	try {
		await updateTask(id, body);
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not update the task.';
	}

	if (failure) back(returnTo, { error: failure });
	revalidatePath('/tasks');
	back(returnTo, { ok: 'Task updated and the change audited.' });
}

export async function updateReminderAction(formData: FormData): Promise<void> {
	const id = text(formData, 'id');
	const triggerAt = text(formData, 'triggerAt');
	const dismissed = text(formData, 'dismissed');
	const reason = text(formData, 'reason');
	const returnTo = text(formData, 'returnTo') || '/reminders';

	if (!id) back('/reminders', { error: 'A reminder id is required.' });
	if (reason.length < 3) back(returnTo, { error: 'A reason is required — reminder changes are audited.' });

	const body: { triggerAt?: string; dismissed?: boolean; reason?: string } = { reason };
	if (triggerAt) body.triggerAt = new Date(triggerAt).toISOString();
	if (dismissed === 'true' || dismissed === 'false') body.dismissed = dismissed === 'true';

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await updateReminder(id, body);
		summary = result.propagation ?? 'Reminder updated and the change audited.';
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not update the reminder.';
	}

	if (failure) back(returnTo, { error: failure });
	revalidatePath('/reminders');
	back(returnTo, { ok: summary });
}

export async function deleteMemoryAction(formData: FormData): Promise<void> {
	const id = text(formData, 'id');
	const confirm = text(formData, 'confirm');
	const returnTo = text(formData, 'returnTo') || '/memory';

	if (!id) back('/memory', { error: 'A memory id is required.' });
	// Typed confirmation: this destroys user data and is not reversible.
	if (confirm !== 'DELETE') {
		back(returnTo, { error: 'Type DELETE to confirm erasing this memory entry.' });
	}

	let failure: string | null = null;
	try {
		await deleteMemory(id);
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not delete the memory entry.';
	}

	if (failure) back(returnTo, { error: failure });
	revalidatePath('/memory');
	back(returnTo, { ok: 'Memory entry erased. The deletion is audited.' });
}
