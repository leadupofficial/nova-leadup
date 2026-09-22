/**
 * Admin Control Center — logs and correlation traces.
 *
 * There **is** a log store now, and this page reads it. `services/api` writes structured pino JSON to
 * stdout *and* to a Postgres-backed sink (`utils/log-sink.ts`, migration 0013), which the query route
 * searches. Until this release the page said there was no sink and named the fix in the same breath —
 * *"wire a sink to the pino stream and add a query route over it"* — which is what happened.
 *
 * What the store holds is narrower than "all logs", and the page says so where a reader will see it:
 * only `warn` and above are persisted, retention is a week, and the sink drops the oldest entries
 * rather than blocking a request if the database cannot keep up. A quiet table therefore means no
 * warnings, not no traffic.
 *
 * The trace lookup still assembles records that share an id rather than a causal chain, and it now
 * includes the durable log lines — which is the source that makes a *failed* request legible, since
 * the other tables record what the platform chose to do and this records what it said while doing it.
 */

import Link from 'next/link';
import { getLogs, getTrace } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { Card, Cell, EmptyState, Notes, PageHeader, Row, StatusBadge, Table, formatDateTime, formatNumber } from '../../components/ui';

export const dynamic = 'force-dynamic';

const inputStyle: React.CSSProperties = {
	padding: '0.5rem 0.7rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.85rem',
	width: '100%',
};

export default async function LogsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const single = (value: string | string[] | undefined): string =>
		(Array.isArray(value) ? value[0] : value ?? '').trim();

	const traceId = single(resolved.traceId);
	// The log filters live in the URL so a view is shareable and a failure is reproducible — which is
	// the whole point of a log viewer during an incident.
	const query = {
		q: single(resolved.q),
		level: single(resolved.level),
		requestId: single(resolved.requestId),
	};

	const result = await loadPage(async () => {
		const [logs, trace] = await Promise.all([
			getLogs({ q: query.q || undefined, level: query.level || undefined, requestId: query.requestId || undefined, pageSize: 50 }).catch(() => null),
			traceId ? getTrace(traceId).catch(() => null) : Promise.resolve(null),
		]);
		return { rows: [{ logs, trace }] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Logs & Traces" />
				<Notes notes={[result.message]} tone="warn" />
			</div>
		);
	}

	const { logs, trace } = result.rows[0];

	return (
		<div>
			<PageHeader
				title="Logs & Traces"
				subtitle="Correlation lookup across the records that carry a request id"
				actions={
					<Link href="/security/audit-log" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Admin audit log →
					</Link>
				}
			/>

			<Card
				title="Trace a correlation id"
				subtitle="Paste the X-Request-Id from a log line, or the request id shown on an audit row"
			>
				<form method="get" style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end' }}>
					<div style={{ flex: 1 }}>
						<label htmlFor="traceId" style={{ display: 'block', fontSize: '0.68rem', fontWeight: 600, color: '#6b7280', marginBottom: '0.2rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
							Correlation id
						</label>
						<input id="traceId" name="traceId" defaultValue={traceId} placeholder="req_… or a uuid" style={inputStyle} />
					</div>
					<button
						type="submit"
						style={{
							padding: '0.5rem 1.1rem',
							background: '#1a1a2e',
							color: '#fff',
							border: 'none',
							borderRadius: '6px',
							fontSize: '0.85rem',
							cursor: 'pointer',
							whiteSpace: 'nowrap',
						}}
					>
						Look up
					</button>
				</form>
			</Card>

			{traceId ? (
				trace ? (
					<Card
						title={`Timeline for ${traceId}`}
						subtitle={trace.available ? 'Records sharing this id, ordered by time' : 'Partial: this stack does not emit spans'}
					>
						<Notes notes={[trace.reason, trace.note].filter((note): note is string => Boolean(note))} tone="warn" />

						{trace.timeline.length === 0 ? (
							<EmptyState
								message="Nothing carries this correlation id"
								hint="Absence is not evidence the work did not happen — a process that never received the id writes no row."
							/>
						) : (
							<Table columns={['When', 'Source', 'Record']}>
								{trace.timeline.map((entry, index) => (
									<Row key={`${entry.source}-${index}`}>
										<Cell muted>{formatDateTime(entry.timestamp)}</Cell>
										<Cell>
											<StatusBadge status="active" label={entry.source} />
										</Cell>
										<Cell>
											<div style={{ fontSize: '0.8rem' }}>{entry.summary}</div>
											{entry.detail ? (
												<details style={{ marginTop: '0.25rem' }}>
													<summary style={{ cursor: 'pointer', fontSize: '0.7rem', color: '#6b7280' }}>detail</summary>
													<pre style={{ margin: '0.25rem 0 0', fontSize: '0.68rem', background: '#f9fafb', padding: '0.4rem', borderRadius: '4px', maxHeight: '200px', overflow: 'auto' }}>
														{JSON.stringify(entry.detail, null, 2)}
													</pre>
												</details>
											) : null}
										</Cell>
									</Row>
								))}
							</Table>
						)}
					</Card>
				) : (
					<Notes notes={['The trace lookup did not return a result for this id.']} tone="warn" />
				)
			) : null}

			<Card
				title="Log centre"
				subtitle={
					logs?.available
						? `${formatNumber(logs.totalItems ?? 0)} entr${(logs.totalItems ?? 0) === 1 ? 'y' : 'ies'} at ${logs.level} and above, kept for ${logs.retentionDays} day(s)`
						: 'Not available in this deployment'
				}
			>
				{!logs?.available ? (
					<>
						<Notes notes={[logs?.reason].filter((note): note is string => Boolean(note))} tone="warn" />
						{logs?.whatExists && logs.whatExists.length > 0 ? (
							<>
								<h3 style={subHeading}>What exists</h3>
								<ul style={listStyle}>
									{logs.whatExists.map((item) => (
										<li key={item}>{item}</li>
									))}
								</ul>
							</>
						) : null}
					</>
				) : (
					<>
						<form method="get" style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '1rem' }}>
							<div style={{ flex: '1 1 220px' }}>
								<label htmlFor="q" style={labelStyle}>Search</label>
								<input id="q" name="q" defaultValue={query.q} placeholder="message, error, route…" style={inputStyle} />
							</div>
							<div style={{ flex: '0 0 140px' }}>
								<label htmlFor="level" style={labelStyle}>Minimum level</label>
								<select id="level" name="level" defaultValue={query.level} style={inputStyle}>
									<option value="">warn and above</option>
									<option value="error">error and above</option>
									<option value="fatal">fatal only</option>
									<option value="info">info and above</option>
									<option value="debug">debug and above</option>
								</select>
							</div>
							<div style={{ flex: '0 0 220px' }}>
								<label htmlFor="requestId" style={labelStyle}>Request id</label>
								<input id="requestId" name="requestId" defaultValue={query.requestId} placeholder="exact correlation id" style={inputStyle} />
							</div>
							<button type="submit" style={submitStyle}>Filter</button>
						</form>

						{logs.byLevel && logs.byLevel.length > 0 ? (
							<p style={{ fontSize: '0.78rem', color: '#6b7280', margin: '0 0 0.8rem' }}>
								Whole store: {logs.byLevel.map((entry) => `${entry.level} ${formatNumber(entry.count)}`).join(' · ')}
								{logs.droppedSinceBoot ? ` · ${formatNumber(logs.droppedSinceBoot)} dropped by the sink` : ''}
								{logs.pendingRows ? ` · ${formatNumber(logs.pendingRows)} waiting to flush` : ''}
							</p>
						) : null}

						{!logs.rows || logs.rows.length === 0 ? (
							<EmptyState
								message="No stored entry matches"
								hint={`Only ${logs.level} and above are persisted, so this means no warnings or errors matched — not that the platform was idle.`}
							/>
						) : (
							<Table columns={['When', 'Level', 'Message', 'Where', 'Correlation']}>
								{logs.rows.map((entry) => (
									<Row key={entry.id}>
										<Cell muted>{formatDateTime(entry.occurredAt)}</Cell>
										<Cell>
											<StatusBadge status={entry.level} />
										</Cell>
										<Cell>
											<div style={{ fontSize: '0.8rem' }}>{entry.msg ?? '(no message)'}</div>
											{entry.errorType ? (
												<div style={{ fontSize: '0.7rem', color: '#b91c1c' }}>
													{entry.errorType}
													{entry.errorMessage ? ` — ${entry.errorMessage}` : ''}
												</div>
											) : null}
											{entry.stack ? (
												<details style={{ marginTop: '0.25rem' }}>
													<summary style={{ cursor: 'pointer', fontSize: '0.7rem', color: '#6b7280' }}>stack trace</summary>
													<pre style={preStyle}>{entry.stack}</pre>
												</details>
											) : null}
											{entry.context && Object.keys(entry.context).length > 0 ? (
												<details style={{ marginTop: '0.2rem' }}>
													<summary style={{ cursor: 'pointer', fontSize: '0.7rem', color: '#6b7280' }}>context</summary>
													<pre style={preStyle}>{JSON.stringify(entry.context, null, 2)}</pre>
												</details>
											) : null}
										</Cell>
										<Cell muted>
											<div style={{ fontSize: '0.72rem' }}>
												{entry.method ? `${entry.method} ` : ''}
												{entry.route ?? '—'}
												{entry.statusCode ? ` → ${entry.statusCode}` : ''}
											</div>
											<div style={{ fontSize: '0.66rem', color: '#9ca3af' }}>
												{entry.service}
												{entry.durationMs !== null && entry.durationMs !== undefined ? ` · ${entry.durationMs} ms` : ''}
											</div>
										</Cell>
										<Cell muted>
											{entry.requestId ? (
												<Link href={`/logs?traceId=${encodeURIComponent(entry.requestId)}`} style={{ fontSize: '0.72rem', color: '#2563eb' }}>
													{entry.requestId}
												</Link>
											) : (
												<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>none</span>
											)}
										</Cell>
									</Row>
								))}
							</Table>
						)}

						<Notes notes={logs.notes ?? []} tone="warn" />
					</>
				)}
			</Card>

			<Card title="Correlation ids in this stack" subtitle="Where a request id is actually written">
				<Table columns={['Table', 'Column', 'Written by']}>
					<Row>
						<Cell mono>admin_audit_logs</Cell>
						<Cell mono>request_id, trace_id</Cell>
						<Cell muted>Every privileged admin action, including refusals</Cell>
					</Row>
					<Row>
						<Cell mono>job_executions</Cell>
						<Cell mono>request_id</Cell>
						<Cell muted>Nothing yet — the in-process engines do not write this table</Cell>
					</Row>
					<Row>
						<Cell mono>tool_executions</Cell>
						<Cell mono>request_id</Cell>
						<Cell muted>The assistant tool executor</Cell>
					</Row>
					<Row>
						<Cell mono>audit_logs</Cell>
						<Cell mono>request_id</Cell>
						<Cell muted>User and platform actions</Cell>
					</Row>
				</Table>
			</Card>
		</div>
	);
}

const labelStyle: React.CSSProperties = {
	display: 'block',
	fontSize: '0.68rem',
	fontWeight: 600,
	color: '#6b7280',
	marginBottom: '0.2rem',
	textTransform: 'uppercase',
	letterSpacing: '0.03em',
};

const submitStyle: React.CSSProperties = {
	padding: '0.5rem 1.1rem',
	background: '#1a1a2e',
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.85rem',
	cursor: 'pointer',
	whiteSpace: 'nowrap',
};

const preStyle: React.CSSProperties = {
	margin: '0.25rem 0 0',
	fontSize: '0.68rem',
	background: '#f9fafb',
	padding: '0.4rem',
	borderRadius: '4px',
	maxHeight: '200px',
	overflow: 'auto',
};

const subHeading: React.CSSProperties = {
	fontSize: '0.8rem',
	fontWeight: 600,
	color: '#374151',
	margin: '0.9rem 0 0.4rem',
};

const listStyle: React.CSSProperties = {
	margin: 0,
	paddingLeft: '1.1rem',
	fontSize: '0.8rem',
	lineHeight: 1.7,
	color: '#374151',
};
