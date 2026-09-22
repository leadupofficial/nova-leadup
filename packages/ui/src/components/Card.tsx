import React from 'react';

interface CardProps {
 children: React.ReactNode;
 className?: string;
 onClick?: () => void;
}

export function Card({ children, className = '', onClick }: CardProps) {
 return (
 <div
 onClick={onClick}
 className={`bg-nova-surface border border-nova-border rounded-xl p-4 ${onClick ? 'cursor-pointer hover:border-nova-border-light transition-colors' : ''} ${className}`}
 >
 {children}
 </div>
 );
}
