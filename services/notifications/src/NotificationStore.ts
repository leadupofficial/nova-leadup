import { logger } from './utils/logger.js';

export type NotificationChannel = 'in_app' | 'email' | 'sms' | 'push';

export interface NotificationRecord {
 id: string;
 userId: string;
 channel: NotificationChannel;
 category: string;
 title: string;
 body: string;
 payload: Record<string, unknown>;
 dedupeKey?: string;
 read: boolean;
 createdAt: Date;
 updatedAt: Date;
}

export interface NotificationStore {
 create(input: Omit<NotificationRecord, 'id' | 'read' | 'createdAt' | 'updatedAt'>): NotificationRecord;
 getById(id: string): NotificationRecord | undefined;
 listByUser(userId: string, opts?: { limit?: number; cursor?: string; unreadOnly?: boolean }): NotificationRecord[];
 delete(id: string): void;
 markRead(id: string): void;
 markAllReadForUser(userId: string): number;
 countUnread(userId: string): number;
 findByDedupeKey(dedupeKey: string): NotificationRecord | undefined;
 countPending(): number;
}

export class InMemoryNotificationStore implements NotificationStore {
 private records: Map<string, NotificationRecord> = new Map();
 private byUserIndex: Map<string, Set<string>> = new Map();
 private pendingCount = 0;

 create(input: Omit<NotificationRecord, 'id' | 'read' | 'createdAt' | 'updatedAt'>): NotificationRecord {
 const now = new Date();
 const record: NotificationRecord = {
 id: `notif-${now.getTime()}-${Math.random().toString(36).slice(2, 9)}`,
 read: false,
 createdAt: now,
 updatedAt: now,
 ...input,
 };

 this.records.set(record.id, record);
 let userIndex = this.byUserIndex.get(record.userId);
 if (!userIndex) {
 userIndex = new Set();
 this.byUserIndex.set(record.userId, userIndex);
 }
 userIndex.add(record.id);
 this.pendingCount++;
 return record;
 }

 getById(id: string): NotificationRecord | undefined {
 return this.records.get(id);
 }

 listByUser(userId: string, opts?: { limit?: number; cursor?: string; unreadOnly?: boolean }): NotificationRecord[] {
 const userIds = this.byUserIndex.get(userId);
 if (!userIds || userIds.size === 0) return [];

 let items = Array.from(userIds)
 .map((id) => this.records.get(id)!)
 .filter((r): r is NotificationRecord => !!r)
 .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

 if (opts?.unreadOnly) {
 items = items.filter((r) => !r.read);
 }

 if (opts?.cursor) {
 const idx = items.findIndex((r) => r.id === opts.cursor);
 items = idx >= 0 ? items.slice(idx + 1) : items;
 }

 if (opts?.limit) {
 items = items.slice(0, opts.limit);
 }

 return items;
 }

 delete(id: string): void {
 const record = this.records.get(id);
 if (!record) return;
 this.records.delete(id);
 const userIndex = this.byUserIndex.get(record.userId);
 if (userIndex) {
 userIndex.delete(id);
 }
 this.pendingCount = Math.max(0, this.pendingCount - 1);
 }

 markRead(id: string): void {
 const record = this.records.get(id);
 if (!record || record.read) return;
 record.read = true;
 record.updatedAt = new Date();
 this.pendingCount = Math.max(0, this.pendingCount - 1);
 }

 markAllReadForUser(userId: string): number {
 const userIds = this.byUserIndex.get(userId);
 if (!userIds) return 0;
 let count = 0;
 for (const id of userIds) {
 const record = this.records.get(id);
 if (record && !record.read) {
 record.read = true;
 record.updatedAt = new Date();
 count++;
 }
 }
 this.pendingCount = Math.max(0, this.pendingCount - count);
 return count;
 }

 countUnread(userId: string): number {
 const userIds = this.byUserIndex.get(userId);
 if (!userIds) return 0;
 return Array.from(userIds).filter((id) => {
 const r = this.records.get(id);
 return r && !r.read;
 }).length;
 }

 findByDedupeKey(dedupeKey: string): NotificationRecord | undefined {
 return Array.from(this.records.values()).find((r) => r.dedupeKey === dedupeKey);
 }

 countPending(): number {
 return this.pendingCount;
 }
}
