/**
 * LEA-021 — Admin Usage & Cost page
 */

import { getUsageSummary, getUsageByUser, type UsageSummary, type UsageByUser } from '../../lib/api';

async function getUsageData(tenantId: string) {
 try {
 const [summary, byUser] = await Promise.all([
 getUsageSummary(tenantId, { token: '' }),
 getUsageByUser(tenantId, { token: '' }),
 ]);
 return { summary, byUser };
 } catch {
 return null;
 }
}

export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const resolved = await searchParams;
	const tenantId = typeof resolved.tenantId === 'string' ? resolved.tenantId : '';
	const data = tenantId ? await getUsageData(tenantId) : null;
	const summary: UsageSummary[] = data?.summary ?? [];
	const byUser: { data: UsageByUser[] } = data?.byUser ?? { data: [] };

 const totalValue = summary.reduce((sum, s) => sum + s.totalValue, 0);

 return (
 <div>
 <div style={{ marginBottom: '1.5rem' }}>
 <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Usage & Cost</h1>
 <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6b7280' }}>
 Per-user and per-tenant resource consumption
 </p>
 </div>

 {/* Tenant selector */}
 <form method="get" style={{ marginBottom: '1.5rem' }}>
 <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
 <div style={{ flex: 1, maxWidth: '400px' }}>
 <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 500, color: '#6b7280', marginBottom: '0.25rem' }}>Tenant ID</label>
 <input
 type="text"
 name="tenantId"
 required
 placeholder="Enter tenant ID"
 defaultValue={tenantId}
 style={{
 width: '100%',
 padding: '0.5rem 0.75rem',
 border: '1px solid #d1d5db',
 borderRadius: '6px',
 fontSize: '0.85rem',
 }}
 />
 </div>
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
 View Usage
 </button>
 </div>
 </form>

 {tenantId && data && (
 <>
 {/* Summary cards */}
 <div style={{
 display: 'grid',
 gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
 gap: '1rem',
 marginBottom: '2rem',
 }}>
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '1.25rem' }}>
 <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: '#6b7280', fontWeight: 500 }}>Total Usage</p>
 <p style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700, color: '#1a1a2e' }}>{totalValue.toLocaleString()}</p>
 </div>
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '1.25rem' }}>
 <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: '#6b7280', fontWeight: 500 }}>Metrics Tracked</p>
 <p style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700, color: '#1a1a2e' }}>{summary.length}</p>
 </div>
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '1.25rem' }}>
 <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: '#6b7280', fontWeight: 500 }}>Active Users</p>
 <p style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700, color: '#1a1a2e' }}>{byUser.data.length}</p>
 </div>
 </div>

 {/* Usage by metric */}
 <div style={{ marginBottom: '2rem' }}>
 <h2 style={{ fontSize: '1.1rem', fontWeight: 600, margin: '0 0 1rem' }}>By Metric</h2>
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
 <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
 <thead>
 <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Metric</th>
 <th style={{ textAlign: 'right', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Total</th>
 <th style={{ textAlign: 'right', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Records</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Unit</th>
 </tr>
 </thead>
 <tbody>
 {summary.map((s) => (
 <tr key={s.metric} style={{ borderBottom: '1px solid #f3f4f6' }}>
 <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', fontWeight: 500 }}>{s.metric}</td>
 <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontWeight: 600 }}>{s.totalValue.toLocaleString()}</td>
 <td style={{ padding: '0.75rem 1rem', textAlign: 'right', color: '#6b7280' }}>{s.recordCount.toLocaleString()}</td>
 <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: '#6b7280' }}>{s.unit}</td>
 </tr>
 ))}
 </tbody>
 </table>
 </div>
 </div>

 {/* Usage by user */}
 <div>
 <h2 style={{ fontSize: '1.1rem', fontWeight: 600, margin: '0 0 1rem' }}>By User</h2>
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
 <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
 <thead>
 <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>User</th>
 <th style={{ textAlign: 'right', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Total</th>
 <th style={{ textAlign: 'right', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Records</th>
 </tr>
 </thead>
 <tbody>
 {byUser.data.map((u) => (
 <tr key={u.userId} style={{ borderBottom: '1px solid #f3f4f6' }}>
 <td style={{ padding: '0.75rem 1rem' }}>
 <div style={{ fontWeight: 500 }}>{u.userName ?? 'Unknown'}</div>
 <div style={{ fontSize: '0.8rem', color: '#9ca3af', fontFamily: 'monospace' }}>{u.userId.slice(0, 8)}</div>
 </td>
 <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontWeight: 600 }}>{u.totalValue.toLocaleString()}</td>
 <td style={{ padding: '0.75rem 1rem', textAlign: 'right', color: '#6b7280' }}>{u.recordCount.toLocaleString()}</td>
 </tr>
 ))}
 {byUser.data.length === 0 && (
 <tr>
 <td colSpan={3} style={{ padding: '3rem', textAlign: 'center', color: '#9ca3af' }}>
 No usage data for this tenant
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 </>
 )}
 </div>
 );
}
