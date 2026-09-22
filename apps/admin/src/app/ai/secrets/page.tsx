/**
 * Admin Control Center — provider credentials.
 *
 * The credential-focused view of the same encrypted store `/configuration` exposes. It
 * exists separately because the question is different: `/configuration` answers "what is
 * this key set to and what reads it", while this page answers **"which providers are
 * usable, which are not, and why"** — grouped by the provider that depends on each key,
 * with a real connectivity test beside it.
 *
 * ## Three things this page states rather than implies
 *
 * 1. **A value can never be read back.** The console shows a masked hint and a
 *    fingerprint. Both are derived, not the secret; the fingerprint is what lets an
 *    operator confirm that a rotation changed *something* without revealing what.
 *
 * 2. **A green test means the credential works, not that it is the right account.**
 *    The provider answers, so the key is valid — but validity says nothing about which
 *    tenant it bills to or which quota it draws from.
 *
 * 3. **Removing a stored value does not necessarily disable a provider.** If the
 *    deployment environment supplies the same key, the effective value is unchanged.
 *    That is why `effectiveSource` is on every row and why removal reports whether an
 *    environment fallback took over.
 */

import Link from 'next/link';
import { getAiProviders, getConfig, type AiProviderRow, type ConfigView } from '../../../lib/api';
import { loadPage } from '../../../lib/page-data';
import { PageError } from '../../../components/PageError';
import {
	Card,
	Cell,
	EmptyState,
	Metric,
	MetricGrid,
	Notes,
	PageHeader,
	Row,
	StatusBadge,
	Table,
	formatDateTime,
	formatNumber,
	formatRelative,
} from '../../../components/ui';
import { removeCredentialAction, rotateCredentialAction, testProviderAction } from './actions';

export const dynamic = 'force-dynamic';

const inputStyle: React.CSSProperties = {
	padding: '0.5rem 0.7rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.85rem',
	width: '100%',
};

const labelStyle: React.CSSProperties = {
	display: 'block',
	fontSize: '0.68rem',
	fontWeight: 600,
	color: '#6b7280',
	marginBottom: '0.25rem',
	textTransform: 'uppercase',
	letterSpacing: '0.03em',
};

const SOURCE_LABELS: Record<string, string> = {
	secret: 'encrypted store',
	environment: 'process environment',
	database: 'database',
	default: 'catalog default',
	unset: 'not set anywhere',
};

function single(value: string | string[] | undefined): string {
	return typeof value === 'string' ? value : '';
}

/** Providers that depend on a given credential key. */
function providersFor(key: string, providers: AiProviderRow[]): AiProviderRow[] {
	return providers.filter((provider) => provider.credentialKey === key);
}

/**
 * A human label for a provider, from the AI/voice catalog when it has one.
 *
 * Infrastructure providers (PostgreSQL, Redis, object storage, Stripe, FCM) are not in that
 * catalog, so the id is title-cased rather than shown raw — `object-storage` reads as a slug, and
 * a button labelled with a slug looks like a bug.
 */
function providerLabel(id: string, providers: AiProviderRow[]): string {
	const known = providers.find((provider) => provider.provider === id);
	if (known?.label) return known.label;
	return id
		.split(/[-_]/)
		.map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
		.join(' ');
}

export default async function SecretsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const okMessage = single(resolved.ok);
	const errorMessage = single(resolved.error);

	const result = await loadPage(async () => {
		const [config, ai] = await Promise.all([
			getConfig(),
			getAiProviders().catch(() => ({ providers: [] as AiProviderRow[], notes: [], defaultModel: null, fallbackModel: null })),
		]);
		return { rows: [{ config, providers: ai.providers }] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="API Keys" />
				<PageError
					title="Could not load the credential store"
					message={result.message}
					status={result.status}
					retryHref="/ai/secrets"
				/>
			</div>
		);
	}

	const config = result.rows[0].config;
	const providers = result.rows[0].providers;
	const secrets: ConfigView[] = config.entries.filter((entry) => entry.scope === 'secret');

	const configured = secrets.filter((entry) => entry.effectiveSource !== 'unset');
	const missing = secrets.filter((entry) => entry.effectiveSource === 'unset');
	const untestable = providers.filter((provider) => provider.testable === false);

	return (
		<div>
			<PageHeader
				title="API Keys"
				subtitle="Provider credentials: what is configured, from where, and whether the provider answers"
				actions={
					<>
						<Link href="/ai" style={{ fontSize: '0.8rem', color: '#2563eb', marginRight: '0.9rem' }}>
							Providers →
						</Link>
						<Link href="/configuration" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
							All configuration →
						</Link>
					</>
				}
			/>

			{errorMessage ? (
				<div role="alert" style={alert('#fef2f2', '#fecaca', '#7f1d1d')}>
					{errorMessage}
				</div>
			) : null}
			{okMessage ? (
				<div role="status" style={alert('#ecfdf5', '#a7f3d0', '#065f46')}>
					{okMessage}
				</div>
			) : null}

			{!config.secretStoreReady ? (
				<Notes
					tone="warn"
					notes={[
						config.secretStoreNote ??
							'The secret store is not ready. Credentials cannot be stored until NOVA_CONFIG_ENCRYPTION_KEY is set on the API service.',
						'This is enforced deliberately: the API refuses to encrypt rather than falling back to storing a credential in plaintext.',
					]}
				/>
			) : null}

			<MetricGrid minWidth={180}>
				<Metric label="Credentials declared" value={secrets.length} />
				<Metric
					label="Configured"
					value={configured.length}
					tone={configured.length === secrets.length ? 'good' : 'default'}
				/>
				<Metric
					label="Not set anywhere"
					value={missing.length}
					tone={missing.length > 0 ? 'warn' : 'good'}
					hint={missing.length > 0 ? 'the provider that needs it is unusable' : ''}
				/>
				<Metric
					label="Encrypted store"
					value={config.secretStoreReady ? 'ready' : 'NOT CONFIGURED'}
					tone={config.secretStoreReady ? 'good' : 'bad'}
				/>
			</MetricGrid>

			<Card
				title="Provider credentials"
				subtitle="Values are never returned by any API — only a masked hint, a fingerprint and the source of the effective value"
			>
				{secrets.length === 0 ? (
					<EmptyState
						message="No credential keys are declared in the catalog"
						hint="This would mean the configuration catalog has no secret-scoped entries, which is a code-level problem rather than a deployment state."
					/>
				) : (
					<Table columns={['Credential', 'Used by', 'State', 'Stored hint', 'Last tested', 'Actions']}>
						{secrets.map((entry) => {
							const users = providersFor(entry.key, providers);
							return (
								<Row key={entry.key}>
									<Cell>
										<div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontWeight: 500 }}>{entry.key}</div>
										<div style={{ fontSize: '0.7rem', color: '#6b7280', maxWidth: '260px' }}>{entry.description}</div>
										{entry.secretFingerprint ? (
											<div style={{ fontSize: '0.66rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
												fingerprint {entry.secretFingerprint}
											</div>
										) : null}
									</Cell>
									<Cell muted>
										{users.length === 0 ? (
											<>
												<div style={{ fontSize: '0.72rem' }}>
													{entry.usedBy.length > 0 ? entry.usedBy.join(', ') : 'no consumer declared'}
												</div>
												<div style={{ fontSize: '0.66rem', color: '#9ca3af' }}>
													not an AI/voice provider key — infrastructure credential
												</div>
											</>
										) : (
											users.map((provider) => (
												<div key={provider.provider} style={{ fontSize: '0.75rem' }}>
													{provider.label || provider.provider}
													<div style={{ fontSize: '0.66rem', color: '#9ca3af' }}>
														{provider.credentialConfigured ? 'usable now' : 'unusable — credential missing'}
													</div>
												</div>
											))
										)}
										{/* Coverage is reported separately from consumption. Conflating the two is
										    how a page tells an operator that an S3 key is untested when it has an
										    end-to-end test that just ran. */}
										<div style={{ fontSize: '0.66rem', color: '#6b7280', marginTop: '0.25rem' }}>
											{entry.testedBy.length > 0
												? `connectivity test: ${entry.testedBy.join(', ')}`
												: 'no connectivity test covers this key'}
										</div>
									</Cell>
									<Cell>
										<StatusBadge
											status={entry.effectiveSource === 'unset' ? 'not_configured' : 'pass'}
											label={entry.effectiveSource === 'unset' ? 'not set' : 'configured'}
										/>
										<div style={{ fontSize: '0.68rem', color: '#6b7280', marginTop: '0.2rem' }}>
											from {SOURCE_LABELS[entry.effectiveSource] ?? entry.effectiveSource}
										</div>
										{entry.envKeyPresent ? (
											<div style={{ fontSize: '0.66rem', color: '#9ca3af' }}>environment variable present</div>
										) : null}
									</Cell>
									<Cell muted>
										<div style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.78rem' }}>
											{entry.secretHint ?? '—'}
										</div>
										{entry.updatedAt ? (
											<div style={{ fontSize: '0.66rem', color: '#9ca3af' }}>
												{formatDateTime(entry.updatedAt)} by {entry.updatedBy ?? 'unknown'}
											</div>
										) : null}
									</Cell>
									<Cell>
										{entry.testStale ? (
											// The value changed after the last test, so the recorded result
											// describes a credential that is no longer in use. Reporting it as
											// the current status is how a rotated key looks "tested" when
											// nothing has tested it.
											<>
												<StatusBadge status="stale" label="tested a previous value" />
												<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
													last run {entry.lastTestedAt ? formatRelative(entry.lastTestedAt) : ''}
												</div>
												<div style={{ fontSize: '0.68rem', color: '#6b7280', maxWidth: '220px' }}>
													The key was replaced after this test. Run it again to confirm the new value.
												</div>
											</>
										) : entry.lastTestedAt ? (
											<>
												<StatusBadge status={entry.lastTestStatus ?? 'unknown'} />
												<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
													{formatRelative(entry.lastTestedAt)}
												</div>
												<div style={{ fontSize: '0.68rem', color: '#6b7280', maxWidth: '220px' }}>
													{entry.lastTestMessage ?? ''}
												</div>
											</>
										) : entry.testedBy.length === 0 ? (
											// Distinguishing "no test exists" from "the test has not run" matters:
											// the first is a gap in the platform, the second is a button away.
											<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>
												no connectivity test covers this key
											</span>
										) : (
											<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>
												covered by {entry.testedBy.join(', ')} — not run yet
											</span>
										)}
									</Cell>
									<Cell>
										<div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
											{/* Buttons come from the API's coverage list, not from the AI provider
											    catalog, so an infrastructure credential with a real test (S3, Redis,
											    PostgreSQL, Stripe, FCM) is testable from here too. */}
											{entry.testedBy.map((provider) => (
												<form key={provider} action={testProviderAction}>
													<input type="hidden" name="provider" value={provider} />
													<button type="submit" style={ghostButton}>
														Test {providerLabel(provider, providers)}
													</button>
												</form>
											))}
											<details>
												<summary style={{ cursor: 'pointer', fontSize: '0.72rem', color: '#6b7280' }}>
													Remove stored value
												</summary>
												<form
													action={removeCredentialAction}
													style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.35rem' }}
												>
													<input type="hidden" name="key" value={entry.key} />
													<input
														name="reason"
														required
														minLength={3}
														placeholder="Reason (audited)"
														aria-label={`Reason for removing ${entry.key}`}
														style={{ ...inputStyle, fontSize: '0.72rem', padding: '0.3rem 0.45rem' }}
													/>
													<input
														name="confirm"
														required
														placeholder={`Type ${entry.key}`}
														aria-label={`Confirm removal of ${entry.key}`}
														style={{ ...inputStyle, fontSize: '0.72rem', padding: '0.3rem 0.45rem' }}
													/>
													<button
														type="submit"
														style={{
															padding: '0.3rem 0.6rem',
															fontSize: '0.72rem',
															color: '#dc2626',
															background: '#fef2f2',
															border: '1px solid #fecaca',
															borderRadius: '6px',
															cursor: 'pointer',
														}}
													>
														Remove stored value
													</button>
												</form>
											</details>
										</div>
									</Cell>
								</Row>
							);
						})}
					</Table>
				)}
			</Card>

			<Card
				title="Provider readiness"
				subtitle="Every provider the runtime is wired to, and whether a credential is present"
				action={
					<Link href="/ai" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						Routing and models →
					</Link>
				}
			>
				{providers.length === 0 ? (
					<EmptyState message="The API reported no providers" />
				) : (
					<Table columns={['Provider', 'Kind', 'Credential key', 'State', 'Edge', 'Test']}>
						{providers.map((provider) => (
							<Row key={provider.provider}>
								<Cell>
									<div style={{ fontWeight: 500 }}>{provider.label || provider.provider}</div>
									<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
										{provider.provider}
									</div>
								</Cell>
								<Cell muted>{provider.kind}</Cell>
								<Cell mono>{provider.credentialKey ?? '—'}</Cell>
								<Cell>
									{provider.credentialConfigured ? (
										<>
											<StatusBadge status="pass" label="configured" />
											<div style={{ fontSize: '0.68rem', color: '#6b7280' }}>
												from {SOURCE_LABELS[provider.credentialSource ?? 'unset'] ?? provider.credentialSource}
											</div>
										</>
									) : (
										<StatusBadge status="not_configured" />
									)}
								</Cell>
								<Cell muted>
									<div style={{ fontSize: '0.7rem', maxWidth: '260px' }}>{provider.selectionReason ?? '—'}</div>
								</Cell>
								<Cell>
									{provider.testable === false ? (
										<span style={{ fontSize: '0.7rem', color: '#9ca3af' }}>
											no connectivity test exists for this provider
										</span>
									) : (
										<form action={testProviderAction}>
											<input type="hidden" name="provider" value={provider.provider} />
											<button type="submit" style={ghostButton}>
												Test with a real call
											</button>
										</form>
									)}
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<Card
				title="Store or rotate a credential"
				subtitle="AES-256-GCM encrypted before it reaches the database. A value can only be replaced or removed — never read back."
			>
				<form action={rotateCredentialAction} style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
					<div style={{ flex: '1 1 220px' }}>
						<label style={labelStyle} htmlFor="credential-key">
							Key
						</label>
						<input
							id="credential-key"
							name="key"
							required
							list="credential-keys"
							placeholder="ANTHROPIC_API_KEY"
							style={inputStyle}
						/>
						<datalist id="credential-keys">
							{secrets.map((entry) => (
								<option key={entry.key} value={entry.key} />
							))}
						</datalist>
					</div>
					<div style={{ flex: '2 1 280px' }}>
						<label style={labelStyle} htmlFor="credential-value">
							New value
						</label>
						<input
							id="credential-value"
							name="value"
							type="password"
							required
							autoComplete="off"
							style={inputStyle}
						/>
					</div>
					<div style={{ flex: '1 1 200px' }}>
						<label style={labelStyle} htmlFor="credential-reason">
							Reason (audited)
						</label>
						<input
							id="credential-reason"
							name="reason"
							required
							minLength={3}
							placeholder="Rotating after a leak"
							style={inputStyle}
						/>
					</div>
					<div style={{ flex: '1 1 200px' }}>
						<label style={labelStyle} htmlFor="credential-confirm">
							Retype the key to confirm
						</label>
						<input id="credential-confirm" name="confirm" required placeholder="ANTHROPIC_API_KEY" style={inputStyle} />
					</div>
					<button
						type="submit"
						disabled={!config.secretStoreReady}
						style={{
							padding: '0.5rem 1.1rem',
							background: config.secretStoreReady ? '#1a1a2e' : '#9ca3af',
							color: '#fff',
							border: 'none',
							borderRadius: '6px',
							fontSize: '0.85rem',
							cursor: config.secretStoreReady ? 'pointer' : 'not-allowed',
						}}
					>
						{config.secretStoreReady ? 'Store credential' : 'Secret store not configured'}
					</button>
				</form>
				<Notes
					notes={[
						'Replacing a credential takes effect in this process immediately; other replicas pick it up on their next config read, within 15 seconds.',
						'A credential write is refused for environment-only keys. This page lists only store-backed secrets, so that case does not arise here — but the API enforces it regardless of what the console offers.',
					]}
				/>
			</Card>

			<Card title="What a green test does and does not prove">
				<ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.8rem', lineHeight: 1.7, color: '#374151' }}>
					<li>
						<strong>Proves:</strong> the provider accepted the credential and answered a real authenticated request.
					</li>
					<li>
						<strong>Does not prove:</strong> that the credential belongs to the account you expect, that it has remaining
						quota, or that it is billed to the right tenant. A valid key for the wrong project still passes.
					</li>
					<li>
						<strong>Costs:</strong> a real request. Tests use read-only endpoints wherever the provider offers one so a
						completion is not billed, and {formatNumber(untestable.length)} provider(s) in this catalog have no
						connectivity test at all — they are marked rather than given a fake one.
					</li>
					<li>
						<strong>Not shown:</strong> the value itself, ever, from any endpoint. The masked hint and fingerprint are
						derived from the stored secret and cannot be reversed into it.
					</li>
				</ul>
			</Card>
		</div>
	);
}

const ghostButton: React.CSSProperties = {
	padding: '0.3rem 0.6rem',
	fontSize: '0.72rem',
	color: '#1a1a2e',
	background: '#f3f4f6',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	cursor: 'pointer',
};

function alert(background: string, border: string, color: string): React.CSSProperties {
	return {
		background,
		border: `1px solid ${border}`,
		color,
		padding: '0.6rem 0.8rem',
		borderRadius: '8px',
		fontSize: '0.82rem',
		marginBottom: '0.9rem',
	};
}
