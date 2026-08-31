<<<<<<< HEAD
import type { Metadata } from 'next';
=======
import type { Metadata } from "next";
>>>>>>> f0688da (feat: complete mobile app source files and add GitHub Actions APK build workflow)

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
<<<<<<< HEAD
 <body>{children}</body>
=======
 <body style={{margin: 0, fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif', background: '#0b1020', color: '#f8fafc', minHeight: '100vh'}}>
 {children}
 </body>
>>>>>>> f0688da (feat: complete mobile app source files and add GitHub Actions APK build workflow)
 </html>
 );
}
