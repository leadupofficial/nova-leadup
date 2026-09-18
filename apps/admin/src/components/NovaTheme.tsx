import { type ReactNode } from 'react';

/**
 * Theme tokens for the admin app. Use these instead of inline literals
 * scattered across pages. Values match globals.css and AdminSidebar.tsx.
 */
export const novaTheme = {
 bg: '#f5f5f5',
 surface: '#ffffff',
 sidebarBg: '#1a1a2e',
 sidebarHover: '#2a2a4a',
 border: '#e5e7eb',
 borderLight: '#f3f4f6',
 textPrimary: '#111827',
 textSecondary: '#6b7280',
 textMuted: '#9ca3af',
 textInverse: '#f8fafc',
 primary: '#6366f1',
 primaryHover: '#4f46e5',
 success: '#10b981',
 successBg: '#ecfdf5',
 warning: '#f59e0b',
 warningBg: '#fffbeb',
 error: '#dc2626',
 errorBg: '#fef2f2',
 info: '#2563eb',
 infoBg: '#eff6ff',
} as const;

/**
 * Centered card used by every page's loading, error, and empty states.
 */
export function StatusCard({
 title,
 description,
 action,
 tone = 'neutral',
 children,
}: {
 title: string;
 description?: string;
 action?: ReactNode;
 tone?: 'neutral' | 'error' | 'success';
 children?: ReactNode;
}) {
 const colors =
 tone === 'error'
 ? { border: '#fecaca', bg: '#fef2f2', text: '#7f1d1d' }
 : tone === 'success'
 ? { border: '#a7f3d0', bg: '#ecfdf5', text: '#065f46' }
 : { border: '#e5e7eb', bg: '#ffffff', text: '#111827' };

 return (
 <div
 role={tone === 'error' ? 'alert' : 'status'}
 aria-live={tone === 'error' ? 'assertive' : 'polite'}
 style={{
 margin: '0 auto',
 maxWidth: '640px',
 padding: '2rem',
 background: colors.bg,
 border: `1px solid ${colors.border}`,
 borderRadius: '8px',
 color: colors.text,
 textAlign: 'center',
 }}
 >
 <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.1rem', fontWeight: 700 }}>
 {title}
 </h2>
 {description && (
 <p style={{ margin: '0 0 1rem', fontSize: '0.9rem', color: '#6b7280' }}>
 {description}
 </p>
 )}
 {action}
 {children}
 </div>
 );
}

export function RetryButton({ onClick, label = 'Try again' }: { onClick: () => void; label?: string }) {
 return (
 <form
 action=""
 onSubmit={(e) => {
 e.preventDefault();
 onClick();
 }}
 >
 <button
 type="submit"
 aria-label={label}
 style={{
 padding: '0.5rem 1.25rem',
 background: '#1a1a2e',
 color: '#fff',
 border: 'none',
 borderRadius: '6px',
 fontSize: '0.85rem',
 cursor: 'pointer',
 fontWeight: 600,
 }}
 >
 {label}
 </button>
 </form>
 );
}
