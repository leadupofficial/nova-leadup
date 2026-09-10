/**
 * AdminAuthGuard — client-side wrapper that enforces authentication and
 * role-based access for the admin panel.
 *
 * Behaviour:
 * - Reads the JWT from localStorage and validates it on mount.
 * - Extracts the user's role from the token payload.
 * - Only allows users whose role is in the allowed set (owner, admin).
 * - If the token is missing or invalid, redirects to /admin/login.
 * - If the token is expired, attempts a single refresh using the stored
 * refresh token before giving up and redirecting to login.
 * - Renders a loading spinner while the token is being validated.
 * - Renders an access-denied message if the user lacks the required role.
 */

'use client';

import { type ReactNode, useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

const TOKEN_KEY = 'admin_token';
const REFRESH_TOKEN_KEY = 'admin_refresh_token';

// Roles allowed to access the admin panel
const ALLOWED_ROLES = new Set(['owner', 'admin']);

// Token refresh endpoint
const REFRESH_PATH = '/auth/refresh';

// ---------------------------------------------------------------------------
// JWT helpers (no external deps)
// ---------------------------------------------------------------------------

function base64UrlDecode(seg: string): string {
 const normalized = seg.replace(/-/g, '+').replace(/_/g, '/');
 const json = atob(normalized);
 return decodeURIComponent(
 [...json].map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
 );
}

export interface JwtPayload {
 sub?: string;
 email?: string;
 name?: string;
 role?: string;
 iat?: number;
 exp?: number;
 [key: string]: unknown;
}

export function decodeJwt(token: string): JwtPayload | null {
 try {
 const parts = token.split('.');
 if (parts.length < 2) return null;
 const payload = JSON.parse(base64UrlDecode(parts[1])) as JwtPayload;
 return payload;
 } catch {
 return null;
 }
}

export function isTokenExpired(payload: JwtPayload): boolean {
 if (!payload.exp) return true;
 // Add a 30-second buffer to account for clock skew
 const now = Math.floor(Date.now() / 1000);
 return now >= payload.exp - 30;
}

export function hasAdminRole(payload: JwtPayload): boolean {
 return !!payload.role && ALLOWED_ROLES.has(payload.role);
}

// ---------------------------------------------------------------------------
// Token storage helpers
// ---------------------------------------------------------------------------

export function readToken(): string | null {
 if (typeof window === 'undefined') return null;
 try {
 return window.localStorage.getItem(TOKEN_KEY);
 } catch {
 return null;
 }
}

export function readRefreshToken(): string | null {
 if (typeof window === 'undefined') return null;
 try {
 return window.localStorage.getItem(REFRESH_TOKEN_KEY);
 } catch {
 return null;
 }
}

export function clearTokens(): void {
 if (typeof window === 'undefined') return;
 window.localStorage.removeItem(TOKEN_KEY);
 window.localStorage.removeItem(REFRESH_TOKEN_KEY);
}

// ---------------------------------------------------------------------------
// Auth state type
// ---------------------------------------------------------------------------

type AuthState =
 | { status: 'loading' }
 | { status: 'authenticated'; payload: JwtPayload }
 | { status: 'refreshing' }
 | { status: 'error'; message: string }
 | { status: 'forbidden' };

interface AdminAuthGuardProps {
 children: ReactNode;
 /** Override the set of allowed roles (default: owner, admin) */
 allowedRoles?: string[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminAuthGuard({ children, allowedRoles }: AdminAuthGuardProps) {
 const router = useRouter();
 const [state, setState] = useState<AuthState>({ status: 'loading' });

 const roles = allowedRoles
 ? new Set(allowedRoles)
 : ALLOWED_ROLES;

 const attemptRefresh = useCallback(async (): Promise<boolean> => {
 const refreshToken = readRefreshToken();
 if (!refreshToken) return false;

 try {
 const base = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3000';
 const res = await fetch(`${base}/auth/refresh`, {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 Accept: 'application/json',
 },
 body: JSON.stringify({ refreshToken }),
 cache: 'no-store',
 });

 if (!res.ok) return false;

 const data = await res.json();
 const newToken = data?.data?.accessToken || data?.accessToken;
 if (!newToken) return false;

 window.localStorage.setItem(TOKEN_KEY, newToken);
 const newRefresh = data?.data?.refreshToken || data?.refreshToken;
 if (newRefresh) {
 window.localStorage.setItem(REFRESH_TOKEN_KEY, newRefresh);
 }
 return true;
 } catch {
 return false;
 }
 }, []);

 // -------------------------------------------------------------------------
 // Validate auth on mount
 // -------------------------------------------------------------------------
 useEffect(() => {
 const validate = async () => {
 let token = readToken();
 if (!token) {
 setState({ status: 'error', message: 'No session found.' });
 setTimeout(() => router.replace('/admin/login'), 0);
 return;
 }

 let payload = decodeJwt(token);
 if (!payload || isTokenExpired(payload)) {
 // Try refreshing once
 setState({ status: 'refreshing' });
 const refreshed = await attemptRefresh();
 if (refreshed) {
 token = readToken();
 payload = decodeJwt(token!);
 } else {
 clearTokens();
 setState({ status: 'error', message: 'Session expired. Please sign in again.' });
 setTimeout(() => router.replace('/admin/login'), 0);
 return;
 }
 }

 // Check role using the resolved roles set
 const userRole = payload?.role;
 if (!userRole || !roles.has(userRole)) {
 clearTokens();
 setState({ status: 'forbidden' });
 return;
 }

 const validPayload = payload as JwtPayload;
 setState({ status: 'authenticated', payload: validPayload });
 };

 validate();
 }, [router, attemptRefresh, roles]);

 // -------------------------------------------------------------------------
 // Render
 // -------------------------------------------------------------------------
 if (state.status === 'loading' || state.status === 'refreshing') {
 return (
 <div
 style={{
 display: 'flex',
 alignItems: 'center',
 justifyContent: 'center',
 minHeight: '100vh',
 background: '#0a0e1a',
 color: '#94a3b8',
 fontSize: '0.9rem',
 flexDirection: 'column',
 gap: '1rem',
 }}
 >
 <svg
 width="40"
 height="40"
 viewBox="0 0 24 24"
 fill="none"
 stroke="currentColor"
 strokeWidth="2"
 strokeLinecap="round"
 strokeLinejoin="round"
 style={{ animation: 'spin 1s linear infinite' }}
 >
 <path d="M21 12a9 9 0 1 1-6.219-8.56" />
 </svg>
 <style>{`
 @keyframes spin {
 from { transform: rotate(0deg); }
 to { transform: rotate(360deg); }
 }
 `}</style>
 {state.status === 'refreshing' ? 'Refreshing session…' : 'Verifying session…'}
 </div>
 );
 }

 if (state.status === 'error') {
 return (
 <div
 style={{
 display: 'flex',
 alignItems: 'center',
 justifyContent: 'center',
 minHeight: '100vh',
 background: '#0a0e1a',
 color: '#f8fafc',
 flexDirection: 'column',
 gap: '1rem',
 padding: '2rem',
 textAlign: 'center',
 }}
 >
 <p style={{ color: '#94a3b8' }}>{state.message}</p>
 <button
 onClick={() => router.replace('/admin/login')}
 style={{
 padding: '0.65rem 1.5rem',
 background: '#6366f1',
 color: '#fff',
 border: 'none',
 borderRadius: '6px',
 fontSize: '0.9rem',
 cursor: 'pointer',
 fontWeight: 600,
 }}
 >
 Go to Login
 </button>
 </div>
 );
 }

 if (state.status === 'forbidden') {
 return (
 <div
 style={{
 display: 'flex',
 alignItems: 'center',
 justifyContent: 'center',
 minHeight: '100vh',
 background: '#0a0e1a',
 color: '#f8fafc',
 flexDirection: 'column',
 gap: '1rem',
 padding: '2rem',
 textAlign: 'center',
 }}
 >
 <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Access Denied</h2>
 <p style={{ color: '#94a3b8', maxWidth: '400px' }}>
 Your account does not have the required permissions to access this panel.
 Please contact your organization owner if you believe this is an error.
 </p>
 <button
 onClick={() => {
 clearTokens();
 router.replace('/admin/login');
 }}
 style={{
 padding: '0.65rem 1.5rem',
 background: '#ef4444',
 color: '#fff',
 border: 'none',
 borderRadius: '6px',
 fontSize: '0.9rem',
 cursor: 'pointer',
 fontWeight: 600,
 }}
 >
 Sign Out
 </button>
 </div>
 );
 }

 // Authenticated — expose payload via context if needed
 return <AuthenticatedProvider payload={state.payload}>{children}</AuthenticatedProvider>;
}

// ---------------------------------------------------------------------------
// Tiny context provider so children can access the decoded payload
// ---------------------------------------------------------------------------

import { createContext, useContext } from 'react';

const AuthContext = createContext<JwtPayload | null>(null);

function AuthenticatedProvider({
 payload,
 children,
}: {
 payload: JwtPayload;
 children: ReactNode;
}) {
 return <AuthContext.Provider value={payload}>{children}</AuthContext.Provider>;
}

export function useAuthPayload(): JwtPayload | null {
 return useContext(AuthContext);
}
