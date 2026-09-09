/**
 * Next.js Middleware — protects /admin/* routes at the edge.
 *
 * Strategy:
 * - Stores the JWT in a cookie (`admin_token`) so the middleware can read it
 * without touching localStorage (which is client-side only).
 * - Redirects unauthenticated visitors on /admin/* to /login.
 * - Redirects already-authenticated visitors on /login to / (dashboard).
 *
 * The actual role check happens in AdminAuthGuard (client-side) because
 * parsing and validating a JWT at the middleware layer adds complexity
 * without much gain for a single-tenant admin panel.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** Routes that require authentication */
const PROTECTED_PREFIXES = ['/admin/', '/'];

/** Routes that must NOT show the admin sidebar/layout */
const PUBLIC_ROUTES = ['/admin/login'];

/** Cookie name – must match the key used in api.ts */
const TOKEN_COOKIE = 'admin_token';

export function middleware(request: NextRequest) {
 const { pathname } = request.nextUrl;
 const token = request.cookies.get(TOKEN_COOKIE)?.value || null;

 // -------------------------------------------------------------------------
 // 1. Allow public auth routes without a token
 // -------------------------------------------------------------------------
 if (pathname === '/admin/login' || pathname === '/login') {
 if (token) {
 // Already logged in – bounce to dashboard
 return NextResponse.redirect(new URL('/', request.url));
 }
 return NextResponse.next();
 }

 // -------------------------------------------------------------------------
 // 2. Protect everything else under /admin/*
 // -------------------------------------------------------------------------
 if (pathname.startsWith('/admin/')) {
 if (!token) {
 const loginUrl = new URL('/admin/login', request.url);
 // Preserve the attempted destination so we can redirect after login
 loginUrl.searchParams.set('next', pathname);
 return NextResponse.redirect(loginUrl);
 }
 return NextResponse.next();
 }

 // -------------------------------------------------------------------------
 // 3. Root / and other app routes – pass through
 // (client-side AdminAuthGuard will handle the real auth check)
 // -------------------------------------------------------------------------
 return NextResponse.next();
}

export const config = {
 matcher: [
 /*
 * Match all request paths except for static files and Next.js internals.
 * We specifically want to intercept /admin/* and /login paths.
 */
 '/((?!_next/static|_next/image|favicon.ico|api/health).*)',
 ],
};
