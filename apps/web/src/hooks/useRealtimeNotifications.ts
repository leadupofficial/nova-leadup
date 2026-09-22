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
	pollInterval?: number;
	limit?: number;
	enableRealtime?: boolean;
	token?: string;
	socketUrl?: string;
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
	enableRealtime = true,
	token,
	socketUrl,
}: UseNotificationsOptions = {}): UseNotificationsReturn {
	const [notifications, setNotifications] = useState<Notification[]>([]);
	const [unreadCount, setUnreadCount] = useState(0);
	const [isLoading, setIsLoading] = useState(true);
	const [isFetching, setIsFetching] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const mountedRef = useRef(true);

	const { connected, on, off, emit } = useSocket({
		token,
		url: socketUrl,
		autoConnect: enableRealtime && !!token,
	});

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

	const markAsRead = useCallback(
		async (id: string) => {
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
		},
		[],
	);

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

	const deleteNotification = useCallback(
		async (id: string) => {
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
		},
		[notifications],
	);

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

	useEffect(() => {
		if (!connected || !enableRealtime) return;

		const handleNewNotification = (notification: Notification) => {
			if (!mountedRef.current) return;
			setNotifications((prev) => {
				const exists = prev.some((n) => n.id === notification.id);
				if (exists) return prev;
				return [notification, ...prev];
			});
			setUnreadCount((prev) => prev + 1);
			setIsLoading(false);
		};

		const handleReadNotification = (data: { id: string }) => {
			if (!mountedRef.current) return;
			setNotifications((prev) =>
				prev.map((n) => (n.id === data.id ? { ...n, read: true } : n)),
			);
			setUnreadCount((prev) => Math.max(0, prev - 1));
		};

		const handleDeletedNotification = (data: { id: string }) => {
			if (!mountedRef.current) return;
			setNotifications((prev) => {
				const target = prev.find((n) => n.id === data.id);
				if (target && !target.read) {
					setUnreadCount((c) => Math.max(0, c - 1));
				}
				return prev.filter((n) => n.id !== data.id);
			});
		};

		const handleAllRead = () => {
			if (!mountedRef.current) return;
			setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
			setUnreadCount(0);
		};

		on('notification:new', handleNewNotification as (data: unknown) => void);
		on('notification:read', handleReadNotification as (data: unknown) => void);
		on('notification:deleted', handleDeletedNotification as (data: unknown) => void);
		on('notification:allRead', handleAllRead as (data: unknown) => void);

		return () => {
			off('notification:new', handleNewNotification as (data: unknown) => void);
			off('notification:read', handleReadNotification as (data: unknown) => void);
			off('notification:deleted', handleDeletedNotification as (data: unknown) => void);
			off('notification:allRead', handleAllRead as (data: unknown) => void);
		};
	}, [connected, enableRealtime, on, off]);

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
