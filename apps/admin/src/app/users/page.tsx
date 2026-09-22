/**
 * Admin Control Center — users.
 *
 * The operator's entry point into a single account. Server-paginated and
 * server-filtered: the API caps `pageSize` at 100 and this page never asks for more, so
 * a production table is never loaded into the browser.
 *
 * The per-row counts come from one batched query per table inside the API, not one query
 * per user, so the page stays usable as the user table grows.
 */

import Link from 'next/link';
import { listUserPage, type AdminUserSummary } from '../../lib/api';
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

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const inputStyle: React.CSSProperties = {
	padding: '0.45rem 0.6rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.82rem',
};

const STATUSES = [
	{ value: 'all', label: 'All accounts' },
	{ value: 'active', label: 'Active (verified)' },
	{ value: 'pending', label: 'Pending verification' },
	{ value: 'disabled', label: 'Suspended' },
];

function positiveInt(value: string | string[] | undefined, fallback: number): number {
	const raw = Array.isArray(value) ? value[0] : value;
	const parsed = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function single(value: string | string[] | undefined): string {
	return typeof value === 'string' ? value : '';
}

export default async function UsersPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const page = positiveInt(resolved.page, 1);
	const search = single(resolved.search);
	const status = single(resolved.status) || 'all';
	const okMessage = single(resolved.ok);
	const errorMessage = single(resolved.error);

	const result = await loadPage<AdminUserSummary>(async () => {
		const pageData = await listUserPage({
			page,
			pageSize: PAGE_SIZE,
			...(search ? { search } : {}),
			...(status !== 'all' ? { status } : {}),
		});
		return {
			rows: pageData.rows,
			totalItems: pageData.totalItems,
			totalPages: pageData.totalPages,
		};
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Users" />
				<PageError
					title="Could not load users"
					message={result.message}
					status={result.status}
					retryHref="/users"
				/>
			</div>
		);
	}

	const { rows, totalItems, totalPages } = result;
	const showingFrom = totalItems === null ? null : (page - 1) * PAGE_SIZE + 1;
	const showingTo = totalItems === null ? null : Math.min(page * PAGE_SIZE, totalItems);

	const queryFor = (nextPage: number) =>
		`/users?${new URLSearchParams({
			...(search ? { search } : {}),
			...(status !== 'all' ? { status } : {}),
			page: String(nextPage),
		}).toString()}`;

	return (
		<div>
			<PageHeader
				title="Users"
				subtitle={
					totalItems === null
						? `Showing ${rows.length} on this page`
						: `${formatNumber(totalItems)} accounts · showing ${showingFrom}–${showingTo}`
				}
				actions={
					<Link href="/config-validator" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Config validator →
					</Link>
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

			{/* Server-side filtering: the form is a GET, so a filtered view is a URL an
			    operator can bookmark or paste into an incident channel. */}
			<form
				method="get"
				style={{
					display: 'flex',
					gap: '0.6rem',
					flexWrap: 'wrap',
					marginBottom: '1rem',
					padding: '0.9rem 1rem',
					background: '#fff',
					border: '1px solid #e5e7eb',
					borderRadius: '10px',
					alignItems: 'flex-end',
				}}
			>
				<div style={{ flex: '2 1 280px' }}>
					<label htmlFor="user-search" style={labelStyle}>
						Search
					</label>
					<input
						id="user-search"
						name="search"
						defaultValue={search}
						placeholder="Email, name or phone"
						style={{ ...inputStyle, width: '100%' }}
					/>
				</div>
				<div style={{ flex: '1 1 180px' }}>
					<label htmlFor="user-status" style={labelStyle}>
						Status
					</label>
					<select id="user-status" name="status" defaultValue={status} style={{ ...inputStyle, width: '100%' }}>
						{STATUSES.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>
				<button
					type="submit"
					style={{
						padding: '0.45rem 1rem',
						background: '#1a1a2e',
						color: '#fff',
						border: 'none',
						borderRadius: '6px',
						fontSize: '0.82rem',
						cursor: 'pointer',
					}}
				>
					Filter
				</button>
				{search || status !== 'all' ? (
					<Link href="/users" style={{ fontSize: '0.8rem', color: '#6b7280', alignSelf: 'center' }}>
						Clear
					</Link>
				) : null}
			</form>

			{rows.length === 0 ? (
				<div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px' }}>
					<EmptyState
						message={search || status !== 'all' ? 'No accounts match this filter' : 'No accounts exist'}
						hint={
							search || status !== 'all'
								? 'The filter was applied server-side; clear it to see every account.'
								: undefined
						}
					/>
				</div>
			) : (
				<Table
					columns={['Account', 'Status', 'Locale', 'Activity', 'NOVA data', 'Created', '']}
				>
					{rows.map((user) => (
						<Row key={user.id}>
							<Cell>
								<Link
									href={`/users/${user.id}`}
									style={{ color: '#2563eb', fontWeight: 500, textDecoration: 'none' }}
								>
									{user.name || '(no name)'}
								</Link>
								<div style={{ fontSize: '0.75rem', color: '#6b7280' }}>{user.email ?? '—'}</div>
								<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
									{user.id.slice(0, 8)}…
								</div>
							</Cell>
							<Cell>
								<StatusBadge status={user.status} />
								{user.phone ? (
									<div style={{ fontSize: '0.72rem', color: '#6b7280', marginTop: '0.2rem' }}>{user.phone}</div>
								) : null}
							</Cell>
							<Cell muted>
								<div style={{ fontSize: '0.78rem' }}>{user.locale ?? '—'}</div>
								<div style={{ fontSize: '0.7rem', color: '#9ca3af' }}>{user.timezone ?? '—'}</div>
							</Cell>
							<Cell muted>
								<div style={{ fontSize: '0.78rem' }}>
									{user.lastLoginAt ? formatRelative(user.lastLoginAt) : 'never signed in'}
								</div>
								<div style={{ fontSize: '0.7rem', color: '#9ca3af' }}>
									{user.counts ? `${formatNumber(user.counts.activeSessions)} live session(s)` : ''}
								</div>
							</Cell>
							<Cell muted>
								{user.counts ? (
									<div style={{ fontSize: '0.74rem', lineHeight: 1.5 }}>
										{formatNumber(user.counts.conversations)} conversations
										<br />
										{formatNumber(user.counts.tasks)} tasks · {formatNumber(user.counts.reminders)} reminders
										<br />
										{formatNumber(user.counts.memories)} memories
									</div>
								) : (
									<span style={{ fontSize: '0.72rem' }}>—</span>
								)}
							</Cell>
							<Cell muted>{formatDateTime(user.createdAt)}</Cell>
							<Cell>
								<Link href={`/users/${user.id}`} style={{ fontSize: '0.78rem', color: '#2563eb' }}>
									Inspect →
								</Link>
							</Cell>
						</Row>
					))}
				</Table>
			)}

			{totalPages !== null && totalPages > 1 ? (
				<div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '1rem' }}>
					{page > 1 ? (
						<Link href={queryFor(page - 1)} style={pagerStyle}>
							← Previous
						</Link>
					) : null}
					<span style={{ fontSize: '0.8rem', color: '#6b7280' }}>
						Page {page} of {totalPages}
					</span>
					{page < totalPages ? (
						<Link href={queryFor(page + 1)} style={pagerStyle}>
							Next →
						</Link>
					) : null}
				</div>
			) : null}

			<Notes
				notes={[
					'Counts are per-account totals fetched in one batched query per table, so a page of 25 accounts costs the same number of queries as one.',
					'“Never signed in” is derived from `users.last_login_at`, which is written on a successful login only.',
					'Device and app-version columns are absent because the mobile client does not report them yet — see the production report, blocker P1.',
				]}
			/>
		</div>
	);
}

const labelStyle: React.CSSProperties = {
	display: 'block',
	fontSize: '0.68rem',
	fontWeight: 600,
	color: '#6b7280',
	marginBottom: '0.15rem',
	textTransform: 'uppercase',
	letterSpacing: '0.03em',
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
