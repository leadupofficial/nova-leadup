/**
 * Admin Control Center — sessions.
 *
 * The platform-wide refresh-session inventory. This is the page an operator opens when
 * the question is "who is signed in right now" or "this IP is doing something odd — which
 * account is it", and it is the page that answers "which single token do I kill".
 *
 * ## Why the session list is not just the users page
 *
 * `/users/:id` shows a user's last 25 sessions. That is the wrong shape for an incident:
 * the starting point is a *session* (an IP, a user-agent, a timestamp), not an account,
 * and by the time you know which account it belongs to you have already found it.
 *
 * ## What the page refuses to imply
 *
 * A revoked session does not make the holder's access token stop working. Access tokens
 * are signed JWTs that are never re-checked against this table, so the honest bound is
 * "dead at the next refresh, at most 15 minutes while idle". The API says so on every
 * response and the page repeats it rather than showing a green "signed out" that is not
 * true yet.
 */

import Link from 'next/link';
import { listSessionPage, type AdminSession } from '../../lib/api';
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
import { revokeSessionAction } from './actions';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const inputStyle: React.CSSProperties = {
	padding: '0.45rem 0.6rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.82rem',
};

const STATUSES = [
	{ value: 'active', label: 'Active (unexpired, unrevoked)' },
	{ value: 'expired', label: 'Expired by time' },
	{ value: 'revoked', label: 'Revoked by an operator' },
	{ value: 'all', label: 'All states' },
];

function single(value: string | string[] | undefined): string {
	return typeof value === 'string' ? value : '';
}

function positiveInt(value: string | string[] | undefined, fallback: number): number {
	const raw = Array.isArray(value) ? value[0] : value;
	const parsed = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default async function SessionsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const page = positiveInt(resolved.page, 1);
	const search = single(resolved.search);
	const status = STATUSES.some((option) => option.value === single(resolved.status))
		? single(resolved.status)
		: 'active';
	const okMessage = single(resolved.ok);
	const errorMessage = single(resolved.error);

	// The status tally arrives in the same response as the rows, so the header and the
	// table cannot disagree. It is carried through `rows[0]` rather than captured in a
	// closure: a `let` assigned inside the loader is not narrowed for the compiler, and
	// the compiler is right — `loadPage` may not have run its loader at all.
	const result = await loadPage(async () => {
		const data = await listSessionPage({
			page,
			pageSize: PAGE_SIZE,
			status,
			...(search ? { search } : {}),
		});
		return { rows: [{ data }], totalItems: data.totalItems, totalPages: data.totalPages };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Sessions" />
				<PageError
					title="Could not load sessions"
					message={result.message}
					status={result.status}
					retryHref="/sessions"
				/>
			</div>
		);
	}

	const data = result.rows[0].data;
	const rows = data.rows;
	const counts = data.counts;
	const { totalItems, totalPages } = data;

	const returnTo = `/sessions?${new URLSearchParams({
		status,
		...(search ? { search } : {}),
		page: String(page),
	}).toString()}`;

	const queryFor = (nextPage: number) =>
		`/sessions?${new URLSearchParams({
			status,
			...(search ? { search } : {}),
			page: String(nextPage),
		}).toString()}`;

	return (
		<div>
			<PageHeader
				title="Sessions"
				subtitle={
					counts
						? `${formatNumber(counts.active)} active · ${formatNumber(counts.expired)} expired · ${formatNumber(counts.revoked)} revoked`
						: `Showing ${rows.length} on this page`
				}
				actions={
					<Link href="/users" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Users →
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

			<Notes
				notes={[
					'A session row is the refresh token. Revoking it deletes nothing — it sets `revoked_at`, and the next refresh is refused, which is what signs the app out.',
					'A revoked session holder keeps working until their access token expires, because access tokens are signed JWTs and this table is not consulted for them. This page cannot make that instant.',
					'Refresh tokens are stored only as hashes. Nothing here can read, replay or display one.',
				]}
			/>

			<form
				method="get"
				style={{
					display: 'flex',
					gap: '0.6rem',
					flexWrap: 'wrap',
					margin: '1rem 0',
					padding: '0.9rem 1rem',
					background: '#fff',
					border: '1px solid #e5e7eb',
					borderRadius: '10px',
					alignItems: 'flex-end',
				}}
			>
				<div style={{ flex: '2 1 280px' }}>
					<label htmlFor="session-search" style={labelStyle}>
						Search
					</label>
					<input
						id="session-search"
						name="search"
						defaultValue={search}
						placeholder="Email, name, IP address or user-agent"
						style={{ ...inputStyle, width: '100%' }}
					/>
				</div>
				<div style={{ flex: '1 1 220px' }}>
					<label htmlFor="session-status" style={labelStyle}>
						State
					</label>
					<select id="session-status" name="status" defaultValue={status} style={{ ...inputStyle, width: '100%' }}>
						{STATUSES.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>
				<button type="submit" style={primaryButton}>
					Filter
				</button>
				{search || status !== 'active' ? (
					<Link href="/sessions" style={{ fontSize: '0.8rem', color: '#6b7280', alignSelf: 'center' }}>
						Clear
					</Link>
				) : null}
			</form>

			{rows.length === 0 ? (
				<div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px' }}>
					<EmptyState
						message={
							search
								? 'No session matches this filter'
								: status === 'active'
									? 'No active session'
									: 'No session in this state'
						}
						hint={
							search
								? 'Email, name, IP address and user-agent are searched. Clear the filter to see every session.'
								: status === 'active'
									? 'Nobody is signed in. An empty table here is a real answer, not a missing feature: the table exists and the auth flow writes to it.'
									: undefined
						}
					/>
				</div>
			) : (
				<Table columns={['Account', 'State', 'Origin', 'Device', 'Started', 'Expires', 'Revoke']}>
					{rows.map((session) => (
						<Row key={session.id}>
							<Cell>
								<Link
									href={`/users/${session.user.id}`}
									style={{ color: '#2563eb', fontWeight: 500, textDecoration: 'none' }}
								>
									{session.user.name || session.user.email || '(unknown account)'}
								</Link>
								{session.user.email && session.user.name ? (
									<div style={{ fontSize: '0.72rem', color: '#6b7280' }}>{session.user.email}</div>
								) : null}
								{session.user.disabled ? (
									<div style={{ fontSize: '0.68rem', color: '#b91c1c' }}>account suspended</div>
								) : null}
								<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
									{session.id.slice(0, 8)}…
								</div>
							</Cell>
							<Cell>
								<StatusBadge
									status={session.active ? 'active' : session.state === 'revoked' ? 'fail' : 'unknown'}
									label={session.state}
								/>
								{session.revokedAt ? (
									<div style={{ fontSize: '0.68rem', color: '#9ca3af', marginTop: '0.2rem' }}>
										{formatRelative(session.revokedAt)}
									</div>
								) : null}
							</Cell>
							<Cell muted>
								<div style={{ fontSize: '0.78rem', fontFamily: 'ui-monospace, Menlo, monospace' }}>
									{session.ipAddress ?? 'no address recorded'}
								</div>
								<div style={{ fontSize: '0.68rem', color: '#9ca3af', maxWidth: '220px' }}>
									{session.userAgent ?? 'no user-agent recorded'}
								</div>
							</Cell>
							<Cell muted>
								{session.device ? (
									<>
										<div style={{ fontSize: '0.78rem' }}>{session.device.name ?? '(unnamed)'}</div>
										<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
											{session.device.platform ?? 'unknown platform'}
										</div>
									</>
								) : (
									<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>
										no device row — the session was not bound to one
									</span>
								)}
							</Cell>
							<Cell muted>
								<div style={{ fontSize: '0.75rem' }}>{formatDateTime(session.createdAt)}</div>
								<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>
									{formatRelative(session.createdAt)}
								</div>
							</Cell>
							<Cell muted>
								<div style={{ fontSize: '0.75rem' }}>{formatDateTime(session.expiresAt)}</div>
							</Cell>
							<Cell>
								{session.active ? (
									// A typed reason per row, not a bare button: the audit row has to
									// explain itself, and "revoke" with no reason is not reviewable.
									<form action={revokeSessionAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
										<input type="hidden" name="id" value={session.id} />
										<input type="hidden" name="returnTo" value={returnTo} />
										<input
											name="reason"
											required
											minLength={3}
											maxLength={500}
											placeholder="Reason (audited)"
											aria-label={`Reason for revoking session ${session.id}`}
											style={{ padding: '0.25rem 0.4rem', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '0.72rem', width: '170px' }}
										/>
										<button
											type="submit"
											style={{
												padding: '0.25rem 0.6rem',
												background: '#b91c1c',
												color: '#fff',
												border: 'none',
												borderRadius: '4px',
												fontSize: '0.72rem',
												cursor: 'pointer',
											}}
										>
											Revoke this session
										</button>
									</form>
								) : (
									<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>
										{terminalNote(session.state)}
									</span>
								)}
							</Cell>
						</Row>
					))}
				</Table>
			)}

			{totalPages !== null && totalPages > 1 ? (
				<div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', marginTop: '1rem', fontSize: '0.8rem' }}>
					{page > 1 ? (
						<Link href={queryFor(page - 1)} style={{ color: '#2563eb' }}>
							← Previous
						</Link>
					) : null}
					<span style={{ color: '#6b7280' }}>
						Page {page} of {totalPages}
						{totalItems !== null ? ` · ${formatNumber(totalItems)} session(s)` : ''}
					</span>
					{page < totalPages ? (
						<Link href={queryFor(page + 1)} style={{ color: '#2563eb' }}>
							Next →
						</Link>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/** Why a row offers no revoke control, stated rather than left blank. */
function terminalNote(state: AdminSession['state']): string {
	return state === 'revoked'
		? 'already revoked — revoking again changes nothing'
		: 'expired — nothing to revoke';
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

const primaryButton: React.CSSProperties = {
	padding: '0.45rem 1rem',
	background: '#1a1a2e',
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.82rem',
	cursor: 'pointer',
};

const alert = (background: string, border: string, color: string): React.CSSProperties => ({
	background,
	border: `1px solid ${border}`,
	color,
	padding: '0.6rem 0.8rem',
	borderRadius: '8px',
	fontSize: '0.82rem',
	marginBottom: '0.9rem',
});
