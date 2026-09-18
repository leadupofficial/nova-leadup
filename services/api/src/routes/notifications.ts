/**
 * NOVA API — Notification routes.
 */
import { Router } from 'express';
import { z } from 'zod';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import { notificationService } from '../services/notification.service.js';

const router: ReturnType<typeof Router> = Router();

// ─── Schemas ─────────────────────────────────────────────────────────────────

const NotificationType = z.enum(['info', 'success', 'warning', 'error', 'system']);

const CreateNotificationSchema = z.object({
	userId: z.string().min(1),
	title: z.string().min(1).max(255),
	body: z.string().min(1).max(5000),
	type: NotificationType.default('info'),
	category: z.string().max(100).optional(),
	actionUrl: z.string().url().optional().nullable(),
	metadata: z.record(z.unknown()).optional().nullable(),
});

const ListQuerySchema = z.object({
	page: z.coerce.number().int().positive().default(1),
	pageSize: z.coerce.number().int().min(1).max(100).default(20),
	unreadOnly: z.coerce.boolean().default(false),
	category: z.string().max(100).optional(),
});

// ─── GET /notifications — list user notifications ─────────────────────────────

router.get('/', authenticate, validate(ListQuerySchema, 'query'), async (req: AuthenticatedRequest, res, next) => {
	try {
		const q = (req as any).validatedQuery as z.infer<typeof ListQuerySchema>;
		const userId = req.user!.id;

		const result = await notificationService.getUserNotifications(userId, {
			page: q.page,
			pageSize: q.pageSize,
			unreadOnly: q.unreadOnly,
			category: q.category,
		});

		res.status(200).json({
			success: true,
			data: result.data,
			pagination: result.pagination,
		});
	} catch (err) { next(err); }
});

// ─── POST /notifications — create notification (admin/system) ─────────────────

router.post('/', authenticate, validate(CreateNotificationSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof CreateNotificationSchema>;

		if (req.user!.role !== 'admin') {
			throw new HttpError(403, 'Only admins can create notifications for other users', 'FORBIDDEN');
		}

		const notification = await notificationService.create({
			userId: body.userId,
			title: body.title,
			body: body.body,
			type: body.type,
			category: body.category,
			actionUrl: body.actionUrl ?? null,
			metadata: body.metadata ?? null,
		});

		logger.info({ notificationId: notification.id, targetUserId: body.userId, adminId: req.user!.id }, 'Notification created');
		res.status(201).json({ success: true, data: notification });
	} catch (err) { next(err); }
});

// ─── PATCH /notifications/:id/read — mark as read ─────────────────────────────

router.patch('/:id/read', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const { id } = req.params;
		const userId = req.user!.id;

		const updated = await notificationService.markAsRead(id, userId);
		if (!updated) {
			throw new HttpError(404, 'Notification not found', 'NOT_FOUND');
		}

		res.status(200).json({ success: true, data: updated });
	} catch (err) { next(err); }
});

// ─── DELETE /notifications/:id — delete notification ─────────────────────────

router.delete('/:id', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const { id } = req.params;
		const userId = req.user!.id;

		const deleted = await notificationService.delete(id, userId);
		if (!deleted) {
			throw new HttpError(404, 'Notification not found', 'NOT_FOUND');
		}

		res.status(204).send();
	} catch (err) { next(err); }
});

// ─── GET /notifications/unread-count ─────────────────────────────────────────

router.get('/unread-count', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const userId = req.user!.id;

		const result = await notificationService.getUnreadCount(userId);
		res.status(200).json({ success: true, data: result.data });
	} catch (err) { next(err); }
});

export { router as notificationsRoutes };
