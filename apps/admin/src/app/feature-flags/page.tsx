/**
 * Admin Control Center — feature flags.
 *
 * This page is where a flag stops being a database row. It shows, for every flag:
 *
 *   - whether a global row exists at all (a key with no row falls back to the
 *     caller's default, which is a real and easily-missed state)
 *   - the rollout percentage, **with a deterministic bucket preview** so an operator
 *     can see that "50%" means the same half of users every time rather than a coin
 *     flip per request
 *   - every environment/user/organization override, which is what actually decides
 *     the answer for a specific subject
 *
 * The reminder that matters is stated on the page: a stored flag reaches a device on
 * that device's next `GET /api/v1/device/bootstrap` call, because the mobile app has
 * no push channel.
 */

import Link from 'next/link';
import { listFlagRows, type FeatureFlagRow } from '../../lib/api';
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
} from '../../components/ui';
import {
	createFlagAction,
	deleteFlagAction,
	deleteOverrideAction,
	setOverrideAction,
	updateFlagAction,
} from './actions';

export const dynamic = 'force-dynamic';

const inputStyle: React.CSSProperties = {
	width: '100%',
	padding: '0.45rem 0.6rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.82rem',
};

const labelStyle: React.CSSProperties = {
	display: 'block',
	fontSize: '0.72rem',
	fontWeight: 600,
	color: '#6b7280',
	marginBottom: '0.2rem',
	textTransform: 'uppercase',
	letterSpacing: '0.03em',
};

const buttonStyle: React.CSSProperties = {
	padding: '0.45rem 0.9rem',
	background: '#1a1a2e',
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.8rem',
	cursor: 'pointer',
};

export default async function FeatureFlagsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const errorMessage = typeof resolved.error === 'string' ? resolved.error : '';
	const okMessage = typeof resolved.ok === 'string' ? resolved.ok : '';

	const result = await loadPage<{ flags: FeatureFlagRow[]; notes: string[] }>(() =>
		listFlagRows().then((data) => ({ rows: [data] })),
	);

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Feature Flags" />
				<PageError
					title="Could not load feature flags"
					message={result.message}
					status={result.status}
					retryHref="/feature-flags"
				/>
			</div>
		);
	}

	const { flags, notes } = result.rows[0] ?? { flags: [], notes: [] };
	const enabledCount = flags.filter((flag) => flag.enabled).length;
	const withOverrides = flags.filter((flag) => flag.overrides.length > 0).length;

	return (
		<div>
			<PageHeader
				title="Feature Flags"
				subtitle={
					<>
						{flags.length} flags · {enabledCount} enabled · {withOverrides} with overrides. Changes are applied
						on this server within 15 seconds and reach a device on its next bootstrap call.{' '}
						<Link href="/configuration/validate" style={{ color: '#2563eb' }}>
							Config validator →
						</Link>
					</>
				}
			/>

			{errorMessage ? (
				<div
					role="alert"
					style={{
						marginBottom: '1rem',
						padding: '0.75rem 1rem',
						background: '#fef2f2',
						border: '1px solid #fecaca',
						borderRadius: '8px',
						color: '#7f1d1d',
						fontSize: '0.85rem',
					}}
				>
					{errorMessage}
				</div>
			) : null}
			{okMessage ? (
				<div
					role="status"
					style={{
						marginBottom: '1rem',
						padding: '0.75rem 1rem',
						background: '#ecfdf5',
						border: '1px solid #a7f3d0',
						borderRadius: '8px',
						color: '#065f46',
						fontSize: '0.85rem',
					}}
				>
					Flag {okMessage}. An audit record was written.
				</div>
			) : null}

			<Notes notes={[...notes]} />

			<Card
				title="Create a flag"
				subtitle="Creating a flag does not change behaviour by itself — an operator still has to enable it, and the client reads the result on its next bootstrap."
			>
				<form action={createFlagAction} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
					<div style={{ flex: '1 1 220px' }}>
						<label style={labelStyle} htmlFor="new-key">
							Key
						</label>
						<input id="new-key" name="key" required placeholder="PROACTIVE_ASSISTANT" style={inputStyle} />
					</div>
					<div style={{ flex: '2 1 300px' }}>
						<label style={labelStyle} htmlFor="new-description">
							Description
						</label>
						<input
							id="new-description"
							name="description"
							required
							placeholder="What does this flag control, and for whom?"
							style={inputStyle}
						/>
					</div>
					<div style={{ flex: '0 1 120px' }}>
						<label style={labelStyle} htmlFor="new-rollout">
							Rollout %
						</label>
						<input id="new-rollout" name="rolloutPercent" type="number" min={0} max={100} defaultValue={0} style={inputStyle} />
					</div>
					<div style={{ flex: '0 1 130px' }}>
						<label style={labelStyle} htmlFor="new-enabled">
							Initial state
						</label>
						<select id="new-enabled" name="enabled" defaultValue="false" style={inputStyle}>
							<option value="false">Disabled</option>
							<option value="true">Enabled (100%)</option>
						</select>
					</div>
					<div style={{ flex: '1 1 220px' }}>
						<label style={labelStyle} htmlFor="new-reason">
							Reason (audited)
						</label>
						<input id="new-reason" name="reason" placeholder="Why is this being added?" style={inputStyle} />
					</div>
					<button type="submit" style={buttonStyle}>
						Create flag
					</button>
				</form>
			</Card>

			{flags.length === 0 ? (
				<Card>
					<EmptyState
						message="No feature flags exist"
						hint="Until a flag exists, every client falls back to its own default for that key."
					/>
				</Card>
			) : (
				flags.map((flag) => <FlagCard key={flag.key} flag={flag} />)
			)}

			<Notes
				notes={[
					'A percentage rollout is a stable hash of (flag key, user id), not a random draw, so the same user is consistently inside or outside the cohort. The bucket preview above demonstrates this.',
					'Precedence is user override → organization override → environment override → global flag and rollout → the caller’s default. The evaluation panel on each flag shows which one applied.',
					'Deleting a flag removes its overrides too, and every evaluation then falls back to the caller default — which may be different from the flag’s last value.',
				]}
			/>
		</div>
	);
}

function FlagCard({ flag }: { flag: FeatureFlagRow }) {
	return (
		<Card
			title={
				<span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
					<span style={{ fontFamily: 'ui-monospace, Menlo, monospace' }}>{flag.key}</span>
					<StatusBadge status={flag.hasRow ? (flag.enabled ? 'active' : 'disabled') : 'unknown'} label={flag.hasRow ? (flag.enabled ? 'enabled' : 'disabled') : 'no row'} />
					{flag.rolloutPercent > 0 && flag.rolloutPercent < 100 ? (
						<StatusBadge status="pending" label={`${flag.rolloutPercent}% rollout`} />
					) : null}
				</span>
			}
			subtitle={flag.description ?? 'No description recorded for this flag.'}
		>
			<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
				<form action={updateFlagAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
					<input type="hidden" name="key" value={flag.key} />
					<div style={{ display: 'flex', gap: '0.5rem' }}>
						<div style={{ flex: 1 }}>
							<label style={labelStyle} htmlFor={`enabled-${flag.key}`}>
								Enabled
							</label>
							<select id={`enabled-${flag.key}`} name="enabled" defaultValue={flag.enabled ? 'true' : 'false'} style={inputStyle}>
								<option value="true">Enabled</option>
								<option value="false">Disabled</option>
							</select>
						</div>
						<div style={{ flex: 1 }}>
							<label style={labelStyle} htmlFor={`rollout-${flag.key}`}>
								Rollout %
							</label>
							<input
								id={`rollout-${flag.key}`}
								name="rolloutPercent"
								type="number"
								min={0}
								max={100}
								defaultValue={flag.rolloutPercent}
								style={inputStyle}
							/>
						</div>
					</div>
					<div>
						<label style={labelStyle} htmlFor={`reason-${flag.key}`}>
							Reason (audited)
						</label>
						<input id={`reason-${flag.key}`} name="reason" placeholder="Why this change?" style={inputStyle} />
					</div>
					<button type="submit" style={buttonStyle}>
						Save global state
					</button>
				</form>

				<div>
					<span style={labelStyle}>Rollout cohort preview</span>
					{flag.evaluationPreview && flag.evaluationPreview.length > 0 ? (
						<Table columns={['Sample subject', 'Bucket', 'In rollout']}>
							{flag.evaluationPreview.map((preview) => (
								<Row key={preview.subjectId}>
									<Cell mono>{preview.subjectId.slice(0, 12)}…</Cell>
									<Cell align="right" mono>
										{preview.bucket}
									</Cell>
									<Cell>
										<StatusBadge status={preview.inside ? 'pass' : 'unknown'} label={preview.inside ? 'inside' : 'outside'} />
									</Cell>
								</Row>
							))}
						</Table>
					) : (
						<p style={{ fontSize: '0.8rem', color: '#6b7280', margin: 0 }}>
							No preview supplied. A 0% rollout means nobody is inside the cohort even when the flag is enabled.
						</p>
					)}
				</div>
			</div>

			<div style={{ marginTop: '1rem' }}>
				<span style={labelStyle}>Overrides ({flag.overrides.length})</span>
				{flag.overrides.length > 0 ? (
					<Table columns={['Scope', 'Value', 'State', 'Rollout', 'Reason', 'Actions']}>
						{flag.overrides.map((override) => (
							<Row key={override.id}>
								<Cell muted>{override.scopeType}</Cell>
								<Cell mono>{override.scopeValue}</Cell>
								<Cell>
									<StatusBadge status={override.enabled ? 'active' : 'disabled'} />
								</Cell>
								<Cell align="right" muted>
									{override.rolloutPercent === null ? '—' : `${override.rolloutPercent}%`}
								</Cell>
								<Cell muted>{override.reason ?? '—'}</Cell>
								<Cell>
									<form action={deleteOverrideAction} style={{ display: 'inline-flex', gap: '0.35rem' }}>
										<input type="hidden" name="key" value={flag.key} />
										<input type="hidden" name="scopeType" value={override.scopeType} />
										<input type="hidden" name="scopeValue" value={override.scopeValue} />
										<input
											name="reason"
											placeholder="Reason"
											style={{ ...inputStyle, width: '110px' }}
											aria-label={`Reason for removing the ${override.scopeType} override on ${flag.key}`}
										/>
										<button
											type="submit"
											style={{
												padding: '0.3rem 0.6rem',
												fontSize: '0.75rem',
												color: '#dc2626',
												background: '#fef2f2',
												border: '1px solid #fecaca',
												borderRadius: '6px',
												cursor: 'pointer',
											}}
										>
											Remove
										</button>
									</form>
								</Cell>
							</Row>
						))}
					</Table>
				) : (
					<p style={{ fontSize: '0.8rem', color: '#6b7280', margin: '0 0 0.5rem' }}>
						This flag has no overrides, so every subject resolves through the global state above.
					</p>
				)}

				<form action={setOverrideAction} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: '0.6rem' }}>
					<input type="hidden" name="key" value={flag.key} />
					<div style={{ flex: '0 1 150px' }}>
						<label style={labelStyle} htmlFor={`scope-${flag.key}`}>
							Scope
						</label>
						<select id={`scope-${flag.key}`} name="scopeType" defaultValue="environment" style={inputStyle}>
							<option value="environment">Environment</option>
							<option value="user">User</option>
							<option value="organization">Organization</option>
						</select>
					</div>
					<div style={{ flex: '1 1 200px' }}>
						<label style={labelStyle} htmlFor={`value-${flag.key}`}>
							Value
						</label>
						<input
							id={`value-${flag.key}`}
							name="scopeValue"
							required
							placeholder="production, or a user id"
							style={inputStyle}
						/>
					</div>
					<div style={{ flex: '0 1 130px' }}>
						<label style={labelStyle} htmlFor={`ov-enabled-${flag.key}`}>
							State
						</label>
						<select id={`ov-enabled-${flag.key}`} name="enabled" defaultValue="true" style={inputStyle}>
							<option value="true">Enabled</option>
							<option value="false">Disabled</option>
						</select>
					</div>
					<div style={{ flex: '0 1 110px' }}>
						<label style={labelStyle} htmlFor={`ov-rollout-${flag.key}`}>
							Rollout %
						</label>
						<input id={`ov-rollout-${flag.key}`} name="rolloutPercent" type="number" min={0} max={100} style={inputStyle} />
					</div>
					<div style={{ flex: '1 1 180px' }}>
						<label style={labelStyle} htmlFor={`ov-reason-${flag.key}`}>
							Reason
						</label>
						<input id={`ov-reason-${flag.key}`} name="reason" style={inputStyle} />
					</div>
					<button type="submit" style={buttonStyle}>
						Set override
					</button>
				</form>
			</div>

			<details style={{ marginTop: '1rem' }}>
				<summary style={{ cursor: 'pointer', fontSize: '0.8rem', color: '#6b7280' }}>
					Delete this flag (irreversible)
				</summary>
				<form action={deleteFlagAction} style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', alignItems: 'flex-end' }}>
					<input type="hidden" name="key" value={flag.key} />
					<div>
						<label style={labelStyle} htmlFor={`confirm-${flag.key}`}>
							Type {flag.key} to confirm
						</label>
						<input id={`confirm-${flag.key}`} name="confirm" placeholder={flag.key} style={{ ...inputStyle, width: '240px' }} />
					</div>
					<div>
						<label style={labelStyle} htmlFor={`del-reason-${flag.key}`}>
							Reason
						</label>
						<input id={`del-reason-${flag.key}`} name="reason" style={{ ...inputStyle, width: '200px' }} />
					</div>
					<button
						type="submit"
						style={{
							padding: '0.45rem 0.9rem',
							fontSize: '0.8rem',
							color: '#dc2626',
							background: '#fef2f2',
							border: '1px solid #fecaca',
							borderRadius: '6px',
							cursor: 'pointer',
						}}
					>
						Delete flag and its overrides
					</button>
				</form>
			</details>
		</Card>
	);
}

