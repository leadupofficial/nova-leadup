'use client';

import { usePathname } from 'next/navigation';
import { BottomNav } from '../../components/ui/BottomNav';
import { useAssistantStore } from '../../stores/assistant-store';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
 const pathname = usePathname();
 const state = useAssistantStore((s) => s.state);
 const isActive = state === 'listening' || state === 'thinking' || state === 'speaking';

 return (
 <div
 className={`
 min-h-screen transition-all duration-500
 bg-gradient-to-b from-[#0b1020] via-[#0f172a] to-[#0b1020]
 ${isActive ? 'opacity-60' : 'opacity-100'}
 `}
 >
 {/* Ambient background effects */}
 {isActive && (
 <div
 className="fixed inset-0 pointer-events-none z-0 transition-opacity duration-500"
 style={{
 background:
 state === 'listening'
 ? 'radial-gradient(ellipse at center, rgba(34,211,238,0.06) 0%, transparent 70%)'
 : state === 'thinking'
 ? 'radial-gradient(ellipse at center, rgba(245,158,11,0.06) 0%, transparent 70%)'
 : 'radial-gradient(ellipse at center, rgba(16,185,129,0.06) 0%, transparent 70%)',
 }}
 />
 )}

 <main className="relative z-10 pb-24">{children}</main>
 <BottomNav />
 </div>
 );
}
