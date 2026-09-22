/**
 * NOVA API — Session chat backed by `conversations` + `conversation_messages`.
 *
 * A "chat session" *is* a `conversations` row: the client-supplied `sessionId`
 * is used as the conversation id, so the same tables and cascade rules that back
 * `/conversations` also back this router. Nothing is stored in the auth
 * `sessions` table, which holds refresh tokens, not chat turns.
 *
 * Assistant replies are generated with the same grounded, tool-bearing loop as
 * `/conversations/:id/messages` and `/voice/chat` (`runAssistantToolLoop`) and
 * the same graceful degradation as `/conversations/:id/messages`: if the
 * provider is unavailable the user's turn is still persisted and the response
 * carries `assistantMessage: null` plus a machine-readable `assistantError`
 * instead of a 5xx.
 *
 * This route used to call `chatCompletion` directly with no `tools` and the
 * bare persona prompt. Asked to set a reminder it truthfully answered that it
 * could not, and pointed the user at Siri — NOVA denying a capability the
 * server beside it already had. The Flutter client does not use this route (it
 * posts to `/conversations/:id/messages`), but it is still mounted and still
 * exercised by `scripts/verify-privacy-gates.py`, so it is repaired rather than
 * removed.
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { conversations, conversationMessages } from '@nova/database';
import { eq, and, asc, desc } from 'drizzle-orm';
import { HttpError } from '../middleware/error-handler.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getPrivacyPreferences } from '../services/privacy-preferences.js';
import { logger } from '../utils/logger.js';
import { buildUserContext, composeSystemPrompt } from '../services/user-context.js';
import { ASSISTANT_TOOLS_PROMPT, runAssistantToolLoop } from '../services/assistant-tools.js';
import {
	HISTORY_MESSAGE_LIMIT,
	NOVA_SYSTEM_PROMPT,
	toAssistantError,
	toChatMessages,
	type AssistantError,
} from '../services/assistant.js';
// The shared output-token ceiling: a reasoning model bills its
// `reasoning_content` against this same budget, so the turn-producing
// routes must not each pick their own number (see `services/ai.ts`).
import { defaultMaxOutputTokens } from '../services/ai.js';

const router: ReturnType<typeof Router> = Router();

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

		// "Save conversations" in Profile → Privacy controls. With it off, the turn is
		// answered but never written. That is what the switch means and it is also its
		// cost: there is no stored history to read back, so the assistant loses
		// multi-turn context. `GET /history/:sessionId` already answers
		// `{ messages: [] }` for a session with no rows, so the client needs no special
		// case — it simply sees an empty thread next time.
		const prefs = await getPrivacyPreferences(db, userId);

		let [conversation] = await db.select().from(conversations)
			.where(and(eq(conversations.id, sessionId), eq(conversations.userId, userId)))
			.limit(1);

		if (!conversation) {
			// Distinguish "session does not exist" from "belongs to someone else"
			// without leaking the latter: a row owned by another user is a 404. This
			// check runs even when nothing will be stored, so another user's session id
			// cannot be used as anonymous scratch space.
			const [foreign] = await db.select().from(conversations)
				.where(eq(conversations.id, sessionId))
				.limit(1);
			if (foreign) {
				throw new HttpError(404, 'Chat session not found', 'NOT_FOUND');
			}

			if (prefs.saveConversations) {
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
		}

		// With persistence off, the user turn is an in-memory object. `id` is a real
		// UUID so the response shape is unchanged and the client can key a list row on
		// it; it simply resolves to nothing on the server.
		let userMessage: ConversationMessage;
		if (prefs.saveConversations) {
			[userMessage] = await db.insert(conversationMessages).values({
				conversationId: sessionId,
				role: 'user',
				content: body.content,
				createdAt: now,
			}).returning();
		} else {
			userMessage = {
				id: randomUUID(),
				conversationId: sessionId,
				role: 'user',
				content: body.content,
				createdAt: now,
			} as ConversationMessage;
		}

		let assistantMessage: ConversationMessage | null = null;
		let assistantError: AssistantError | null = null;

		try {
			// Only the stored thread is read. With "Save conversations" off there is
			// nothing to read, so the turn is answered without context — and the reply
			// says so is not the server's job here; the client shows the switch state.
			const history = prefs.saveConversations
				? await db
						.select({ role: conversationMessages.role, content: conversationMessages.content })
						.from(conversationMessages)
						.where(eq(conversationMessages.conversationId, sessionId))
						.orderBy(desc(conversationMessages.createdAt))
						.limit(HISTORY_MESSAGE_LIMIT)
				: [];

			history.reverse();

			// Ground the reply the same way `/voice/chat` and
			// `/conversations/:id/messages` do, and offer the same write tools.
			// Without them this route could only tell the user NOVA had no way to
			// set a reminder. The tools run as the *authenticated* user; the model
			// is given no way to name one.
			//
			// The user's own turn is passed so the memory block is ranked *against
			// what they just asked*. The ranking lives in `user-context.ts` but is
			// unreachable unless a caller supplies the turn, and a caller that
			// forgets leaves the feature as dead as the broken vector query it
			// replaced — which is the exact failure this change exists to end.
			const context = await buildUserContext(userId, {}, undefined, { userTurn: body.content });

			// Timed so the console can report AI latency; nothing recorded it before.
			const modelCallStartedAt = Date.now();
			const completion = await runAssistantToolLoop(userId, toChatMessages(history), {
				systemPrompt: composeSystemPrompt({
					basePrompt: NOVA_SYSTEM_PROMPT,
					context: context.text,
					capabilities: ASSISTANT_TOOLS_PROMPT,
				}),
				maxTokens: defaultMaxOutputTokens(),
				temperature: 0.7,
			});

			if (prefs.saveConversations) {
				[assistantMessage] = await db.insert(conversationMessages).values({
					conversationId: sessionId,
					role: 'assistant',
					content: completion.content,
					model: completion.model,
					tokenUsage: completion.usage,
					durationMs: Date.now() - modelCallStartedAt,
					createdAt: new Date(),
				}).returning();

				await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, sessionId));
			} else {
				assistantMessage = {
					id: randomUUID(),
					conversationId: sessionId,
					role: 'assistant',
					content: completion.content,
					model: completion.model,
					tokenUsage: completion.usage,
					createdAt: new Date(),
				} as ConversationMessage;
			}

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
