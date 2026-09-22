/**
 * Admin Control Center — reminders.
 *
 * Operational view over every reminder in the platform: upcoming, overdue, acknowledged
 * and dismissed, server-filtered and paginated.
 *
 * Three facts about a reminder are kept distinct here, because conflating them is how
 * this page previously misled:
 *
 *  - **overdue** — the trigger time has passed and the reminder is not dismissed. Says
 *    nothing about whether anyone saw it.
 *  - **acknowledged** — the user *opened the notification*. `reminders.triggered_at` is
 *    written by `POST /reminders/:id/acknowledge`, which the app calls on a tap, and
 *    journalled by the `reminders_triggered_change` trigger (migration 0010). The OS
 *    fires the alarm with the app closed, so the firing instant is not observable
 *    server-side — a tap is. This is an acknowledgement, not a delivery.
 *  - **dismissed** — the user's own cancel flag.
 *
 * Before migration 0010 the second of those did not exist: the column was never
 * written, so "delivered" and "merely due" were genuinely indistinguishable, and this
 * page said so. It now has a writer, so the page reports it instead of a caveat.
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
import { updateReminderAction } from '../actions/operations';

export const dynamic = 'force-dynamic';

const inputStyle: React.CSSProperties = {
	padding: '0.4rem 0.55rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.78rem',
};

type ReminderRow = {
	id: string;
	user_id: string;
	user_email: string | null;
	title: string;
	trigger_at: string;
	timezone: string | null;
	repeat_rule: string | null;
	notification_channel: unknown;
	dismissed: boolean;
	triggered_at: string | null;
	overdue: boolean;
	revisions: number;
	last_revision_at: string | null;
	created_at: string;
};

const STATES = [
	{ value: 'all', label: 'All reminders' },
	{ value: 'upcoming', label: 'Upcoming' },
	{ value: 'overdue', label: 'Overdue (trigger time passed)' },
	{ value: 'acknowledged', label: 'Acknowledged (notification opened)' },
	{ value: 'dismissed', label: 'Cancelled / dismissed' },
];

function single(value: string | string[] | undefined): string {
	return typeof value === 'string' ? value : '';
}

function positiveInt(value: string | string[] | undefined, fallback: number): number {
	const raw = Array.isArray(value) ? value[0] : value;
	const parsed = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default async function RemindersPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const page = positiveInt(resolved.page, 1);
	const state = single(resolved.state) || 'all';
	const search = single(resolved.search);
	const okMessage = single(resolved.ok);
	const errorMessage = single(resolved.error);
	const returnTo = `/reminders?${new URLSearchParams({ state, page: String(page), ...(search ? { search } : {}) }).toString()}`;

	const result = await loadPage<ReminderRow>(async () => {
		const envelope = await getOperations<ReminderRow>('reminders', {
			page,
			pageSize: 25,
			...(state !== 'all' ? { state } : {}),
			...(search ? { search } : {}),
		});
		return { rows: envelope.data, totalItems: envelope.totalItems, totalPages: envelope.totalPages };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Reminders" />
				<PageError
					title="Could not load reminders"
					message={result.message}
					status={result.status}
					retryHref="/reminders"
				/>
			</div>
		);
	}

	const { rows, totalItems, totalPages } = result;

	return (
		<div>
			<PageHeader
				title="Reminders"
				subtitle={
					totalItems === null
						? `Showing ${rows.length}`
						: `${formatNumber(totalItems)} reminder(s) matching this filter`
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

			<Notes
				notes={[
					'“Acknowledged” means the user opened the reminder’s notification. That is the only delivery signal the platform offers: the device’s OS alarm fires with the app closed, so the firing instant is never reported to the server. A reminder that was shown and ignored is therefore overdue but not acknowledged.',
					'Reminders are delivered by the operating system’s alarm scheduler on the device, not by this backend. A recurring reminder is acknowledged once — the server records the first acknowledgement, and the client re-arms later occurrences from the repeat rule.',
					'“Revisions” counts entries in the reminder’s journal: every reschedule (written by a database trigger on `trigger_at`) and the acknowledgement. It is the closest thing to an execution history this data supports.',
				]}
			/>

			<form method="get" style={filterBarStyle}>
				<div style={{ flex: '2 1 260px' }}>
					<label htmlFor="reminder-search" style={labelStyle}>
						Search title
					</label>
					<input id="reminder-search" name="search" defaultValue={search} style={{ ...inputStyle, width: '100%' }} />
				</div>
				<div style={{ flex: '1 1 200px' }}>
					<label htmlFor="reminder-state" style={labelStyle}>
						State
					</label>
					<select id="reminder-state" name="state" defaultValue={state} style={{ ...inputStyle, width: '100%' }}>
						{STATES.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>
				<button type="submit" style={primaryButton}>
					Filter
				</button>
				{search || state !== 'all' ? (
					<Link href="/reminders" style={{ fontSize: '0.78rem', color: '#6b7280', alignSelf: 'center' }}>
						Clear
					</Link>
				) : null}
			</form>

			{rows.length === 0 ? (
				<div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px' }}>
					<EmptyState message="No reminders match this filter" />
				</div>
			) : (
				<Table columns={['Reminder', 'User', 'Trigger at', 'Repeat', 'Acknowledged', 'Revisions', 'State', 'Adjust']}>
					{rows.map((reminder) => (
						<Row key={reminder.id}>
							<Cell>
								<div style={{ maxWidth: '260px', fontWeight: 500 }}>{reminder.title}</div>
								<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
									{reminder.id.slice(0, 8)}…
								</div>
							</Cell>
							<Cell>
								<Link href={`/users/${reminder.user_id}`} style={{ fontSize: '0.78rem', color: '#2563eb' }}>
									{reminder.user_email ?? reminder.user_id.slice(0, 8)}
								</Link>
							</Cell>
							<Cell>
								{formatDateTime(reminder.trigger_at)}
								<div style={{ fontSize: '0.7rem', color: '#9ca3af' }}>
									{formatRelative(reminder.trigger_at)} · {reminder.timezone ?? 'no tz stored'}
								</div>
							</Cell>
							<Cell muted>{reminder.repeat_rule ?? 'one-off'}</Cell>
							<Cell>
								{/* The timestamp the acknowledgement endpoint recorded, or an explicit
								    statement that none exists. Never "delivered": the server cannot see the
								    OS alarm fire. */}
								{reminder.triggered_at ? (
									<>
										<div style={{ fontSize: '0.78rem' }}>{formatDateTime(reminder.triggered_at)}</div>
										<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
											{formatRelative(reminder.triggered_at)}
										</div>
									</>
								) : (
									<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>
										no acknowledgement recorded
									</span>
								)}
							</Cell>
							<Cell align="right" muted>
								{formatNumber(reminder.revisions)}
								{reminder.last_revision_at ? (
									<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
										last {formatRelative(reminder.last_revision_at)}
									</div>
								) : null}
							</Cell>
							<Cell>
								<StatusBadge
									status={
										reminder.dismissed
											? 'dismissed'
											: reminder.overdue
												? 'overdue'
												: reminder.triggered_at
													? 'acknowledged'
													: 'active'
									}
									label={
										reminder.dismissed
											? 'dismissed'
											: reminder.overdue
												? 'overdue'
												: reminder.triggered_at
													? 'acknowledged'
													: 'upcoming'
									}
								/>
							</Cell>
							<Cell>
								<form action={updateReminderAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
									<input type="hidden" name="id" value={reminder.id} />
									<input type="hidden" name="returnTo" value={returnTo} />
									<input
										type="datetime-local"
										name="triggerAt"
										defaultValue={toLocalInput(reminder.trigger_at)}
										style={{ ...inputStyle, width: '190px' }}
										aria-label={`New trigger time for ${reminder.title}`}
									/>
									<select
										name="dismissed"
										defaultValue={reminder.dismissed ? 'true' : 'false'}
										style={{ ...inputStyle, width: '190px' }}
										aria-label={`Dismissed state for ${reminder.title}`}
									>
										<option value="false">Active</option>
										<option value="true">Dismissed</option>
									</select>
									<input
										name="reason"
										required
										placeholder="Reason (audited)"
										style={{ ...inputStyle, width: '190px' }}
										aria-label={`Reason for changing ${reminder.title}`}
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
				<Pager page={page} totalPages={totalPages} base="/reminders" query={{ state, search }} />
			) : null}
		</div>
	);
}

/**
 * `datetime-local` inputs take a local wall-clock string, while the API returns UTC.
 * Converting here (rather than sending the local string back) is what stops a save from
 * silently shifting the reminder by the browser's UTC offset.
 */
function toLocalInput(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return '';
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Pager({
	page,
	totalPages,
	base,
	query,
}: {
	page: number;
	totalPages: number;
	base: string;
	query: Record<string, string>;
}) {
	const href = (next: number) =>
		`${base}?${new URLSearchParams({ ...query, page: String(next) }).toString()}`;
	return (
		<div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '1rem' }}>
			{page > 1 ? (
				<Link href={href(page - 1)} style={pagerStyle}>
					← Previous
				</Link>
			) : null}
			<span style={{ fontSize: '0.8rem', color: '#6b7280' }}>
				Page {page} of {totalPages}
			</span>
			{page < totalPages ? (
				<Link href={href(page + 1)} style={pagerStyle}>
					Next →
				</Link>
			) : null}
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
