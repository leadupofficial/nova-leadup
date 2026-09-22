import React from 'react';

interface ButtonProps {
 children: React.ReactNode;
 onClick?: () => void;
 variant?: 'primary' | 'secondary' | 'ghost';
 size?: 'sm' | 'md' | 'lg';
 disabled?: boolean;
}

export function Button({ children, onClick, variant = 'primary', size = 'md', disabled }: ButtonProps) {
 const variants = {
 primary: 'bg-nova-primary text-white hover:bg-nova-primary-dark',
 secondary: 'bg-nova-surface-alt text-nova-text hover:bg-nova-border',
 ghost: 'bg-transparent text-nova-text hover:bg-nova-surface-alt',
 };
 const sizes = { sm: 'px-3 py-1.5 text-sm', md: 'px-4 py-2 text-base', lg: 'px-6 py-3 text-lg' };
 return (
 <button
 onClick={onClick}
 disabled={disabled}
 className={`rounded-lg font-medium transition-colors ${variants[variant]} ${sizes[size]} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
 >
 {children}
 </button>
 );
}
