/**
 * Admin Control Center — permission matrix.
 *
 * Shows the catalog and which roles hold each permission, so an operator can answer two
 * questions without reading code: *what can my role do*, and *who can do X*.
 *
 * **This page renders the authority, not a copy of it.** The catalogue and the role matrix come from
 * `GET /control/permissions`, which reads `services/api/src/admin/permissions.ts` — the same module
 * that resolves the role on every request and answers 403 per route. It used to render a
 * hand-maintained mirror of that matrix from `apps/admin/src/lib/permissions.ts`, kept in step by hand;
 * the mirror is gone, because two lists that must agree eventually do not.
 */

import Link from 'next/link';
import { NAV_GROUPS } from '../../lib/nav';
import { loadPage } from '../../lib/page-data';
import { getAdmins, getPermissionCatalog, type PermissionCatalog } from '../../lib/api';
import { Card, Cell, EmptyState, Notes, PageHeader, Row, StatusBadge, Table } from '../../components/ui';

export const dynamic = 'force-dynamic';

/**
 * The platform claim each admin role answers to, and what the role is *for*.
 *
 * Only the prose lives here. The role list itself, every permission each role holds and the catalogue
 * come from `GET /control/permissions` — the same module the API enforces with — so this table cannot
 * disagree with what the server will do.
 */
const ROLE_PURPOSE: Record<string, string> = {
	SUPER_ADMIN: 'Everything, including granting roles and managing secrets.',
	PLATFORM_ADMIN: 'Run the platform: AI, voice, flags, maintenance, kill switches.',
	SUPPORT_ADMIN: 'Help a human: read accounts and NOVA state, suspend, revoke sessions.',
	OPERATIONS_ADMIN: 'Keep the machinery running: jobs, services, incidents, realtime.',
	ANALYTICS_ADMIN: 'Metrics and cost. No personal data.',
	DEVELOPER: 'Read everything for debugging, including logs and traces. Writes nothing.',
	READ_ONLY: 'Aggregate reads only.',
};

/** The complete catalog, grouped as the API groups it. */
/**
 * The catalogue grouped the way the API groups it.
 *
 * Built from `GET /control/permissions` at render time rather than held here: 47 permissions with
 * labels and descriptions is exactly the kind of list that rots in a copy.
 */
function groupCatalog(catalog: PermissionCatalog | null) {
	const groups = new Map<string, PermissionCatalog['catalog']>();
	for (const entry of catalog?.catalog ?? []) {
		const existing = groups.get(entry.group);
		if (existing) existing.push(entry);
		else groups.set(entry.group, [entry]);
	}
	return [...groups.entries()].map(([group, permissions]) => ({ group, permissions }));
}

export default async function PermissionsPage() {
	const result = await loadPage(async () => {
		const [admins, catalog] = await Promise.all([
			getAdmins().catch(() => null),
			getPermissionCatalog().catch(() => null),
		]);
		return { rows: [{ admins, catalog }] };
	});

	const admins = result.ok ? result.rows[0].admins : null;
	const catalog: PermissionCatalog | null = result.ok ? result.rows[0].catalog : null;

	// Which roles hold each permission, computed from the **server's** matrix.
	const roleRows = catalog?.roles ?? [];
	const holdersFor = (permission: string) =>
		roleRows.filter((role) => role.permissions.includes(permission)).map((role) => role.role);

	return (
		<div>
			<PageHeader
				title="Permissions & Roles"
				subtitle="The catalog, what each role holds, and which destinations that unlocks"
				actions={
					<Link href="/security/admins" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Admins →
					</Link>
				}
			/>

			<Notes
				notes={[
					'This page documents the model; it does not enforce it. The API resolves the role from the verified JWT on every request and answers 403 per route, and the mirrored matrix in the console only decides which links to show.',
					'Because the console copy is separate, it can drift from the server — the failure mode is a visible 403, never a silent privilege. Moving the catalog into @nova/shared-types would remove the duplication.',
					'A new permission must be added in services/api/src/admin/permissions.ts first; the server denies anything it does not know, so a console-only addition grants nothing.',
				]}
				tone="warn"
			/>

			<Card title="Roles" subtitle="Platform role claim → admin role → what it is for">
				<Table columns={['Platform claim', 'Admin role', 'Purpose', 'Permissions held']}>
					{roleRows.map((role) => (
						<Row key={role.role}>
							<Cell mono>{role.role}</Cell>
							<Cell>
								<StatusBadge status="active" label={role.role} />
							</Cell>
							<Cell muted>{ROLE_PURPOSE[role.role] ?? '(no description in this build)'}</Cell>
							<Cell align="right">{role.permissions.length}</Cell>
						</Row>
					))}
				</Table>
				<p style={{ fontSize: '0.75rem', color: '#6b7280', margin: '0.75rem 0 0', lineHeight: 1.6 }}>
					An unrecognised role resolves to nothing: there is no fallback that keeps partial access, so a token with
					a role this build does not know is denied everywhere.
				</p>
			</Card>

			{groupCatalog(catalog).map((group) => (
				<Card key={group.group} title={group.group} subtitle={`${group.permissions.length} permission(s)`}>
					<Table columns={['Permission', 'What it allows', 'Held by', 'Risk']}>
						{group.permissions.map((permission) => {
							const holders = holdersFor(permission.permission);
							return (
								<Row key={permission.permission}>
									<Cell mono>{permission.permission}</Cell>
									<Cell muted>
										<div style={{ maxWidth: '400px', fontSize: '0.78rem' }}>
											<strong style={{ fontWeight: 600, color: '#374151' }}>{permission.label}</strong>
											{' — '}
											{permission.description}
										</div>
									</Cell>
									<Cell>
										<div style={{ fontSize: '0.72rem' }}>{holders.length > 0 ? holders.join(', ') : 'nobody'}</div>
									</Cell>
									<Cell>
										{permission.dangerous ? (
											<StatusBadge status="overdue" label="privileged" />
										) : (
											<StatusBadge status="pass" label="read/safe" />
										)}
									</Cell>
								</Row>
							);
						})}
					</Table>
				</Card>
			))}

			<Card title="Destinations by role" subtitle="What the navigation shows for each role">
				<Table columns={['Admin role', 'Visible destinations']}>
					{roleRows.map((role) => {
						const permissions = role.permissions;
						const destinations = NAV_GROUPS.flatMap((group) =>
							group.items
								.filter((item) => item.permissions.length === 0 || item.permissions.some((p) => permissions.includes(p)))
								.map((item) => item.label),
						);
						return (
							<Row key={role.role}>
								<Cell mono>{role.role}</Cell>
								<Cell muted>
									<div style={{ fontSize: '0.75rem', maxWidth: '640px' }}>
										{destinations.length > 0 ? destinations.join(' · ') : '(none)'}
									</div>
								</Cell>
							</Row>
						);
					})}
				</Table>
			</Card>

			<Card title="Administrators on record" subtitle="Role assignment is not yet manageable from this console">
				{!result.ok ? (
					<Notes notes={[result.message]} tone="warn" />
				) : admins && admins.roleBindings.length === 0 ? (
					<EmptyState
						message="No role bindings exist"
						hint={
							admins.note ??
							'The roles and role_bindings tables are empty, so admin rights currently come from the platform role claim issued at login.'
						}
					/>
				) : (
					<Table columns={['User', 'Role', 'Scope', 'Granted']}>
						{(admins?.roleBindings ?? []).map((binding) => (
							<Row key={String(binding.id)}>
								<Cell mono>{String(binding.user_id)}</Cell>
								<Cell>{String(binding.role_name)}</Cell>
								<Cell muted>{String(binding.scope)}</Cell>
								<Cell muted>{(binding.permissions as string[])?.length ?? 0} permission(s)</Cell>
							</Row>
						))}
					</Table>
				)}
				<Notes
					notes={[
						'Granting a role from this console requires a route that writes `role_bindings` plus a resolver that reads them; the permission model already accepts a narrowed per-request grant, so the enforcement half is ready.',
						'Until then, admin rights are issued by the auth service as a role claim at login.',
					]}
					tone="warn"
				/>
			</Card>
		</div>
	);
}
