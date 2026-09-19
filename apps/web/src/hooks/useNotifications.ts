'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSocket } from './useSocket';

export interface Notification {
 id: string;
 userId: string;
 title: string;
 body: string;
 data?: Record<string, unknown>;
 app?: string;
 category?: string;
 priority: 'low' | 'normal' | 'high';
 read: boolean;
 createdAt: string;
}

export interface NotificationsResponse {
 notifications: Notification[];
 total: number;
 unreadCount: number;
 hasMore: boolean;
}

export interface UseNotificationsOptions {
 /** Poll interval in ms. Set to 0 to disable polling. Default: 30000 */
 pollInterval?: number;
 /** Limit per page. Default: 20 */
 limit?: number;
}

export interface UseNotificationsReturn {
 notifications: Notification[];
 unreadCount: number;
 isLoading: boolean;
 isFetching: boolean;
 error: string | null;
 markAsRead: (id: string) => Promise<void>;
 markAllAsRead: () => Promise<void>;
 deleteNotification: (id: string) => Promise<void>;
 refresh: () => Promise<void>;
}

const API_BASE = '/api/notifications';

async function api<T>(url: string, options?: RequestInit): Promise<T> {
 const res = await fetch(url, {
 ...options,
 headers: {
 'Content-Type': 'application/json',
 ...options?.headers,
 },
 credentials: 'include',
 });

 const json = await res.json();

 if (!res.ok || json.error) {
 throw new Error(json.error?.message ?? `Request failed (${res.status})`);
 }

 return json as T;
}

export function useNotifications({
 pollInterval = 30000,
 limit = 20,
}: UseNotificationsOptions = {}): UseNotificationsReturn {
 const socket = useSocket({ autoConnect: true });
 const [notifications, setNotifications] = useState<Notification[]>([]);
 const [unreadCount, setUnreadCount] = useState(0);
 const [isLoading, setIsLoading] = useState(true);
 const [isFetching, setIsFetching] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
 const mountedRef = useRef(true);
 const joinedRoomRef = useRef(false);

 const fetchNotifications = useCallback(async () => {
 if (!mountedRef.current) return;
 setIsFetching(true);
 setError(null);

 try {
 const params = new URLSearchParams({ limit: String(limit) });
 const data = await api<NotificationsResponse>(`${API_BASE}?${params}`);

 if (!mountedRef.current) return;
 setNotifications(data.notifications);
 setUnreadCount(data.unreadCount);
 } catch (err) {
 if (!mountedRef.current) return;
 setError(err instanceof Error ? err.message : 'Failed to load notifications');
 } finally {
 if (mountedRef.current) {
 setIsLoading(false);
 setIsFetching(false);
 }
 }
 }, [limit]);

 // Join the user's notification room when socket connects
 useEffect(() => {
 if (!socket || !socket.connected || joinedRoomRef.current) return;
 joinedRoomRef.current = true;
 socket.emit('client:join_user_room');
 }, [socket]);

 // Reset room join flag on disconnect so we re-join on reconnect
 useEffect(() => {
 if (!socket) return;

 const onDisconnect = () => {
 joinedRoomRef.current = false;
 };

 socket.on('disconnect', onDisconnect);
 return () => { socket.off('disconnect', onDisconnect); };
}, [socket]);

 // Listen for realtime notification events
 useEffect(() => {
 if (!socket) return;

 const onNew = (notification: Notification) => {
 setNotifications((prev) => {
 const exists = prev.some((n) => n.id === notification.id);
 if (exists) return prev;
 return [notification, ...prev];
 });
 setUnreadCount((prev) => prev + 1);
 };

 const onRead = (notification: Notification) => {
 setNotifications((prev) =>
 prev.map((n) => (n.id === notification.id ? { ...n, read: true } : n)),
 );
 setUnreadCount((prev) => Math.max(0, prev - 1));
 };

 const onAllRead = () => {
 setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
 setUnreadCount(0);
 };

 const onDeleted = (notification: Notification) => {
 setNotifications((prev) => prev.filter((n) => n.id !== notification.id));
 if (!notification.read) {
 setUnreadCount((prev) => Math.max(0, prev - 1));
 }
 };

 socket.on('notification:new', onNew as (data: unknown) => void);
 socket.on('notification:read', onRead as (data: unknown) => void);
 socket.on('notification:allRead', onAllRead as (data: unknown) => void);
 socket.on('notification:deleted', onDeleted as (data: unknown) => void);

 return () => {
 socket.off('notification:new', onNew as (data: unknown) => void);
 socket.off('notification:read', onRead as (data: unknown) => void);
 socket.off('notification:allRead', onAllRead as (data: unknown) => void);
 socket.off('notification:deleted', onDeleted as (data: unknown) => void);
 };
 }, [socket]);

 const markAsRead = useCallback(async (id: string) => {
 setNotifications((prev) =>
 prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
 );
 setUnreadCount((prev) => Math.max(0, prev - 1));

 try {
 await api(`${API_BASE}/${id}`, { method: 'PATCH' });
 } catch {
 setNotifications((prev) =>
 prev.map((n) => (n.id === id ? { ...n, read: false } : n)),
 );
 setUnreadCount((prev) => prev + 1);
 }
 }, []);

 const markAllAsRead = useCallback(async () => {
 setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
 const count = unreadCount;
 setUnreadCount(0);

 try {
 await api(`${API_BASE}/read-all`, { method: 'PATCH' });
 } catch {
 setUnreadCount(count);
 setNotifications((prev) => prev.map((n) => ({ ...n, read: false })));
 }
 }, [unreadCount]);

 const deleteNotification = useCallback(async (id: string) => {
 const target = notifications.find((n) => n.id === id);
 setNotifications((prev) => prev.filter((n) => n.id !== id));
 if (target && !target.read) {
 setUnreadCount((prev) => Math.max(0, prev - 1));
 }

 try {
 await api(`${API_BASE}/${id}`, { method: 'DELETE' });
 } catch {
 if (target) {
 setNotifications((prev) => {
 const exists = prev.some((n) => n.id === id);
 if (!exists) return [...prev, target];
 return prev;
 });
 if (target && !target.read) {
 setUnreadCount((prev) => prev + 1);
 }
 }
 }
 }, [notifications]);

 useEffect(() => {
 mountedRef.current = true;
 fetchNotifications();

 if (pollInterval > 0) {
 pollRef.current = setInterval(fetchNotifications, pollInterval);
 }

 return () => {
 mountedRef.current = false;
 if (pollRef.current) clearInterval(pollRef.current);
 };
 }, [fetchNotifications, pollInterval]);

 return {
 notifications,
 unreadCount,
 isLoading,
 isFetching,
 error,
 markAsRead,
 markAllAsRead,
 deleteNotification,
 refresh: fetchNotifications,
 };
}
