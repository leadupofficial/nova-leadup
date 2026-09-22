'use server';

/**
 * Configuration and secret mutations.
 *
 * Two distinct paths, and the distinction is the security model:
 *
 *  - `updateConfigAction` writes a **non-secret** value. Plaintext in the database,
 *    returned to the console, editable.
 *  - `writeSecretAction` writes a **secret**. AES-256-GCM encrypted before it reaches
 *    the database, never returned, and only ever replaceable — never readable.
 *
 * The API refuses a secret write through the plain config route (`403
 * SECRETS_REQUIRE_DEDICATED_ENDPOINT`) and refuses a config write to an
 * environment-only key (`409 ENV_ONLY`). Those refusals are surfaced verbatim rather
 * than being pre-empted here, because the server's message explains the reason.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { deleteSecret, updateConfig, writeSecret } from '../../lib/api';

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

function back(params: Record<string, string>): never {
	redirect(`/configuration?${new URLSearchParams(params).toString()}`);
}

function fail(message: string): never {
	back({ error: message });
}

export async function updateConfigAction(formData: FormData): Promise<void> {
	const key = text(formData, 'key');
	const value = text(formData, 'value');
	const reason = text(formData, 'reason');
	if (!key) fail('A configuration key is required.');

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await updateConfig(key, { value, ...(reason ? { reason } : {}) });
		const affected = result.affectedServices?.join(', ') || 'no registered consumer';
		summary =
			`${key}: ${result.before ?? '(unset)'} → ${result.after}. ` +
			`Affects: ${affected}. ` +
			(result.restartRequired
				? 'A restart is required for this key to take effect everywhere.'
				: 'Applied immediately in this process.');
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not update the configuration.';
	}

	if (failure) fail(failure);
	revalidatePath('/configuration');
	back({ ok: summary });
}

export async function writeSecretAction(formData: FormData): Promise<void> {
	const key = text(formData, 'key');
	const value = text(formData, 'value');
	const reason = text(formData, 'reason');
	const confirm = text(formData, 'confirm');

	if (!key) fail('A secret key is required.');
	if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
		fail('A secret key must be upper-case letters, digits and underscores, e.g. ANTHROPIC_API_KEY.');
	}
	if (!value) fail('A secret value is required.');
	if (reason.length < 3) fail('A reason is required — rotating a credential is audited.');

	// Typed confirmation. Replacing a credential breaks every caller of it if the new
	// value is wrong, so this is deliberately not a one-click action.
	if (confirm !== key) {
		fail(`Type the key name (${key}) to confirm replacing this credential.`);
	}

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await writeSecret(key, { value, reason });
		summary = `${key} ${result.rotated ? 'rotated' : 'stored'} (${result.maskedDisplay}). ${result.prose}`;
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not store the secret.';
	}

	if (failure) fail(failure);
	revalidatePath('/configuration');
	back({ ok: summary });
}

export async function deleteSecretAction(formData: FormData): Promise<void> {
	const key = text(formData, 'key');
	const reason = text(formData, 'reason');
	const confirm = text(formData, 'confirm');
	if (!key) fail('A secret key is required.');
	if (reason.length < 3) fail('A reason is required.');
	if (confirm !== key) fail(`Type the key name (${key}) to confirm removal.`);

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await deleteSecret(key, { reason, confirm: key });
		summary = result.envFallbackActive
			? `${key} removed from the encrypted store. The process environment still supplies a value for this key, so behaviour is unchanged until the deployment variable is removed too.`
			: `${key} removed from the encrypted store. ${result.note}`;
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not remove the secret.';
	}

	if (failure) fail(failure);
	revalidatePath('/configuration');
	back({ ok: summary });
}
