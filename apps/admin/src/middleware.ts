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

/** Routes reachable without a session. */
const PUBLIC_ROUTES = ['/login'];

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

export function middleware(request: NextRequest) {
 const { pathname } = request.nextUrl;
 const token = request.cookies.get(TOKEN_COOKIE)?.value || null;
 const origin = requestOrigin(request);

 // -------------------------------------------------------------------------
 // 1. Public auth routes
 // -------------------------------------------------------------------------
 if (PUBLIC_ROUTES.includes(pathname)) {
 if (token) {
 // Already signed in – bounce to the dashboard.
 return NextResponse.redirect(new URL('/', origin));
 }
 return NextResponse.next();
 }

 // -------------------------------------------------------------------------
 // 2. Everything else requires a session
 // -------------------------------------------------------------------------
 if (!token) {
 const loginUrl = new URL('/login', origin);
 // Preserve the attempted destination so we can return after login.
 loginUrl.searchParams.set('next', pathname);
 return NextResponse.redirect(loginUrl);
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
