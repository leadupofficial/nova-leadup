import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { NotificationGateway, NotificationMessage } from './NotificationGateway.js';
import { InMemoryNotificationStore, type NotificationStore } from './NotificationStore.js';
import { logger } from './utils/logger.js';

// ─── Validation schemas ───────────────────────────────────────────────────────

const NotificationMessageSchema = z.object({
 userId: z.string().uuid(),
 channel: z.enum(['in_app', 'email', 'sms', 'push']),
 category: z.string().min(1).max(64),
 title: z.string().min(1).max(256),
 body: z.string().min(1).max,
 payload: z.record(z.string(), z.unknown()).optional(),
 dedupeKey: z.string().optional(),
});

const ListQuerySchema = z.object({
 cursor: z.string().uuid().optional(),
 limit: z.coerce.number().int().positive().max(100).default(20),
 unreadOnly: z.coerce.boolean().default(false),
});

// ─── Service ──────────────────────────────────────────────────────────────────

export class NotificationService {
 private gateway: NotificationGateway;
 private store: NotificationStore;
 private httpRouter: Router;

 constructor(gateway: NotificationGateway, store?: NotificationStore) {
 this.gateway = gateway;
 this.store = store ?? new InMemoryNotificationStore();
 this.httpRouter = this.buildRouter();
 logger.info('[notifications] NotificationService initialized');
 }

 // ─── Public API ────────────────────────────────────────────────────────────

 async publish(message: NotificationMessage): Promise<{ id: string; status: 'queued' | 'deduplicated' }> {
 const parsed = NotificationMessageSchema.parse(message);

 if (parsed.dedupeKey) {
 const existing = this.store.findByDedupeKey(parsed.dedupeKey);
 if (existing) {
 logger.debug({ dedupeKey: parsed.dedupeKey, existingId: existing.id }, '[notifications] duplicate suppressed');
 return { id: existing.id, status: 'deduplicated' };
 }
 }

 const record = this.store.create({
 userId: parsed.userId,
 channel: parsed.channel,
 category: parsed.category,
 title: parsed.title,
 body: parsed.body,
 payload: parsed.payload ?? {},
 dedupeKey: parsed.dedupeKey,
 });

 try {
 this.gateway.emit(record);
 logger.info({ notificationId: record.id, userId: record.userId, channel: record.channel }, '[notifications] published');
 } catch (err) {
 logger.error({ err, notificationId: record.id }, '[notifications] gateway emit failed');
 }

 return { id: record.id, status: 'queued' };
 }

 async listForUser(userId: string, query: { cursor?: string; limit?: number; unreadOnly?: boolean }): Promise<{ items: NotificationRecord[]; nextCursor?: string }> {
 const parsed = ListQuerySchema.parse(query);
 const items = this.store.listByUser(userId, {
 limit: parsed.limit + 1,
 cursor: parsed.cursor,
 unreadOnly: parsed.unreadOnly,
 });

 const hasMore = items.length > parsed.limit;
 const resultItems = hasMore ? items.slice(0, parsed.limit) : items;
 const nextCursor = hasMore ? resultItems[resultItems.length - 1]?.id : undefined;

 return { items: resultItems, nextCursor };
 }

 async markAsRead(notificationId: string, userId: string): Promise<boolean> {
 const record = this.store.getById(notificationId);
 if (!record || record.userId !== userId) return false;
 this.store.markRead(notificationId);
 logger.debug({ notificationId, userId }, '[notifications] marked read');
 return true;
 }

 async markAllAsRead(userId: string): Promise<number> {
 const count = this.store.markAllReadForUser(userId);
 logger.debug({ userId, count }, '[notifications] marked all read');
 return count;
 }

 async delete(notificationId: string, userId: string): Promise<boolean> {
 const record = this.store.getById(notificationId);
 if (!record || record.userId !== userId) return false;
 this.store.delete(notificationId);
 logger.debug({ notificationId, userId }, '[notifications] deleted');
 return true;
 }

 getUnreadCount(userId: string): number {
 return this.store.countUnread(userId);
 }

 // ─── Health ────────────────────────────────────────────────────────────────

 getHealth(): { status: string; store: string; gateway: string; queueDepth: number } {
 return {
 status: 'ok',
 store: 'connected',
 gateway: this.gateway.isConnected() ? 'connected' : 'disconnected',
 queueDepth: this.store.countPending(),
 };
 }

 // ─── Express routes ────────────────────────────────────────────────────────

 getRouter(): Router {
 return this.httpRouter;
 }

 private buildRouter(): Router {
 const router = Router();

 router.get('/health', (_req: Request, res: Response) => {
 res.json(this.getHealth());
 });

 router.get('/notifications', async (req: Request, res: Response, next: (err: unknown) => void) => {
 try {
 const userId = (req as any).user?.id as string | undefined;
 if (!userId) return res.status(401).json({ error: 'unauthenticated' });
 const result = await this.listForUser(userId, {
 cursor: req.query.cursor as string | undefined,
 limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
 unreadOnly: req.query.unreadOnly === 'true',
 });
 res.json(result);
 } catch (err) {
 next(err);
 }
 });

 router.post('/notifications', async (req: Request, res: Response, next: (err: unknown) => void) => {
 try {
 const result = await this.publish(req.body);
 res.status(201).json(result);
 } catch (err) {
 if (err instanceof z.ZodError) return res.status(400).json({ error: 'validation_error', details: err.errors });
 next(err);
 }
 });

 router.patch('/notifications/:id/read', async (req: Request, res: Response, next: (err: unknown) => void) => {
 try {
 const userId = (req as any).user?.id as string | undefined;
 if (!userId) return res.status(401).json({ error: 'unauthenticated' });
 const ok = await this.markAsRead(req.params.id, userId);
 if (!ok) return res.status(404).json({ error: 'not_found' });
 res.json({ ok: true });
 } catch (err) {
 next(err);
 }
 });

 router.post('/notifications/read-all', async (req: Request, res: Response, next: (err: unknown) => void) => {
 try {
 const userId = (req as any).user?.id as string | undefined;
 if (!userId) return res.status(401).json({ error: 'unauthenticated' });
 const count = await this.markAllAsRead(userId);
 res.json({ count });
 } catch (err) {
 next(err);
 }
 });

 router.delete('/notifications/:id', async (req: Request, res: Response, next: (err: unknown) => void) => {
 try {
 const userId = (req as any).user?.id as string | undefined;
 if (!userId) return res.status(401).json({ error: 'unauthenticated' });
 const ok = await this.delete(req.params.id, userId);
 if (!ok) return res.status(404).json({ error: 'not_found' });
 res.json({ ok: true });
 } catch (err) {
 next(err);
 }
 });

 router.get('/notifications/unread-count', async (req: Request, res: Response, next: (err: unknown) => void) => {
 try {
 const userId = (req as any).user?.id as string | undefined;
 if (!userId) return res.status(401).json({ error: 'unauthenticated' });
 const count = this.getUnreadCount(userId);
 res.json({ count });
 } catch (err) {
 next(err);
 }
 });

 return router;
 }
}

// Re-export store types
export type { NotificationRecord, NotificationStore } from './NotificationStore.js';
export { InMemoryNotificationStore } from './NotificationStore.js';