/**
 * Admin Control Center — the administrator audit log.
 *
 * This is a **different table from `/audit-logs`**. That one records what users and the
 * platform did; this one records what *operators* did to the platform, and it is the
 * record that answers "who changed the AI model at 3am, and why".
 *
 * Three guarantees are enforced, not promised:
 *
 *  - **Append-only.** A database trigger installed by migration 0006 rejects UPDATE and
 *    DELETE, so the rows cannot be edited even with direct database access. There is no
 *    API route that mutates this table.
 *  - **Refusals are recorded.** A denied attempt writes a row with `outcome = 'denied'`,
 *    which is how an over-reaching or compromised admin account becomes visible.
 *  - **Secrets never land here.** `before`/`after` snapshots pass through a redactor that
 *    replaces any secret-shaped field with `[REDACTED]` before the row is written.
 *
 * `before` and `after` are rendered as formatted JSON in a collapsed `<details>`, so an
 * operator can see exactly what changed without a wall of text on the list.
 *
 * **Export** hands the operator a CSV of the rows their filters select. It is a separate
 * permission (`audit.export`, held only by SUPER_ADMIN) because reading the log in the console and
 * taking a copy of it out of the platform are different capabilities, and the export writes its own
 * audit row before reading anything.
 */

import Link from 'next/link';
import { getAdminAuditLogs, type AdminAuditEntry } from '../../../lib/api';
import { loadPage } from '../../../lib/page-data';
import { PageError } from '../../../components/PageError';
import {
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
} from '../../../components/ui';

export const dynamic = 'force-dynamic';

const OUTCOMES = [
	{ value: 'success', label: 'Succeeded' },
	{ value: 'failure', label: 'Failed (the operation errored)' },
	{ value: 'denied', label: 'Refused (permission)' },
];

function single(value: string | string[] | undefined): string {
	return typeof value === 'string' ? value : '';
}

function positiveInt(value: string | string[] | undefined, fallback: number): number {
	const raw = Array.isArray(value) ? value[0] : value;
	const parsed = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Render an audit snapshot.
 *
 * Truncated at a generous bound: a snapshot of a large object would otherwise dominate
 * the page. The bound is stated rather than silent so nobody assumes they are seeing all
 * of it.
 */
function Snapshot({ label, value }: { label: string; value: unknown }) {
	if (value === null || value === undefined) return null;
	const text = JSON.stringify(value, null, 2);
	if (!text || text === '{}' || text === 'null') return null;
	const truncated = text.length > 4000;
	return (
		<details style={{ marginTop: '0.3rem' }}>
			<summary style={{ cursor: 'pointer', fontSize: '0.72rem', color: '#6b7280' }}>{label}</summary>
			<pre
				style={{
					margin: '0.3rem 0 0',
					padding: '0.5rem',
					background: '#f9fafb',
					border: '1px solid #e5e7eb',
					borderRadius: '6px',
					fontSize: '0.7rem',
					maxHeight: '260px',
					overflow: 'auto',
				}}
			>
				{truncated ? `${text.slice(0, 4000)}\n… truncated` : text}
			</pre>
		</details>
	);
}

/**
 * Renders a stored ISO instant back into the value a `datetime-local` input expects.
 *
 * Done here rather than by slicing the ISO string, which would show UTC while the input reads it as
 * local — the filter would then appear to shift by the operator's offset on every round trip.
 */
function localInputValue(iso: string | null): string {
	if (!iso) return '';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '';
	const offsetMs = date.getTimezoneOffset() * 60_000;
	return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

/**
 * Normalises a `datetime-local` value into an ISO instant, or drops it.
 *
 * Returns `null` rather than passing a malformed value through: a bad date in the URL should leave the
 * filter off, not make the page fail with a validation error about a field the operator cannot see.
 */
function toIsoInstant(value: string): string | null {
	if (!value) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export default async function ControlAuditPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const page = positiveInt(resolved.page, 1);
	const outcome = single(resolved.outcome);
	const action = single(resolved.action);
	const search = single(resolved.search);
	const actorId = single(resolved.actorId);
	// A date range. `datetime-local` sends `2026-09-21T14:30`, which the API's `.datetime()` rejects, so
	// the browser's local precision is normalised to an ISO instant here — the filter has to send what
	// the endpoint accepts or the operator gets a validation error for using the control as designed.
	const from = toIsoInstant(single(resolved.from));
	const to = toIsoInstant(single(resolved.to));

	const query = {
		...(outcome ? { outcome } : {}),
		...(action ? { action } : {}),
		...(search ? { search } : {}),
		...(actorId ? { actorId } : {}),
		...(from ? { from } : {}),
		...(to ? { to } : {}),
	};

	const result = await loadPage<Awaited<ReturnType<typeof getAdminAuditLogs>>>(async () => {
		const data = await getAdminAuditLogs({ page, pageSize: 50, ...query });
		return { rows: [data], totalItems: data.totalItems, totalPages: data.totalPages };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Admin Audit Log" />
				<PageError
					title="Could not load the audit log"
					message={result.message}
					status={result.status}
					retryHref="/security/audit-log"
				/>
			</div>
		);
	}

	const payload = result.rows[0];
	const rows: AdminAuditEntry[] = payload?.rows ?? [];
	const successCount = payload?.outcomes.find((entry) => entry.outcome === 'success')?.count ?? 0;
	const deniedCount = payload?.outcomes.find((entry) => entry.outcome === 'denied')?.count ?? 0;
	const failureCount = payload?.outcomes.find((entry) => entry.outcome === 'failure')?.count ?? 0;

	const href = (next: number) =>
		`/security/audit-log?${new URLSearchParams({ ...query, page: String(next) }).toString()}`;

	return (
		<div>
			<PageHeader
				title="Admin Audit Log"
				subtitle={
					<>
						Every privileged administrator action, including refusals. Append-only at the database level.{' '}
						<Link href="/audit-logs" style={{ color: '#2563eb' }}>
							User/platform audit →
						</Link>
					</>
				}
				actions={
					// A plain link, not a button with a handler: the endpoint answers
					// `Content-Disposition: attachment`, so the browser performs the download and the
					// console never holds the file in memory. The current filters travel with it, so
					// the export is what the operator was looking at rather than the whole table.
					<a
						href={`/security/audit-log/export?${new URLSearchParams(query).toString()}`}
						style={{
							padding: '0.45rem 0.9rem',
							background: '#1a1a2e',
							color: '#fff',
							borderRadius: '6px',
							fontSize: '0.8rem',
							textDecoration: 'none',
							whiteSpace: 'nowrap',
						}}
					>
						Export CSV
					</a>
				}
			/>

			<MetricGrid minWidth={170}>
				<Metric label="Total records" value={payload?.totalItems ?? 0} />
				<Metric label="Succeeded" value={successCount} tone="good" />
				<Metric label="Failed" value={failureCount} tone={failureCount > 0 ? 'warn' : 'default'} />
				<Metric
					label="Refused"
					value={deniedCount}
					tone={deniedCount > 0 ? 'bad' : 'good'}
					hint={deniedCount > 0 ? 'A role attempted something it may not do' : 'No permission refusals recorded'}
				/>
			</MetricGrid>

			<Notes notes={payload?.notes ?? []} tone="warn" />

			{payload && payload.topActions.length > 0 ? (
				<p style={{ fontSize: '0.78rem', color: '#6b7280', marginBottom: '1rem' }}>
					Most frequent actions:{' '}
					{payload.topActions
						.slice(0, 6)
						.map((entry) => `${entry.action} (${entry.count})`)
						.join(' · ')}
				</p>
			) : null}

			<form method="get" style={filterBarStyle}>
				<div style={{ flex: '2 1 240px' }}>
					<label htmlFor="audit-search" style={labelStyle}>
						Search actor, action or target
					</label>
					<input id="audit-search" name="search" defaultValue={search} style={{ ...inputStyle, width: '100%' }} />
				</div>
				<div style={{ flex: '1 1 160px' }}>
					<label htmlFor="audit-outcome" style={labelStyle}>
						Outcome
					</label>
					<select id="audit-outcome" name="outcome" defaultValue={outcome} style={{ ...inputStyle, width: '100%' }}>
						<option value="">Any</option>
						{OUTCOMES.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>
				<div style={{ flex: '1 1 200px' }}>
					<label htmlFor="audit-action" style={labelStyle}>
						Exact action
					</label>
					<input
						id="audit-action"
						name="action"
						defaultValue={action}
						placeholder="e.g. control.update"
						style={{ ...inputStyle, width: '100%' }}
					/>
				</div>
				<div style={{ flex: '1 1 200px' }}>
					<label htmlFor="audit-actor" style={labelStyle}>
						Actor user id
					</label>
					<input id="audit-actor" name="actorId" defaultValue={actorId} style={{ ...inputStyle, width: '100%' }} />
				</div>
				<div style={{ flex: '1 1 200px' }}>
					<label htmlFor="audit-from" style={labelStyle}>
						From
					</label>
					<input
						id="audit-from"
						name="from"
						type="datetime-local"
						defaultValue={localInputValue(from)}
						style={{ ...inputStyle, width: '100%' }}
					/>
				</div>
				<div style={{ flex: '1 1 200px' }}>
					<label htmlFor="audit-to" style={labelStyle}>
						To
					</label>
					<input
						id="audit-to"
						name="to"
						type="datetime-local"
						defaultValue={localInputValue(to)}
						style={{ ...inputStyle, width: '100%' }}
					/>
				</div>
				<button type="submit" style={primaryButton}>
					Filter
				</button>
				{Object.keys(query).length > 0 ? (
					<Link href="/security/audit-log" style={{ fontSize: '0.78rem', color: '#6b7280', alignSelf: 'center' }}>
						Clear
					</Link>
				) : null}
			</form>

			{rows.length === 0 ? (
				<div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px' }}>
					<EmptyState
						message="No audit records match this filter"
						hint="On a fresh install this table is genuinely empty until an administrator changes something."
					/>
				</div>
			) : (
				<Table columns={['When', 'Administrator', 'Action', 'Target', 'Outcome', 'Reason', 'Change', 'Request']}>
					{rows.map((entry) => (
						<Row key={entry.id}>
							<Cell muted>
								{formatDateTime(entry.occurred_at)}
								<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>{entry.ip_address ?? 'no ip recorded'}</div>
							</Cell>
							<Cell>
								<div style={{ fontSize: '0.78rem' }}>{entry.actor_email ?? entry.actor_id ?? 'unknown'}</div>
								<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>{entry.actor_role ?? 'no role claim'}</div>
							</Cell>
							<Cell mono>{entry.action}</Cell>
							<Cell muted>
								{entry.target_type ? (
									<>
										{entry.target_type}
										{entry.target_id ? (
											<div style={{ fontSize: '0.68rem', color: '#9ca3af', maxWidth: '160px', wordBreak: 'break-all' }}>
												{entry.target_id}
											</div>
										) : null}
									</>
								) : (
									'—'
								)}
							</Cell>
							<Cell>
								<StatusBadge status={entry.outcome} />
								{entry.permission ? (
									<div style={{ fontSize: '0.66rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
										{entry.permission}
									</div>
								) : null}
							</Cell>
							<Cell muted>
								<div style={{ maxWidth: '200px', fontSize: '0.75rem' }}>{entry.reason ?? '—'}</div>
							</Cell>
							<Cell>
								<Snapshot label="before" value={entry.before} />
								<Snapshot label="after" value={entry.after} />
								{!entry.before && !entry.after ? <span style={{ color: '#9ca3af', fontSize: '0.75rem' }}>—</span> : null}
							</Cell>
							<Cell muted>
								{entry.request_id ? (
									<Link
										href={`/logs?traceId=${encodeURIComponent(entry.request_id)}`}
										style={{ fontSize: '0.7rem', color: '#2563eb', fontFamily: 'ui-monospace, Menlo, monospace' }}
									>
										{entry.request_id.slice(0, 16)}…
									</Link>
								) : (
									'—'
								)}
							</Cell>
						</Row>
					))}
				</Table>
			)}

			{payload?.totalPages && payload.totalPages > 1 ? (
				<div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '1rem' }}>
					{page > 1 ? (
						<Link href={href(page - 1)} style={pagerStyle}>
							← Previous
						</Link>
					) : null}
					<span style={{ fontSize: '0.8rem', color: '#6b7280' }}>
						Page {page} of {payload.totalPages}
					</span>
					{page < payload.totalPages ? (
						<Link href={href(page + 1)} style={pagerStyle}>
							Next →
						</Link>
					) : null}
				</div>
			) : null}

			<Notes
				notes={[
					'This table cannot be pruned or edited by design: the migration installs a trigger that rejects UPDATE and DELETE. Growth is unbounded, which is the intended trade for tamper resistance.',
					'Export downloads a CSV of exactly the rows the current filters select — including the date range — capped at 50,000. The API reports whether the cap was reached, so a truncated file cannot be mistaken for the whole log. Cells beginning with a spreadsheet formula character are prefixed so an operator-supplied reason cannot execute on the machine of whoever opens the file, and the export itself is written to this log before the data is read.',
					`Showing ${formatNumber(rows.length)} of ${formatNumber(payload?.totalItems ?? rows.length)} record(s).`,
				]}
			/>
		</div>
	);
}

const inputStyle: React.CSSProperties = {
	padding: '0.4rem 0.55rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.78rem',
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

const primaryButton: React.CSSProperties = {
	padding: '0.45rem 1rem',
	background: '#1a1a2e',
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.8rem',
	cursor: 'pointer',
};

const pagerStyle: React.CSSProperties = {
	padding: '0.4rem 0.85rem',
	background: '#fff',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.8rem',
	color: '#2563eb',
	textDecoration: 'none',
};

const filterBarStyle: React.CSSProperties = {
	display: 'flex',
	gap: '0.6rem',
	flexWrap: 'wrap',
	marginBottom: '1rem',
	padding: '0.9rem 1rem',
	background: '#fff',
	border: '1px solid #e5e7eb',
	borderRadius: '10px',
	alignItems: 'flex-end',
};
