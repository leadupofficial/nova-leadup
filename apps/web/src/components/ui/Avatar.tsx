"use client";

import { type ReactNode, type HTMLAttributes } from "react";

interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
 size?: "sm" | "md" | "lg" | "xl";
 src?: string;
 fallback?: string;
 isOnline?: boolean;
}

const sizeStyles: Record<string, { container: React.CSSProperties; text: React.CSSProperties; dot: React.CSSProperties }> = {
 sm: { container: { width: '32px', height: '32px' }, text: { fontSize: '14px' }, dot: { width: '8px', height: '8px' } },
 md: { container: { width: '40px', height: '40px' }, text: { fontSize: '16px' }, dot: { width: '10px', height: '10px' } },
 lg: { container: { width: '56px', height: '56px' }, text: { fontSize: '18px' }, dot: { width: '12px', height: '12px' } },
 xl: { container: { width: '80px', height: '80px' }, text: { fontSize: '24px' }, dot: { width: '16px', height: '16px' } },
};

export function Avatar({
 size = "md",
 src,
 fallback = "N",
 isOnline = false,
 className = "",
 children,
 ...props
}: AvatarProps) {
 const s = sizeStyles[size]!;

 if (src) {
 return (
 <div
 style={{
 position: 'relative',
 display: 'inline-flex',
 flexShrink: 0,
 ...s.container,
 }}
 className={className}
 {...props}
 >
 <img
 src={src}
 alt=""
 style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover', border: '2px solid rgba(99,102,241,0.3)' }}
 />
 {isOnline && (
 <span
 style={{
 position: 'absolute',
 bottom: '0',
 right: '0',
 ...s.dot,
 borderRadius: '50%',
 background: '#10b981',
 border: '2px solid #0b1020',
 }}
 />
 )}
 </div>
 );
 }

 return (
 <div
 style={{
 position: 'relative',
 display: 'inline-flex',
 flexShrink: 0,
 alignItems: 'center',
 justifyContent: 'center',
 borderRadius: '50%',
 background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
 ...s.container,
 ...s.text,
 fontWeight: 'bold',
 color: '#ffffff',
 }}
 className={className}
 {...props}
 >
 {fallback}
 {isOnline && (
 <span
 style={{
 position: 'absolute',
 bottom: '0',
 right: '0',
 ...s.dot,
 borderRadius: '50%',
 background: '#10b981',
 border: '2px solid #0b1020',
 }}
 />
 )}
 </div>
 );
}
