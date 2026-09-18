import type { Metadata } from 'next';
import AdminAuthGuard from '../components/AdminAuthGuard';
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
export default function RootLayout({ children }: { children: React.ReactNode }) {
 return (
 <html lang="en">
 <body style={{ fontFamily: 'system-ui, sans-serif' }}>
 <AdminAuthGuard>{children}</AdminAuthGuard>
 </body>
 </html>
 );
}
