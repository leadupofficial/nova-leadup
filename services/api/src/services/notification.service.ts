import { getDb } from '../db/connection.js';
import { notifications } from '@nova/database';
import { eq, desc, and, sql } from 'drizzle-orm';
import type { Server as SocketIOServer } from 'socket.io';

const db = getDb();

type NotificationRow = typeof notifications.$inferSelect;

export interface CreateNotificationInput {
	userId: string;
	title: string;
	body?: string;
	type?: string;
	category?: string;
	actionUrl?: string | null;
	metadata?: Record<string, unknown> | null;
}

export interface NotificationPagination {
	page: number;
	pageSize: number;
	total: number;
	totalPages: number;
}

export interface NotificationListResult {
	success: boolean;
	data: NotificationRow[];
	pagination: NotificationPagination;
}

export interface UnreadCountResult {
	success: boolean;
	data: { count: number };
}

export class NotificationService {
	private io: SocketIOServer | null = null;

	setSocketServer(io: SocketIOServer) {
		this.io = io;
	}

	async create(input: CreateNotificationInput): Promise<NotificationRow> {
		const row = await db
			.insert(notifications)
			.values({
				userId: input.userId,
				title: input.title,
				body: input.body ?? null,
				type: input.type ?? 'info',
				payload: {
					category: input.category ?? null,
					actionUrl: input.actionUrl ?? null,
					metadata: input.metadata ?? null,
				},
				read: false,
			})
			.returning();

		const notification = row[0];
		if (!notification) {
			throw new Error('Failed to create notification');
		}

		this.emitToUser(input.userId, 'notification:new', notification);

		return notification;
	}

	async markAsRead(notificationId: string, userId: string): Promise<NotificationRow | null> {
		const row = await db
			.update(notifications)
			.set({ read: true, readAt: new Date() })
			.where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
			.returning();

		const updated = row[0];
		if (updated) {
			this.emitToUser(userId, 'notification:read', { id: notificationId });
		}

		return updated ?? null;
	}

	async markAllAsRead(userId: string): Promise<{ count: number }> {
		const result = await db
			.update(notifications)
			.set({ read: true, readAt: new Date() })
			.where(and(eq(notifications.userId, userId), eq(notifications.read, false)))
			.returning({ id: notifications.id });

		const updatedCount = result.length;
		this.emitToUser(userId, 'notification:allRead', { count: updatedCount });

		return { count: updatedCount };
	}

	async delete(notificationId: string, userId: string): Promise<boolean> {
		const row = await db
			.delete(notifications)
			.where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
			.returning({ id: notifications.id });

		const deleted = row[0];
		if (deleted) {
			this.emitToUser(userId, 'notification:deleted', { id: notificationId });
			return true;
		}

		return false;
	}

	async getUserNotifications(
		userId: string,
		options: { page?: number; pageSize?: number; unreadOnly?: boolean; category?: string } = {},
	): Promise<NotificationListResult> {
		const page = Math.max(1, options.page ?? 1);
		const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
		const offset = (page - 1) * pageSize;

		const conditions = [eq(notifications.userId, userId)];
		if (options.unreadOnly) {
			conditions.push(eq(notifications.read, false));
		}

		const whereClause = conditions.length > 1 ? and(...conditions) : conditions[0];

		const items = await db
			.select()
			.from(notifications)
			.where(whereClause)
			.orderBy(desc(notifications.occurredAt))
			.limit(pageSize)
			.offset(offset);

		const totalRows = await db
			.select({ total: sql<number>`count(*)::int` })
			.from(notifications)
			.where(whereClause);
		const total = Number(totalRows[0]?.total ?? 0);

		return {
			success: true,
			data: items,
			pagination: {
				page,
				pageSize,
				total,
				totalPages: Math.ceil(total / pageSize) || 1,
			},
		};
	}

	async getUnreadCount(userId: string): Promise<UnreadCountResult> {
		const result = await db
			.select({ count: sql<number>`count(*)::int` })
			.from(notifications)
			.where(and(eq(notifications.userId, userId), eq(notifications.read, false)));

		const count = Number(result[0]?.count ?? 0);
		return { success: true, data: { count } };
	}

	private emitToUser(userId: string, event: string, payload: unknown) {
		if (!this.io) return;
		this.io.to(`user:${userId}`).emit(event, payload);
	}
}

export const notificationService = new NotificationService();
