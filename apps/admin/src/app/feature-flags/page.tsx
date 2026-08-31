/**
 * LEA-021 — Admin Feature Flags page
 */

import { listFeatureFlags, createFeatureFlag, updateFeatureFlag, deleteFeatureFlag, type AdminFeatureFlag } from '../../lib/api';

async function getFlags() {
 try {
 const result = await listFeatureFlags('');
 return result;
 } catch {
 return null;
 }
}

export default async function FeatureFlagsPage() {
 const flags: AdminFeatureFlag[] = await getFlags() ?? [];

 return (
 <div>
 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
 <div>
 <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Feature Flags</h1>
 <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6b7280' }}>
 {flags.length} total flags
 </p>
 </div>
 </div>

 {/* Create form */}
 <form action="/feature-flags/create" method="post" style={{
 display: 'flex',
 gap: '0.75rem',
 marginBottom: '1.5rem',
 padding: '1rem',
 background: '#fff',
 borderRadius: '8px',
 border: '1px solid #e5e7eb',
 flexWrap: 'wrap',
 alignItems: 'flex-end',
 }}>
 <div style={{ flex: '1 1 200px' }}>
 <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 500, color: '#6b7280', marginBottom: '0.25rem' }}>Key</label>
 <input type="text" name="key" required placeholder="e.g. voice_enabled"
 style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.85rem' }} />
 </div>
 <div style={{ flex: '1 1 150px' }}>
 <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 500, color: '#6b7280', marginBottom: '0.25rem' }}>Rollout %</label>
 <input type="number" name="rolloutPercent" min="0" max="100" defaultValue="0"
 style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.85rem' }} />
 </div>
 <div style={{ flex: '2 1 300px' }}>
 <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 500, color: '#6b7280', marginBottom: '0.25rem' }}>Description</label>
 <input type="text" name="description" placeholder="What does this flag control?"
 style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.85rem' }} />
 </div>
 <button type="submit" formAction="/feature-flags/create"
 style={{
 padding: '0.5rem 1.25rem',
 background: '#1a1a2e',
 color: '#fff',
 border: 'none',
 borderRadius: '6px',
 fontSize: '0.85rem',
 cursor: 'pointer',
 height: 'fit-content',
 }}>
 Create Flag
 </button>
 </form>

 {/* Flags Table */}
 <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', overflow: 'hidden' }}>
 <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
 <thead>
 <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Key</th>
 <th style={{ textAlign: 'center', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Enabled</th>
 <th style={{ textAlign: 'center', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Rollout</th>
 <th style={{ textAlign: 'left', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Description</th>
 <th style={{ textAlign: 'right', padding: '0.75rem 1rem', fontWeight: 600, color: '#6b7280', fontSize: '0.8rem', textTransform: 'uppercase' }}>Updated</th>
 </tr>
 </thead>
 <tbody>
 {flags.map((flag) => (
 <tr key={flag.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
 <td style={{ padding: '0.75rem 1rem', fontFamily: 'monospace', fontWeight: 500 }}>
 {flag.key}
 </td>
 <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
 <FlagToggle key={flag.key} defaultEnabled={flag.enabled} />
 </td>
 <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
 <span style={{
 display: 'inline-flex',
 padding: '0.2rem 0.6rem',
 borderRadius: '9999px',
 fontSize: '0.75rem',
 fontWeight: 500,
 background: flag.rolloutPercent > 0 ? '#eff6ff' : '#f9fafb',
 color: flag.rolloutPercent > 0 ? '#2563eb' : '#6b7280',
 border: `1px solid ${flag.rolloutPercent > 0 ? '#bfdbfe' : '#e5e7eb'}`,
 }}>
 {flag.rolloutPercent}%
 </span>
 </td>
 <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem', color: '#6b7280', maxWidth: '300px' }}>
 {flag.description ?? '—'}
 </td>
 <td style={{ padding: '0.75rem 1rem', textAlign: 'right', fontSize: '0.85rem', color: '#6b7280', whiteSpace: 'nowrap' }}>
 {new Date(flag.updatedAt).toLocaleDateString()}
 </td>
 </tr>
 ))}
 {flags.length === 0 && (
 <tr>
 <td colSpan={5} style={{ padding: '3rem', textAlign: 'center', color: '#9ca3af' }}>
 No feature flags configured
 </td>
 </tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 );
}

function FlagToggle({ key, defaultEnabled }: { key: string; defaultEnabled: boolean }) {
 return (
 <form action={`/feature-flags/${encodeURIComponent(key)}/toggle`} method="post">
 <button
 type="submit"
 style={{
 width: '44px',
 height: '24px',
 borderRadius: '12px',
 border: 'none',
 background: defaultEnabled ? '#10b981' : '#d1d5db',
 position: 'relative',
 cursor: 'pointer',
 transition: 'background 0.2s',
 }}
 >
 <span style={{
 position: 'absolute',
 top: '2px',
 left: defaultEnabled ? '22px' : '2px',
 width: '20px',
 height: '20px',
 borderRadius: '50%',
 background: '#fff',
 boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
 transition: 'left 0.2s',
 }} />
 </button>
 </form>
 );
}
