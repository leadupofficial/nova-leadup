/**
 * Admin Control Center — runtime configuration.
 *
 * Every key shown here is declared in `services/api/src/admin/config.ts`, which was
 * derived from what the repository actually reads rather than from a generic list.
 *
 * The column that matters most is **Read by runtime**. The console previously
 * presented configuration keys as though editing one would change behaviour, while a
 * grep proved several were read by nothing at all — the most misleading thing this
 * screen could do. A key whose stored value is inert is still listed (an operator may
 * legitimately stage a value) but it is labelled, and `Not wired` is stated as plainly
 * as `Live`.
 *
 * Secrets are shown masked and are write-only. The plaintext is never returned by the
 * API, which is why there is no "reveal" control anywhere on this page.
 */

import Link from 'next/link';
import { getConfig, type ConfigView } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { PageError } from '../../components/PageError';
import {
	Card,
	Cell,
	EmptyState,
	Notes,
	PageHeader,
	Row,
	StatusBadge,
	Table,
	formatDateTime,
} from '../../components/ui';
import { deleteSecretAction, updateConfigAction, writeSecretAction } from './actions';

export const dynamic = 'force-dynamic';

const inputStyle: React.CSSProperties = {
	width: '100%',
	padding: '0.4rem 0.55rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.8rem',
};

const labelStyle: React.CSSProperties = {
	display: 'block',
	fontSize: '0.68rem',
	fontWeight: 600,
	color: '#6b7280',
	marginBottom: '0.15rem',
	textTransform: 'uppercase',
	letterSpacing: '0.03em',
};

const compactButton: React.CSSProperties = {
	padding: '0.35rem 0.7rem',
	background: '#1a1a2e',
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.75rem',
	cursor: 'pointer',
	whiteSpace: 'nowrap',
};

function sourceBadge(source: ConfigView['effectiveSource']) {
	const map: Record<ConfigView['effectiveSource'], { status: string; label: string }> = {
		database: { status: 'active', label: 'database' },
		environment: { status: 'running', label: 'environment' },
		secret: { status: 'active', label: 'encrypted store' },
		default: { status: 'unknown', label: 'built-in default' },
		unset: { status: 'overdue', label: 'UNSET' },
	};
	return map[source] ?? { status: 'unknown', label: source };
}

export default async function ConfigurationPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const errorMessage = typeof resolved.error === 'string' ? resolved.error : '';
	const okMessage = typeof resolved.ok === 'string' ? resolved.ok : '';

	const result = await loadPage<{
		entries: ConfigView[];
		secretStoreReady: boolean;
		secretStoreNote: string | null;
	}>(() => getConfig().then((data) => ({ rows: [data] })));

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Configuration" />
				<PageError
					title="Could not load configuration"
					message={result.message}
					status={result.status}
					retryHref="/configuration"
				/>
			</div>
		);
	}

	const { entries, secretStoreReady, secretStoreNote } = result.rows[0] ?? {
		entries: [],
		secretStoreReady: false,
		secretStoreNote: null,
	};

	// The API already groups by category; grouping here again keeps the page correct even
	// if a build returns a flat list.
	const byCategory = new Map<string, ConfigView[]>();
	for (const entry of entries) {
		const list = byCategory.get(entry.category) ?? [];
		list.push(entry);
		byCategory.set(entry.category, list);
	}

	const unset = (entries ?? []).filter((entry) => entry.effectiveSource === 'unset');
	const notWired = (entries ?? []).filter((entry) => !entry.readByRuntime);

	return (
		<div>
			<PageHeader
				title="Configuration"
				subtitle={
					<>
						{entries.length} declared keys · {notWired.length} not yet read by running code.{' '}
						<Link href="/configuration/validate" style={{ color: '#2563eb' }}>
							Run the validator →
						</Link>
					</>
				}
			/>

			{errorMessage ? (
				<div role="alert" style={alertStyle('#fef2f2', '#fecaca', '#7f1d1d')}>
					{errorMessage}
				</div>
			) : null}
			{okMessage ? <div role="status" style={alertStyle('#ecfdf5', '#a7f3d0', '#065f46')}>{okMessage}</div> : null}

			{!secretStoreReady ? (
				<Notes
					tone="warn"
					notes={[
						secretStoreNote ??
							'No secret encryption key is configured. Secrets cannot be stored until NOVA_CONFIG_ENCRYPTION_KEY is set on the API service.',
						'This is enforced deliberately: the API refuses to encrypt rather than silently storing a credential in plaintext.',
					]}
				/>
			) : null}

			{unset.length > 0 ? (
				<Notes
					tone="warn"
					notes={[`${unset.length} key(s) have no value from any source: ${unset.map((entry) => entry.key).join(', ')}.`]}
				/>
			) : null}

			<Notes
				notes={[
					'Precedence is database value → process environment → catalog default. A key marked "environment" has no stored override, so the deployed variable is in charge.',
					'Environment-only keys (DATABASE_URL, JWT_SECRET, NOVA_CONFIG_ENCRYPTION_KEY) cannot be changed here: a database row does not change a running process’s environment, and pretending otherwise is the most misleading thing this screen could do. They need a deployment-level change.',
					'Changes apply immediately in this API process; other replicas pick them up on their next config read, within 15 seconds.',
				]}
			/>

			<Card
				title="Store or rotate a secret"
				subtitle="AES-256-GCM encrypted at rest. The value is never returned by any API, so it can only be replaced or removed — never read back."
			>
				<form action={writeSecretAction} style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
					<div style={{ flex: '1 1 220px' }}>
						<label style={labelStyle} htmlFor="secret-key">
							Key
						</label>
						<input id="secret-key" name="key" required placeholder="ANTHROPIC_API_KEY" style={inputStyle} />
					</div>
					<div style={{ flex: '2 1 280px' }}>
						<label style={labelStyle} htmlFor="secret-value">
							Value
						</label>
						<input id="secret-value" name="value" type="password" required autoComplete="off" style={inputStyle} />
					</div>
					<div style={{ flex: '1 1 200px' }}>
						<label style={labelStyle} htmlFor="secret-reason">
							Reason (audited)
						</label>
						<input id="secret-reason" name="reason" required placeholder="Rotating after a leak" style={inputStyle} />
					</div>
					<div style={{ flex: '1 1 200px' }}>
						<label style={labelStyle} htmlFor="secret-confirm">
							Retype the key to confirm
						</label>
						<input id="secret-confirm" name="confirm" required placeholder="ANTHROPIC_API_KEY" style={inputStyle} />
					</div>
					<button type="submit" style={compactButton}>
						Store secret
					</button>
				</form>
			</Card>

			{[...byCategory.entries()].map(([category, group]) => (
				<Card key={category} title={category} subtitle={`${group.length} key${group.length === 1 ? '' : 's'}`}>
					<Table columns={['Key', 'Value', 'Source', 'Read by runtime', 'Affects', 'Edit']}>
						{group.map((entry) => (
							<Row key={entry.key}>
								<Cell mono>
									{entry.key}
									{entry.restartRequired ? (
										<span style={{ marginLeft: '0.4rem', fontSize: '0.7rem', color: '#d97706' }}>restart</span>
									) : null}
									<div style={{ fontSize: '0.72rem', color: '#6b7280', marginTop: '0.15rem', maxWidth: '280px' }}>
										{entry.description}
									</div>
								</Cell>
								<Cell mono>
									{entry.scope === 'secret' ? (
										<span style={{ color: '#6b7280' }}>{entry.secretHint ?? 'not configured'}</span>
									) : entry.value === null ? (
										<span style={{ color: '#dc2626' }}>unset</span>
									) : (
										<span style={{ wordBreak: 'break-all' }}>{entry.value}</span>
									)}
								</Cell>
								<Cell>
									<StatusBadge {...sourceBadge(entry.effectiveSource)} />
								</Cell>
								<Cell>
									<StatusBadge
										status={entry.readByRuntime ? 'pass' : 'unknown'}
										label={entry.readByRuntime ? 'live' : 'not wired'}
									/>
									<div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: '0.2rem', maxWidth: '240px' }}>
										{entry.runtimeWiringNote}
									</div>
								</Cell>
								<Cell muted>
									<div style={{ fontSize: '0.72rem', maxWidth: '160px' }}>{entry.usedBy.join(', ') || '—'}</div>
								</Cell>
								<Cell>
									{entry.envOnly ? (
										<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>environment only</span>
									) : entry.scope === 'secret' ? (
										<SecretControls entry={entry} />
									) : (
										<form action={updateConfigAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
											<input type="hidden" name="key" value={entry.key} />
											<input
												name="value"
												defaultValue={entry.value ?? ''}
												style={{ ...inputStyle, width: '180px' }}
												aria-label={`New value for ${entry.key}`}
											/>
											<input
												name="reason"
												placeholder="Reason"
												style={{ ...inputStyle, width: '180px' }}
												aria-label={`Reason for changing ${entry.key}`}
											/>
											<button type="submit" style={compactButton}>
												Save
											</button>
										</form>
									)}
								</Cell>
							</Row>
						))}
					</Table>
					{group.some((entry) => entry.updatedAt) ? (
						<p style={{ fontSize: '0.72rem', color: '#9ca3af', margin: '0.5rem 0 0' }}>
							Last changed:{' '}
							{group
								.filter((entry) => entry.updatedAt)
								.map((entry) => `${entry.key} at ${formatDateTime(entry.updatedAt)} by ${entry.updatedBy ?? 'unknown'}`)
								.join(' · ')}
						</p>
					) : null}
				</Card>
			))}

			{entries.length === 0 ? (
				<Card>
					<EmptyState message="No configuration keys are declared." />
				</Card>
			) : null}
		</div>
	);
}

function SecretControls({ entry }: { entry: ConfigView }) {
	return (
		<details>
			<summary style={{ cursor: 'pointer', fontSize: '0.75rem', color: '#6b7280' }}>Manage</summary>
			<div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginTop: '0.4rem' }}>
				<form action={deleteSecretAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
					<input type="hidden" name="key" value={entry.key} />
					<input name="reason" placeholder="Reason" style={{ ...inputStyle, width: '180px' }} aria-label={`Reason for removing ${entry.key}`} />
					<input name="confirm" placeholder={`Type ${entry.key}`} style={{ ...inputStyle, width: '180px' }} aria-label={`Confirm removal of ${entry.key}`} />
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
						Remove stored secret
					</button>
				</form>
				<p style={{ fontSize: '0.68rem', color: '#9ca3af', margin: 0, maxWidth: '200px' }}>
					Replacing the value uses the form at the top of the page.
				</p>
			</div>
		</details>
	);
}

function alertStyle(background: string, border: string, color: string): React.CSSProperties {
	return {
		marginBottom: '1rem',
		padding: '0.75rem 1rem',
		background,
		border: `1px solid ${border}`,
		borderRadius: '8px',
		color,
		fontSize: '0.85rem',
	};
}
