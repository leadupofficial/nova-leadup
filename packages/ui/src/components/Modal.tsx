import React from 'react';

interface ModalProps {
 isOpen: boolean;
 onClose: () => void;
 title?: string;
 children: React.ReactNode;
}

export function Modal({ isOpen, onClose, title, children }: ModalProps) {
 if (!isOpen) return null;
 return (
 <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
 <div className="bg-nova-surface border border-nova-border rounded-xl p-6 max-w-md w-full mx-4" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
 {title && <h2 className="text-xl font-bold text-nova-text mb-4">{title}</h2>}
 {children}
 </div>
 </div>
 );
}
