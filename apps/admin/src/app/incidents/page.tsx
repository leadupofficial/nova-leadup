/**
 * LEA-021 — Admin Incidents page
 */

import { listIncidents, resolveIncident, type AdminIncident } from '../../lib/api';

async function getIncidents() {
 try {
 const result = await listIncidents({ token: '' });
 return result;
 } catch {
 return null;
 }
}

const SEVERITY_COLORS: Record<string, { bg: string; color: string; border: string }> = {
 critical: { bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
 error: { bg: '#fff7ed', color: '#ea580c', border: '#fed7aa' },
 warning: { bg: '#fffbeb', color: '#d97706', border: '#fde68a' },
 info: { bg: '#eff6ff', color: '#2563eb', border: '#bfdbfe' },
};

export default async function IncidentsPage() {
 const result = await getIncidents();
 const incidents: AdminIncident[] = result?.data ?? [];

 return (
 <div>
 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
 <div>
 <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Incidents</h1>
 <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6b7280' }}>
 {incidents.filter((i) => !i.resolved).length} open · {incidents.filter((i) => i.resolved).length} resolved
 </p>
 </div>
 <span style={{
 padding: '0.4rem 1rem',
 borderRadius: '9999px',
 fontSize: '0.85rem',
 fontWeight: 500,
 background: incidents.some((i) => !i.resolved && i.severity === 'critical') ? '#fef2f2' : '#ecfdf5',
 color: incidents.some((i) => !i.resolved && i.severity === 'critical') ? '#dc2626' : '#059669',
 border: `1px solid ${incidents.some((i) => !i.resolved && i.severity === 'critical') ? '#fecaca' : '#a7f3d0'}`,
 }}>
 System Status
 </span>
 </div>

 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
 <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
 <thead>
 <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Severity</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Title</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Status</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Occurred</th>
 <th style={{ textAlign: 'right', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Action</th>
 </tr>
 </thead>
 <tbody>
 {incidents.map((incident) => {
 const colors = SEVERITY_COLORS[incident.severity as keyof typeof SEVERITY_COLORS]!;
 return (
 <tr key={incident.id} style={{ borderBottom: '1px solid #f3f4f6', opacity: incident.resolved ? 0.6 : 1 }}>
 <td style={{ padding: '0.75rem 1rem' }}>
 <span style={{
 display: 'inline-flex',
 padding: '0.2rem 0.6rem',
 borderRadius: '9999px',
 fontSize: '0.75rem',
 fontWeight: 500,
 background: colors.bg,
 color: colors.color,
 border: `1px solid ${colors.border}`,
 textTransform: 'capitalize',
 }}>
 {incident.severity}
 </span>
 </td>
 <td style={{ padding: '0.75rem 1rem' }}>
 <div style={{ fontWeight: 500 }}>{incident.title}</div>
 {incident.description && (
 <div style={{ fontSize: '0.8rem', color: '#9ca3af', marginTop: '0.25rem' }}>
 {incident.description.slice(0, 100)}{incident.description.length > 100 ? '…' : ''}
 </div>
 )}
 </td>
 <td style={{ padding: '0.75rem 1rem' }}>
 <span style={{
 display: 'inline-flex',
 padding: '0.2rem 0.6rem',
 borderRadius: '9999px',
 fontSize: '0.75rem',
 fontWeight: 500,
 background: incident.resolved ? '#ecfdf5' : '#fef2f2',
 color: incident.resolved ? '#059669' : '#dc2626',
 border: `1px solid ${incident.resolved ? '#a7f3d0' : '#fecaca'}`,
 textTransform: 'capitalize',
 }}>
 {incident.resolved ? 'Resolved' : 'Open'}
 </span>
 </td>
 <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: '#6b7280', whiteSpace: 'nowrap' }}>
 {new Date(incident.occurredAt).toLocaleString()}
 </td>
 <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
 {!incident.resolved && (
 <form action={`/incidents/${incident.id}/resolve`} method="post">
 <button
 type="submit"
 style={{
 padding: '0.3rem 0.75rem',
 fontSize: '0.8rem',
 border: '1px solid #d1d5db',
 borderRadius: '4px',
 background: '#10b981',
 color: '#fff',
 cursor: 'pointer',
 }}>
 Resolve
 </button>
 </form>
 )}
 </td>
 </tr>
 );
 })}
 {incidents.length === 0 && (
 <tr>
 <td colSpan={5} style={{ padding: '3rem', textAlign: 'center', color: '#9ca3af' }}>
 No incidents reported
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 );
}
