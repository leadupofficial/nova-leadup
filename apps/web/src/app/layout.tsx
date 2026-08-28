import type { Metadata } from 'next';

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
 <body>{children}</body>
 </html>
 );
}
