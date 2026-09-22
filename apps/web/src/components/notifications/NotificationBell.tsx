'use client';

import React from 'react';

interface NotificationBellProps {
 unreadCount: number;
 onClick: () => void;
 isOpen: boolean;
 disabled?: boolean;
 className?: string;
}

export function NotificationBell({
 unreadCount,
 onClick,
 isOpen,
 disabled = false,
 className = '',
}: NotificationBellProps) {
 const showBadge = unreadCount > 0;
 const badgeText = unreadCount > 99 ? '99+' : String(unreadCount);

 return (
 <button
 type="button"
 onClick={onClick}
 disabled={disabled}
 aria-label={`Notifications${showBadge ? `, ${unreadCount} unread` : ''}`}
 aria-expanded={isOpen}
 aria-haspopup="true"
 className={[
 'relative inline-flex items-center justify-center',
 'w-10 h-10 rounded-full',
 'transition-colors duration-150',
 'hover:bg-nova-surface-alt',
 'focus:outline-none focus-visible:ring-2 focus-visible:ring-nova-primary focus-visible:ring-offset-2',
 'disabled:opacity-50 disabled:cursor-not-allowed',
 'text-nova-text',
 className,
 ].join(' ')}
 >
 {/* Bell icon */}
 <svg
 xmlns="http://www.w3.org/2000/svg"
 viewBox="0 0 24 24"
 fill="none"
 stroke="currentColor"
 strokeWidth={2}
 strokeLinecap="round"
 strokeLinejoin="round"
 className="w-5 h-5"
 aria-hidden="true"
 >
 <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
 <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
 </svg>

 {/* Unread badge */}
 {showBadge && (
 <span
 aria-label={`${unreadCount} unread notifications`}
 className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-nova-primary text-white text-xs font-semibold leading-none ring-2 ring-nova-surface"
 >
 {badgeText}
 </span>
 )}
 </button>
 );
}
