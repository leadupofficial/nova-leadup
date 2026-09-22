/**
 * Admin Control Center — Security Overview.
 *
 * The one page that answers *"is somebody abusing the control plane right now"*. The console had
 * the pieces scattered across four destinations — the audit log, Admin Sessions, Admins & Roles,
 * and the credential list on `/ai/secrets` — and nowhere that put them side by side.
 *
 * ## What changed to make this page possible
 *
 * **Failed sign-ins were not recorded anywhere.** `users.last_login_at` kept the most recent
 * *success* for one account with no client information, and a failed attempt left no trace: neither
 * `audit_logs` nor `admin_audit_logs` had an auth row at all. This page would have had to say NOT
 * AVAILABLE for §29's first item. `services/auth-events.ts` now writes a row for every attempt,
 * including the reason and the client address, and this page reports them.
 *
 * ## What this page deliberately does not do
 *
 * It performs **no actions**. Suspending an account lives on the user page, ending an operator's
 * session lives on Admin Sessions, and a kill switch lives on Maintenance — each already carrying
 * the confirmation and impact the action needs. Adding the same buttons here would create a second
 * path to every mutation, and the one an operator finds first would be the one that skips a step.
 *
 * ## And what it does not claim
 *
 * A refusal is a *fact the platform recorded*, not a verdict about the account: during an incident
 * a support engineer routinely reaches for a permission they do not hold. The watchlist names the
 * permissions and times rather than labelling anybody, and the thresholds are printed on the page
 * so a reader can judge them.
 */

import Link from 'next/link';
import { getMfaCoverage, getSecurityOverview, type SecurityOverview } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { PageError } from '../../components/PageError';
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
} from '../../components/ui';

export const dynamic = 'force-dynamic';

/** Human labels for the recorded failure reasons. */
const REASON_LABELS: Record<string, string> = {
	'unknown-account': 'No account for that address',
	'bad-password': 'Wrong password',
	'account-disabled': 'Correct password, suspended account',
	unrecorded: 'Recorded before reasons were stored',
};

function single(value: string | string[] | undefined): string {
	return typeof value === 'string' ? value : '';
}

export default async function SecurityOverviewPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const requested = Number.parseInt(single(resolved.days), 10);
	const days = Number.isFinite(requested) && requested >= 1 && requested <= 90 ? requested : 7;

	const result = await loadPage<SecurityOverview>(async () => {
		const data = await getSecurityOverview(days);
		return { rows: [data] };
	});

	// Read separately and allowed to fail: coverage needs `security.read`, which every operator who
	// can open this page holds, but a failure here must not blank the rest of the dashboard.
	const coverage = await getMfaCoverage().catch(() => null);

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Security Overview" />
				<PageError
					title="Could not load the security overview"
					message={result.message}
					status={result.status}
					retryHref="/security"
				/>
			</div>
		);
	}

	const data = result.rows[0];
	const watchlisted = data.watchlist.length > 0;

	return (
		<div>
			<PageHeader
				title="Security Overview"
				subtitle={`Everything the platform recorded in the last ${data.window.days} day(s), from ${formatDateTime(data.window.since)}`}
				actions={
					<span style={{ fontSize: '0.78rem', color: '#6b7280' }}>
						{[1, 7, 30, 90].map((option, index) => (
							<span key={option}>
								{index > 0 ? ' · ' : ''}
								<Link
									href={`/security?days=${option}`}
									style={{ color: option === days ? '#1a1a2e' : '#2563eb', fontWeight: option === days ? 700 : 400 }}
								>
									{option}d
								</Link>
							</span>
						))}
					</span>
				}
			/>

			<MetricGrid minWidth={180}>
				<Metric
					label="Failed sign-ins"
					value={data.signIns.instrumented ? data.signIns.failed : null}
					tone={data.signIns.failed > 0 ? 'warn' : 'good'}
					hint={
						data.signIns.instrumented
							? `${formatNumber(data.signIns.succeeded)} succeeded in the window`
							: 'no attempt recorded yet — the recorder was added this release'
					}
				/>
				<Metric
					label="Refused privileged actions"
					value={data.refusals.total}
					tone={data.refusals.total > 0 ? 'bad' : 'good'}
					hint={data.refusals.total > 0 ? 'A role attempted something it does not hold' : 'Nothing was refused'}
				/>
				<Metric
					label="Operators signed in"
					value={data.adminSessions.active}
					tone={watchlisted ? 'warn' : 'good'}
					hint={`${formatNumber(data.adminSessions.expired)} expired · ${formatNumber(data.adminSessions.revoked)} ended`}
				/>
				<Metric
					label="Accounts on the watchlist"
					value={data.watchlist.length}
					tone={watchlisted ? 'warn' : 'good'}
					hint={watchlisted ? 'Repeated refusals — see below' : 'No account crossed the threshold'}
				/>
			</MetricGrid>

			<Card
				title="Watchlist — accounts repeatedly refused"
				subtitle="Refusals the platform itself recorded. Not a verdict: review the permissions and times before acting."
				action={
					<Link href="/security/audit-log?outcome=denied" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						All refusals →
					</Link>
				}
			>
				{!watchlisted ? (
					<EmptyState
						message="No account has crossed the threshold"
						hint="An account appears here after several refusals inside the window. The threshold is printed in the notes below."
					/>
				) : (
					<Table columns={['Account', 'Role', 'Refusals', 'Distinct permissions', 'First', 'Latest']}>
						{data.watchlist.map((entry) => (
							<Row key={`${entry.actorEmail}-${entry.role}`}>
								<Cell>
									<div style={{ fontSize: '0.8rem' }}>{entry.actorEmail ?? '(no email on the row)'}</div>
								</Cell>
								<Cell muted>{entry.role ?? '—'}</Cell>
								<Cell align="right">
									<strong>{formatNumber(entry.refusals)}</strong>
								</Cell>
								<Cell align="right" muted>
									{/* The count that separates "kept trying one thing" from "probed the whole
									    permission surface" — a bare refusal count hides the difference. */}
									{formatNumber(entry.distinctPermissions)}
								</Cell>
								<Cell muted>{entry.firstSeen ? formatRelative(entry.firstSeen) : '—'}</Cell>
								<Cell muted>{entry.lastSeen ? formatRelative(entry.lastSeen) : '—'}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<Card title="Failed sign-ins" subtitle="Every attempt the platform recorded, with the reason it gave the operator — never the caller">
				{!data.signIns.instrumented ? (
					<EmptyState
						message="No sign-in attempt has been recorded yet"
						hint="Attempts are recorded by services/auth-events.ts. This is not the same as 'no failures': a newly instrumented deployment has no history, and none is reconstructed."
					/>
				) : (
					<>
						<MetricGrid minWidth={180}>
							{data.signIns.byReason.map((entry) => (
								<Metric
									key={entry.reason}
									label={REASON_LABELS[entry.reason] ?? entry.reason}
									value={entry.count}
									tone={entry.reason === 'account-disabled' ? 'warn' : 'default'}
								/>
							))}
						</MetricGrid>

						<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
							<div>
								<h3 style={subHeading}>Most-attempted addresses</h3>
								{data.signIns.topAttemptedEmails.length === 0 ? (
									<p style={mutedText}>No failed attempt in this window.</p>
								) : (
									<Table columns={['Address', 'Attempts']}>
										{data.signIns.topAttemptedEmails.map((entry, index) => (
											<Row key={`${entry.email ?? 'none'}-${index}`}>
												<Cell mono>{entry.email ?? '(no address sent)'}</Cell>
												<Cell align="right" muted>
													{formatNumber(entry.attempts)}
												</Cell>
											</Row>
										))}
									</Table>
								)}
							</div>
							<div>
								<h3 style={subHeading}>Source addresses</h3>
								{data.signIns.topSourceAddresses.length === 0 ? (
									<p style={mutedText}>No failed attempt in this window.</p>
								) : (
									<Table columns={['Client IP', 'Attempts']}>
										{data.signIns.topSourceAddresses.map((entry, index) => (
											<Row key={`${entry.ip ?? 'none'}-${index}`}>
												<Cell mono>{entry.ip ?? '(not captured)'}</Cell>
												<Cell align="right" muted>
													{formatNumber(entry.attempts)}
												</Cell>
											</Row>
										))}
									</Table>
								)}
							</div>
						</div>

						{data.signIns.recentFailures.length > 0 ? (
							<>
								<h3 style={subHeading}>Most recent failures</h3>
								<Table columns={['When', 'Address tried', 'Reason', 'Client']}>
									{data.signIns.recentFailures.map((entry, index) => (
										<Row key={String(entry.requestId ?? index)}>
											<Cell muted>{formatDateTime(entry.occurredAt as string)}</Cell>
											<Cell mono>{(entry.attemptedEmail as string) ?? '(no address sent)'}</Cell>
											<Cell>{REASON_LABELS[entry.reason as string] ?? String(entry.reason ?? '—')}</Cell>
											<Cell muted>
												<div style={{ fontSize: '0.72rem' }}>{String(entry.clientIp ?? 'no address')}</div>
												<div style={{ fontSize: '0.66rem', color: '#9ca3af', maxWidth: '260px' }}>
													{String(entry.userAgent ?? 'no user-agent')}
												</div>
											</Cell>
										</Row>
									))}
								</Table>
							</>
						) : null}
					</>
				)}
			</Card>

			<Card
				title="Refused privileged actions"
				subtitle="Recorded by the permission check itself, including the caller's stated reason for trying"
				action={
					<Link href="/security/audit-log" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						Full audit log →
					</Link>
				}
			>
				{data.refusals.total === 0 ? (
					<EmptyState message="Nothing was refused in this window" />
				) : (
					<>
						<MetricGrid minWidth={220}>
							{data.refusals.topPermissions.slice(0, 4).map((entry) => (
								<Metric
									key={entry.permission ?? 'none'}
									label={entry.permission ?? '(no permission recorded)'}
									value={entry.refusals}
								/>
							))}
						</MetricGrid>
						<Table columns={['When', 'Action', 'Permission', 'Actor', 'Reason']}>
							{data.refusals.recent.map((entry) => (
								<Row key={String(entry.id)}>
									<Cell muted>{formatDateTime(entry.occurredAt as string)}</Cell>
									<Cell mono>{String(entry.action)}</Cell>
									<Cell mono>{String(entry.permission ?? '—')}</Cell>
									<Cell>
										<div style={{ fontSize: '0.75rem' }}>{String(entry.actorEmail ?? 'unknown')}</div>
										<div style={{ fontSize: '0.66rem', color: '#9ca3af' }}>{String(entry.actorRole ?? '—')}</div>
									</Cell>
									<Cell muted>
										<div style={{ fontSize: '0.72rem', maxWidth: '260px' }}>{String(entry.reason ?? '—')}</div>
									</Cell>
								</Row>
							))}
						</Table>
					</>
				)}
			</Card>

			<Card
				title="Two-factor authentication coverage"
				subtitle="Available is not the same as in use: this is the count of administrators actually covered"
				action={
					<Link href="/security/mfa" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						Enrol your account →
					</Link>
				}
			>
				{coverage === null ? (
					<EmptyState message="Coverage could not be read" hint="The rest of this page is unaffected." />
				) : (
					<>
						<MetricGrid minWidth={200}>
							<Metric
								label="Administrators with a factor"
								value={coverage.confirmed}
								tone={coverage.confirmed > 0 ? 'good' : 'warn'}
								hint="Enrolled and confirmed an authenticator"
							/>
							<Metric
								label="Enrolment started, not confirmed"
								value={coverage.pending}
								tone={coverage.pending > 0 ? 'warn' : 'default'}
								hint="Nothing is enforced for these accounts"
							/>
							<Metric
								label="Administrators without a factor"
								value={coverage.adminsWithout}
								tone={coverage.adminsWithout > 0 ? 'bad' : 'good'}
								hint="A password alone protects these accounts"
							/>
						</MetricGrid>
						<p style={{ fontSize: '0.78rem', color: '#6b7280', margin: '0.75rem 0 0' }}>
							Two-factor is opt-in per account and enforced at sign-in by the API, not by this console.
							{coverage.adminsWithout > 0 ? `${coverage.adminsWithout} administrator account(s) can still be taken over with a password alone.` : 'Every administrator holds a second factor.'}
						</p>
					</>
				)}
			</Card>

			<Card
				title="Operator sessions"
				subtitle="Live console sessions, and the ones ending soonest"
				action={
					<Link href="/security/sessions" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						Manage sessions →
					</Link>
				}
			>
				{data.adminSessions.soonestExpiring.length === 0 ? (
					<EmptyState
						message="No operator is signed in"
						hint="A session row is created the first time a token is used against the control plane."
					/>
				) : (
					<Table columns={['Operator', 'Role', 'Client', 'Last seen', 'Expires']}>
						{data.adminSessions.soonestExpiring.map((entry) => (
							<Row key={String(entry.id)}>
								<Cell>{String(entry.email ?? '(unknown operator)')}</Cell>
								<Cell muted>{String(entry.role)}</Cell>
								<Cell mono>{String(entry.ipAddress ?? 'no address')}</Cell>
								<Cell muted>{entry.lastSeenAt ? formatRelative(String(entry.lastSeenAt)) : '—'}</Cell>
								<Cell muted>{formatDateTime(String(entry.expiresAt))}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<Card
				title="Privilege and configuration changes"
				subtitle="Who changed what the platform does, and who can administer it"
				action={
					<Link href="/security/audit-log" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						Full audit log →
					</Link>
				}
			>
				<h3 style={subHeading}>Role grants and revocations</h3>
				{data.privilegeChanges.length === 0 ? (
					<p style={mutedText}>No role grant or revocation in this window.</p>
				) : (
					<Table columns={['When', 'Action', 'Target', 'Actor', 'Reason']}>
						{data.privilegeChanges.map((entry) => (
							<Row key={String(entry.id)}>
								<Cell muted>{formatDateTime(entry.occurredAt as string)}</Cell>
								<Cell mono>{String(entry.action)}</Cell>
								<Cell mono>{String(entry.targetId ?? '—')}</Cell>
								<Cell>{String(entry.actorEmail ?? 'unknown')}</Cell>
								<Cell muted>
									<div style={{ fontSize: '0.72rem', maxWidth: '260px' }}>{String(entry.reason ?? '—')}</div>
								</Cell>
							</Row>
						))}
					</Table>
				)}

				<h3 style={subHeading}>Configuration, flags and secrets</h3>
				{data.configurationChanges.length === 0 ? (
					<p style={mutedText}>No configuration change in this window.</p>
				) : (
					<Table columns={['When', 'Action', 'Key', 'Actor', 'Outcome']}>
						{data.configurationChanges.map((entry) => (
							<Row key={String(entry.id)}>
								<Cell muted>{formatDateTime(entry.occurredAt as string)}</Cell>
								<Cell mono>{String(entry.action)}</Cell>
								<Cell mono>{String(entry.targetId ?? '—')}</Cell>
								<Cell>{String(entry.actorEmail ?? 'unknown')}</Cell>
								<Cell>
									<StatusBadge status={String(entry.outcome)} />
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<Card
				title="Credential status"
				subtitle="Configured or not, where the value comes from, and when it was last proven to work"
				action={
					<Link href="/ai/secrets" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						Manage credentials →
					</Link>
				}
			>
				<Table columns={['Credential', 'State', 'Source', 'Last test', 'Tested by']}>
					{data.credentials.map((entry) => (
						<Row key={entry.key}>
							<Cell mono>{entry.key}</Cell>
							<Cell>
								<StatusBadge
									status={entry.configured ? 'pass' : 'not_configured'}
									label={entry.configured ? 'configured' : 'not set'}
								/>
							</Cell>
							<Cell muted>{entry.source}</Cell>
							<Cell>
								{entry.testStale ? (
									// A result that describes a value which has since been replaced is not a
									// statement about this credential. Showing the badge would assert a
									// working key that no longer exists — or a failure the operator has
									// already fixed.
									<>
										<StatusBadge status="stale" label="tested a previous value" />
										<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
											last run {entry.lastTestedAt ? formatRelative(entry.lastTestedAt) : ''} · re-test to confirm
										</div>
									</>
								) : entry.lastTestStatus ? (
									<>
										<StatusBadge status={entry.lastTestStatus} />
										<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
											{entry.lastTestedAt ? formatRelative(entry.lastTestedAt) : ''}
										</div>
									</>
								) : (
									// "Unknown" and "healthy" must not look alike: a credential nobody has
									// tested is not a credential that works.
									<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>no test recorded</span>
								)}
							</Cell>
							<Cell muted>
								{entry.testedBy.length > 0 ? (
									entry.testedBy.join(', ')
								) : (
									<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>no connectivity test covers this key</span>
								)}
							</Cell>
						</Row>
					))}
				</Table>
			</Card>

			<Notes notes={data.notes} tone="warn" />
		</div>
	);
}

const subHeading: React.CSSProperties = {
	fontSize: '0.78rem',
	fontWeight: 700,
	textTransform: 'uppercase',
	letterSpacing: '0.05em',
	color: '#6b7280',
	margin: '1.25rem 0 0.4rem',
};

const mutedText: React.CSSProperties = {
	fontSize: '0.8rem',
	color: '#6b7280',
	margin: '0.3rem 0 0',
};
