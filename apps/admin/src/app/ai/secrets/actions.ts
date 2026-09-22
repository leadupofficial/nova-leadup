'use server';

/**
 * Provider-credential operations for the Control Center.
 *
 * These call the same two API endpoints `/configuration` calls; the difference is where
 * the operator lands afterwards and what the page is *about*. The security model is
 * unchanged and lives entirely on the server: the value is AES-256-GCM encrypted before
 * it reaches the database, no API ever returns it, and the plain config route refuses a
 * secret write outright.
 *
 * The `confirm` field is required on both paths. Restating it here rather than trusting
 * the browser's `required` attribute is deliberate: a Server Action is a public endpoint,
 * and the typed key name (or the explicit confirm string) is the only thing separating a
 * deliberate rotation from a mis-click on a destructive control.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { deleteSecret, testProvider, writeSecret } from '../../../lib/api';

function text(form: FormData, name: string): string {
	return String(form.get(name) ?? '').trim();
}

function back(params: Record<string, string>): never {
	redirect(`/ai/secrets?${new URLSearchParams(params).toString()}`);
}

function fail(message: string): never {
	back({ error: message });
}

export async function rotateCredentialAction(formData: FormData): Promise<void> {
	const key = text(formData, 'key');
	const value = text(formData, 'value');
	const reason = text(formData, 'reason');
	const confirm = text(formData, 'confirm');

	if (!key) fail('A credential key is required.');
	if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
		fail('A credential key must be upper-case letters, digits and underscores, e.g. ANTHROPIC_API_KEY.');
	}
	if (!value) fail('A credential value is required.');
	if (reason.length < 3) fail('A reason is required — rotating a credential is audited.');
	if (confirm !== key) fail(`Type the key name (${key}) to confirm replacing this credential.`);

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await writeSecret(key, { value, reason });
		summary = `${key} ${result.rotated ? 'rotated' : 'stored'} (${result.maskedDisplay}). ${result.prose}`;
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not store the credential.';
	}

	if (failure) fail(failure);
	revalidatePath('/ai/secrets');
	revalidatePath('/configuration');
	back({ ok: summary });
}

export async function removeCredentialAction(formData: FormData): Promise<void> {
	const key = text(formData, 'key');
	const reason = text(formData, 'reason');
	const confirm = text(formData, 'confirm');
	if (!key) fail('A credential key is required.');
	if (reason.length < 3) fail('A reason is required — removing a credential is audited.');
	if (confirm !== key) fail(`Type the key name (${key}) to confirm removal.`);

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await deleteSecret(key, { reason, confirm: key });
		// The important part of this message is the fallback: removing the stored value
		// does NOT disable the provider when the deployment environment supplies the same
		// key. Saying "removed" without that would be a false claim about what changed.
		summary = result.envFallbackActive
			? `${key} removed from the encrypted store, but the deployment environment still supplies a value, so the provider is NOT disabled. Remove the environment variable as well to disable it.`
			: `${key} removed from the encrypted store. ${result.note}`;
	} catch (error) {
		failure = error instanceof Error ? error.message : 'Could not remove the credential.';
	}

	if (failure) fail(failure);
	revalidatePath('/ai/secrets');
	revalidatePath('/configuration');
	back({ ok: summary });
}

/**
 * Tests one provider with a real authenticated call.
 *
 * The result is read back from the API's recorded history on the next render, so what the
 * operator sees is the same `provider_health_checks` row everyone else sees rather than a
 * one-off response body. `testProvider` requires `services.read`, which every role that
 * can reach this page holds — but a 403 is surfaced verbatim if that ever stops being
 * true, because a permission change should not silently look like a provider outage.
 */
export async function testProviderAction(formData: FormData): Promise<void> {
	const provider = text(formData, 'provider');
	if (!provider) fail('A provider id is required.');

	let failure: string | null = null;
	let summary = '';
	try {
		const result = await testProvider(provider);
		summary = `${provider}: ${result.status}. ${result.message ?? ''}`.trim();
	} catch (error) {
		failure = error instanceof Error ? error.message : `Could not test ${provider}.`;
	}

	if (failure) fail(failure);
	revalidatePath('/ai/secrets');
	back({ ok: summary });
}
