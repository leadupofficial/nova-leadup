/**
 * LEA-021 — Admin Usage & Cost page
 */

import { getUsageSummary, getUsageByUser, type UsageSummary, type UsageByUser } from '../../lib/api';
import { describeLoadError } from '../../lib/page-data';
import { PageError } from '../../components/PageError';

/**
 * Money, without lying in either direction.
 *
 * The API's cost is a flat list-price estimate and it used to be rounded to whole
 * dollars, so every tenant below 50k tokens rendered as `$0.00` and the Cost card read
 * as "free". The API now carries four decimals; `toFixed(2)` here would undo that, so
 * sub-cent amounts are shown to four places and everything else to two.
 */
function formatUsd(amount: number | null | undefined): string {
  const value = amount ?? 0;
  if (value === 0) return '$0.00';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/**
 * Loads both halves of the page, keeping the failure instead of discarding it.
 *
 * `catch { return null }` made "no tenant chosen yet" and "the request failed" the
 * same state, so an expired session rendered an empty usage table.
 */
async function getUsageData(tenantId: string): Promise<
 | { ok: true; summary: UsageSummary; byUser: UsageByUser[] }
 | { ok: false; message: string; status: number | null }
> {
 try {
 const [summary, byUser] = await Promise.all([
 getUsageSummary(tenantId),
 getUsageByUser(tenantId),
 ]);
 return { ok: true, summary, byUser };
 } catch (error) {
 return { ok: false, ...describeLoadError(error) };
 }
}

export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const resolved = await searchParams;
	const tenantId = typeof resolved.tenantId === 'string' ? resolved.tenantId : '';
	const data = tenantId ? await getUsageData(tenantId) : null;
	if (data && !data.ok) {
		return (
			<div>
				<div style={{ marginBottom: '1.5rem' }}>
					<h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Usage &amp; Cost</h1>
				</div>
				<PageError
					title="Could not load usage"
					message={data.message}
					status={data.status}
					retryHref={`/usage?tenantId=${encodeURIComponent(tenantId)}`}
				/>
			</div>
		);
	}
	const summary: UsageSummary | null = data?.ok ? data.summary : null;
	const byUser: UsageByUser[] = data?.ok ? data.byUser : [];

 // Summary is a single object; the per-metric breakdown is derived from it below.

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
 <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: '#6b7280', fontWeight: 500 }}>API Calls</p>
 <p style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700, color: '#1a1a2e' }}>{(summary?.totalCalls ?? 0).toLocaleString()}</p>
 </div>
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '1.25rem' }}>
 <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: '#6b7280', fontWeight: 500 }}>Tokens</p>
 <p style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700, color: '#1a1a2e' }}>{(summary?.totalTokens ?? 0).toLocaleString()}</p>
 </div>
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '1.25rem' }}>
 <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: '#6b7280', fontWeight: 500 }}>Cost</p>
 <p style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700, color: '#1a1a2e' }}>{formatUsd(summary?.totalCost)}</p>
 </div>
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', padding: '1.25rem' }}>
 <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: '#6b7280', fontWeight: 500 }}>Active Users</p>
 <p style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700, color: '#1a1a2e' }}>{byUser.length}</p>
 {byUser.length >= 100 && (
 <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#b45309' }}>
 At least {byUser.length} — the API returns at most 100 per request.
 </p>
 )}
 </div>
 </div>

 {/* Summary breakdown */}
 <div style={{ marginBottom: '2rem' }}>
 <h2 style={{ fontSize: '1.1rem', fontWeight: 600, margin: '0 0 1rem' }}>Summary</h2>
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
 <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
 <thead>
 <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Metric</th>
 <th style={{ textAlign: 'right', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Total</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Unit</th>
 </tr>
 </thead>
 <tbody>
 {[
 { metric: 'API calls', value: summary?.totalCalls ?? 0, unit: 'calls' },
 { metric: 'Tokens', value: summary?.totalTokens ?? 0, unit: 'tokens' },
 { metric: 'Cost', value: formatUsd(summary?.totalCost), unit: 'USD' },
 ].map((row) => (
 <tr key={row.metric} style={{ borderBottom: '1px solid #f3f4f6' }}>
 <td style={{ padding: '0.75rem 1rem', fontWeight: 500 }}>{row.metric}</td>
 {/* `formatUsd` for money, `toLocaleString` for counts. This cell used to run the Cost
     row through `toLocaleString` as well, so the same amount read `$0.0012` on the card
     and `0.001` here. */}
 <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontWeight: 600 }}>
 {row.unit === 'USD' ? row.value : Number(row.value).toLocaleString()}
 </td>
 <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: '#6b7280' }}>{row.unit}</td>
 </tr>
 ))}
 {summary?.period && (
 <tr>
 <td colSpan={3} style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: '#6b7280' }}>
 Period: {summary.period}
 </td>
 </tr>
 )}
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
 <th style={{ textAlign: 'right', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Calls</th>
 <th style={{ textAlign: 'right', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Tokens</th>
 <th style={{ textAlign: 'right', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Cost</th>
 </tr>
 </thead>
 <tbody>
 {byUser.map((u) => (
 <tr key={u.userId} style={{ borderBottom: '1px solid #f3f4f6' }}>
 <td style={{ padding: '0.75rem 1rem' }}>
 <div style={{ fontWeight: 500 }}>{u.email || 'Unknown'}</div>
 <div style={{ fontSize: '0.8rem', color: '#9ca3af', fontFamily: 'monospace' }}>{u.userId.slice(0, 8)}</div>
 </td>
 <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontWeight: 600 }}>{u.calls.toLocaleString()}</td>
 <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontWeight: 600 }}>{u.tokens.toLocaleString()}</td>
 <td style={{ padding: '0.75rem 1rem', textAlign: 'right', color: '#6b7280' }}>{formatUsd(u.cost)}</td>
 </tr>
 ))}
 {byUser.length === 0 && (
 <tr>
 <td colSpan={4} style={{ padding: '3rem', textAlign: 'center', color: '#9ca3af' }}>
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
