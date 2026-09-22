/**
 * Admin Control Center — tasks.
 *
 * Server-filtered and paginated. "Overdue" is computed in the API from
 * `due_at < now() AND status <> 'completed'`, so it reflects the real definition rather
 * than a client-side guess.
 *
 * Status and priority are editable here because an operator occasionally has to correct
 * a task on a user's behalf during support, but every change carries a required reason
 * and lands in the audit log with a before/after snapshot.
 */

import Link from 'next/link';
import { getOperations } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { PageError } from '../../components/PageError';
import {
	Cell,
	EmptyState,
	Notes,
	PageHeader,
	Row,
	StatusBadge,
	Table,
	formatDateTime,
	formatNumber,
	formatRelative,
} from '../../components/ui';
import { updateTaskAction } from '../actions/operations';

export const dynamic = 'force-dynamic';

const inputStyle: React.CSSProperties = {
	padding: '0.4rem 0.55rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.78rem',
};

type TaskRow = {
	id: string;
	user_id: string;
	user_email: string | null;
	title: string;
	description: string | null;
	status: string;
	priority: string;
	due_at: string | null;
	completed_at: string | null;
	source: string;
	tags: unknown;
	created_at: string;
	overdue: boolean;
	linked_reminders: number;
};

const STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

function single(value: string | string[] | undefined): string {
	return typeof value === 'string' ? value : '';
}

function positiveInt(value: string | string[] | undefined, fallback: number): number {
	const raw = Array.isArray(value) ? value[0] : value;
	const parsed = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default async function TasksPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const page = positiveInt(resolved.page, 1);
	const status = single(resolved.status);
	const priority = single(resolved.priority);
	const search = single(resolved.search);
	const overdueOnly = single(resolved.overdue) === 'true';
	const okMessage = single(resolved.ok);
	const errorMessage = single(resolved.error);

	const query = {
		...(status ? { status } : {}),
		...(priority ? { priority } : {}),
		...(search ? { search } : {}),
		...(overdueOnly ? { overdue: 'true' } : {}),
	};
	const returnTo = `/tasks?${new URLSearchParams({ ...query, page: String(page) }).toString()}`;

	const result = await loadPage<TaskRow>(async () => {
		const envelope = await getOperations<TaskRow>('tasks', { page, pageSize: 25, ...query });
		return {
			rows: envelope.data,
			totalItems: envelope.totalItems,
			totalPages: envelope.totalPages,
			// Passed through rather than assigned to a captured variable: the React compiler
			// rejects reassignment inside the loader, and it was the wrong shape anyway.
			contentRedacted: Boolean(envelope.contentRedacted),
			contentPermission: envelope.contentPermission,
		};
	});

	// True when the API withheld the user's own words because this operator's role does not
	// hold the matching content permission.
	const contentRedacted = result.ok && result.contentRedacted === true;

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Tasks" />
				<PageError
					title="Could not load tasks"
					message={result.message}
					status={result.status}
					retryHref="/tasks"
				/>
			</div>
		);
	}

	const { rows, totalItems, totalPages } = result;

	return (
		<div>
			<PageHeader
				title="Tasks"
				subtitle={
					totalItems === null ? `Showing ${rows.length}` : `${formatNumber(totalItems)} task(s) matching this filter`
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

			<form method="get" style={filterBarStyle}>
				<div style={{ flex: '2 1 240px' }}>
					<label htmlFor="task-search" style={labelStyle}>
						Search title
					</label>
					<input id="task-search" name="search" defaultValue={search} style={{ ...inputStyle, width: '100%' }} />
				</div>
				<div style={{ flex: '1 1 150px' }}>
					<label htmlFor="task-status" style={labelStyle}>
						Status
					</label>
					<select id="task-status" name="status" defaultValue={status} style={{ ...inputStyle, width: '100%' }}>
						<option value="">Any</option>
						{STATUSES.map((value) => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</select>
				</div>
				<div style={{ flex: '1 1 150px' }}>
					<label htmlFor="task-priority" style={labelStyle}>
						Priority
					</label>
					<select id="task-priority" name="priority" defaultValue={priority} style={{ ...inputStyle, width: '100%' }}>
						<option value="">Any</option>
						{PRIORITIES.map((value) => (
							<option key={value} value={value}>
								{value}
							</option>
						))}
					</select>
				</div>
				<label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.78rem', color: '#374151' }}>
					<input type="checkbox" name="overdue" value="true" defaultChecked={overdueOnly} />
					Overdue only
				</label>
				<button type="submit" style={primaryButton}>
					Filter
				</button>
				{Object.keys(query).length > 0 ? (
					<Link href="/tasks" style={{ fontSize: '0.78rem', color: '#6b7280', alignSelf: 'center' }}>
						Clear
					</Link>
				) : null}
			</form>

			{rows.length === 0 ? (
				<div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px' }}>
					<EmptyState message="No tasks match this filter" />
				</div>
			) : (
				<Table columns={['Task', 'User', 'Status', 'Priority', 'Due', 'Linked reminders', 'Adjust']}>
					{rows.map((task) => (
						<Row key={task.id}>
							<Cell>
								<div style={{ maxWidth: '260px', fontWeight: 500 }}>{task.title}</div>
								{task.description ? (
									<div style={{ fontSize: '0.72rem', color: '#6b7280', maxWidth: '280px' }}>{task.description}</div>
								) : null}
								<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
									source: {task.source} · created {formatRelative(task.created_at)}
								</div>
							</Cell>
							<Cell>
								<Link href={`/users/${task.user_id}`} style={{ fontSize: '0.78rem', color: '#2563eb' }}>
									{task.user_email ?? task.user_id.slice(0, 8)}
								</Link>
							</Cell>
							<Cell>
								<StatusBadge status={task.status} />
								{task.completed_at ? (
									<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
										completed {formatRelative(task.completed_at)}
									</div>
								) : null}
							</Cell>
							<Cell muted>{task.priority}</Cell>
							<Cell>
								{task.due_at ? (
									<>
										{formatDateTime(task.due_at)}
										{task.overdue ? (
											<div style={{ fontSize: '0.7rem', color: '#dc2626', fontWeight: 600 }}>
												overdue {formatRelative(task.due_at)}
											</div>
										) : null}
									</>
								) : (
									<span style={{ color: '#9ca3af' }}>no due date</span>
								)}
							</Cell>
							<Cell align="right" muted>
								{formatNumber(task.linked_reminders)}
							</Cell>
							<Cell>
								<form action={updateTaskAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
									<input type="hidden" name="id" value={task.id} />
									<input type="hidden" name="returnTo" value={returnTo} />
									<select name="status" defaultValue={task.status} style={{ ...inputStyle, width: '150px' }} aria-label={`Status for ${task.title}`}>
										{STATUSES.map((value) => (
											<option key={value} value={value}>
												{value}
											</option>
										))}
									</select>
									<select name="priority" defaultValue={task.priority} style={{ ...inputStyle, width: '150px' }} aria-label={`Priority for ${task.title}`}>
										{PRIORITIES.map((value) => (
											<option key={value} value={value}>
												{value}
											</option>
										))}
									</select>
									<input
										name="reason"
										required
										placeholder="Reason (audited)"
										style={{ ...inputStyle, width: '150px' }}
										aria-label={`Reason for changing ${task.title}`}
									/>
									<button type="submit" style={smallButton}>
										Save
									</button>
								</form>
							</Cell>
						</Row>
					))}
				</Table>
			)}

			{totalPages !== null && totalPages > 1 ? (
				<div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '1rem' }}>
					{page > 1 ? (
						<Link href={`/tasks?${new URLSearchParams({ ...query, page: String(page - 1) }).toString()}`} style={pagerStyle}>
							← Previous
						</Link>
					) : null}
					<span style={{ fontSize: '0.8rem', color: '#6b7280' }}>
						Page {page} of {totalPages}
					</span>
					{page < totalPages ? (
						<Link href={`/tasks?${new URLSearchParams({ ...query, page: String(page + 1) }).toString()}`} style={pagerStyle}>
							Next →
						</Link>
					) : null}
				</div>
			) : null}

			<Notes
				notes={[
					...(contentRedacted
						? [
								`Task titles and descriptions withheld: reading it requires the \`tasks.content_read\` permission, which your role does not hold. The rows, counts and timing are complete — only the user's own words are removed.`,
							]
						: []),
					'Statuses shown are the ones the API accepts: pending, in_progress, completed, cancelled. The mobile client currently writes only pending and completed.',
					'Changing a task from the console does not notify the user; the app sees it on its next fetch.',
				]}
			/>
		</div>
	);
}

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

const smallButton: React.CSSProperties = {
	padding: '0.3rem 0.7rem',
	background: '#1a1a2e',
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.75rem',
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

function alert(background: string, border: string, color: string): React.CSSProperties {
	return {
		marginBottom: '1rem',
		padding: '0.75rem 1rem',
		background,
		border: `1px solid ${border}`,
		borderRadius: '8px',
		color,
		fontSize: '0.85rem',
		lineHeight: 1.5,
	};
}
