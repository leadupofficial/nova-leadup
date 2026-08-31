import type { Metadata } from "next";

export const metadata: Metadata = {
 title: 'NOVA',
 description: 'Voice and Visual Companion',
};

export default function RootLayout({
 children,
}: {
 children: React.ReactNode;
}) {
 return (
 <html lang="en">
 <body style={{margin: 0, fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif', background: '#0b1020', color: '#f8fafc', minHeight: '100vh'}}>
 {children}
 </body>
 </html>
 );
}
