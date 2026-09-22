'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

const GATEWAY_URL = process.env.NEXT_PUBLIC_REALTIME_GATEWAY_URL ?? 'ws://localhost:3002';
const GATEWAY_PATH = '/ws/realtime';

export interface UseSocketOptions {
	autoConnect?: boolean;
	reconnectIntervalMs?: number;
	maxReconnectAttempts?: number;
	token?: string;
	url?: string;
}

export interface SocketLike {
	connected: boolean;
	on: (event: string, handler: (data: unknown) => void) => void;
	off: (event: string, handler: (data: unknown) => void) => void;
	emit: (event: string, data?: unknown) => void;
}

function buildUrl(token?: string, customUrl?: string): string {
	if (customUrl) {
		const sep = customUrl.includes('?') ? '&' : '?';
		const url = customUrl + (token ? `${sep}token=${encodeURIComponent(token)}` : '');
		return url;
	}
	const separator = GATEWAY_URL.endsWith('/') ? '' : '/';
	const path = GATEWAY_PATH.startsWith('/') ? GATEWAY_PATH : `/${GATEWAY_PATH}`;
	const url = `${GATEWAY_URL}${separator}${path.replace(/^\//, '')}`;
	if (token) {
		const sep = url.includes('?') ? '&' : '?';
		return `${url}${sep}token=${encodeURIComponent(token)}`;
	}
	return url;
}

export function useSocket({
	autoConnect = true,
	reconnectIntervalMs = 3000,
	maxReconnectAttempts = 10,
	token,
	url,
}: UseSocketOptions = {}): SocketLike {
	const [connected, setConnected] = useState(false);
	const wsRef = useRef<WebSocket | null>(null);
	const listenersRef = useRef<Map<string, Set<(data: unknown) => void>>>(new Map());
	const reconnectAttemptsRef = useRef(0);
	const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const tokenRef = useRef<string | undefined>(undefined);
	const shouldReconnectRef = useRef(true);

	const connect = useCallback((opts?: { token?: string; url?: string }) => {
		if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
			return;
		}

		const socketToken = opts?.token ?? tokenRef.current;
		const url = buildUrl(socketToken);
		const ws = new WebSocket(url);
		wsRef.current = ws;

		ws.onopen = () => {
			setConnected(true);
			reconnectAttemptsRef.current = 0;
		};

		ws.onmessage = (event: MessageEvent) => {
			try {
				const message = JSON.parse(event.data as string);
				const eventType = message.type;
				const handlers = listenersRef.current.get(eventType);
				if (handlers) {
					handlers.forEach((handler) => handler(message.data ?? message));
				}
			} catch {
				// ignore non-JSON messages
			}
		};

		ws.onclose = () => {
			setConnected(false);
			wsRef.current = null;

			if (shouldReconnectRef.current && reconnectAttemptsRef.current < maxReconnectAttempts) {
				reconnectAttemptsRef.current += 1;
				reconnectTimerRef.current = setTimeout(() => {
					connect(opts);
				}, reconnectIntervalMs);
			}
		};

		ws.onerror = () => {
			ws.close();
		};
	}, [reconnectIntervalMs, maxReconnectAttempts]);

	useEffect(() => {
		if (!autoConnect) return;

		// Get auth token from cookies or localStorage
		try {
			const cookies = document.cookie.split(';').reduce<Record<string, string>>((acc, cookie) => {
				const [key, value] = cookie.trim().split('=');
				if (key) acc[key] = decodeURIComponent(value);
				return acc;
			}, {});
			tokenRef.current = cookies['access_token'] ?? undefined;
		} catch {
			// ignore cookie read errors
		}

		shouldReconnectRef.current = true;
		const socketOpts = { token, url } as { token?: string; url?: string } | undefined;
		connect(socketOpts);

		return () => {
			shouldReconnectRef.current = false;
			if (reconnectTimerRef.current) {
				clearTimeout(reconnectTimerRef.current);
			}
			if (wsRef.current) {
				wsRef.current.close();
				wsRef.current = null;
			}
		};
	}, [autoConnect, connect]);

	const on = useCallback((event: string, handler: (data: unknown) => void) => {
		const handlers = listenersRef.current.get(event) ?? new Set();
		handlers.add(handler);
		listenersRef.current.set(event, handlers);
		return () => off(event, handler);
	}, []);

	const off = useCallback((event: string, handler: (data: unknown) => void) => {
		const handlers = listenersRef.current.get(event);
		if (handlers) {
			handlers.delete(handler);
			if (handlers.size === 0) {
				listenersRef.current.delete(event);
			}
		}
	}, []);

	const emit = useCallback((event: string, data?: unknown) => {
		if (wsRef.current?.readyState === WebSocket.OPEN) {
			wsRef.current.send(JSON.stringify({ type: event, data }));
		}
	}, []);

	return {
		connected,
		on,
		off,
		emit,
	};
}
