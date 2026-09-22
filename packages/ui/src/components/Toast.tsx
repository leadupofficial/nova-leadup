import React, { useEffect } from 'react';

interface ToastProps {
 message: string;
 type?: 'info' | 'success' | 'error' | 'warning';
 isVisible: boolean;
 onClose: () => void;
 duration?: number;
}

export function Toast({ message, type = 'info', isVisible, onClose, duration = 3000 }: ToastProps) {
 useEffect(() => {
 if (isVisible) {
 const timer = setTimeout(onClose, duration);
 return () => clearTimeout(timer);
 }
 }, [isVisible, duration, onClose]);

 if (!isVisible) return null;

 const colors = {
 info: 'bg-nova-primary',
 success: 'bg-nova-success',
 error: 'bg-nova-error',
 warning: 'bg-nova-warning',
 };

 return (
 <div className={`fixed top-4 right-4 z-50 ${colors[type]} text-white px-6 py-3 rounded-lg shadow-lg animate-slide-in`}>
 {message}
 </div>
 );
}
