/**
 * LEA-021 — Admin Organizations page
 */

import { listOrganizations, type AdminOrganization } from '../../lib/api';

async function getOrgs() {
 try {
 const result = await listOrganizations({ limit: 50, token: '' });
 return result;
 } catch {
 return null;
 }
}

export default async function OrganizationsPage() {
 const result = await getOrgs();
 const orgs: AdminOrganization[] = result?.data ?? [];

 return (
 <div>
 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
 <div>
 <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Organizations</h1>
 <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6b7280' }}>
 {result?.meta?.total ?? 0} total organizations
 </p>
 </div>
 </div>

 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
 <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
 <thead>
 <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Name</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Slug</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Plan</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Created</th>
 </tr>
 </thead>
 <tbody>
 {orgs.map((org) => (
 <tr key={org.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
 <td style={{ padding: '0.75rem 1rem', fontWeight: 500 }}>{org.name}</td>
 <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', fontSize: '0.85rem', color: '#6b7280' }}>
 {org.slug}
 </td>
 <td style={{ padding: '0.75rem 1rem' }}>
 <span style={{
 display: 'inline-flex',
 padding: '0.2rem 0.6rem',
 borderRadius: '9999px',
 fontSize: '0.75rem',
 fontWeight: 500,
 background: planBg(org.plan),
 color: planColor(org.plan),
 border: `1px solid ${planBorder(org.plan)}`,
 textTransform: 'capitalize',
 }}>
 {org.plan}
 </span>
 </td>
 <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: '#6b7280' }}>
 {new Date(org.createdAt).toLocaleDateString()}
 </td>
 </tr>
 ))}
 {orgs.length === 0 && (
 <tr>
 <td colSpan={4} style={{ padding: '3rem', textAlign: 'center', color: '#9ca3af' }}>
 No organizations found
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 );
}

function planBg(plan: string): string {
 const map: Record<string, string> = { free: '#f0fdf4', pro: '#eff6ff', enterprise: '#fefce8' };
 return map[plan] ?? '#f9fafb';
}

function planColor(plan: string): string {
 const map: Record<string, string> = { free: '#059669', pro: '#2563eb', enterprise: '#ca8a04' };
 return map[plan] ?? '#6b7280';
}

function planBorder(plan: string): string {
 const map: Record<string, string> = { free: '#a7f3d0', pro: '#bfdbfe', enterprise: '#fde68a' };
 return map[plan] ?? '#e5e7eb';
}
