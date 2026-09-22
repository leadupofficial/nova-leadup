import React from 'react';

interface AvatarProps {
 src?: string;
 alt?: string;
 size?: 'sm' | 'md' | 'lg';
 emotion?: string;
}

export function Avatar({ src, alt = 'User', size = 'md', emotion }: AvatarProps) {
 const sizeClasses = { sm: 'w-8 h-8', md: 'w-12 h-12', lg: 'w-16 h-16' };
 return (
 <div className={`${sizeClasses[size]} rounded-full bg-nova-primary flex items-center justify-center text-nova-text font-semibold`}>
 {alt.charAt(0).toUpperCase()}
 </div>
 );
}
