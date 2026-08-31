'use client';

import { type ReactNode, type HTMLAttributes } from 'react';
import { motion } from 'framer-motion';
import { cn } from '../../lib/utils';

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
 children?: ReactNode;
 padding?: 'none' | 'sm' | 'md' | 'lg';
 glow?: boolean;
 hoverable?: boolean;
}

const paddingStyles: Record<string, string> = {
 none: '',
 sm: 'p-3',
 md: 'p-4',
 lg: 'p-6',
};

export function GlassPanel({
 children,
 padding = 'md',
 glow = false,
 hoverable = false,
 className = '',
 ...props
}: GlassPanelProps) {
 return (
 <motion.div
 {...(hoverable ? { whileHover: { y: -2, scale: 1.005 } } : {})}
 transition={{ duration: 0.2, ease: 'easeOut' }}
 {...(props as any)}
 className={cn(
 'rounded-2xl',
 'bg-white/[0.03]',
 'backdrop-blur-xl',
 'border border-white/[0.08]',
 'shadow-lg shadow-black/20',
 'transition-all duration-200',
 glow && 'shadow-[0_0_30px_rgba(99,102,241,0.1)]',
 hoverable && 'hover:border-white/[0.15] hover:shadow-[0_8px_32px_rgba(0,0,0,0.3)]',
 paddingStyles[padding],
 className,
 )}
 style={{
 background: 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%)',
 }}
 >
 {children}
 </motion.div>
 );
}
