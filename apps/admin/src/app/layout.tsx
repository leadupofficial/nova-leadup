import type { Metadata } from 'next';
import AdminAuthGuard from '../components/AdminAuthGuard';
import { getMyPermissions, type MyPermissions } from '../lib/api';
import './globals.css';

export const metadata: Metadata = {
 title: 'NOVA Admin',
 description: 'NOVA platform admin console',
};

/**
 * The sidebar/main chrome is applied by AdminAuthGuard, not here.
 *
 * It previously lived in this file, inside the guard, so every route — including
 * /login — was wrapped in the console shell. That is what made the login page
 * unreachable: the guard rendered its "Verifying session…" spinner on /login,
 * found no token, then redirected to /login again, forever.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
 // The caller's authority is resolved **on the server**, once per page load, and handed to the client
 // shell. It used to be computed in the browser from the role claim plus a copy of the permission
 // matrix, and the first attempt at replacing that with a browser fetch was blocked by CORS — the
 // console's own API calls are server-side, and this one belongs there too. Resolving it here also
 // means the navigation is correct on the first paint rather than after a round trip.
 //
 // Tolerant by design: `/login` is public and has no token, and a failure must render no destinations
 // rather than every one.
 const authority: MyPermissions | null = await getMyPermissions().catch(() => null);

 return (
 <html lang="en">
 <body style={{ fontFamily: 'system-ui, sans-serif' }}>
 <AdminAuthGuard authority={authority}>{children}</AdminAuthGuard>
 </body>
 </html>
 );
}
