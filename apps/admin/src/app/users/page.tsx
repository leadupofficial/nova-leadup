/**
 * LEA-021 — Admin Users page
 */

import { listUsers, type AdminUser } from '../../lib/api';

async function getUsers(params: Record<string, string | number>) {
 try {
 const result = await listUsers({ ...params, token: '' });
 return result;
 } catch {
 return null;
 }
}

export default async function UsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const resolved = await searchParams;
	const orgFilter = typeof resolved.organizationId === 'string' ? resolved.organizationId : '';
	const result = await getUsers({ organizationId: orgFilter, limit: 50 });
	const users: AdminUser[] = result?.data ?? [];

 return (
 <div>
 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
 <div>
 <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Users</h1>
 <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6b7280' }}>
 {result?.meta?.total ?? 0} total users
 </p>
 </div>
 </div>

 {/* Filters */}
 <form method="get" style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
 <input
 type="text"
 name="organizationId"
 placeholder="Filter by organization ID"
 defaultValue={orgFilter}
 style={{
 padding: '0.5rem 0.75rem',
 border: '1px solid #d1d5db',
 borderRadius: '6px',
 fontSize: '0.85rem',
 minWidth: '220px',
 }}
 />
 <button
 type="submit"
 style={{
 padding: '0.5rem 1.25rem',
 background: '#1a1a2e',
 color: '#fff',
 border: 'none',
 borderRadius: '6px',
 fontSize: '0.85rem',
 cursor: 'pointer',
 }}
 >
 Apply Filter
 </button>
 {orgFilter && (
 <a
 href="/users"
 style={{
 padding: '0.5rem 1.25rem',
 border: '1px solid #d1d5db',
 borderRadius: '6px',
 fontSize: '0.85rem',
 color: '#6b7280',
 textDecoration: 'none',
 display: 'inline-flex',
 alignItems: 'center',
 }}
 >
 Clear
 </a>
 )}
 </form>

 {/* Users Table */}
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
 <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
 <thead>
 <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>User</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>ID</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Status</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Created</th>
 </tr>
 </thead>
 <tbody>
 {users.map((user) => (
 <tr key={user.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
 <td style={{ padding: '0.75rem 1rem' }}>
 <div style={{ fontWeight: 500 }}>{user.name}</div>
 <div style={{ fontSize: '0.8rem', color: '#9ca3af' }}>{user.email ?? user.phone ?? '—'}</div>
 </td>
 <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', fontSize: '0.8rem', color: '#6b7280' }}>
 {user.id.slice(0, 8)}…
 </td>
 <td style={{ padding: '0.75rem 1rem' }}>
 <UserStatusBadge disabled={user.disabled} emailVerified={user.emailVerified} />
 </td>
 <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: '#6b7280' }}>
 {new Date(user.createdAt).toLocaleDateString()}
 </td>
 </tr>
 ))}
 {users.length === 0 && (
 <tr>
 <td colSpan={4} style={{ padding: '3rem', textAlign: 'center', color: '#9ca3af' }}>
 No users found
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 );
}

function UserStatusBadge({ disabled, emailVerified }: { disabled: boolean; emailVerified: boolean }) {
 const label = disabled ? 'Disabled' : emailVerified ? 'Verified' : 'Unverified';
 const color = disabled ? '#dc2626' : emailVerified ? '#059669' : '#d97706';
 const bg = disabled ? '#fef2f2' : emailVerified ? '#ecfdf5' : '#fffbeb';
 const border = disabled ? '#fecaca' : emailVerified ? '#a7f3d0' : '#fde68a';

 return (
 <span style={{
 display: 'inline-flex',
 alignItems: 'center',
 padding: '0.2rem 0.6rem',
 borderRadius: '9999px',
 fontSize: '0.75rem',
 fontWeight: 500,
 background: bg,
 color,
 border: `1px solid ${border}`,
 }}>
 {label}
 </span>
 );
}
