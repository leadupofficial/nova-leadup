/**
 * LEA-021 — Admin Dashboard
 *
 * Overview of platform health, user count, organization count, and
 * recent activity. Requires admin authentication.
 */

import { getHealth } from '../lib/api';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getServerHealth(): Promise<any> {
 try {
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 const health: { status: string; checks: { name: string; status: string; message?: string; durationMs?: number }[]; timestamp: string } = await getHealth() as any;
 return health;
 } catch {
 return null;
 }
}

export default async function DashboardPage() {
 const health: { status: string; checks: { name: string; status: string; message?: string; durationMs?: number }[]; timestamp: string } | null = await getServerHealth();

 return (
 <div>
 <h1 style={{ margin: '0 0 1.5rem', fontSize: '1.75rem', fontWeight: 700 }}>Dashboard</h1>

 {/* Health Status */}
 <div style={{
 display: 'grid',
 gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
 gap: '1rem',
 marginBottom: '2rem',
 }}>
 <HealthCard health={health} />
 </div>

 {/* Summary Cards */}
 <div style={{
 display: 'grid',
 gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
 gap: '1rem',
 }}>
 <SummaryCard title="Platform Status" value={health?.status ?? 'unknown'} color={healthColor(health?.status)} />
 <SummaryCard title="Health Checks" value={`${health?.checks?.length ?? 0} checks`} color="#3b82f6" />
 <SummaryCard title="API Version" value="v0.1.0" color="#10b981" />
 <SummaryCard title="Last Updated" value={new Date().toLocaleDateString()} color="#6366f1" />
 </div>

 {/* Health Checks Detail */}
 {health?.checks && (
 <div style={{ marginTop: '2rem' }}>
 <h2 style={{ fontSize: '1.1rem', fontWeight: 600, margin: '0 0 1rem' }}>Health Checks</h2>
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
 {health.checks.map((check) => (
 <div
 key={check.name}
 style={{
 display: 'flex',
 alignItems: 'center',
 justifyContent: 'space-between',
 padding: '0.75rem 1rem',
 borderBottom: '1px solid #f3f4f6',
 }}
 >
 <div>
 <span style={{ fontWeight: 500, textTransform: 'capitalize' }}>{check.name}</span>
 {check.message && (
 <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#6b7280' }}>{check.message}</p>
 )}
 </div>
 <StatusBadge status={check.status} />
 </div>
 ))}
 </div>
 </div>
 )}
 </div>
 );
}

function HealthCard({ health }: { health: { status: string; checks: { name: string; status: string; message?: string; durationMs?: number }[]; timestamp: string } | null }) {
 if (!health) {
 return (
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '1.5rem' }}>
 <p style={{ margin: 0, color: '#6b7280' }}>Unable to fetch health status</p>
 </div>
 );
 }

 return (
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '1.5rem' }}>
 <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: '#6b7280', fontWeight: 500 }}>Health Status</p>
 <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
 <StatusBadge status={health.status} />
 <span style={{ fontSize: '0.8rem', color: '#9ca3af' }}>
 {new Date(health.timestamp).toLocaleTimeString()}
 </span>
 </div>
 <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
 {health.checks.map((check) => (
 <div key={check.name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
 <span style={{ color: '#6b7280', textTransform: 'capitalize' }}>{check.name}</span>
 <StatusBadge status={check.status} />
 </div>
 ))}
 </div>
 </div>
 );
}

function SummaryCard({ title, value, color }: { title: string; value: string; color: string }) {
 return (
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '1.5rem' }}>
 <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: '#6b7280', fontWeight: 500 }}>{title}</p>
 <p style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700, color }}>{value}</p>
 </div>
 );
}

function StatusBadge({ status }: { status: string }) {
 const color = status === 'pass' || status === 'healthy' || status === 'success'
 ? '#10b981'
 : status === 'fail' || status === 'unhealthy' || status === 'failure'
 ? '#ef4444'
 : status === 'warn' || status === 'degraded'
 ? '#f59e0b'
 : '#6b7280';

 return (
 <span style={{
 display: 'inline-flex',
 alignItems: 'center',
 gap: '0.35rem',
 padding: '0.2rem 0.6rem',
 borderRadius: '9999px',
 fontSize: '0.75rem',
 fontWeight: 600,
 background: `${color}15`,
 color,
 border: `1px solid ${color}30`,
 textTransform: 'uppercase',
 }}>
 <span style={{
 width: '6px',
 height: '6px',
 borderRadius: '50%',
 background: color,
 }} />
 {status}
 </span>
 );
}

function healthColor(status?: string): string {
 if (status === 'healthy') return '#10b981';
 if (status === 'degraded') return '#f59e0b';
 if (status === 'unhealthy') return '#ef4444';
 return '#6b7280';
}
