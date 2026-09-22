/**
 * Admin Control Center — voice (STT / TTS / wake word).
 *
 * The test buttons here execute the **real backend path**: they call the same provider
 * clients the voice pipeline uses, so a green result means the provider answered, not that
 * a key looked plausible. The Sarvam check performs a one-character synthesis and is
 * labelled as billed.
 *
 * Two honest limits are stated on the page rather than left implied:
 *  - **wake word cannot be changed from the server.** It is an on-device sherpa-onnx model
 *    bundled as a build asset; the API has no lever over it.
 *  - **STT/TTS request counts and latency are not persisted**, so they are absent rather
 *    than zero.
 */

import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { getVoiceConfig, getVoiceHealth, testVoice } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { PageError } from '../../components/PageError';
import { Card, Cell, EmptyState, Notes, PageHeader, Row, StatusBadge, Table, formatDateTime } from '../../components/ui';

export const dynamic = 'force-dynamic';

type StepResult = {
	provider?: string;
	kind?: string;
	status?: string;
	latencyMs?: number | null;
	message?: string;
	method?: string;
	checkedAt?: string;
};

/** Runs a real STT/TTS/pipeline test through the API's own provider clients. */
async function testAction(formData: FormData): Promise<void> {
	'use server';
	const kind = String(formData.get('kind') ?? 'pipeline') as 'stt' | 'tts' | 'pipeline';
	const provider = String(formData.get('provider') ?? '').trim();
	await testVoice({ kind, ...(provider ? { provider } : {}) }).catch(() => null);
	revalidatePath('/voice');
}

function renderValue(value: unknown): string {
	if (value === null || value === undefined) return 'unset';
	if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ');
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

export default async function VoicePage() {
	const result = await loadPage(async () => {
		const [config, health] = await Promise.all([
			getVoiceConfig().catch(() => null),
			getVoiceHealth().catch(() => null),
		]);
		return { rows: [{ config, health }] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Voice" />
				<PageError
					title="Could not load voice configuration"
					message={result.message}
					status={result.status}
					retryHref="/voice"
				/>
			</div>
		);
	}

	const payload = result.rows[0];
	const config = payload?.config ?? null;
	const health = payload?.health ?? null;

	// The API returns either a `settings` array or a flat object depending on the route's
	// evolution; normalise to key/value rows so the page cannot silently render nothing.
	const settings: Array<[string, unknown]> = config
		? Array.isArray((config as { settings?: unknown }).settings)
			? ((config as { settings: Array<{ key: string; value: unknown }> }).settings).map((entry) => [entry.key, entry.value])
			: Object.entries(config).filter(([key]) => !['notes', 'limitations'].includes(key))
		: [];

	const providers = Array.isArray((health as { providers?: unknown })?.providers)
		? ((health as { providers: StepResult[] }).providers)
		: [];

	return (
		<div>
			<PageHeader
				title="Voice Control Center"
				subtitle="Speech-to-text, text-to-speech and wake word availability"
				actions={
					<Link href="/ai" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						AI providers →
					</Link>
				}
			/>

			<Notes
				notes={[
					'Test buttons below execute the real provider clients used by the voice pipeline. A pass means the provider answered an authenticated request.',
					'The Sarvam test performs a one-character synthesis, which is billed. It is the only provider with no read-only credential check.',
					'The wake word is an on-device model bundled with the app (sherpa-onnx KWS). It cannot be changed, enabled or disabled from the server — this console reports its status only.',
					'STT and TTS request counts and per-request latency are NOT persisted anywhere, so they are absent from this page rather than shown as zero.',
				]}
				tone="warn"
			/>

			<Card title="Run a test" subtitle="Real backend path — these calls hit the provider">
				<div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
					<form action={testAction}>
						<input type="hidden" name="kind" value="stt" />
						<button type="submit" style={testButton}>
							Test STT
						</button>
					</form>
					<form action={testAction}>
						<input type="hidden" name="kind" value="tts" />
						<button type="submit" style={testButton}>
							Test TTS
						</button>
					</form>
					<form action={testAction}>
						<input type="hidden" name="kind" value="pipeline" />
						<button type="submit" style={testButton}>
							Test voice pipeline (STT + TTS)
						</button>
					</form>
				</div>
				<p style={{ fontSize: '0.75rem', color: '#9ca3af', margin: '0.75rem 0 0', lineHeight: 1.5 }}>
					Results are recorded in the provider health history, so the Services page shows the same outcome. A
					wake-word test is not offered: the detector runs on the device and has no server-side entry point.
				</p>
			</Card>

			<Card title="Provider health" subtitle="Last recorded result per STT/TTS provider">
				{providers.length === 0 ? (
					<EmptyState
						message="No voice provider health recorded"
						hint="Run a test above, or use “Test all connections” on the Services page."
					/>
				) : (
					<Table columns={['Provider', 'Kind', 'Status', 'Latency', 'Detail', 'Method']}>
						{providers.map((provider) => (
							<Row key={`${provider.provider}-${provider.kind}`}>
								<Cell>{provider.provider ?? '—'}</Cell>
								<Cell muted>{provider.kind ?? '—'}</Cell>
								<Cell>
									<StatusBadge status={String(provider.status ?? 'unknown')} />
								</Cell>
								<Cell align="right" muted>
									{provider.latencyMs === null || provider.latencyMs === undefined ? '—' : `${provider.latencyMs} ms`}
								</Cell>
								<Cell muted>
									<div style={{ maxWidth: '380px', fontSize: '0.78rem' }}>{provider.message ?? '—'}</div>
								</Cell>
								<Cell muted>
									<div style={{ maxWidth: '280px', fontSize: '0.72rem' }}>{provider.method ?? '—'}</div>
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<Card title="Effective configuration" subtitle="What the voice pipeline will use on the next session">
				{settings.length === 0 ? (
					<EmptyState message="Voice configuration was not returned by the API" />
				) : (
					<Table columns={['Setting', 'Value']}>
						{settings.map(([key, value]) => (
							<Row key={key}>
								<Cell mono>{key}</Cell>
								<Cell>
									{value === null || value === undefined ? (
										<span style={{ color: '#dc2626' }}>unset</span>
									) : (
										renderValue(value)
									)}
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<Card title="Wake word" subtitle="Reported, not controllable from here">
				<Table columns={['Aspect', 'State']}>
					<Row>
						<Cell>Detector</Cell>
						<Cell>sherpa-onnx keyword spotting, on-device</Cell>
					</Row>
					<Row>
						<Cell>Phrase source</Cell>
						<Cell mono>android/app/src/main/assets/wakeword/models.json</Cell>
					</Row>
					<Row>
						<Cell>Server-side control</Cell>
						<Cell>
							<StatusBadge status="not_configured" label="none — build asset" />
						</Cell>
					</Row>
					<Row>
						<Cell>User preference</Cell>
						<Cell>
							Stored per account (`/api/v1/device/wake-word/config`) and enforced on the device; the server
							records the choice but cannot change what the microphone listens for.
						</Cell>
					</Row>
					<Row>
						<Cell>Android constraint</Cell>
						<Cell>
							A microphone-type foreground service cannot be re-armed from a background BOOT_COMPLETED on
							API 34+, so the detector re-arms on app resume.
						</Cell>
					</Row>
				</Table>
			</Card>

			<Notes
				notes={[
					`Configuration read at ${formatDateTime(new Date().toISOString())}.`,
					'Changing STT/TTS provider from Configuration is currently inert: the catalog declares STT_PROVIDER and TTS_PROVIDER but the realtime pipeline selects by language (English → Deepgram, else Sarvam) and hard-codes its streaming TTS provider. The Configuration page marks both “not wired”.',
				]}
			/>
		</div>
	);
}

const testButton: React.CSSProperties = {
	padding: '0.5rem 1rem',
	background: '#1a1a2e',
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.82rem',
	cursor: 'pointer',
};
