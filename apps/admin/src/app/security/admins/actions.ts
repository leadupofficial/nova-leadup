'use server';

/**
 * Platform role assignment.
 *
 * This is the most dangerous surface in the console — the permission involved grants every
 * other permission — so the guards are not duplicated here. The API refuses a grant above the
 * caller's own rank, refuses self-changes, and refuses to remove the last administrator; this
 * layer's job is only to require a reason and surface the server's own error code, which names
 * *which* guard refused. Flattening those into "could not save" would hide the one piece of
 * information an operator needs.
 *
 * Revocation needs a typed `REVOKE`, matching how the other irreversible actions in this
 * console are guarded.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { grantPlatformRole, revokePlatformRole } from '../../../lib/api';

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

function back(params: Record<string, string>): never {
	redirect(`/security/admins?${new URLSearchParams(params).toString()}`);
}

export async function grantRoleAction(formData: FormData): Promise<void> {
	const userId = text(formData, 'userId');
	const role = text(formData, 'role');
	const reason = text(formData, 'reason');

	if (!userId) back({ error: 'Select an account to grant a role to.' });
	if (!role) back({ error: 'Select a role.' });
	if (reason.length < 3) {
		back({ error: 'A reason is required — granting a role is audited.' });
	}

	const confirming = text(formData, 'confirm');
	// A grant that includes admin_users.manage can hand out every other permission, so it
	// takes the same typed confirmation as a destructive action.
	if (role === 'SUPER_ADMIN' && confirming !== 'SUPER_ADMIN') {
		back({ error: 'Type SUPER_ADMIN to confirm granting the highest role.' });
	}

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await grantPlatformRole(userId, { role, reason });
		summary = `${result.role} granted (${result.permissionCount} permission(s)). ${result.propagation}`;
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not grant the role.';
	}

	if (failure) back({ error: failure });
	revalidatePath('/security/admins');
	back({ ok: summary });
}

export async function revokeRoleAction(formData: FormData): Promise<void> {
	const userId = text(formData, 'userId');
	const reason = text(formData, 'reason');
	const confirm = text(formData, 'confirm');

	if (!userId) back({ error: 'A user id is required.' });
	if (reason.length < 3) back({ error: 'A reason is required — revoking a role is audited.' });
	if (confirm !== 'REVOKE') back({ error: 'Type REVOKE to confirm removing this role.' });

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await revokePlatformRole(userId, { reason, confirm: 'REVOKE' });
		summary = result.propagation;
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not revoke the role.';
	}

	if (failure) back({ error: failure });
	revalidatePath('/security/admins');
	back({ ok: summary });
}
