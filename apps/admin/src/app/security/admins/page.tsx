/**
 * Admin Control Center — administrators and sessions.
 *
 * Answers "who is in the control plane" from the records that exist, and states the gap:
 * `roles` and `role_bindings` are empty in this deployment, so admin rights currently come
 * from the platform role claim issued at login rather than from an assignment made here.
 *
 * The permission matrix itself lives on `/permissions`; this page is the roster and the
 * audit-facing view.
 */

import Link from 'next/link';
import { getAdminAuditLogs, getAdmins, getEnvironment, getPlatformRoles, listUserPage } from '../../../lib/api';
import { loadPage } from '../../../lib/page-data';
import { PageError } from '../../../components/PageError';
import { Card, Cell, EmptyState, Metric, MetricGrid, Notes, PageHeader, Row, StatusBadge, Table, formatDateTime, formatNumber, formatRelative } from '../../../components/ui';
import { grantRoleAction, revokeRoleAction } from './actions';

export const dynamic = 'force-dynamic';

const ROLE_CLAIMS = ['owner', 'admin', 'support', 'operations', 'analytics', 'developer', 'read_only'];

const inputStyle: React.CSSProperties = {
	padding: '0.4rem 0.55rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.78rem',
};

export default async function AdminsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const result = await loadPage(async () => {
		const [admins, environment, audit, users, roles] = await Promise.all([
			getAdmins().catch(() => null),
			getEnvironment().catch(() => null),
			getAdminAuditLogs({ pageSize: 50 }).catch(() => null),
			listUserPage({ pageSize: 25, status: 'active' }).catch(() => null),
			getPlatformRoles().catch(() => null),
		]);
		return { rows: [{ admins, environment, audit, users, roles }] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Admins & Roles" />
				<PageError
					title="Could not load admin records"
					message={result.message}
					status={result.status}
					retryHref="/security/admins"
				/>
			</div>
		);
	}

	const { admins, environment, audit, users, roles } = result.rows[0];
	const okMessage = typeof resolved.ok === 'string' ? resolved.ok : '';
	const errorMessage = typeof resolved.error === 'string' ? resolved.error : '';

	// Distinct actors seen in the audit log: the only evidence of who actually used the
	// control plane, since role bindings are not stored.
	const actors = new Map<string, { email: string; role: string | null; actions: number; lastSeen: string; denials: number }>();
	for (const entry of audit?.rows ?? []) {
		const key = entry.actor_id ?? entry.actor_email ?? 'unknown';
		const existing = actors.get(key);
		const isDenied = entry.outcome === 'denied';
		if (existing) {
			existing.actions += 1;
			if (isDenied) existing.denials += 1;
			if (entry.occurred_at > existing.lastSeen) existing.lastSeen = entry.occurred_at;
		} else {
			actors.set(key, {
				email: entry.actor_email ?? entry.actor_id ?? 'unknown',
				role: entry.actor_role,
				actions: 1,
				lastSeen: entry.occurred_at,
				denials: isDenied ? 1 : 0,
			});
		}
	}

	return (
		<div>
			<PageHeader
				title="Admins & Roles"
				subtitle="Who has acted in the control plane, and with what role claim"
				actions={
					<Link href="/permissions" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Permission matrix →
					</Link>
				}
			/>

			{errorMessage ? (
				<div role="alert" style={{ marginBottom: '1rem', padding: '0.75rem 1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#7f1d1d', fontSize: '0.85rem', lineHeight: 1.5 }}>
					{errorMessage}
				</div>
			) : null}
			{okMessage ? (
				<div role="status" style={{ marginBottom: '1rem', padding: '0.75rem 1rem', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '8px', color: '#065f46', fontSize: '0.85rem', lineHeight: 1.5 }}>
					{okMessage}
				</div>
			) : null}

			<MetricGrid minWidth={180}>
				<Metric label="Distinct actors (recent)" value={actors.size} />
				<Metric label="Role bindings stored" value={admins?.roleBindings.length ?? 0} tone={(admins?.roleBindings.length ?? 0) === 0 ? 'warn' : 'good'} />
				<Metric label="Accounts in the platform" value={admins?.candidates ?? 0} hint="This is not the admin count" />
				<Metric label="Audit records read" value={audit?.rows.length ?? 0} />
			</MetricGrid>

			<Notes
				notes={[
					admins?.note,
					'“Distinct actors” is derived from the audit log, which is the only record of who actually used the control plane. The audit log is append-only, so this list cannot be edited after the fact.',
					'Admin rights are issued as a role claim by the auth service at login. There is no per-user role assignment screen yet because `role_bindings` is empty and no route writes it.',
					environment ? `This console is talking to the ${environment.environment} environment (NODE_ENV=${environment.nodeEnv}).` : null,
				]}
				tone="warn"
			/>

			<Card title="Actors observed in the audit log" subtitle="Not a user list — the accounts that have performed privileged actions">
				{actors.size === 0 ? (
					<EmptyState
						message="No privileged action has been recorded"
						hint="On a fresh install this is genuinely empty: the table fills the first time an administrator changes something."
					/>
				) : (
					<Table columns={['Actor', 'Role claim at the time', 'Actions', 'Refusals', 'Last seen']}>
						{[...actors.entries()].map(([id, actor]) => (
							<Row key={id}>
								<Cell>
									<div style={{ fontSize: '0.8rem' }}>{actor.email}</div>
									<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>{id}</div>
								</Cell>
								<Cell>
									<StatusBadge status="active" label={actor.role ?? 'no claim recorded'} />
								</Cell>
								<Cell align="right">{formatNumber(actor.actions)}</Cell>
								<Cell align="right">
									<span style={{ color: actor.denials > 0 ? '#dc2626' : undefined }}>{formatNumber(actor.denials)}</span>
								</Cell>
								<Cell muted>{formatRelative(actor.lastSeen)}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<Card title="Role claims this console understands" subtitle="A token with any other role is denied everywhere rather than partially allowed">
				<Table columns={['Platform claim', 'Effect']}>
					{ROLE_CLAIMS.map((claim) => (
						<Row key={claim}>
							<Cell mono>{claim}</Cell>
							<Cell muted>
								{claim === 'owner'
									? 'Maps to SUPER_ADMIN — every permission, including granting roles and managing secrets.'
									: claim === 'admin'
										? 'Maps to PLATFORM_ADMIN — runs the platform but cannot grant roles or read secret values.'
										: 'See the permission matrix for the full grant set.'}
							</Cell>
						</Row>
					))}
					<Row>
						<Cell mono>anything else</Cell>
						<Cell muted>Denied on every route. An unrecognised role resolves to no permissions at all.</Cell>
					</Row>
				</Table>
			</Card>

			<Card
				title="Grant a platform role"
				subtitle="Writes a grant that decides the account's permissions on its next request — no re-login needed. Only a SUPER_ADMIN may do this."
			>
				{roles?.caller.canManageAdmins ? (
					<form action={grantRoleAction} style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
						<div style={{ flex: '2 1 260px' }}>
							<label htmlFor="grant-user" style={labelStyle}>
								Account
							</label>
							<select id="grant-user" name="userId" required style={{ ...inputStyle, width: '100%' }}>
								<option value="">Select an account…</option>
								{(roles.availableAccounts ?? []).map((account) => (
									<option key={account.id} value={account.id}>
										{account.email ?? account.name ?? account.id}
										{account.disabled ? ' (suspended)' : ''}
									</option>
								))}
							</select>
						</div>
						<div style={{ flex: '1 1 190px' }}>
							<label htmlFor="grant-role" style={labelStyle}>
								Role
							</label>
							<select id="grant-role" name="role" required defaultValue="" style={{ ...inputStyle, width: '100%' }}>
								<option value="">Select a role…</option>
								{roles.roles
									.filter((entry) => roles.caller.canGrantUpTo.includes(entry.role))
									.map((entry) => (
										<option key={entry.role} value={entry.role}>
											{entry.role} ({entry.permissionCount})
										</option>
									))}
							</select>
						</div>
						<div style={{ flex: '1 1 200px' }}>
							<label htmlFor="grant-reason" style={labelStyle}>
								Reason (audited)
							</label>
							<input id="grant-reason" name="reason" required placeholder="e.g. on-call rotation" style={{ ...inputStyle, width: '100%' }} />
						</div>
						<div style={{ flex: '1 1 170px' }}>
							<label htmlFor="grant-confirm" style={labelStyle}>
								Type SUPER_ADMIN if granting it
							</label>
							<input id="grant-confirm" name="confirm" placeholder="SUPER_ADMIN" style={{ ...inputStyle, width: '100%' }} />
						</div>
						<button type="submit" style={grantButton}>
							Grant role
						</button>
					</form>
				) : (
					<EmptyState
						message="You cannot assign platform roles"
						hint="Granting a role requires the admin_users.manage permission, which only SUPER_ADMIN holds. This is deliberate: the permission grants every other permission."
					/>
				)}
			</Card>

			<Card
				title={`Platform role grants (${roles?.grants.length ?? 0})`}
				subtitle="An account with a grant is decided by it; an account without one falls back to its token role claim"
			>
				{!roles || roles.grants.length === 0 ? (
					<EmptyState
						message="No platform role grants exist"
						hint="Every administrator is currently authorised by the role claim in their access token, which is how this platform behaved before role assignment existed."
					/>
				) : (
					<Table columns={['Account', 'Granted role', 'Permissions', 'Granted by', 'Reason', 'When', 'Revoke']}>
						{roles.grants.map((grant) => (
							<Row key={grant.id}>
								<Cell>
									<Link href={`/users/${grant.userId}`} style={{ color: '#2563eb', fontSize: '0.8rem' }}>
										{grant.email ?? grant.name ?? grant.userId.slice(0, 8)}
									</Link>
									<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
										{grant.userId.slice(0, 8)}…
									</div>
								</Cell>
								<Cell>
									<StatusBadge status={grant.roleKnown ? 'active' : 'fail'} label={grant.role} />
								</Cell>
								<Cell align="right">{formatNumber(grant.permissionCount)}</Cell>
								<Cell muted>
									<div style={{ fontSize: '0.72rem', maxWidth: '160px' }}>{grant.grantedBy ?? 'unknown'}</div>
								</Cell>
								<Cell muted>
									<div style={{ fontSize: '0.74rem', maxWidth: '200px' }}>{grant.reason ?? '—'}</div>
								</Cell>
								<Cell muted>{formatRelative(grant.updatedAt)}</Cell>
								<Cell>
									{roles.caller.canManageAdmins ? (
										<form action={revokeRoleAction} style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
											<input type="hidden" name="userId" value={grant.userId} />
											<input name="reason" placeholder="Reason" style={{ ...inputStyle, width: '100px' }} aria-label={`Reason for revoking the grant on ${grant.email ?? grant.userId}`} />
											<input name="confirm" placeholder="REVOKE" style={{ ...inputStyle, width: '84px' }} aria-label={`Type REVOKE to revoke the grant on ${grant.email ?? grant.userId}`} />
											<button type="submit" style={revokeButton}>
												Revoke
											</button>
										</form>
									) : (
										<span style={{ fontSize: '0.72rem', color: '#9ca3af' }}>needs admin_users.manage</span>
									)}
								</Cell>
							</Row>
						))}
					</Table>
				)}
				<Notes notes={roles?.notes ?? []} tone="warn" />
				<p style={{ fontSize: '0.75rem', color: '#6b7280', margin: '0.6rem 0 0', lineHeight: 1.6 }}>
					Refusals are audited individually, so a rejected attempt to grant a role above the caller&apos;s rank is
					visible in the audit log with outcome <code>denied</code>.
				</p>
			</Card>

			<Card title="Legacy role bindings" subtitle="The org-scoped roles/role_bindings tables. Platform operator roles live in platform_admin_roles, not here.">
				{!admins || admins.roleBindings.length === 0 ? (
					<EmptyState
						message="No rows in roles or role_bindings"
						hint="These model tenant roles: roles.organization_id is NOT NULL, so an org-wide role is not a platform operator role. Platform grants are the table above."
					/>
				) : (
					<Table columns={['User id', 'Role', 'Scope', 'Granted']}>
						{admins.roleBindings.map((binding) => (
							<Row key={String(binding.id)}>
								<Cell mono>{String(binding.user_id)}</Cell>
								<Cell>{String(binding.role_name ?? binding.role_slug)}</Cell>
								<Cell muted>{String(binding.scope)}</Cell>
								<Cell muted>{formatDateTime(String(binding.created_at))}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<Card title="Recently active accounts" subtitle="For context only — these are not necessarily administrators">
				{!users || users.rows.length === 0 ? (
					<EmptyState message="No active accounts returned" />
				) : (
					<Table columns={['Account', 'Status', 'Last sign-in']}>
						{users.rows.slice(0, 10).map((user) => (
							<Row key={user.id}>
								<Cell>
									<Link href={`/users/${user.id}`} style={{ color: '#2563eb', fontSize: '0.8rem' }}>
										{user.email ?? user.name}
									</Link>
								</Cell>
								<Cell>
									<StatusBadge status={user.status} />
								</Cell>
								<Cell muted>{user.lastLoginAt ? formatRelative(user.lastLoginAt) : 'never'}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>
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

const grantButton: React.CSSProperties = {
	padding: '0.45rem 1rem',
	background: '#1a1a2e',
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.8rem',
	cursor: 'pointer',
};

const revokeButton: React.CSSProperties = {
	padding: '0.3rem 0.6rem',
	fontSize: '0.72rem',
	color: '#dc2626',
	background: '#fef2f2',
	border: '1px solid #fecaca',
	borderRadius: '6px',
	cursor: 'pointer',
};
