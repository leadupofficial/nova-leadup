import type { NotificationRecord, NotificationChannel } from './NotificationStore.js';
import { logger } from './utils/logger.js';

export interface NotificationMessage {
 userId: string;
 channel: NotificationChannel;
 category: string;
 title: string;
 body: string;
 payload?: Record<string, unknown>;
 dedupeKey?: string;
}

export interface NotificationGateway {
 isConnected(): boolean;
 emit(record: NotificationRecord): void;
 close(): void;
}

type Listener = (message: NotificationRecord) => void;

export class InMemoryNotificationGateway implements NotificationGateway {
 private listeners: Map<string, Set<Listener>> = new Map();

 isConnected(): boolean {
 return this.listeners.size > 0;
 }

 emit(record: NotificationRecord): void {
 const userListeners = this.listeners.get(record.userId);
 if (!userListeners || userListeners.size === 0) {
 logger.debug({ userId: record.userId, notificationId: record.id }, '[gateway] no online listeners for user');
 return;
 }

 const payload: NotificationRecord = { ...record };
 for (const listener of userListeners) {
 try {
 listener(payload);
 } catch (err) {
 logger.error({ err, userId: record.userId }, '[gateway] listener threw');
 }
 }
 }

 subscribe(userId: string, listener: Listener): () => void {
 let userListeners = this.listeners.get(userId);
 if (!userListeners) {
 userListeners = new Set();
 this.listeners.set(userId, userListeners);
 }
 userListeners.add(listener);
 logger.debug({ userId }, '[gateway] listener subscribed');

 return () => {
 userListeners!.delete(listener);
 if (userListeners!.size === 0) {
 this.listeners.delete(userId);
 }
 logger.debug({ userId }, '[gateway] listener unsubscribed');
 };
 }

 close(): void {
 this.listeners.clear();
 logger.info('[gateway] closed');
 }
}
