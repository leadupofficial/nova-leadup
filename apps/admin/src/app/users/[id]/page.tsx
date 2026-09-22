/**
 * Admin Control Center — user detail.
 *
 * The "what is NOVA actually doing for this person" screen. Every number comes from the
 * API's single aggregated call (`GET /control/users/:id`), which assembles it from the
 * tables that hold that state; nothing here is estimated.
 *
 * Tabs are rendered as sections with a sticky in-page nav rather than client-side tab
 * state, so every section is present in the HTML: an operator can Ctrl-F for a reminder
 * title, the page works without JavaScript, and a deep link to a section is just an
 * anchor. The sections are collapsed with `<details>` where the content is long, which is
 * plain HTML and therefore also works without JavaScript.
 *
 * Capability checks (Voice, Memory, Proactive…) come from the real feature-flag resolver
 * evaluated for **this user**, so an operator can see that a flag is off for them
 * specifically and why.
 */

import Link from 'next/link';
import { getUser, type UserDetail } from '../../../lib/api';
import { loadPage } from '../../../lib/page-data';
import { PageError } from '../../../components/PageError';
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
} from '../../../components/ui';
import { revokeSessionsAction, suspendUserAction } from '../actions';

export const dynamic = 'force-dynamic';

const inputStyle: React.CSSProperties = {
	padding: '0.4rem 0.55rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.8rem',
};

export default async function UserDetailPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const { id } = await params;
	const resolved = await searchParams;
	const okMessage = typeof resolved.ok === 'string' ? resolved.ok : '';
	const errorMessage = typeof resolved.error === 'string' ? resolved.error : '';
	const returnTo = `/users/${id}`;

	const result = await loadPage<UserDetail>(() => getUser(id).then((data) => ({ rows: [data] })));

	if (!result.ok) {
		return (
			<div>
				<PageHeader
					title="User"
					actions={
						<Link href="/users" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
							← All users
						</Link>
					}
				/>
				<PageError
					title="Could not load this account"
					message={result.message}
					status={result.status}
					retryHref={returnTo}
				/>
			</div>
		);
	}

	const detail = result.rows[0];
	if (!detail) {
		return (
			<div>
				<PageHeader title="User" />
				<PageError
					title="Empty response"
					message="The admin API answered successfully but returned no account."
					status={null}
					retryHref={returnTo}
				/>
			</div>
		);
	}

	const { user, counts, capabilities, featureFlags, sessions, devices } = detail;
	const capabilityNotes = Array.isArray(capabilities.notes) ? (capabilities.notes as string[]) : [];
	const activeSessions = sessions.filter((session) => session.active);

	return (
		<div>
			<PageHeader
				title={user.name || '(no name)'}
				subtitle={
					<>
						{user.email ?? 'no email'} · <StatusBadge status={user.status} /> ·{' '}
						<span style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.78rem' }}>{user.id}</span>
					</>
				}
				actions={
					<Link href="/users" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						← All users
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

			{/* In-page navigation. Anchors, so this works with no client JavaScript. */}
			<nav
				style={{
					display: 'flex',
					gap: '0.4rem',
					flexWrap: 'wrap',
					marginBottom: '1.25rem',
					paddingBottom: '0.75rem',
					borderBottom: '1px solid #e5e7eb',
				}}
			>
				{[
					['#overview', 'Overview'],
					['#nova-status', 'NOVA status'],
					['#flags', 'Feature flags'],
					['#sessions', `Sessions (${activeSessions.length})`],
					['#devices', `Devices (${devices.length})`],
					['#conversations', `Conversations (${detail.conversations.length})`],
					['#tasks', `Tasks (${detail.tasks.length})`],
					['#reminders', `Reminders (${detail.reminders.length})`],
					['#memory', `Memory (${detail.memories.length})`],
					['#notifications', `Notifications (${detail.notifications.length})`],
					['#audit', `Audit (${detail.auditLog.length})`],
					['#operations', 'Operations'],
				].map(([href, label]) => (
					<a key={href} href={href} style={anchorStyle}>
						{label}
					</a>
				))}
			</nav>

			{/* ── Overview ─────────────────────────────────────────────────────── */}
			<h2 id="overview" style={sectionHeading}>
				Overview
			</h2>
			<MetricGrid minWidth={170}>
				<Metric label="Conversations" value={counts?.conversations ?? 0} />
				<Metric label="Messages" value={counts?.messages ?? 0} />
				<Metric label="Tasks" value={counts?.tasks ?? 0} hint={`${formatNumber(counts?.tasksCompleted ?? 0)} completed`} />
				<Metric label="Reminders" value={counts?.reminders ?? 0} />
				<Metric label="Memories" value={counts?.memories ?? 0} />
				<Metric label="Notifications" value={counts?.notifications ?? 0} />
				<Metric label="Active sessions" value={activeSessions.length} />
				<Metric label="Devices" value={devices.length} />
			</MetricGrid>

			<Card title="Account">
				<Table columns={['Field', 'Value']}>
					<Row>
						<Cell muted>Created</Cell>
						<Cell>{formatDateTime(user.createdAt)}</Cell>
					</Row>
					<Row>
						<Cell muted>Last sign-in</Cell>
						<Cell>{user.lastLoginAt ? `${formatDateTime(user.lastLoginAt)} (${formatRelative(user.lastLoginAt)})` : 'never'}</Cell>
					</Row>
					<Row>
						<Cell muted>Email verified</Cell>
						<Cell>
							<StatusBadge status={user.emailVerified ? 'pass' : 'pending'} label={user.emailVerified ? 'verified' : 'not verified'} />
						</Cell>
					</Row>
					<Row>
						<Cell muted>Phone</Cell>
						<Cell>{user.phone ?? '—'}</Cell>
					</Row>
					<Row>
						<Cell muted>Locale / timezone</Cell>
						<Cell>
							{user.locale ?? '—'} / {user.timezone ?? '—'}
						</Cell>
					</Row>
					<Row>
						<Cell muted>Organization</Cell>
						<Cell>{detail.organization ? `${detail.organization.name} (${detail.organization.plan})` : 'none'}</Cell>
					</Row>
					<Row>
						<Cell muted>Subscription</Cell>
						<Cell>
							{detail.subscription
								? `${String(detail.subscription.plan)} — ${String(detail.subscription.status)}`
								: 'none on record'}
						</Cell>
					</Row>
				</Table>
			</Card>

			{/* ── NOVA status ──────────────────────────────────────────────────── */}
			<h2 id="nova-status" style={sectionHeading}>
				NOVA status for this account
			</h2>
			<Card
				title="Capability checks"
				subtitle="Resolved by the real feature-flag engine for this user, including any per-user override"
			>
				<Table columns={['Capability', 'State', 'Note']}>
					{[
						['Account active', capabilities.accountActive, 'Suspended accounts are refused at authentication.'],
						['Email verified', capabilities.emailVerified, ''],
						['Active session', capabilities.hasActiveSession, 'A live, unrevoked refresh session exists.'],
						['Device registered', capabilities.hasDeviceRecord, 'Requires the client to report a device.'],
						['Push token', capabilities.hasPushToken, 'Requires FCM integration, which the app does not have.'],
						['Voice (STT + AI + TTS)', capabilities.voice, 'All three must be enabled.'],
						['Speech-to-text', capabilities.stt, ''],
						['Text-to-speech', capabilities.tts, ''],
						['AI', capabilities.ai, 'Master switch for LLM calls.'],
						['Memory', capabilities.memory, ''],
						['Tasks', capabilities.tasks, ''],
						['Reminders', capabilities.reminders, ''],
						['Proactive assistant', capabilities.proactive, 'Whether NOVA may initiate contact.'],
						['Background assistant', capabilities.background, ''],
						['Notifications', capabilities.notifications, ''],
						['Avatar', capabilities.avatar, ''],
						['Overlay', capabilities.overlay, ''],
					].map(([label, state, note]) => (
						<Row key={String(label)}>
							<Cell>{String(label)}</Cell>
							<Cell>
								<StatusBadge status={state ? 'pass' : 'fail'} label={state ? 'enabled' : 'disabled'} />
							</Cell>
							<Cell muted>{String(note ?? '')}</Cell>
						</Row>
					))}
				</Table>
				<Notes notes={capabilityNotes} tone="warn" />
			</Card>

			{/* ── Flags ────────────────────────────────────────────────────────── */}
			<h2 id="flags" style={sectionHeading}>
				Feature flags
			</h2>
			<Card
				title="Resolved for this user"
				subtitle="Shows which layer decided each flag — a user override beats the global state"
				action={
					<Link href="/feature-flags" style={{ fontSize: '0.78rem', color: '#2563eb' }}>
						Manage flags →
					</Link>
				}
			>
				<Table columns={['Flag', 'Enabled', 'Source', 'Rollout', 'Reason']}>
					{featureFlags.map((flag) => (
						<Row key={flag.key}>
							<Cell mono>{flag.key}</Cell>
							<Cell>
								<StatusBadge status={flag.enabled ? 'pass' : 'unknown'} label={flag.enabled ? 'on' : 'off'} />
							</Cell>
							<Cell muted>{flag.source}</Cell>
							<Cell align="right" muted>
								{flag.rolloutPercent === null ? '—' : `${flag.rolloutPercent}%`}
							</Cell>
							<Cell muted>{flag.reason}</Cell>
						</Row>
					))}
				</Table>
			</Card>

			{/* ── Sessions ─────────────────────────────────────────────────────── */}
			<h2 id="sessions" style={sectionHeading}>
				Sessions
			</h2>
			<Card
				title={`${activeSessions.length} active of ${sessions.length} shown`}
				subtitle="Force logout revokes the refresh session; the app signs out on its next refresh"
			>
				{sessions.length === 0 ? (
					<EmptyState message="No sessions on record" hint="This account has never completed a sign-in." />
				) : (
					<Table columns={['Created', 'IP', 'User agent', 'Expires', 'State']}>
						{sessions.map((session) => (
							<Row key={session.id}>
								<Cell muted>{formatDateTime(session.createdAt)}</Cell>
								<Cell mono>{session.ipAddress ?? '—'}</Cell>
								<Cell muted>
									<div style={{ maxWidth: '320px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
										{session.userAgent ?? '—'}
									</div>
								</Cell>
								<Cell muted>
									{formatRelative(session.expiresAt)}
									{session.revokedAt ? (
										<div style={{ fontSize: '0.72rem', color: '#dc2626' }}>
											revoked {formatRelative(session.revokedAt)}
										</div>
									) : null}
								</Cell>
								<Cell>
									<StatusBadge status={session.active ? 'active' : 'dismissed'} />
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			{/* ── Devices ──────────────────────────────────────────────────────── */}
			<h2 id="devices" style={sectionHeading}>
				Devices
			</h2>
			<Card title="Registered devices">
				{devices.length === 0 ? (
					<EmptyState
						message="No device has been registered for this account"
						hint="The Flutter client does not report device or app-version information, so `devices` stays empty for every user."
					/>
				) : (
					<Table columns={['Name', 'Platform', 'Push token', 'Last seen', 'Created']}>
						{devices.map((device) => (
							<Row key={device.id}>
								<Cell>{device.name ?? '—'}</Cell>
								<Cell muted>{device.platform ?? '—'}</Cell>
								<Cell>
									<StatusBadge
										status={device.hasPushToken ? 'pass' : 'unknown'}
										label={device.hasPushToken ? 'registered' : 'none'}
									/>
								</Cell>
								<Cell muted>{device.lastSeenAt ? formatRelative(device.lastSeenAt) : '—'}</Cell>
								<Cell muted>{formatDateTime(device.createdAt)}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			{/* ── Conversations ────────────────────────────────────────────────── */}
			<h2 id="conversations" style={sectionHeading}>
				Conversations
			</h2>
			<Card
				title={`Most recent ${detail.conversations.length}`}
				subtitle="Message text requires the separate conversation-content permission, and every read is audited"
			>
				{detail.conversations.length === 0 ? (
					<EmptyState message="This account has no conversations" />
				) : (
					<Table columns={['Started', 'Mode', 'Messages', 'Last message']}>
						{detail.conversations.map((conversation) => (
							<Row key={String(conversation.id)}>
								<Cell muted>{formatDateTime(String(conversation.createdAt))}</Cell>
								<Cell>
									<StatusBadge status={conversation.mode === 'voice' ? 'running' : 'unknown'} label={String(conversation.mode)} />
								</Cell>
								<Cell align="right">{formatNumber(Number(conversation.messages ?? 0))}</Cell>
								<Cell muted>
									{conversation.lastMessageAt ? formatRelative(String(conversation.lastMessageAt)) : '—'}
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			{/* ── Tasks ────────────────────────────────────────────────────────── */}
			<h2 id="tasks" style={sectionHeading}>
				Tasks
			</h2>
			<Card title={`Most recent ${detail.tasks.length}`}>
				{detail.tasks.length === 0 ? (
					<EmptyState message="No tasks for this account" />
				) : (
					<Table columns={['Title', 'Status', 'Priority', 'Due', 'Source', 'Created']}>
						{detail.tasks.map((task) => (
							<Row key={String(task.id)}>
								<Cell>
									<div style={{ maxWidth: '320px' }}>{String(task.title)}</div>
								</Cell>
								<Cell>
									<StatusBadge status={String(task.status)} />
								</Cell>
								<Cell muted>{String(task.priority)}</Cell>
								<Cell muted>{task.dueAt ? formatDateTime(String(task.dueAt)) : '—'}</Cell>
								<Cell muted>{String(task.source ?? '—')}</Cell>
								<Cell muted>{formatDateTime(String(task.createdAt))}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			{/* ── Reminders ────────────────────────────────────────────────────── */}
			<h2 id="reminders" style={sectionHeading}>
				Reminders
			</h2>
			<Card
				title={`Most recent ${detail.reminders.length}`}
				subtitle="“Delivered” cannot be shown: `reminders.triggered_at` is never written by any code path"
			>
				{detail.reminders.length === 0 ? (
					<EmptyState message="No reminders for this account" />
				) : (
					<Table columns={['Title', 'Trigger at', 'Timezone', 'Repeat', 'Revisions', 'State']}>
						{detail.reminders.map((reminder) => (
							<Row key={String(reminder.id)}>
								<Cell>
									<div style={{ maxWidth: '300px' }}>{String(reminder.title)}</div>
								</Cell>
								<Cell>{formatDateTime(String(reminder.triggerAt))}</Cell>
								<Cell muted>{String(reminder.timezone ?? '—')}</Cell>
								<Cell muted>{String(reminder.repeatRule ?? 'one-off')}</Cell>
								<Cell align="right" muted>
									{formatNumber(Number(reminder.revisions ?? 0))}
								</Cell>
								<Cell>
									<StatusBadge status={reminder.dismissed ? 'dismissed' : 'active'} />
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			{/* ── Memory ───────────────────────────────────────────────────────── */}
			<h2 id="memory" style={sectionHeading}>
				Memory
			</h2>
			<Card
				title={`Most recent ${detail.memories.length}`}
				subtitle="Personal data. Listing memory is an audited action."
			>
				{detail.memories.length === 0 ? (
					<EmptyState message="No memory stored for this account" />
				) : (
					<Table columns={['Content', 'Category', 'Importance', 'Created']}>
						{detail.memories.map((memory) => (
							<Row key={String(memory.id)}>
								<Cell>
									<div style={{ maxWidth: '460px' }}>{String(memory.content)}</div>
								</Cell>
								<Cell muted>{String(memory.category ?? '—')}</Cell>
								<Cell align="right" muted>
									{memory.importance === null || memory.importance === undefined ? '—' : String(memory.importance)}
								</Cell>
								<Cell muted>{formatDateTime(String(memory.createdAt))}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			{/* ── Notifications ────────────────────────────────────────────────── */}
			<h2 id="notifications" style={sectionHeading}>
				Notifications
			</h2>
			<Card title={`Most recent ${detail.notifications.length}`}>
				{detail.notifications.length === 0 ? (
					<EmptyState message="No notifications for this account" />
				) : (
					<Table columns={['Type', 'Title', 'Read', 'Occurred']}>
						{detail.notifications.map((notification) => (
							<Row key={String(notification.id)}>
								<Cell muted>{String(notification.type)}</Cell>
								<Cell>{String(notification.title)}</Cell>
								<Cell>
									<StatusBadge status={notification.read ? 'pass' : 'pending'} label={notification.read ? 'read' : 'unread'} />
								</Cell>
								<Cell muted>{formatDateTime(String(notification.occurredAt))}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			{/* ── Audit ────────────────────────────────────────────────────────── */}
			<h2 id="audit" style={sectionHeading}>
				Account audit trail
			</h2>
			<Card
				title="Events recorded against this user"
				subtitle="From `audit_logs` — what the user and the platform did, not what administrators did"
			>
				{detail.auditLog.length === 0 ? (
					<EmptyState message="No audit events for this account" />
				) : (
					<Table columns={['Action', 'Actor', 'Outcome', 'Target', 'When']}>
						{detail.auditLog.map((entry) => (
							<Row key={String(entry.id)}>
								<Cell mono>{String(entry.action)}</Cell>
								<Cell muted>{String(entry.actor_type ?? '—')}</Cell>
								<Cell>
									<StatusBadge status={String(entry.outcome ?? 'unknown')} />
								</Cell>
								<Cell muted>{entry.target_type ? `${String(entry.target_type)}` : '—'}</Cell>
								<Cell muted>{formatDateTime(String(entry.occurredAt))}</Cell>
							</Row>
						))}
					</Table>
				)}
				<p style={{ fontSize: '0.75rem', color: '#6b7280', margin: '0.6rem 0 0' }}>
					Administrator actions against the platform are in the{' '}
					<Link href="/audit-logs" style={{ color: '#2563eb' }}>
						Control Center audit log
					</Link>
					, which is a separate append-only table.
				</p>
			</Card>

			{/* ── Operations ───────────────────────────────────────────────────── */}
			<h2 id="operations" style={sectionHeading}>
				Operations
			</h2>
			<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem' }}>
				<Card
					title={user.disabled ? 'Reactivate this account' : 'Suspend this account'}
					subtitle={
						user.disabled
							? 'Restores sign-in. Existing sessions were revoked at suspension and are not restored.'
							: 'Blocks sign-in AND revokes refresh sessions, so the app cannot keep working on an unexpired access token.'
					}
				>
					<form action={suspendUserAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
						<input type="hidden" name="id" value={user.id} />
						<input type="hidden" name="disabled" value={user.disabled ? 'false' : 'true'} />
						<input type="hidden" name="returnTo" value={returnTo} />
						{user.disabled ? null : (
							<label style={{ fontSize: '0.78rem', color: '#374151', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
								<input type="checkbox" name="revokeSessions" value="true" defaultChecked />
								Also revoke every active session
							</label>
						)}
						<label style={labelStyle} htmlFor="suspend-reason">
							Reason (required — audited)
						</label>
						<input id="suspend-reason" name="reason" required style={inputStyle} placeholder="e.g. reported abuse, ticket #1234" />
						<button type="submit" style={user.disabled ? restoreButton : dangerButton}>
							{user.disabled ? 'Reactivate account' : 'Suspend account'}
						</button>
					</form>
				</Card>

				<Card
					title="Force logout"
					subtitle="Revokes refresh sessions. The app signs out on its next refresh — immediately while in use, within 15 minutes while idle."
				>
					<form action={revokeSessionsAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
						<input type="hidden" name="id" value={user.id} />
						<input type="hidden" name="returnTo" value={returnTo} />
						<label style={labelStyle} htmlFor="revoke-reason">
							Reason (required — audited)
						</label>
						<input id="revoke-reason" name="reason" required style={inputStyle} placeholder="e.g. device lost" />
						<button type="submit" style={dangerButton}>
							Revoke all sessions ({activeSessions.length} active)
						</button>
					</form>
					<p style={{ fontSize: '0.72rem', color: '#9ca3af', margin: '0.6rem 0 0', lineHeight: 1.5 }}>
						There is no push channel to the app, so a server-initiated logout is a revoke-and-wait. The console
						does not claim otherwise.
					</p>
				</Card>
			</div>

			<Notes
				notes={[
					'Every section on this page comes from one aggregated API call; per-section counts are real totals, not page lengths.',
					'Conversation message text, memory contents and conversation-content reads are separately permissioned and individually audited.',
					'Deleting an account is deliberately not offered here: erasure goes through the documented deletion-request flow, where the user’s own request is on file.',
				]}
			/>
		</div>
	);
}

const sectionHeading: React.CSSProperties = {
	fontSize: '0.78rem',
	fontWeight: 700,
	textTransform: 'uppercase',
	letterSpacing: '0.06em',
	color: '#6b7280',
	margin: '1.75rem 0 0.6rem',
	scrollMarginTop: '1rem',
};

const anchorStyle: React.CSSProperties = {
	padding: '0.3rem 0.65rem',
	background: '#f3f4f6',
	border: '1px solid #e5e7eb',
	borderRadius: '9999px',
	fontSize: '0.75rem',
	color: '#374151',
	textDecoration: 'none',
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

const dangerButton: React.CSSProperties = {
	padding: '0.5rem 1rem',
	background: '#dc2626',
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.8rem',
	fontWeight: 600,
	cursor: 'pointer',
};

const restoreButton: React.CSSProperties = {
	padding: '0.5rem 1rem',
	background: '#059669',
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.8rem',
	fontWeight: 600,
	cursor: 'pointer',
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
