'use client';

import React, { useState, useRef, useEffect } from 'react';
import { Notification } from '../../hooks/useNotifications';

interface NotificationDropdownProps {
 notifications: Notification[];
 unreadCount: number;
 isLoading: boolean;
 isFetching: boolean;
 error: string | null;
 onMarkAsRead: (id: string) => void;
 onMarkAllAsRead: () => void;
 onDelete: (id: string) => void;
 /** Called when user wants to see all notifications. If omitted, the link is hidden. */
 onViewAll?: () => void;
 /** Maximum items to render before a "show more" affordance. Default: 8 */
 maxVisible?: number;
 className?: string;
}

function timeAgo(iso: string): string {
 const diff = Date.now() - new Date(iso).getTime();
 const seconds = Math.floor(diff / 1000);
 if (seconds < 60) return 'Just now';
 const minutes = Math.floor(seconds / 60);
 if (minutes < 60) return `${minutes}m ago`;
 const hours = Math.floor(minutes / 60);
 if (hours < 24) return `${hours}h ago`;
 const days = Math.floor(hours / 24);
 if (days < 7) return `${days}d ago`;
 return new Date(iso).toLocaleDateString();
}

function priorityDot(priority: Notification['priority']) {
 if (priority === 'high') {
 return <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-red-500" aria-label="High priority" />;
 }
 if (priority === 'low') {
 return <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-gray-400" aria-label="Low priority" />;
 }
 return <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-nova-primary" aria-label="Normal priority" />;
}

export function NotificationDropdown({
 notifications,
 unreadCount,
 isLoading,
 isFetching,
 error,
 onMarkAsRead,
 onMarkAllAsRead,
 onDelete,
 onViewAll,
 maxVisible = 8,
 className = '',
}: NotificationDropdownProps) {
 const [isVisible, setIsVisible] = useState(true);
 const [deletingId, setDeletingId] = useState<string | null>(null);
 const containerRef = useRef<HTMLDivElement>(null);

 // Close on Escape
 useEffect(() => {
 const handleKey = (e: KeyboardEvent) => {
 if (e.key === 'Escape') setIsVisible(false);
 };
 window.addEventListener('keydown', handleKey);
 return () => window.removeEventListener('keydown', handleKey);
 }, []);

 const visible = notifications.slice(0, maxVisible);
 const hasMore = notifications.length > maxVisible;

 const handleDelete = async (id: string, e: React.MouseEvent) => {
 e.stopPropagation();
 setDeletingId(id);
 try {
 onDelete(id);
 } finally {
 setDeletingId(null);
 }
 };

 if (!isVisible) return null;

 return (
 <div
 ref={containerRef}
 className={[
 'absolute right-0 top-full mt-2 z-50',
 'w-[360px] max-w-[calc(100vw-2rem)]',
 'bg-white rounded-xl shadow-xl border border-nova-border',
 'overflow-hidden',
 'animate-in fade-in slide-in-from-top-2 duration-200',
 className,
 ].join(' ')}
 role="menu"
 aria-label="Notifications"
 >
 {/* Header */}
 <div className="flex items-center justify-between px-4 py-3 border-b border-nova-border">
 <div className="flex items-center gap-2">
 <h2 className="text-sm font-semibold text-nova-text">Notifications</h2>
 {isFetching && (
 <span className="h-2 w-2 rounded-full bg-nova-primary animate-pulse" aria-label="Updating" />
 )}
 </div>
 <div className="flex items-center gap-2">
 {unreadCount > 0 && (
 <button
 type="button"
 onClick={onMarkAllAsRead}
 className="text-xs font-medium text-nova-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-nova-primary rounded"
 >
 Mark all read
 </button>
 )}
 <button
 type="button"
 onClick={() => setIsVisible(false)}
 className="rounded p-1 text-gray-400 hover:text-nova-text hover:bg-nova-surface-alt focus:outline-none focus-visible:ring-2 focus-visible:ring-nova-primary"
 aria-label="Close notifications"
 >
 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
 <path d="M18 6 6 18M6 6l12 12" />
 </svg>
 </button>
 </div>
 </div>

 {/* Loading state */}
 {isLoading && (
 <div className="px-4 py-8 text-center text-sm text-gray-500">
 <div className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-nova-primary border-t-transparent mr-2" />
 Loading notifications...
 </div>
 )}

 {/* Error state */}
 {!isLoading && error && (
 <div className="px-4 py-6 text-center text-sm text-red-600">
 {error}
 </div>
 )}

 {/* Empty state */}
 {!isLoading && !error && notifications.length === 0 && (
 <div className="px-4 py-8 text-center">
 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="w-10 h-10 mx-auto text-gray-300 mb-2" aria-hidden="true">
 <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
 <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
 </svg>
 <p className="text-sm text-gray-500">You are all caught up</p>
 </div>
 )}

 {/* Notification list */}
 {!isLoading && !error && notifications.length > 0 && (
 <ul className="max-h-[420px] overflow-y-auto divide-y divide-nova-border" role="list">
 {visible.map((notif) => {
 const isRead = notif.read;
 const isDeleting = deletingId === notif.id;

 return (
 <li
 key={notif.id}
 role="menuitem"
 aria-readonly={isRead}
 className={[
 'group flex gap-3 px-4 py-3',
 'transition-colors duration-100',
 'hover:bg-nova-surface-alt',
 isRead ? 'opacity-70' : 'bg-nova-surface/40',
 isDeleting && 'opacity-50 pointer-events-none',
 ].filter(Boolean).join(' ')}
 >
 {/* Priority indicator */}
 {priorityDot(notif.priority)}

 {/* Content */}
 <div className="flex-1 min-w-0" onClick={() => !isRead && onMarkAsRead(notif.id)}>
 <div className="flex items-start justify-between gap-2">
 <p className={['text-sm leading-snug', isRead ? 'text-nova-text' : 'text-nova-text font-medium'].join(' ')}>
 {notif.title}
 </p>
 <time dateTime={notif.createdAt} className="shrink-0 text-xs text-gray-400 mt-0.5">
 {timeAgo(notif.createdAt)}
 </time>
 </div>
 <p className="mt-0.5 text-xs text-gray-500 line-clamp-2">{notif.body}</p>
 {notif.app && (
 <span className="mt-1 inline-block text-[10px] font-medium uppercase tracking-wider text-nova-primary bg-nova-primary/10 rounded px-1.5 py-0.5">
 {notif.app}
 </span>
 )}
 </div>

 {/* Actions */}
 <div className="flex flex-col items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
 <button
 type="button"
 onClick={(e) => handleDelete(notif.id, e)}
 disabled={isDeleting}
 aria-label={`Delete notification: ${notif.title}`}
 className="rounded p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-nova-primary"
 title="Delete"
 >
 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5" aria-hidden="true">
 <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
 <path d="M10 11v6M14 11v6" />
 </svg>
 </button>
 </div>
 </li>
 );
 })}
 </ul>
 )}

 {/* View all footer */}
 {!isLoading && !error && onViewAll && notifications.length > 0 && (
 <div className="border-t border-nova-border px-4 py-2.5 bg-nova-surface-alt/50">
 <button
 type="button"
 onClick={onViewAll}
 className="w-full text-center text-xs font-medium text-nova-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-nova-primary rounded"
 >
 View all notifications
 </button>
 </div>
 )}
 </div>
 );
}
