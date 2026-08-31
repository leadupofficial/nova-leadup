import type { Metadata } from 'next';
import AdminSidebar from './AdminSidebar';
import './globals.css';

export const metadata: Metadata = {
 title: 'NOVA Admin',
 description: 'NOVA platform admin console',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
 return (
 <html lang="en">
 <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f5f5f5' }}>
 <div style={{ display: 'flex', minHeight: '100vh' }}>
 <AdminSidebar />
 <main style={{ flex: 1, padding: '2rem', overflow: 'auto' }}>
 {children}
 </main>
 </div>
 </body>
 </html>
 );
}
