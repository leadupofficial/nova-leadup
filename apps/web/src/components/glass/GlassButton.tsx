'use client';

import { type ReactNode, type ButtonHTMLAttributes } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn } from '../../lib/utils';
import { animations } from '../../lib/animations';

interface GlassButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
 variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
 size?: 'sm' | 'md' | 'lg';
 loading?: boolean;
 children: ReactNode;
}

const baseStyles =
 'inline-flex items-center justify-center gap-2 font-medium rounded-xl transition-all duration-200 cursor-pointer select-none';

const variantStyles = {
 primary: cn(
 'bg-gradient-to-r from-indigo-500 to-cyan-400',
 'text-white shadow-lg shadow-indigo-500/25',
 'hover:shadow-xl hover:shadow-indigo-500/30 hover:brightness-110',
 'active:scale-[0.97]',
 ),
 secondary: cn(
 'bg-white/[0.06] border border-white/[0.1]',
 'text-slate-200 hover:bg-white/[0.1] hover:border-white/[0.15]',
 'active:scale-[0.97]',
 ),
 ghost: cn(
 'bg-transparent border border-transparent',
 'text-slate-400 hover:text-white hover:bg-white/[0.06]',
 'active:scale-[0.97]',
 ),
 danger: cn(
 'bg-gradient-to-r from-red-500 to-red-600',
 'text-white shadow-lg shadow-red-500/25',
 'hover:shadow-xl hover:shadow-red-500/30 hover:brightness-110',
 'active:scale-[0.97]',
 ),
};

const sizeStyles = {
 sm: 'px-3 py-1.5 text-sm',
 md: 'px-4 py-2.5 text-sm',
 lg: 'px-6 py-3.5 text-base',
};

export function GlassButton({
 variant = 'primary',
 size = 'md',
 loading = false,
 children,
 className = '',
 disabled,
 ...props
}: GlassButtonProps) {
 return (
 <motion.button
 whileTap={{ scale: disabled || loading ? 1 : 0.97 }}
 className={cn(baseStyles, variantStyles[variant], sizeStyles[size], className)}
 disabled={disabled || loading}
 {...props}
 >
 {loading && (
 <motion.span
 animate={{ rotate: 360 }}
 transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
 className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full"
 />
 )}
 {children}
 </motion.button>
 );
}
