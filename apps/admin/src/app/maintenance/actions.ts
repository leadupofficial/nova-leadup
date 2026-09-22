'use server';

/**
 * Maintenance mode and emergency kill-switch mutations.
 *
 * Every one of these changes what real users can do, so each requires a reason, is
 * audited, and returns the concrete consequence rather than a bare success. The API
 * enforces `kill_switch.manage` (and `maintenance.manage` for maintenance-scope keys),
 * so a role without the permission gets a 403 that is itself recorded as a denied
 * attempt.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { setControl, setMaintenance } from '../../lib/api';

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

function back(params: Record<string, string>): never {
	redirect(`/maintenance?${new URLSearchParams(params).toString()}`);
}

function fail(message: string): never {
	back({ error: message });
}

export async function setControlAction(formData: FormData): Promise<void> {
	const key = text(formData, 'key');
	const rawValue = text(formData, 'value');
	const reason = text(formData, 'reason');

	if (!key) fail('A control key is required.');
	if (reason.length < 3) {
		fail('A reason is required. An emergency control with no explanation is indistinguishable from an accident.');
	}

	// Typed confirmation for switching a capability OFF, matching how destructive
	// actions elsewhere in the console are guarded. Turning something back ON is
	// deliberately easier: restoring service should not be impeded.
	const disabling = rawValue === 'false';
	if (disabling && text(formData, 'confirm') !== 'DISABLE') {
		fail('Type DISABLE to confirm switching this capability off.');
	}

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await setControl(key, {
			value: rawValue === 'true' || rawValue === 'false' ? rawValue === 'true' : rawValue,
			reason,
		});
		const warnings = result.warnings?.length ? ` ${result.warnings.join(' ')}` : '';
		summary = `${key}: ${result.previous ?? '(unset)'} → ${result.next}. ${result.propagation}${warnings}`;
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not change the control.';
	}

	if (failure) fail(failure);
	revalidatePath('/maintenance');
	revalidatePath('/');
	back({ ok: summary });
}

export async function setMaintenanceAction(formData: FormData): Promise<void> {
	const enabled = text(formData, 'enabled') === 'true';
	const message = text(formData, 'message');
	const note = text(formData, 'note');
	const reason = text(formData, 'reason');

	if (reason.length < 3) fail('A reason is required.');

	if (enabled && text(formData, 'confirm') !== 'MAINTENANCE') {
		fail('Type MAINTENANCE to confirm taking NOVA offline for users.');
	}
	if (enabled && message.length < 10) {
		fail('Write the message users will see — a blank maintenance notice tells them nothing.');
	}

	let failure: string | null = null;
	let summary = '';
	try {
		const controls = await setMaintenance({
			enabled,
			...(message ? { message } : {}),
			...(note ? { note } : {}),
			reason,
		});
		summary = enabled
			? `Maintenance mode is ON. Users see: “${controls.maintenanceMessage}”. AI and voice requests are refused with 503.`
			: 'Maintenance mode is OFF. Normal service resumed.';
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not change maintenance mode.';
	}

	if (failure) fail(failure);
	revalidatePath('/maintenance');
	revalidatePath('/');
	back({ ok: summary });
}
