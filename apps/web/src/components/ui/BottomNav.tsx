"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
 Home,
 MessageSquare,
 CheckSquare,
 Brain,
 User,
} from "lucide-react";

interface NavItem {
 href: string;
 label: string;
 icon: typeof Home;
}

const navItems: NavItem[] = [
 { href: "/dashboard", label: "Home", icon: Home },
 { href: "/dashboard/converse", label: "Converse", icon: MessageSquare },
 { href: "/dashboard/tasks", label: "Tasks", icon: CheckSquare },
 { href: "/dashboard/memory", label: "Memory", icon: Brain },
 { href: "/dashboard/settings", label: "Profile", icon: User },
];

export function BottomNav() {
 const pathname = usePathname();

 const getItemStyle = (isActive: boolean): React.CSSProperties => ({
 position: 'relative',
 display: 'flex',
 flexDirection: 'column' as const,
 alignItems: 'center',
 gap: '2px',
 padding: '6px 12px',
 borderRadius: '12px',
 minWidth: '48px',
 minHeight: '44px',
 justifyContent: 'center',
 color: isActive ? '#6366f1' : '#64748b',
 textDecoration: 'none',
 transition: 'all 0.2s',
 } as React.CSSProperties);

 return (
 <nav
 style={{
 position: 'fixed',
 bottom: 0,
 left: 0,
 right: 0,
 zIndex: 50,
 padding: '8px 16px',
 background: 'rgba(11, 16, 32, 0.9)',
 backdropFilter: 'blur(20px)',
 borderTop: '1px solid rgba(99, 102, 241, 0.1)',
 }}
 aria-label="Main navigation"
 >
 <div
 style={{
 maxWidth: '600px',
 margin: '0 auto',
 display: 'flex',
 justifyContent: 'space-around',
 background: 'rgba(21, 29, 51, 0.85)',
 borderRadius: '16px',
 padding: '8px 0',
 backdropFilter: 'blur(20px)',
 border: '1px solid rgba(99, 102, 241, 0.1)',
 }}
 >
 {navItems.map((item) => {
 const isActive =
 item.href === "/dashboard"
 ? pathname === "/dashboard"
 : pathname.startsWith(item.href);
 const Icon = item.icon;

 return (
 <Link
 key={item.href}
 href={item.href}
 style={getItemStyle(isActive)}
 aria-current={isActive ? "page" : undefined}
 aria-label={item.label}
 >
 <Icon size={20} strokeWidth={isActive ? 2.5 : 1.8} />
 <span style={{fontSize: '11px', fontWeight: '500'}}>{item.label}</span>
 {isActive && (
 <span style={{width: '4px', height: '4px', borderRadius: '50%', background: '#6366f1'}} />
 )}
 </Link>
 );
 })}
 </div>
 </nav>
 );
}
