'use client';

import Link from 'next/link';

const NAV_ITEMS = [
 { href: '/', label: 'Dashboard', icon: '📊' },
 { href: '/users', label: 'Users', icon: '👥' },
 { href: '/organizations', label: 'Organizations', icon: '🏢' },
 { href: '/audit-logs', label: 'Audit Logs', icon: '📋' },
 { href: '/feature-flags', label: 'Feature Flags', icon: '🚩' },
 { href: '/incidents', label: 'Incidents', icon: '⚠️' },
 { href: '/usage', label: 'Usage & Cost', icon: '💰' },
];

export default function AdminSidebar() {
 return (
 <nav style={{
 width: '240px',
 background: '#1a1a2e',
 color: '#fff',
 padding: '1.5rem 0',
 position: 'fixed',
 height: '100vh',
 overflow: 'auto',
 }}>
 <div style={{ padding: '0 1.5rem 1.5rem', borderBottom: '1px solid #2a2a4a' }}>
 <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>NOVA Admin</h1>
 <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#888' }}>Platform Console</p>
 </div>
 <div style={{ padding: '1rem 0' }}>
 {NAV_ITEMS.map((item) => (
 <Link
 key={item.href}
 href={item.href}
 style={{
 display: 'flex',
 alignItems: 'center',
 gap: '0.75rem',
 padding: '0.75rem 1.5rem',
 color: '#aaa',
 textDecoration: 'none',
 fontSize: '0.9rem',
 transition: 'all 0.15s',
 }}
 onMouseEnter={(e) => {
 e.currentTarget.style.background = '#2a2a4a';
 e.currentTarget.style.color = '#fff';
 }}
 onMouseLeave={(e) => {
 e.currentTarget.style.background = 'transparent';
 e.currentTarget.style.color = '#aaa';
 }}
 >
 <span>{item.icon}</span>
 <span>{item.label}</span>
 </Link>
 ))}
 </div>
 </nav>
 );
}
