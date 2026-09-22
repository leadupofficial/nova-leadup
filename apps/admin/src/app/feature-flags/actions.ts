'use server';

/**
 * Feature-flag mutations for the Control Center.
 *
 * These target the newer key-addressed routes in `routes/admin/system.ts`
 * (`/admin/feature-flags/:key`), not the id-addressed legacy pair in
 * `routes/admin.ts`. The key is the stable identity an operator reasons about, and
 * targeting it means the console cannot act on the wrong flag after a re-create.
 *
 * Every mutation carries a `reason`. The API enforces that for the actions that need
 * it, and the audit row is what makes a flag change reviewable after the fact — the
 * whole reason `admin_audit_logs` exists.
 *
 * Failures redirect back with the API's own message rather than a generic string: a
 * 403 ("this action requires feature_flags.write") and a 404 ("unknown flag") need
 * different responses from the operator.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
	deleteFlag,
	deleteFlagOverride,
	setFlagOverride,
	updateFlag,
	upsertFlag,
} from '../../lib/api';

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

function back(params: Record<string, string>): never {
	redirect(`/feature-flags?${new URLSearchParams(params).toString()}`);
}

function fail(message: string): never {
	back({ error: message });
}

export async function createFlagAction(formData: FormData): Promise<void> {
	const key = text(formData, 'key');
	const description = text(formData, 'description');
	const reason = text(formData, 'reason');
	const rolloutRaw = Number.parseInt(text(formData, 'rolloutPercent') || '0', 10);
	const rolloutPercent = Number.isFinite(rolloutRaw) ? Math.min(100, Math.max(0, rolloutRaw)) : 0;
	const enabled = text(formData, 'enabled') === 'true';

	if (!key) fail('A flag key is required.');
	if (!/^[A-Z][A-Z0-9_]{1,99}$/.test(key)) {
		fail('A flag key must be upper-case letters, digits and underscores, e.g. PROACTIVE_ASSISTANT.');
	}
	if (description.length < 5) fail('Describe what the flag controls — the next operator will thank you.');

	let failure: string | null = null;
	try {
		await upsertFlag({
			key,
			enabled,
			rolloutPercent,
			...(description ? { description } : {}),
			...(reason ? { reason } : {}),
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not create the flag.';
	}

	if (failure) fail(failure);
	revalidatePath('/feature-flags');
	back({ ok: `created ${key}` });
}

export async function updateFlagAction(formData: FormData): Promise<void> {
	const key = text(formData, 'key');
	const reason = text(formData, 'reason');
	if (!key) fail('A flag key is required.');

	const patch: { enabled?: boolean; rolloutPercent?: number; description?: string; reason?: string } = {};
	const enabledRaw = text(formData, 'enabled');
	if (enabledRaw === 'true' || enabledRaw === 'false') patch.enabled = enabledRaw === 'true';

	const rolloutRaw = text(formData, 'rolloutPercent');
	if (rolloutRaw) {
		const parsed = Number.parseInt(rolloutRaw, 10);
		if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
			fail('Rollout percentage must be a whole number between 0 and 100.');
		}
		patch.rolloutPercent = parsed;
	}

	const description = text(formData, 'description');
	if (description) patch.description = description;
	if (reason) patch.reason = reason;

	if (Object.keys(patch).filter((k) => k !== 'reason').length === 0) {
		fail('Nothing to change.');
	}

	let failure: string | null = null;
	try {
		await updateFlag(key, patch);
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not update the flag.';
	}

	if (failure) fail(failure);
	revalidatePath('/feature-flags');
	back({ ok: `updated ${key}` });
}

export async function deleteFlagAction(formData: FormData): Promise<void> {
	const key = text(formData, 'key');
	const reason = text(formData, 'reason');
	if (!key) fail('A flag key is required.');

	// Typed confirmation, validated server-side. The page is a Server Component and
	// cannot attach `onSubmit`, and a client-only confirm would not be a guard anyway.
	if (text(formData, 'confirm') !== key) {
		fail(`Type the flag key (${key}) exactly to confirm deletion.`);
	}

	let failure: string | null = null;
	try {
		await deleteFlag(key, { confirm: key, ...(reason ? { reason } : {}) });
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not delete the flag.';
	}

	if (failure) fail(failure);
	revalidatePath('/feature-flags');
	back({ ok: `deleted ${key}` });
}

export async function setOverrideAction(formData: FormData): Promise<void> {
	const key = text(formData, 'key');
	const scopeType = text(formData, 'scopeType') as 'environment' | 'user' | 'organization';
	const scopeValue = text(formData, 'scopeValue');
	const reason = text(formData, 'reason');
	const enabled = text(formData, 'enabled') === 'true';
	const rolloutRaw = text(formData, 'rolloutPercent');

	if (!key) fail('A flag key is required.');
	if (!['environment', 'user', 'organization'].includes(scopeType)) fail('Unknown override scope.');
	if (!scopeValue) fail('A scope value is required (an environment name, user id or organization id).');

	const body: {
		scopeType: 'environment' | 'user' | 'organization';
		scopeValue: string;
		enabled: boolean;
		rolloutPercent?: number | null;
		reason?: string;
	} = { scopeType, scopeValue, enabled };
	if (rolloutRaw) {
		const parsed = Number.parseInt(rolloutRaw, 10);
		if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
			fail('Override rollout must be a whole number between 0 and 100.');
		}
		body.rolloutPercent = parsed;
	}
	if (reason) body.reason = reason;

	let failure: string | null = null;
	try {
		await setFlagOverride(key, body);
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not save the override.';
	}

	if (failure) fail(failure);
	revalidatePath('/feature-flags');
	back({ ok: `override set on ${key}` });
}

export async function deleteOverrideAction(formData: FormData): Promise<void> {
	const key = text(formData, 'key');
	const scopeType = text(formData, 'scopeType');
	const scopeValue = text(formData, 'scopeValue');
	const reason = text(formData, 'reason');
	if (!key || !scopeType || !scopeValue) fail('Flag key, scope and scope value are all required.');

	let failure: string | null = null;
	try {
		await deleteFlagOverride(key, { scopeType, scopeValue, ...(reason ? { reason } : {}) });
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not remove the override.';
	}

	if (failure) fail(failure);
	revalidatePath('/feature-flags');
	back({ ok: `override removed from ${key}` });
}
