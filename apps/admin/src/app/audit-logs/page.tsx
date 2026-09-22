/**
 * LEA-021 — Admin Audit Logs page
 */

import { requestListPage, type AdminAuditLog } from '../../lib/api';

const OUTCOME_COLORS: Record<string, { bg: string; color: string; border: string }> = {
 success: { bg: '#ecfdf5', color: '#059669', border: '#a7f3d0' },
 failure: { bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
 denied: { bg: '#fffbeb', color: '#d97706', border: '#fde68a' },
};

import { loadPage } from '../../lib/page-data';
import { PageError } from '../../components/PageError';

export default async function AuditLogsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const resolved = await searchParams;
	const actionFilter = typeof resolved.action === 'string' ? resolved.action : '';
	const result = await loadPage<AdminAuditLog>(() =>
		requestListPage<AdminAuditLog>('/admin/audit-logs', {
			pageSize: 50,
			...(actionFilter ? { action: actionFilter } : {}),
		}),
	);
	const logs: AdminAuditLog[] = result.ok ? result.rows : [];

 if (!result.ok) {
 // Failure and emptiness must never look the same: a 401 used to render
 // the empty-state row, which reads as "you have no data".
 return (
 <div>
 <div style={{ marginBottom: '1.5rem' }}>
 <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Audit Logs</h1>
 </div>
 <PageError
 title="Could not load audit logs"
 message={result.message}
 status={result.status}
 retryHref="/audit-logs"
 />
 </div>
 );
 }

 return (
 <div>
 <div style={{ marginBottom: '1.5rem' }}>
 <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Audit Logs</h1>
 <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6b7280' }}>
 Sensitive operation history
 </p>
 </div>

 {/* Filters */}
 <form method="get" style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
 <input
 type="text"
 name="action"
 placeholder="Filter by action"
 defaultValue={actionFilter}
 style={{
 padding: '0.5rem 0.75rem',
 border: '1px solid #d1d5db',
 borderRadius: '6px',
 fontSize: '0.85rem',
 minWidth: '200px',
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
 Filter
 </button>
 </form>

 {/* Logs Table */}
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
 <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
 <thead>
 <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Time</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Actor</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Action</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Outcome</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Target</th>
 </tr>
 </thead>
 <tbody>
 {logs.map((log) => {
 // Fallback rather than a non-null assertion: `outcome` is a varchar(50) with the
// allowed values only in a schema comment, so a fourth value from the database
// turned this row into `undefined.bg` and threw. A neutral badge is the honest
// rendering of an outcome this console does not know.
 const colors =
 OUTCOME_COLORS[log.outcome as keyof typeof OUTCOME_COLORS] ?? {
 bg: '#f9fafb',
 color: '#6b7280',
 border: '#e5e7eb',
 };
 return (
 <tr key={log.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
 <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: '#6b7280', whiteSpace: 'nowrap' }}>
 {new Date(log.occurredAt).toLocaleString()}
 </td>
 <td style={{ padding: '0.75rem 1rem' }}>
 <span style={{ fontSize: '0.85rem' }}>{log.actorType}</span>
 {log.actorId && (
 <span style={{ display: 'block', fontSize: '0.75rem', color: '#9ca3af', fontFamily: 'monospace' }}>
 {log.actorId.slice(0, 8)}
 </span>
 )}
 </td>
 <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', fontSize: '0.85rem' }}>
 {log.action}
 </td>
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
 textTransform: 'uppercase',
 }}>
 {log.outcome}
 </span>
 </td>
 <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem' }}>
 {log.targetType && (
 <span style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
 {log.targetType}:{log.targetId?.slice(0, 8) ?? ''}
 </span>
 )}
 </td>
 </tr>
 );
 })}
 {logs.length === 0 && (
 <tr>
 <td colSpan={5} style={{ padding: '3rem', textAlign: 'center', color: '#9ca3af' }}>
 No audit logs found
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 );
}
