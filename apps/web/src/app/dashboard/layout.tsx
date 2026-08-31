"use client";

import { BottomNav } from "../../components/ui/BottomNav";

export default function DashboardLayout({
 children,
}: {
 children: React.ReactNode;
}) {
 return (
 <div className="app-shell min-h-screen pb-20 bg-nova-bg">
 {children}
 <BottomNav />
 </div>
 );
}
