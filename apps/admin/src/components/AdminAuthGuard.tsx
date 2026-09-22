/**
 * AdminAuthGuard — client-side wrapper that enforces authentication and
 * role-based access for the admin panel.
 *
 * Behaviour:
 * - Reads the JWT from localStorage and validates it on mount.
 * - Extracts the user's role from the token payload.
 * - Only allows users whose role is in the allowed set (owner, admin).
 * - If the token is missing or invalid, redirects to /login.
 * - If the token is expired, attempts a single refresh using the stored
 * refresh token before giving up and redirecting to login.
 * - Renders a loading spinner while the token is being validated.
 * - Renders an access-denied message if the user lacks the required role.
 */

'use client';

import { type ReactNode, useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import AdminSidebar from '../app/AdminSidebar';
import type { MyPermissions } from '../lib/api';

const TOKEN_KEY = 'admin_token';
const REFRESH_TOKEN_KEY = 'admin_refresh_token';

// Roles allowed to access the admin panel
// Mirrors `PLATFORM_ROLE_MAP` in services/api/src/admin/permissions.ts. The server is
// the authority — it resolves the role to a permission set and answers 403 per route —
// but the edge and client gates should not bounce a legitimate support or read-only
// operator before they can reach a page their role permits.
const ALLOWED_ROLES = new Set<string>(['owner', 'admin', 'superadmin', 'super_admin', 'platform_admin', 'support', 'support_admin', 'operations', 'operations_admin', 'analytics', 'analytics_admin', 'developer', 'read_only', 'readonly']);

// The refresh path is `/auth/refresh` relative to the API base; it is inlined in
// `attemptRefresh` because the base is resolved at call time. The module-level
// constant that used to sit here was dead code.

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

/**
 * Sign-out helper — re-exported from lib/api so there is exactly one definition.
 *
 * This file used to define its own `clearTokens` that removed the localStorage
 * entries but left the `admin_token` COOKIE in place, and AdminSidebar/LoginForm
 * import from here. Signing out therefore cleared localStorage and navigated to
 * /login, where the middleware still saw the cookie, treated the visitor as
 * authenticated, and redirected straight back to /. Logout silently did nothing.
 */
import { clearTokens, writeTokens } from '../lib/api';
import { getPublicEnv } from '../lib/env';

export { clearTokens };

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
 /**
 * What the **server** says this operator may do, resolved in the root layout for this page load.
 *
 * Passed down rather than fetched here: the console's API calls are server-side, and asking from the
 * browser is blocked by CORS and would leave the navigation wrong until a round trip finished.
 */
 authority?: MyPermissions | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AdminAuthGuard({ children, allowedRoles, authority }: AdminAuthGuardProps) {
 const router = useRouter();
 const pathname = usePathname();
 const [state, setState] = useState<AuthState>({ status: 'loading' });

 /**
 * The guard sits in the root layout, so it wraps /login as well. Without this
 * exemption the login page was unreachable: it rendered the guard's spinner, the
 * guard found no token and called router.replace('/login'), and /login rendered
 * the same spinner again. The server HTML for the page was literally
 * "NOVA Admin Verifying session…" with no <form> or <input> in it at all.
 */
 // `/privacy`, `/delete-account` and `/support` are exempt for a different reason:
 // they are the public URLs both app stores require (policy link, deletion resource,
 // Support URL). Play's account-deletion requirement says the
 // web resource must be reachable **without reinstalling the app** — by anyone,
 // signed in or not. `src/middleware.ts` already lets them through the edge gate, but
 // this guard is the layer that actually renders the page, so leaving them out here
 // produced a 200 whose body was the spinner and whose visible content (once JS ran)
 // was a redirect to /login: a policy URL that looks live to a crawler and dead to a
 // reviewer.
 const PUBLIC_ROUTES = new Set(['/login', '/privacy', '/delete-account', '/support']);
 const isPublicRoute = PUBLIC_ROUTES.has(pathname);

 const roles = allowedRoles
 ? new Set(allowedRoles)
 : ALLOWED_ROLES;

 const attemptRefresh = useCallback(async (): Promise<boolean> => {
 const refreshToken = readRefreshToken();
 if (!refreshToken) return false;

 try {
 // `getPublicEnv()` rather than a bare `process.env` read: the base must carry the
 // `/api/v1` prefix that every other call site relies on, and a hard-coded
 // `http://localhost:3000` fallback sent the refresh to a host that is not the API
 // in any environment. This path previously disagreed with `lib/api.ts` about both.
 const base = getPublicEnv().NEXT_PUBLIC_API_BASE.replace(/\/+$/, '');
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
 // The API returns snake_case (`access_token`); accept camelCase too.
 const payload = data?.data ?? data;
 const newToken = payload?.access_token ?? payload?.accessToken;
 if (!newToken) return false;

 const newRefresh = payload?.refresh_token ?? payload?.refreshToken;
 // `writeTokens`, not a local assignment: it is the single place that keeps
 // localStorage, the refresh token and the `admin_token` COOKIE in step. Writing
 // only localStorage left the middleware reading the expired cookie on the next
 // navigation, so a refresh that had just succeeded bounced the operator straight
 // back to /login — which then deleted the cookie it had just failed to read.
 writeTokens(newToken, newRefresh);
 return true;
 } catch {
 return false;
 }
 }, []);

 // -------------------------------------------------------------------------
 // Validate auth on mount
 // -------------------------------------------------------------------------
 useEffect(() => {
 // Public routes (the login page) must never be gated or redirected.
 if (isPublicRoute) return;

 const validate = async () => {
 let token = readToken();
 if (!token) {
 setState({ status: 'error', message: 'No session found.' });
 setTimeout(() => router.replace('/login'), 0);
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
 setTimeout(() => router.replace('/login'), 0);
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
 }, [router, attemptRefresh, roles, isPublicRoute]);

 // -------------------------------------------------------------------------
 // Render
 // -------------------------------------------------------------------------

 // Public route: render the page bare — no chrome, no spinner, no redirect.
 if (isPublicRoute) {
 return <>{children}</>;
 }

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
 onClick={() => router.replace('/login')}
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
 router.replace('/login');
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

 // Authenticated — expose the payload via context and apply the console chrome.
 // The chrome lives here rather than in the layout so that it cannot wrap /login.
 //
 // marginLeft matches AdminSidebar's width. The sidebar is `position: fixed`, so
 // it takes no space in the flow and the first 240px of every page was rendering
 // underneath it — the dashboard's first card and each table's first column were
 // hidden behind the nav.
 return (
 <AuthenticatedProvider payload={state.payload}>
 <div style={{ display: 'flex', minHeight: '100vh' }}>
 <AdminSidebar authority={authority ?? null} />
 <main style={{ flex: 1, padding: '2rem', overflow: 'auto', marginLeft: '240px' }}>{children}</main>
 </div>
 </AuthenticatedProvider>
 );
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
