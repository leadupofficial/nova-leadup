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
import { chatCompletion } from '../services/ai.js';
import { buildUserContext, composeSystemPrompt } from '../services/user-context.js';
import { getLanguageByCode } from '@nova/shared-types';
import {
	HISTORY_MESSAGE_LIMIT,
	NOVA_SYSTEM_PROMPT,
	toAssistantError,
	toChatMessages,
	type AssistantError,
} from '../services/assistant.js';
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

/** Row shape returned by drizzle for `conversation_messages`. */
type ConversationMessage = typeof conversationMessages.$inferSelect;

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

		const [message]: ConversationMessage[] = await db.insert(conversationMessages).values({
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

		// Generate + persist the assistant reply for a *user* turn. An incoming
		// assistant turn (imported history, tool echo) is stored as-is and must not
		// trigger a second reply.
		let assistantMessage: ConversationMessage | null = null;
		let assistantError: AssistantError | null = null;

		if (message.role === 'user') {
			try {
				// Replay the tail of this conversation so the model has context. The
				// turn just persisted is already included; the helper bounds the
				// replay to HISTORY_MESSAGE_LIMIT turns and HISTORY_CHAR_BUDGET chars.
				const history = await db
					.select({ role: conversationMessages.role, content: conversationMessages.content })
					.from(conversationMessages)
					.where(eq(conversationMessages.conversationId, parsed.data.id))
					.orderBy(desc(conversationMessages.createdAt))
					.limit(HISTORY_MESSAGE_LIMIT);

				history.reverse();

				// Ground the reply in the user's own tasks, reminders and
				// memories. Without this the assistant truthfully answered that
				// it had no way to see them, which makes "what do I have
				// tomorrow?" and "remind me" impossible.
				const context = await buildUserContext(req.user!.id);
				const languageInfo = body.language
					? getLanguageByCode(body.language)
					: undefined;

				const completion = await chatCompletion(toChatMessages(history), {
					systemPrompt: composeSystemPrompt({
						basePrompt: NOVA_SYSTEM_PROMPT,
						context: context.text,
						language: body.language,
						languageName: languageInfo?.name,
						languageNative: languageInfo?.native,
					}),
					maxTokens: 1024,
					temperature: 0.7,
				});

				[assistantMessage] = await db.insert(conversationMessages).values({
					conversationId: parsed.data.id,
					role: 'assistant',
					content: completion.content,
					model: completion.model,
					tokenUsage: completion.usage,
					createdAt: new Date(),
				}).returning();

				await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, parsed.data.id));

				logger.info(
					{ conversationId: parsed.data.id, userId: req.user!.id, model: completion.model, usage: completion.usage },
					'Assistant reply generated',
				);
			} catch (aiErr) {
				// Graceful degradation: the user's turn is already stored, so report the
				// provider failure as data instead of a 5xx that would lose it.
				assistantError = toAssistantError(aiErr);
				logger.warn(
					{ err: aiErr, conversationId: parsed.data.id, code: assistantError.code },
					'Assistant reply unavailable — returning the stored user message',
				);
			}
		}

		res.status(201).json({
			success: true,
			data: {
				userMessage: message,
				assistantMessage,
				assistantError,
			},
		});
	} catch (err) { next(err); }
});

export { router as conversationsRoutes };
