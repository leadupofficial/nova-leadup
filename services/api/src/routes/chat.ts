/**
 * NOVA API — Session chat backed by `conversations` + `conversation_messages`.
 *
 * A "chat session" *is* a `conversations` row: the client-supplied `sessionId`
 * is used as the conversation id, so the same tables and cascade rules that back
 * `/conversations` also back this router. Nothing is stored in the auth
 * `sessions` table, which holds refresh tokens, not chat turns.
 *
 * Assistant replies are generated with `services/ai.js#chatCompletion` and use
 * the same graceful degradation as `/conversations/:id/messages`: if the
 * provider is unavailable the user's turn is still persisted and the response
 * carries `assistantMessage: null` plus a machine-readable `assistantError`
 * instead of a 5xx.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { conversations, conversationMessages } from '@nova/database';
import { eq, and, asc, desc } from 'drizzle-orm';
import { HttpError } from '../middleware/error-handler.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { logger } from '../utils/logger.js';
import { chatCompletion } from '../services/ai.js';
import {
	HISTORY_MESSAGE_LIMIT,
	NOVA_SYSTEM_PROMPT,
	toAssistantError,
	toChatMessages,
	type AssistantError,
} from '../services/assistant.js';

const router = Router();

type ConversationMessage = typeof conversationMessages.$inferSelect;

const MAX_CONTENT_CHARS = 10_000;

/**
 * Reject obvious injection payloads at the boundary. The messages are stored as
 * bound parameters (never string-concatenated into SQL), so this is
 * defence-in-depth against stored XSS and against feeding hostile text to the
 * model — not the primary injection defence. The checks are intentionally
 * narrow to avoid rejecting ordinary prose.
 */
const INJECTION_PATTERNS = [
	/<script[\s>/]/i,
	/<\/script/i,
	/javascript\s*:/i,
	/\b(drop|alter|truncate)\s+table\b/i,
	/\bunion\s+(all\s+)?select\b/i,
	/;\s*--/,
	/('\s*or\s*'?\d+'?\s*=\s*'?\d+)/i,
];

function containsInjectionPayload(text: string): boolean {
	return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

const ChatMessageSchema = z.object({
	sessionId: z.string().uuid(),
	content: z
		.string()
		.min(1)
		.max(MAX_CONTENT_CHARS)
		.refine((value) => !containsInjectionPayload(value), {
			message: 'Content contains a disallowed payload',
		}),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

const SessionIdSchema = z.object({ sessionId: z.string().uuid() });

function parseSessionId(raw: string): string {
	const parsed = SessionIdSchema.safeParse({ sessionId: raw });
	if (!parsed.success) {
		throw new HttpError(400, 'Invalid session ID format', 'INVALID_ID');
	}
	return parsed.data.sessionId;
}

/**
 * POST /message — persist the user turn (creating the session on first use),
 * generate and persist the assistant reply, and return both.
 */
router.post('/message', authenticate, validate(ChatMessageSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof ChatMessageSchema>;
		const db = getDb();
		const userId = req.user!.id;
		const sessionId = body.sessionId;
		const now = new Date();

		let [conversation] = await db.select().from(conversations)
			.where(and(eq(conversations.id, sessionId), eq(conversations.userId, userId)))
			.limit(1);

		if (!conversation) {
			// Distinguish "session does not exist" from "belongs to someone else"
			// without leaking the latter: a row owned by another user is a 404.
			const [foreign] = await db.select().from(conversations)
				.where(eq(conversations.id, sessionId))
				.limit(1);
			if (foreign) {
				throw new HttpError(404, 'Chat session not found', 'NOT_FOUND');
			}

			[conversation] = await db.insert(conversations).values({
				id: sessionId,
				userId,
				title: body.content.slice(0, 100),
				mode: 'text',
				metadata: body.metadata ?? {},
				createdAt: now,
				updatedAt: now,
			}).returning();

			logger.info({ sessionId, userId }, 'Chat session created');
		}

		const [userMessage]: ConversationMessage[] = await db.insert(conversationMessages).values({
			conversationId: sessionId,
			role: 'user',
			content: body.content,
			createdAt: now,
		}).returning();

		let assistantMessage: ConversationMessage | null = null;
		let assistantError: AssistantError | null = null;

		try {
			const history = await db
				.select({ role: conversationMessages.role, content: conversationMessages.content })
				.from(conversationMessages)
				.where(eq(conversationMessages.conversationId, sessionId))
				.orderBy(desc(conversationMessages.createdAt))
				.limit(HISTORY_MESSAGE_LIMIT);

			history.reverse();

			const completion = await chatCompletion(toChatMessages(history), {
				systemPrompt: NOVA_SYSTEM_PROMPT,
				maxTokens: 1024,
				temperature: 0.7,
			});

			[assistantMessage] = await db.insert(conversationMessages).values({
				conversationId: sessionId,
				role: 'assistant',
				content: completion.content,
				model: completion.model,
				tokenUsage: completion.usage,
				createdAt: new Date(),
			}).returning();

			await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, sessionId));

			logger.info({ sessionId, userId, model: completion.model }, 'Chat reply generated');
		} catch (aiErr) {
			assistantError = toAssistantError(aiErr);
			logger.warn({ err: aiErr, sessionId, code: assistantError.code }, 'Chat reply unavailable — user turn retained');
		}

		res.status(200).json({
			success: true,
			data: {
				sessionId,
				userMessage,
				assistantMessage,
				assistantError,
			},
		});
	} catch (err) { next(err); }
});

/** GET /history/:sessionId — stored turns for a session owned by the caller. */
router.get('/history/:sessionId', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const sessionId = parseSessionId(req.params.sessionId);
		const db = getDb();

		const [conversation] = await db.select().from(conversations)
			.where(and(eq(conversations.id, sessionId), eq(conversations.userId, req.user!.id)))
			.limit(1);

		// A session that has never been written to is not an error.
		if (!conversation) {
			res.status(200).json({ success: true, data: { sessionId, messages: [] } });
			return;
		}

		const messages = await db.select().from(conversationMessages)
			.where(eq(conversationMessages.conversationId, sessionId))
			.orderBy(asc(conversationMessages.createdAt));

		res.status(200).json({ success: true, data: { sessionId, messages } });
	} catch (err) { next(err); }
});

/** DELETE /history/:sessionId — delete the session; messages cascade with it. */
router.delete('/history/:sessionId', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const sessionId = parseSessionId(req.params.sessionId);
		const db = getDb();

		// Scoped by userId so a caller can never delete another user's session.
		// Idempotent: deleting an absent session still returns 204.
		await db.delete(conversations)
			.where(and(eq(conversations.id, sessionId), eq(conversations.userId, req.user!.id)));

		res.status(204).send();
	} catch (err) { next(err); }
});

export { router as chatRoutes };
