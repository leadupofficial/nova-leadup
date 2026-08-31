import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
 subsets: ["latin"],
 weight: ["300", "400", "500", "600", "700", "800"],
 display: "swap",
 variable: "--font-inter",
});

export const metadata: Metadata = {
 title: {
 default: "NOVA — Personal AI Assistant",
 template: "%s | NOVA",
 },
 description: "NOVA is your personal AI companion — voice-driven, memory-aware, and always ready to help.",
 keywords: ["AI", "assistant", "voice", "companion", "NOVA"],
};

export default function RootLayout({
 children,
}: {
 children: React.ReactNode;
 }) {
 return (
 <html lang="en" className={inter.variable}>
 <body
 className={`
 ${inter.className}
 bg-nova-bg text-nova-text
 antialiased
 min-h-screen
 ` }
 style={{
 margin: 0,
 background: '#0b1020',
 color: '#f8fafc',
 minHeight: '100vh',
 }}
 >
 {children}
 </body>
 </html>
 );
}
