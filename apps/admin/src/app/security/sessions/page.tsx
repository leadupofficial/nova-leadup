/**
 * Admin Control Center — administrator console sessions.
 *
 * The registry `admin_sessions` was designed for. Before this page existed the table had **no
 * writer**: a session row could not exist, `touchAdminSession()` updated a row that was never
 * there, and the console derived "who has acted" from the audit log — which says who acted in the
 * past and nothing about who holds a usable token now.
 *
 * ## What an operator can do here that they could not before
 *
 * End another administrator's session, and have it take effect on that operator's **next request**
 * rather than whenever their token happens to expire. That is a different mechanism from revoking a
 * user's refresh token, which the mobile app only notices on its next refresh: `verifyAccessToken`
 * consults the denylist before any route runs, so a revocation here is immediate on the replica that
 * performed it, and reaches every other replica within one poll interval (5 s) because revocations are
 * written to a shared table that each replica polls — verified across two live processes, not asserted.
 *
 * ## What this page deliberately does not show
 *
 * The token. Only its id (`jti`), the role it carried, the client it was used from and its expiry
 * are stored, and none of them can be turned back into a credential.
 */

import Link from 'next/link';
import { listAdminSessions, type AdminSessionRow } from '../../../lib/api';
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
	formatRelative,
} from '../../../components/ui';
import { revokeAdminSessionAction } from './actions';

export const dynamic = 'force-dynamic';

const inputStyle: React.CSSProperties = {
	padding: '0.45rem 0.6rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.82rem',
};

const STATUSES = [
	{ value: 'active', label: 'Active (unexpired, unrevoked)' },
	{ value: 'revoked', label: 'Ended by an operator' },
	{ value: 'expired', label: 'Expired by time' },
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

export default async function AdminSessionsPage({
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

	const result = await loadPage(async () => {
		const data = await listAdminSessions({
			page,
			pageSize: 25,
			status,
			...(search ? { search } : {}),
		});
		return { rows: [{ data }], totalItems: data.totalItems, totalPages: data.totalPages };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Admin Sessions" />
				<PageError
					title="Could not load administrator sessions"
					message={result.message}
					status={result.status}
					retryHref="/security/sessions"
				/>
			</div>
		);
	}

	const data = result.rows[0].data;
	const rows: AdminSessionRow[] = data.rows;
	const counts = data.counts;
	const returnTo = `/security/sessions?${new URLSearchParams({
		status,
		...(search ? { search } : {}),
		page: String(page),
	}).toString()}`;

	return (
		<div>
			<PageHeader
				title="Admin Sessions"
				subtitle={
					counts
						? `${formatNumber(counts.active)} active · ${formatNumber(counts.expired)} expired · ${formatNumber(counts.revoked)} ended`
						: `Showing ${rows.length} on this page`
				}
				actions={
					<Link href="/security/admins" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Admins &amp; Roles →
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

			<MetricGrid minWidth={200}>
				<Metric label="Active sessions" value={counts?.active ?? null} tone={(counts?.active ?? 0) > 0 ? 'good' : 'default'} hint="Operators holding a usable console token right now" />
				<Metric label="Ended by an operator" value={counts?.revoked ?? null} />
				<Metric label="Expired by time" value={counts?.expired ?? null} hint="An access token lives 15 minutes; a session ends with it" />
			</MetricGrid>

			<form method="get" style={filterBarStyle}>
				<div style={{ flex: '2 1 260px' }}>
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
					<label htmlFor="session-state" style={labelStyle}>
						State
					</label>
					<select id="session-state" name="status" defaultValue={status} style={{ ...inputStyle, width: '100%' }}>
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
					<Link href="/security/sessions" style={{ fontSize: '0.78rem', color: '#6b7280', alignSelf: 'center' }}>
						Clear
					</Link>
				) : null}
			</form>

			{rows.length === 0 ? (
				<div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px' }}>
					<EmptyState
						message={search ? 'No session matches this filter' : status === 'active' ? 'No operator is signed in' : 'No session in this state'}
						hint={
							status === 'active' && !search
								? 'A session row is created the first time a token is used against the control plane, so signing in and opening any page makes one appear here.'
								: undefined
						}
					/>
				</div>
			) : (
				<Table columns={['Operator', 'State', 'Client', 'Started', 'Last seen', 'Expires', 'End session']}>
					{rows.map((session) => (
						<Row key={session.id}>
							<Cell>
								<Link
									href={`/users/${session.user.id}`}
									style={{ color: '#2563eb', fontWeight: 500, textDecoration: 'none' }}
								>
									{session.user.name || session.user.email || '(unknown operator)'}
								</Link>
								{session.user.name && session.user.email ? (
									<div style={{ fontSize: '0.72rem', color: '#6b7280' }}>{session.user.email}</div>
								) : null}
								<div style={{ fontSize: '0.7rem', color: '#6b7280' }}>{session.role}</div>
								{session.current ? (
									<div style={{ fontSize: '0.68rem', color: '#2563eb', fontWeight: 600 }}>this session</div>
								) : null}
							</Cell>
							<Cell>
								<StatusBadge
									status={session.state === 'active' ? 'active' : session.state === 'revoked' ? 'fail' : 'unknown'}
									label={session.state}
								/>
								{session.revokedAt ? (
									<div style={{ fontSize: '0.68rem', color: '#9ca3af', marginTop: '0.2rem' }}>
										ended {formatRelative(session.revokedAt)}
									</div>
								) : null}
							</Cell>
							<Cell muted>
								<div style={{ fontSize: '0.78rem', fontFamily: 'ui-monospace, Menlo, monospace' }}>
									{session.ipAddress ?? 'no address recorded'}
								</div>
								<div style={{ fontSize: '0.68rem', color: '#9ca3af', maxWidth: '240px' }}>
									{session.userAgent ?? 'no user-agent recorded'}
								</div>
							</Cell>
							<Cell muted>
								<div style={{ fontSize: '0.75rem' }}>{formatDateTime(session.createdAt)}</div>
							</Cell>
							<Cell muted>
								<div style={{ fontSize: '0.75rem' }}>{formatRelative(session.lastSeenAt)}</div>
								<div style={{ fontSize: '0.68rem', color: '#9ca3af' }}>{formatDateTime(session.lastSeenAt)}</div>
							</Cell>
							<Cell muted>
								<div style={{ fontSize: '0.75rem' }}>{formatDateTime(session.expiresAt)}</div>
							</Cell>
							<Cell>
								{session.current ? (
									// The API refuses this with 409 SELF_SESSION. Saying so here rather than
									// offering the button is not a duplicate guard — it is the difference
									// between an operator knowing why and discovering it by clicking.
									<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>
										the session you are using — Sign out to end it
									</span>
								) : session.state === 'active' ? (
									<form action={revokeAdminSessionAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
										<input type="hidden" name="id" value={session.id} />
										<input type="hidden" name="returnTo" value={returnTo} />
										<input
											name="reason"
											required
											minLength={3}
											maxLength={500}
											placeholder="Reason (audited)"
											aria-label={`Reason for ending session ${session.id}`}
											style={{ ...inputStyle, width: '180px', fontSize: '0.72rem' }}
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
											End session
										</button>
									</form>
								) : (
									<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>
										{session.state === 'revoked' ? 'already ended' : 'expired — nothing to end'}
									</span>
								)}
							</Cell>
						</Row>
					))}
				</Table>
			)}

			<Notes
				notes={[
					...data.notes,
					'A session is registered on the first control-plane request from a token, and its expiry is the token\'s own — 15 minutes from issue. An operator who keeps working simply rotates onto a new session as the client refreshes, so a long shift appears as several rows that each expired naturally.',
					'Ending a session does not remove anyone\'s permissions. It is undone by signing in again, which is why there is no last-administrator guard here: refusing to end the only remaining super-admin session would leave a stolen token alive exactly when ending it matters most.',
				]}
			/>
		</div>
	);
}

const filterBarStyle: React.CSSProperties = {
	display: 'flex',
	gap: '0.6rem',
	flexWrap: 'wrap',
	margin: '1rem 0',
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

function alert(background: string, border: string, color: string): React.CSSProperties {
	return {
		background,
		border: `1px solid ${border}`,
		color,
		padding: '0.6rem 0.8rem',
		borderRadius: '8px',
		fontSize: '0.82rem',
		marginBottom: '0.9rem',
	};
}
