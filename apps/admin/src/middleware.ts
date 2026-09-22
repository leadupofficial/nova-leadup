/**
 * Next.js Middleware — cookie-based gate for the admin console.
 *
 * The console's pages live at the root (`/users`, `/organizations`, `/usage`, …),
 * NOT under `/admin/*`, so the matcher below protects every route except `/login`,
 * static assets and Next.js internals. The access token is mirrored into the
 * `admin_token` cookie by the client (see `lib/api.ts`) precisely so it can be
 * read here and in server components.
 *
 * The role check stays client-side in AdminAuthGuard: parsing and validating a
 * JWT at the middleware layer adds complexity without much gain for a
 * single-tenant admin panel.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Routes reachable without a session.
 *
 * `/privacy`, `/delete-account` and `/support` are here because both stores need
 * public, unauthenticated URLs before an app can be submitted — the policy link, Play's
 * account-deletion web resource (reachable without reinstalling the app), and the
 * Support URL in the listing metadata. This origin is the one that is actually
 * deployed. They must never be moved behind the session gate.
 */
const PUBLIC_ROUTES = ['/login', '/privacy', '/delete-account', '/support'];

/** Cookie name – must match the key used in api.ts */
const TOKEN_COOKIE = 'admin_token';

/**
 * Public origin of the current request.
 *
 * Behind nginx the socket is plain HTTP even though the user is on HTTPS, so the
 * forwarded headers win. Without this, redirects were emitted against the
 * container's own bind address (e.g. http://localhost:3005/login), which is
 * unreachable from a browser.
 */
function requestOrigin(request: NextRequest): string {
 const proto =
 request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
 request.nextUrl.protocol.replace(':', '') ||
 'http';
 const host =
 request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
 request.headers.get('host') ||
 request.nextUrl.host;
 return `${proto}://${host}`;
}

/**
 * Roles this console serves. Mirrors `ALLOWED_ROLES` in `AdminAuthGuard`, which is the
 * client-side gate; this is the edge gate, and the authoritative check remains
 * `requireAdmin` on `services/api`.
 */
const ALLOWED_ROLES = new Set<string>(['owner', 'admin', 'superadmin', 'super_admin', 'platform_admin', 'support', 'support_admin', 'operations', 'operations_admin', 'analytics', 'analytics_admin', 'developer', 'read_only', 'readonly']);

interface TokenClaims {
	exp?: number;
	role?: string;
}

/**
 * Reads the claims out of a JWT **without verifying the signature**.
 *
 * The Edge runtime has no access to `JWT_SECRET`, so this cannot be an authentication
 * decision and is not treated as one: `services/api` verifies the signature and the
 * role on every admin request, and that is the gate that matters. What this does fix is
 * the shell rendering for a token that is obviously unusable — an expired one, or one
 * whose `role` claim is not an admin role. Before, the middleware only asked whether the
 * cookie *existed*, so `admin_token=not-a-jwt` rendered the whole console chrome (and
 * its server-side data fetches) before the client guard bounced it.
 */
function readClaims(token: string): TokenClaims | null {
	const parts = token.split('.');
	if (parts.length < 2) return null;
	try {
		const segment = parts[1].replace(/-/g, '+').replace(/_/g, '/');
		const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
		const json = atob(padded);
		const parsed = JSON.parse(json) as TokenClaims;
		return typeof parsed === 'object' && parsed !== null ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * True when the cookie holds a token the client side can still recover from.
 *
 * **Expiry is deliberately NOT part of this decision.** It was, and that broke silent
 * refresh: access tokens live 15 minutes, so after 15 minutes idle this gate rejected the
 * cookie, redirected to `/login` and *deleted* it — and because `/login` is public the
 * client guard never ran, so the 7-day refresh token sitting in localStorage was never
 * used. The operator was forced to sign in again every 15 minutes. An adversarial pass
 * caught it; the browser evidence was an expired cookie plus a **valid** localStorage
 * token landing on `/login?next=%2Fusers` with the cookie cleared.
 *
 * So the edge gate answers only two questions: is there a token at all, and does it claim
 * an admin role? An expired-but-refreshable token passes through, the shell renders, and
 * `AdminAuthGuard.attemptRefresh` renews it in the background — which is what the refresh
 * token is for. A malformed token or a non-admin role still stops here, because no amount
 * of refreshing turns either into an admin session.
 *
 * This remains a coarse gate and not an authentication decision: `services/api` verifies
 * the signature and the role on every admin request, and that is the check that matters.
 */
function sessionCanBeRecovered(token: string): boolean {
	const claims = readClaims(token);
	if (!claims) return false;
	return typeof claims.role === 'string' && ALLOWED_ROLES.has(claims.role);
}

function redirectToLogin(origin: string, pathname: string, clearCookie: boolean) {
	const loginUrl = new URL('/login', origin);
	// Preserve the attempted destination so we can return after login.
	loginUrl.searchParams.set('next', pathname);
	const response = NextResponse.redirect(loginUrl);
	if (clearCookie) {
		// An unusable cookie would otherwise bounce the user in a loop: /login sees a
		// cookie and redirects to /, which rejects it and sends them back here.
		response.cookies.delete(TOKEN_COOKIE);
	}
	return response;
}

export function middleware(request: NextRequest) {
 const { pathname } = request.nextUrl;
 const token = request.cookies.get(TOKEN_COOKIE)?.value || null;
 const usable = token !== null && sessionCanBeRecovered(token);
 const origin = requestOrigin(request);

 // -------------------------------------------------------------------------
 // 1. Public auth routes
 // -------------------------------------------------------------------------
 if (PUBLIC_ROUTES.includes(pathname)) {
 if (usable && pathname === '/login') {
 // Already signed in – bounce to the dashboard. That is correct for the sign-in
 // page and WRONG for the two store-mandated URLs. Play's account-deletion
 // requirement and both stores' privacy-policy requirement say the resource must be
 // reachable by anyone, and the person checking it — a reviewer, or whoever is
 // filling in the Data safety form — is very often signed in. Redirecting them to
 // the console made the published URL look broken exactly when it was verified.
 return NextResponse.redirect(new URL('/', origin));
 }
 // An expired or malformed cookie is cleared here so the login page renders.
 // Redirecting instead would loop: /login → /login?next=/login → …
 const response = NextResponse.next();
 // Never clear a *usable* session just because it landed on /privacy or
 // /delete-account.
 if (token !== null && !usable) response.cookies.delete(TOKEN_COOKIE);
 return response;
 }

 // -------------------------------------------------------------------------
 // 2. Everything else requires a usable session
 // -------------------------------------------------------------------------
 if (!usable) {
 return redirectToLogin(origin, pathname, token !== null);
 }

 return NextResponse.next();
}

export const config = {
 matcher: [
 /*
 * Match all request paths except static files and Next.js internals.
 */
 '/((?!_next/static|_next/image|favicon.ico).*)',
 ],
};
