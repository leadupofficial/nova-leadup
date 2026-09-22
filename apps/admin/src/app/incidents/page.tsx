/**
 * LEA-021 — Admin Incidents page
 */

import { requestListPage, type AdminIncident } from '../../lib/api';

const SEVERITY_COLORS: Record<string, { bg: string; color: string; border: string }> = {
 critical: { bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
 error: { bg: '#fff7ed', color: '#ea580c', border: '#fed7aa' },
 warning: { bg: '#fffbeb', color: '#d97706', border: '#fde68a' },
 info: { bg: '#eff6ff', color: '#2563eb', border: '#bfdbfe' },
};

import { loadPage } from '../../lib/page-data';
import { PageError } from '../../components/PageError';
import { resolveIncidentAction } from './actions';

export default async function IncidentsPage({
 searchParams,
}: {
 searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
 const resolvedParams = await searchParams;
 const errorMessage = typeof resolvedParams.error === 'string' ? resolvedParams.error : '';
 const okMessage = typeof resolvedParams.ok === 'string' ? resolvedParams.ok : '';
 const result = await loadPage<AdminIncident>(() =>
 requestListPage<AdminIncident>('/admin/incidents', { pageSize: 50 }),
 );
 const incidents: AdminIncident[] = result.ok ? result.rows : [];
 // The header counts are over the loaded page. `totalItems` is what the API says the
 // table holds, so the difference can be stated rather than hidden.
 const total = result.ok ? (result.totalItems ?? incidents.length) : 0;

 if (!result.ok) {
 // Failure and emptiness must never look the same: a 401 used to render
 // the empty-state row, which reads as "you have no data".
 return (
 <div>
 <div style={{ marginBottom: '1.5rem' }}>
 <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Incidents</h1>
 </div>
 <PageError
 title="Could not load incidents"
 message={result.message}
 status={result.status}
 retryHref="/incidents"
 />
 </div>
 );
 }

 return (
 <div>
 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
 <div>
 <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Incidents</h1>
 <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6b7280' }}>
 {incidents.filter((i) => !i.resolved).length} open · {incidents.filter((i) => i.resolved).length} resolved
 {/* These counts are over the loaded page, not the whole table. Saying "on this
 page" is the difference between a real total and a number that silently stops
 growing once there is more than one page of incidents. */}
 {total > incidents.length ? ` · showing the first ${incidents.length} of ${total}` : ''}
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

 {errorMessage ? (
 <div role="alert" style={{ margin: '0 0 1rem', padding: '0.75rem 1rem', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', color: '#7f1d1d', fontSize: '0.85rem' }}>
 {errorMessage}
 </div>
 ) : null}
 {okMessage ? (
 <div role="status" style={{ margin: '0 0 1rem', padding: '0.75rem 1rem', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '8px', color: '#065f46', fontSize: '0.85rem' }}>
 Incident {okMessage}.
 </div>
 ) : null}

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
 <form action={resolveIncidentAction}>
 <input type="hidden" name="id" value={incident.id} />
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
