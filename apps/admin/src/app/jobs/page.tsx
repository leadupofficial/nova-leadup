/**
 * Admin Control Center — background jobs and scheduled work.
 *
 * Two halves, deliberately separated:
 *
 *  1. **Execution history** from `job_executions`.
 *  2. **The scheduled inventory**, read from the queue worker itself: which handlers are registered
 *     and how often the scheduler enqueues them. It used to be a hardcoded list of in-process engines
 *     with a note that they wrote no execution rows — true then, and no longer: the worker writes a row
 *     per run, which is why the history below is populated.
 *
 * **Retry works.** It answered 501 until this release, and the reason was accurate — there was no
 * queue to re-enqueue into. `src/jobs/queue.ts` now claims with `FOR UPDATE SKIP LOCKED`, so a retry
 * resets the row to `queued` and whichever replica gets there first runs it. Retrying something
 * already queued or running is refused with 409: that is a duplicate, not a retry.
 */

import { getOperations } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { ListView, positiveInt, shortId, singleParam, type Column } from '../../components/operations-list';
import { retryJobAction } from './actions';
import { Card, Notes, StatusBadge, formatDateTime, formatDuration, formatNumber, formatRelative } from '../../components/ui';

export const dynamic = 'force-dynamic';

type JobRow = {
	id: string;
	job_name: string;
	queue_name: string | null;
	worker_id: string | null;
	status: string;
	user_id: string | null;
	related_type: string | null;
	related_id: string | null;
	attempt: number;
	max_attempts: number;
	error_message: string | null;
	duration_ms: number | null;
	request_id: string | null;
	started_at: string | null;
	finished_at: string | null;
	created_at: string;
	user_email: string | null;
};

type JobStat = {
	job_name: string;
	total: number;
	failed: number;
	dead_letter: number;
	running: number;
	avg_duration_ms: number;
	last_run_at: string | null;
};

type ScheduledJob = {
	name: string;
	kind: string;
	startedBy: string;
	description: string;
	interval: string | null;
};

type JobsPayload = {
	data: JobRow[];
	byJob: JobStat[];
	scheduled: ScheduledJob[];
	page: number;
	pageSize: number;
	totalItems: number;
	totalPages: number;
	note: string | null;
	/** The queue's own state, so "nothing has run" is distinguishable from "no worker". */
	worker?: {
		id: string | null;
		running: boolean;
		handlers: string[];
		byStatus: Record<string, number>;
		oldestQueuedSeconds: number | null;
		reclaimable: number;
	};
	notes?: string[];
};

const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled'];

export default async function JobsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const page = positiveInt(resolved.page, 1);
	const status = singleParam(resolved.status);
	const jobName = singleParam(resolved.jobName);
	const userId = singleParam(resolved.userId);

	// This endpoint answers a richer envelope than the generic list (it carries the
	// scheduled inventory and a per-job rollup), so it is fetched directly.
	const result = await loadPage<JobsPayload>(async () => {
		const envelope = await getOperations<never>('jobs', {
			page,
			pageSize: 25,
			...(status ? { status } : {}),
			...(jobName ? { jobName } : {}),
			...(userId ? { userId } : {}),
		});
		const payload = envelope as unknown as JobsPayload;
		return {
			rows: [payload],
			totalItems: payload.totalItems ?? null,
			totalPages: payload.totalPages ?? null,
		};
	});

	const payload = result.ok ? result.rows[0] : null;
	const rows = payload?.data ?? [];
	const query = {
		...(status ? { status } : {}),
		...(jobName ? { jobName } : {}),
		...(userId ? { userId } : {}),
	};

	const columns: Array<Column<JobRow>> = [
		{
			header: 'Job',
			render: (row) => (
				<>
					<div style={{ fontWeight: 500 }}>{row.job_name}</div>
					<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
						{shortId(row.id)}
						{row.queue_name ? ` · ${row.queue_name}` : ''}
					</div>
				</>
			),
		},
		{ header: 'Status', render: (row) => <StatusBadge status={row.status} /> },
		{
			header: 'Attempt',
			align: 'right',
			render: (row) => (
				<span style={{ fontSize: '0.8rem' }}>
					{row.attempt}/{row.max_attempts}
				</span>
			),
		},
		{ header: 'Duration', align: 'right', render: (row) => <span style={{ fontSize: '0.8rem' }}>{formatDuration(row.duration_ms)}</span> },
		{
			header: 'User / entity',
			render: (row) => (
				<span style={{ fontSize: '0.78rem' }}>
					{row.user_email ?? (row.user_id ? shortId(row.user_id) : '—')}
					{row.related_type ? (
						<div style={{ fontSize: '0.7rem', color: '#9ca3af' }}>
							{row.related_type} {shortId(row.related_id)}
						</div>
					) : null}
				</span>
			),
		},
		{
			header: 'Error',
			render: (row) =>
				row.error_message ? (
					<span style={{ fontSize: '0.76rem', color: '#dc2626', maxWidth: '260px', display: 'block' }}>
						{row.error_message}
					</span>
				) : (
					<span style={{ color: '#9ca3af' }}>—</span>
				),
		},
		{ header: 'Started', render: (row) => <span style={{ fontSize: '0.78rem' }}>{formatDateTime(row.started_at ?? row.created_at)}</span> },
		{
			header: 'Retry',
			render: (row) =>
				// Only the states the queue will actually accept. Offering it on a running job would
				// produce a refusal the operator cannot act on, and the API refuses for a reason:
				// waiting for a job to finish is not a retry.
				['failed', 'dead_letter', 'cancelled'].includes(row.status) ? (
					<form action={retryJobAction}>
						<input type="hidden" name="id" value={row.id} />
						<button type="submit" style={retryButton}>
							Requeue
						</button>
					</form>
				) : (
					<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>—</span>
				),
		},
	];

	const retryButton: React.CSSProperties = {
		fontSize: '0.72rem',
		padding: '0.25rem 0.5rem',
		borderRadius: '4px',
		border: '1px solid #c7d2fe',
		background: '#eef2ff',
		color: '#4338ca',
		cursor: 'pointer',
	};

	const scheduledCards = (
		<Card
			title="Scheduled work"
			subtitle="The queue worker and the handlers it runs — every run is a row below"
		>
			<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
				<tbody>
					{(payload?.scheduled ?? []).map((job) => (
						<tr key={job.name} style={{ borderBottom: '1px solid #f3f4f6' }}>
							<td style={{ padding: '0.55rem 0.5rem', fontFamily: 'ui-monospace, Menlo, monospace', fontWeight: 500 }}>
								{job.name}
							</td>
							<td style={{ padding: '0.55rem 0.5rem', color: '#6b7280' }}>{job.description}</td>
							<td style={{ padding: '0.55rem 0.5rem', fontSize: '0.72rem', color: '#9ca3af', whiteSpace: 'nowrap' }}>
								{job.startedBy}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</Card>
	);

	const rollup =
		// `?? []` rather than a bare `.length`: this page reads a route whose response was rewritten once
		// and silently lost `byJob` — the page then threw inside the render with the table below it still
		// populated, so the browser sweep passed. A missing section should render nothing, not crash the
		// page that has the data an operator came for.
		payload && (payload.byJob ?? []).length > 0 ? (
			<Card title="Per-job rollup" subtitle="Totals across all recorded executions">
				<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
					<thead>
						<tr style={{ borderBottom: '1px solid #e5e7eb', textAlign: 'left' }}>
							<th style={th}>Job</th>
							<th style={th}>Total</th>
							<th style={th}>Failed</th>
							<th style={th}>Dead letter</th>
							<th style={th}>Running</th>
							<th style={th}>Avg duration</th>
							<th style={th}>Last run</th>
						</tr>
					</thead>
					<tbody>
						{payload.byJob.map((stat) => (
							<tr key={stat.job_name} style={{ borderBottom: '1px solid #f3f4f6' }}>
								<td style={{ padding: '0.5rem 0.5rem', fontFamily: 'ui-monospace, Menlo, monospace' }}>{stat.job_name}</td>
								<td style={{ padding: '0.5rem 0.5rem' }}>{formatNumber(stat.total)}</td>
								<td style={{ padding: '0.5rem 0.5rem', color: stat.failed > 0 ? '#dc2626' : undefined }}>{formatNumber(stat.failed)}</td>
								<td style={{ padding: '0.5rem 0.5rem', color: stat.dead_letter > 0 ? '#dc2626' : undefined }}>
									{formatNumber(stat.dead_letter)}
								</td>
								<td style={{ padding: '0.5rem 0.5rem' }}>{formatNumber(stat.running)}</td>
								<td style={{ padding: '0.5rem 0.5rem' }}>{formatDuration(stat.avg_duration_ms)}</td>
								<td style={{ padding: '0.5rem 0.5rem', color: '#6b7280' }}>
									{stat.last_run_at ? formatRelative(stat.last_run_at) : '—'}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</Card>
		) : null;

	if (!result.ok) {
		return (
			<ListView
				title="Jobs & Queues"
				path="jobs"
				columns={columns}
				rows={[]}
				totalItems={null}
				totalPages={null}
				page={1}
				query={{}}
				rowKey={(row) => row.id}
				notes={[result.message]}
				emptyMessage="Could not load job executions"
			/>
		);
	}

	return (
		<>
			<ListView
				title="Jobs & Queues"
				path="jobs"
				columns={columns}
				rows={rows}
				totalItems={payload?.totalItems ?? null}
				totalPages={payload?.totalPages ?? null}
				page={page}
				query={query}
				filters={[{ name: 'status', label: 'Status', options: STATUSES.map((value) => ({ value, label: value })) }]}
				searchParam="jobName"
				searchPlaceholder="Exact job name, e.g. follow-up-engine"
				searchValue={jobName}
				rowKey={(row) => row.id}
				notes={[
					payload?.note,
					'There is no queue: these engines run in-process on an interval, so "queue depth" is not a meaningful metric here and is not shown.',
					'Retry is not offered. A job_executions row is a record, not a queued message — there is no broker to re-enqueue into, so the API refuses with 501 rather than pretending it retried.',
				]}
				emptyMessage="No job executions recorded"
				emptyHint="See “Scheduled engines” below — those run on an interval and do not write execution rows, so an empty table does not mean nothing is running."
			/>
			<div style={{ marginTop: '1.5rem' }}>
				{scheduledCards}
				{rollup}
			</div>
		</>
	);
}

const th: React.CSSProperties = {
	padding: '0.5rem 0.5rem',
	fontWeight: 600,
	color: '#6b7280',
	fontSize: '0.72rem',
	textTransform: 'uppercase',
	letterSpacing: '0.03em',
};
