import React from 'react';

interface InputProps {
 value: string;
 onChange: (value: string) => void;
 placeholder?: string;
 type?: string;
 disabled?: boolean;
}

export function Input({ value, onChange, placeholder, type = 'text', disabled }: InputProps) {
 return (
 <input
 type={type}
 value={value}
 onChange={(e) => onChange(e.target.value)}
 placeholder={placeholder}
 disabled={disabled}
 className="w-full px-4 py-2 bg-nova-surface border border-nova-border rounded-lg text-nova-text placeholder-nova-text-dim focus:outline-none focus:border-nova-primary transition-colors disabled:opacity-50"
 />
 );
}
