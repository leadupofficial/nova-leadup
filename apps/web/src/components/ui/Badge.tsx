"use client";

import { type ReactNode, type HTMLAttributes } from "react";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
 variant?: "primary" | "secondary" | "accent" | "success" | "warning" | "danger" | "neutral";
 size?: "sm" | "md";
 children: ReactNode;
 dot?: boolean;
}

const variantStyles: Record<string, { bg: string; text: string; dot: string }> = {
 primary: { bg: "rgba(99,102,241,0.15)", text: "#6366f1", dot: "#6366f1" },
 secondary: { bg: "rgba(139,92,246,0.15)", text: "#8b5cf6", dot: "#8b5cf6" },
 accent: { bg: "rgba(34,211,238,0.15)", text: "#22d3ee", dot: "#22d3ee" },
 success: { bg: "rgba(16,185,129,0.15)", text: "#10b981", dot: "#10b981" },
 warning: { bg: "rgba(245,158,11,0.15)", text: "#f59e0b", dot: "#f59e0b" },
 danger: { bg: "rgba(239,68,68,0.15)", text: "#ef4444", dot: "#ef4444" },
 neutral: { bg: "rgba(255,255,255,0.1)", text: "#94a3b8", dot: "#94a3b8" },
};

const sizeStyles: Record<string, React.CSSProperties> = {
 sm: { fontSize: '12px', padding: '2px 8px' },
 md: { fontSize: '14px', padding: '4px 10px' },
};

export function Badge({
 variant = "primary",
 size = "md",
 children,
 dot = false,
 className = "",
 ...props
}: BadgeProps) {
 const v = variantStyles[variant]!;

 return (
 <span
 style={{
 display: 'inline-flex',
 alignItems: 'center',
 gap: '6px',
 borderRadius: '50%',
 fontWeight: '500',
 background: v.bg,
 color: v.text,
 ...sizeStyles[size],
 }}
 {...props}
 >
 {dot && <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: v.dot }} />}
 {children}
 </span>
 );
}
