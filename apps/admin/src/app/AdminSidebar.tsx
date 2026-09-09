'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type MouseEvent, useCallback, useEffect, useState } from 'react';
import { clearTokens, decodeJwt } from '../../components/AdminAuthGuard';

const NAV_ITEMS = [
 { href: '/', label: 'Dashboard', icon: '📊' },
 { href: '/users', label: 'Users', icon: '👥' },
 { href: '/organizations', label: 'Organizations', icon: '🏢' },
 { href: '/audit-logs', label: 'Audit Logs', icon: '📋' },
 { href: '/feature-flags', label: 'Feature Flags', icon: '🚩' },
 { href: '/incidents', label: 'Incidents', icon: '⚠️' },
 { href: '/usage', label: 'Usage & Cost', icon: '💰' },
];

const TOKEN_KEY = 'admin_token';

export default function AdminSidebar() {
 const router = useRouter();
 const [userEmail, setUserEmail] = useState<string | null>(null);
 const [userRole, setUserRole] = useState<string | null>(null);
 const [showDropdown, setShowDropdown] = useState(false);

 useEffect(() => {
 try {
 const token = window.localStorage.getItem(TOKEN_KEY);
 if (token) {
 const payload = decodeJwt(token);
 if (payload) {
 setUserEmail(payload.email || null);
 setUserRole(payload.role || null);
 }
 }
 } catch {
 // ignore
 }
 }, []);

 const handleLogout = useCallback(() => {
 clearTokens();
 router.replace('/admin/login');
 }, [router]);

 const handleDropdownToggle = useCallback(() => {
 setShowDropdown((prev) => !prev);
 }, []);

 const handleOutsideClick = useCallback((e: MouseEvent) => {
 if (!e.currentTarget.contains(e.target as Node)) {
 setShowDropdown(false);
 }
 }, []);

 return (
 <nav
 onClick={handleOutsideClick}
 style={{
 width: '240px',
 background: '#1a1a2e',
 color: '#fff',
 padding: 0,
 position: 'fixed',
 height: '100vh',
 overflow: 'auto',
 display: 'flex',
 flexDirection: 'column',
 }}>
 {/* Brand header */}
 <div style={{ padding: '1.5rem', borderBottom: '1px solid #2a2a4a' }}>
 <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>NOVA Admin</h1>
 <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#888' }}>Platform Console</p>
 </div>

 {/* Navigation */}
 <div style={{ flex: 1, padding: '1rem 0' }}>
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

 {/* User info + logout */}
 <div
 style={{
 padding: '1rem 1.5rem',
 borderTop: '1px solid #2a2a4a',
 position: 'relative',
 }}
 >
 {/* User badge */}
 <div
 onClick={handleDropdownToggle}
 style={{
 display: 'flex',
 alignItems: 'center',
 gap: '0.75rem',
 cursor: 'pointer',
 padding: '0.5rem 0',
 userSelect: 'none',
 }}
 role="button"
 aria-expanded={showDropdown}
 aria-haspopup="true"
 tabIndex={0}
 onKeyDown={(e) => {
 if (e.key === 'Enter' || e.key === ' ') {
 e.preventDefault();
 handleDropdownToggle();
 }
 }}
 >
 <div
 style={{
 width: '32px',
 height: '32px',
 borderRadius: '50%',
 background: '#6366f1',
 display: 'flex',
 alignItems: 'center',
 justifyContent: 'center',
 fontSize: '0.85rem',
 fontWeight: 600,
 color: '#fff',
 flexShrink: 0,
 }}
 >
 {userEmail ? userEmail.charAt(0).toUpperCase() : 'U'}
 </div>
 <div style={{ minWidth: 0 }}>
 <p
 style={{
 margin: 0,
 fontSize: '0.8rem',
 fontWeight: 500,
 color: '#f8fafc',
 overflow: 'hidden',
 textOverflow: 'ellipsis',
 whiteSpace: 'nowrap',
 }}
 >
 {userEmail || 'user@example.com'}
 </p>
 <p
 style={{
 margin: '0.15rem 0 0',
 fontSize: '0.7rem',
 color: '#6366f1',
 textTransform: 'capitalize',
 }}
 >
 {userRole || 'user'}
 </p>
 </div>
 <span
 style={{
 marginLeft: 'auto',
 fontSize: '0.7rem',
 color: '#64748b',
 transition: 'transform 0.15s',
 transform: showDropdown ? 'rotate(180deg)' : 'rotate(0deg)',
 }}
 >
 ▾
 </span>
 </div>

 {/* Dropdown */}
 {showDropdown && (
 <div
 style={{
 position: 'absolute',
 bottom: '100%',
 left: '1.5rem',
 right: '1.5rem',
 marginBottom: '0.5rem',
 background: '#1e2540',
 border: '1px solid #2a2a4a',
 borderRadius: '8px',
 overflow: 'hidden',
 boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
 zIndex: 50,
 }}
 >
 <div
 style={{
 padding: '0.75rem 1rem',
 borderBottom: '1px solid #2a2a4a',
 }}
 >
 <p
 style={{
 margin: 0,
 fontSize: '0.8rem',
 fontWeight: 500,
 color: '#f8fafc',
 overflow: 'hidden',
 textOverflow: 'ellipsis',
 whiteSpace: 'nowrap',
 }}
 >
 {userEmail || 'user@example.com'}
 </p>
 <p
 style={{
 margin: '0.15rem 0 0',
 fontSize: '0.7rem',
 color: '#6366f1',
 textTransform: 'capitalize',
 }}
 >
 {userRole || 'user'}
 </p>
 </div>
 <button
 type="button"
 onClick={handleLogout}
 style={{
 width: '100%',
 padding: '0.65rem 1rem',
 background: 'transparent',
 color: '#f87171',
 border: 'none',
 fontSize: '0.8rem',
 cursor: 'pointer',
 textAlign: 'left',
 display: 'flex',
 alignItems: 'center',
 gap: '0.5rem',
 transition: 'background 0.15s',
 }}
 onMouseEnter={(e) => {
 e.currentTarget.style.background = '#450a0a';
 }}
 onMouseLeave={(e) => {
 e.currentTarget.style.background = 'transparent';
 }}
 >
 <span>🚪</span>
 Sign Out
 </button>
 </div>
 )}
 </div>
 </nav>
 );
}
