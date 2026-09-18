/**
 * NOVA API — Conversations CRUD with real PostgreSQL via drizzle-orm.
 *
 * All list endpoints use cursor-based pagination (not offset-based).
 * All mutations validate input via Zod schemas.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { conversations, conversationMessages, users, organizations } from '@nova/database';
import { eq, desc, and, sql, gt, lt, asc } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import {
	ConversationListQuerySchema,
	CreateConversationSchema,
	UpdateConversationSchema,
	SendMessageSchema,
	parseCursorPagination,
	decodeCursor,
	encodeCursor,
	type CursorPaginationInput,
} from '../schemas/index.js';

const router: ReturnType<typeof Router> = Router();

// ─── /conversations ──────────────────────────────────────────────────────────

router.get('/', authenticate, validate(ConversationListQuerySchema, 'query'), async (req: AuthenticatedRequest, res, next) => {
	try {
		const q = parseCursorPagination(req) as CursorPaginationInput;
		const db = getDb();
		const userId = req.user!.id;
		const cursorColumn = conversations.id;

		const whereClauses = [eq(conversations.userId, userId)];

		// Add cursor condition for pagination
		if (q.cursor) {
			const decoded = decodeCursor(q.cursor);
			const cursorWhere = q.direction === 'backward'
				? lt(cursorColumn, decoded)
				: gt(cursorColumn, decoded);
			whereClauses.push(cursorWhere);
		}

		const where = and(...whereClauses);

		// Get total count (single query)
		const [countRow] = await db.select({ count: sql<number>`count(*)` })
			.from(conversations)
			.where(where);
		const total = Number(countRow?.count ?? 0);

		// Fetch page
		const orderBy = q.direction === 'backward' ? asc(conversations.updatedAt) : desc(conversations.updatedAt);
		const rows = await db.select().from(conversations)
			.where(where)
			.orderBy(orderBy)
			.limit(q.limit + 1); // +1 to detect hasMore

		const hasMore = rows.length > q.limit;
		const pageData = hasMore ? rows.slice(0, q.limit) : rows;
		const lastId = pageData[pageData.length - 1]?.id;
		const firstId = pageData[0]?.id;

		res.status(200).json({
			success: true,
			data: {
				conversations: pageData,
				pagination: {
					nextCursor: hasMore ? encodeCursor(lastId) : null,
					prevCursor: firstId ? encodeCursor(firstId) : null,
					hasMore,
					limit: q.limit,
					total,
				},
			},
		});
	} catch (err) { next(err); }
});

router.post('/', authenticate, validate(CreateConversationSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof CreateConversationSchema>;
		const db = getDb();
		const userId = req.user!.id;
		const now = new Date();

		const [conversation] = await db.insert(conversations).values({
			userId,
			title: body.title ?? 'New Conversation',
			mode: body.mode,
			metadata: {},
			createdAt: now,
			updatedAt: now,
		}).returning();

		logger.info({ conversationId: conversation.id, userId }, 'Conversation created');
		res.status(201).json({ success: true, data: conversation });
	} catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const { id } = req.params;
		const idSchema = z.object({ id: z.string().uuid() });
		const parsed = idSchema.safeParse({ id });
		if (!parsed.success) {
			throw new HttpError(400, 'Invalid conversation ID format', 'INVALID_ID');
		}

		const db = getDb();
		const [conversation] = await db.select().from(conversations)
			.where(and(eq(conversations.id, parsed.data.id), eq(conversations.userId, req.user!.id)))
			.limit(1);
		if (!conversation) {
			throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
		}
		res.status(200).json({ success: true, data: conversation });
	} catch (err) { next(err); }
});

router.patch('/:id', authenticate, validate(UpdateConversationSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const { id } = req.params;
		const idSchema = z.object({ id: z.string().uuid() });
		const parsed = idSchema.safeParse({ id });
		if (!parsed.success) {
			throw new HttpError(400, 'Invalid conversation ID format', 'INVALID_ID');
		}

		const body = (req as any).validatedBody as z.infer<typeof UpdateConversationSchema>;
		const db = getDb();

		const [existing] = await db.select().from(conversations)
			.where(and(eq(conversations.id, parsed.data.id), eq(conversations.userId, req.user!.id)))
			.limit(1);
		if (!existing) {
			throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
		}

		const [updated] = await db.update(conversations)
			.set({
				...(body.title !== undefined && { title: body.title }),
				...(body.mode !== undefined && { mode: body.mode }),
				updatedAt: new Date(),
			})
			.where(eq(conversations.id, parsed.data.id))
			.returning();

		res.status(200).json({ success: true, data: updated });
	} catch (err) { next(err); }
});

router.delete('/:id', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const { id } = req.params;
		const idSchema = z.object({ id: z.string().uuid() });
		const parsed = idSchema.safeParse({ id });
		if (!parsed.success) {
			throw new HttpError(400, 'Invalid conversation ID format', 'INVALID_ID');
		}

		const db = getDb();
		const [existing] = await db.select().from(conversations)
			.where(and(eq(conversations.id, parsed.data.id), eq(conversations.userId, req.user!.id)))
			.limit(1);
		if (!existing) {
			throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
		}

		await db.delete(conversations).where(eq(conversations.id, parsed.data.id));
		res.status(204).send();
	} catch (err) { next(err); }
});

// ─── Messages within a conversation ─────────────────────────────────────────

router.get('/:id/messages', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const { id } = req.params;
		const idSchema = z.object({ id: z.string().uuid() });
		const parsed = idSchema.safeParse({ id });
		if (!parsed.success) {
			throw new HttpError(400, 'Invalid conversation ID format', 'INVALID_ID');
		}

		const db = getDb();
		const [conversation] = await db.select().from(conversations)
			.where(and(eq(conversations.id, parsed.data.id), eq(conversations.userId, req.user!.id)))
			.limit(1);
		if (!conversation) {
			throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
		}

		const messages = await db.select().from(conversationMessages)
			.where(eq(conversationMessages.conversationId, parsed.data.id))
			.orderBy(asc(conversationMessages.createdAt));

		res.status(200).json({ success: true, data: { messages } });
	} catch (err) { next(err); }
});

router.post('/:id/messages', authenticate, validate(SendMessageSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const { id } = req.params;
		const idSchema = z.object({ id: z.string().uuid() });
		const parsed = idSchema.safeParse({ id });
		if (!parsed.success) {
			throw new HttpError(400, 'Invalid conversation ID format', 'INVALID_ID');
		}

		const body = (req as any).validatedBody as z.infer<typeof SendMessageSchema>;
		const db = getDb();

		const [conversation] = await db.select().from(conversations)
			.where(and(eq(conversations.id, parsed.data.id), eq(conversations.userId, req.user!.id)))
			.limit(1);
		if (!conversation) {
			throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
		}

		const [message] = await db.insert(conversationMessages).values({
			conversationId: parsed.data.id,
			role: body.role,
			content: body.content,
			model: body.model,
			toolCalls: body.toolCalls,
			toolResults: body.toolResults,
			createdAt: new Date(),
		}).returning();

		// Update conversation's updatedAt
		await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, parsed.data.id));

		res.status(201).json({ success: true, data: message });
	} catch (err) { next(err); }
});

export { router as conversationsRoutes };
