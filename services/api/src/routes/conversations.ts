/**
 * NOVA API — Conversations CRUD with real PostgreSQL via drizzle-orm.
 *
 * All list endpoints use cursor-based pagination (not offset-based).
 * All mutations validate input via Zod schemas.
 */
import { randomUUID } from 'node:crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { getPrivacyPreferences } from '../services/privacy-preferences.js';
import { conversations, conversationMessages, users, organizations } from '@nova/database';
import { eq, desc, and, sql, gt, lt, asc } from 'drizzle-orm';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { validate } from '../middleware/validate.js';
import { buildUserContext, composeSystemPrompt } from '../services/user-context.js';
import { ASSISTANT_TOOLS_PROMPT, runAssistantToolLoop } from '../services/assistant-tools.js';
import { getLanguageByCode } from '@nova/shared-types';
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
import {
	ConversationListQuerySchema,
	CreateConversationSchema,
	UpdateConversationSchema,
	SendMessageSchema,
	parseCursorPagination,

	type CursorPaginationInput,
} from '../schemas/index.js';
import { decodeKeysetCursor, encodeKeysetCursor, keysetWhere } from '../utils/pagination.js';

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
			// Keyset on `(updated_at, id)` — the column this list is ordered by. Filtering
			// on `id` while ordering by `updated_at` skipped and duplicated rows, because a
			// UUID ordering has nothing to do with a timestamp ordering.
			let cursor;
			try {
				cursor = decodeKeysetCursor(q.cursor);
			} catch {
				throw new HttpError(400, 'Invalid cursor', 'INVALID_CURSOR');
			}
			whereClauses.push(keysetWhere(conversations.updatedAt, cursorColumn, cursor, q.direction));
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
		const last = pageData[pageData.length - 1];
		const first = pageData[0];

		res.status(200).json({
			success: true,
			data: {
				conversations: pageData,
				pagination: {
					nextCursor: hasMore && last ? encodeKeysetCursor(last.updatedAt, last.id) : null,
					prevCursor: first ? encodeKeysetCursor(first.updatedAt, first.id) : null,
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

		// "Save conversations" in Profile → Privacy controls.
		//
		// This router — not `routes/chat.ts` — is the path the Flutter client actually
		// uses (`nova_api.dart` posts to `/conversations/:id/messages`). Gating only
		// `/chat/message` therefore enforced the switch on a route the app never calls,
		// and the promise was still false: with the switch off, a real session's content
		// was written here. An adversarial pass caught that; this is the fix.
		const prefs = await getPrivacyPreferences(db, userId);

		// With saving off the session is **ephemeral**, not refused. Rejecting the call
		// would make the feature unusable, which is not what "don't save my
		// conversations" means — the user wants to talk without being recorded. So a
		// container is returned with a real id that simply resolves to nothing on the
		// server, and every turn is answered without being written.
		if (!prefs.saveConversations) {
			res.status(201).json({
				success: true,
				data: {
					id: randomUUID(),
					userId,
					title: body.title ?? 'New Conversation',
					mode: body.mode,
					metadata: {},
					createdAt: now,
					updatedAt: now,
					ephemeral: true,
				},
			});
			return;
		}

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

		// With "Save conversations" off there is no stored thread to find, and a 404
		// would read to the client as "this session is broken" rather than "nothing was
		// kept". `routes/chat.ts` already answers an empty history for a session with no
		// rows; this matches it, so the two conversation APIs behave the same way under
		// the same switch.
		if (!conversation) {
			const prefs = await getPrivacyPreferences(db, req.user!.id);
			if (prefs.saveConversations) {
				throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
			}
			res.status(200).json({ success: true, data: { messages: [], ephemeral: true } });
			return;
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

		// "Save conversations" in Profile → Privacy controls. This router — not
		// `routes/chat.ts` — is the path the Flutter client actually uses
		// (`nova_api.dart` posts to `/conversations/:id/messages`), so gating only
		// `/chat/message` enforced the switch on a route the app never calls. An
		// adversarial pass caught that; this is the fix.
		const prefs = await getPrivacyPreferences(db, req.user!.id);

		const [existing] = await db.select({ id: conversations.id }).from(conversations)
			.where(and(eq(conversations.id, parsed.data.id), eq(conversations.userId, req.user!.id)))
			.limit(1);

		if (!existing && prefs.saveConversations) {
			throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
		}

		// Ephemeral turns still refuse another user's session id as scratch space: a row
		// that exists but is not this user's is a 404 either way.
		if (!existing && !prefs.saveConversations) {
			const [foreign] = await db
				.select({ id: conversations.id })
				.from(conversations)
				.where(eq(conversations.id, parsed.data.id))
				.limit(1);
			if (foreign) {
				throw new HttpError(404, 'Conversation not found', 'NOT_FOUND');
			}
		}

		let message: ConversationMessage;
		if (prefs.saveConversations) {
			[message] = await db.insert(conversationMessages).values({
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
		} else {
			// Answered but never written. The client still needs the turn to render it, so
			// it comes back with a generated id and the same shape as a stored one.
			message = {
				id: randomUUID(),
				conversationId: parsed.data.id,
				role: body.role,
				content: body.content,
				model: body.model ?? null,
				toolCalls: body.toolCalls ?? null,
				toolResults: body.toolResults ?? null,
				tokenUsage: null,
				createdAt: new Date(),
			} as ConversationMessage;
		}

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
				// tomorrow?" and "remind me" impossible. The message just sent is
				// passed as the turn so the memory block is ranked against it.
				const context = await buildUserContext(req.user!.id, {}, undefined, {
					userTurn: body.content,
				});
				const languageInfo = body.language
					? getLanguageByCode(body.language)
					: undefined;

				// The write tools (create_reminder / create_task / save_memory)
				// run against the *authenticated* user id. The model is offered
				// no way to name a user, and the loop is capped at
				// MAX_TOOL_ITERATIONS model calls.
				// Measure the model call so the console can report AI latency. Nothing recorded it
				// before, which is why "AI latency" was NOT AVAILABLE. The full tool loop is timed,
				// not one HTTP round trip: several model calls can happen, and the total is what the
				// user waits for.
				const modelCallStartedAt = Date.now();
				const completion = await runAssistantToolLoop(req.user!.id, toChatMessages(history), {
					systemPrompt: composeSystemPrompt({
						basePrompt: NOVA_SYSTEM_PROMPT,
						context: context.text,
						capabilities: ASSISTANT_TOOLS_PROMPT,
						language: body.language,
						languageName: languageInfo?.name,
						languageNative: languageInfo?.native,
					}),
					maxTokens: defaultMaxOutputTokens(),
					temperature: 0.7,
				});

				// Only the final assistant text is persisted — the app renders
				// `content`, and `tool_calls`/`tool_results` are left null.
				if (prefs.saveConversations) {
					[assistantMessage] = await db.insert(conversationMessages).values({
						conversationId: parsed.data.id,
						role: 'assistant',
						content: completion.content,
						model: completion.model,
						tokenUsage: completion.usage,
						durationMs: Date.now() - modelCallStartedAt,
						createdAt: new Date(),
					}).returning();

					await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, parsed.data.id));
				} else {
					// Answered but not kept. `assistantMessage` stays the in-memory object
					// the client renders for this turn.
					assistantMessage = {
						id: randomUUID(),
						conversationId: parsed.data.id,
						role: 'assistant',
						content: completion.content,
						model: completion.model,
						toolCalls: null,
						toolResults: null,
						tokenUsage: completion.usage ?? null,
						durationMs: Date.now() - modelCallStartedAt,
						createdAt: new Date(),
					} as ConversationMessage;
				}

				logger.info(
					{
						conversationId: parsed.data.id,
						userId: req.user!.id,
						model: completion.model,
						usage: completion.usage,
						iterations: completion.iterations,
						tools: completion.toolCalls.map((t) => `${t.name}:${t.ok ? 'ok' : 'failed'}`),
						capped: completion.capped,
						// True when the model's narration claimed a change the tool
						// results did not support and the reply was replaced.
						claimCorrected: completion.claimCorrected,
					},
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
