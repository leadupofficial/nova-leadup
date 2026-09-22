/**
 * NOVA API — Server-Sent Events stream for assistant replies.
 *
 * IMPORTANT — no true token streaming yet: `services/ai.js#chatCompletion` wraps
 * Anthropic's non-streaming `messages.create()` and exposes no streaming
 * variant (there is no `stream: true` path anywhere in that module). Rather than
 * pretend, this route buffers the full reply and emits it as a **single**
 * `chunk` event followed by `done`. The event contract is already
 * token-stream-shaped (ordered `chunk` events + terminal `done`), so when a
 * streaming provider is wired in, this route can emit many chunks without any
 * client change.
 *
 * Wire format (one JSON object per `data:` line):
 *   event: start  data: { sessionId, streaming: false }
 *   event: chunk  data: { sessionId, index, content }
 *   event: done   data: { sessionId, chunks, model, usage, streaming: false }
 *   event: error  data: { sessionId, code, message }   (before a terminal done)
 */
import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { logger } from '../utils/logger.js';
import { chatCompletion, defaultMaxOutputTokens } from '../services/ai.js';
import { NOVA_SYSTEM_PROMPT, toAssistantError } from '../services/assistant.js';

const router: ReturnType<typeof Router> = Router();

const MAX_MESSAGE_CHARS = 10_000;

const SessionIdSchema = z.object({ sessionId: z.string().uuid() });

const StreamBodySchema = z.object({
	message: z.string().min(1).max(MAX_MESSAGE_CHARS),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

function parseSessionId(raw: string): string {
	const parsed = SessionIdSchema.safeParse({ sessionId: raw });
	if (!parsed.success) {
		throw new HttpError(400, 'Invalid session ID format', 'INVALID_ID');
	}
	return parsed.data.sessionId;
}

/**
 * Open the SSE response and return an emitter that is a no-op once the client
 * has disconnected or the response has ended.
 */
function openSse(res: Response) {
	res.status(200);
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Cache-Control', 'no-cache, no-transform');
	res.setHeader('Connection', 'keep-alive');
	// Disable proxy buffering (nginx) so events reach the client immediately.
	res.setHeader('X-Accel-Buffering', 'no');
	res.flushHeaders?.();

	let closed = false;
	// Detect client disconnect on the *response*: `req.on('close')` also fires as
	// soon as a request body has been fully consumed, which would suppress every
	// event on a POST. `res.on('close')` fires only when the connection is gone.
	res.on('close', () => { closed = true; });

	return {
		emit(event: string, data: Record<string, unknown>): void {
			if (closed || res.writableEnded) return;
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		},
		isClosed(): boolean {
			return closed;
		},
	};
}

async function streamAssistantReply(
	req: AuthenticatedRequest,
	res: Response,
	sessionId: string,
	message: string,
): Promise<void> {
	const sse = openSse(res);

	sse.emit('start', { sessionId, streaming: false });

	try {
		const completion = await chatCompletion([{ role: 'user', content: message }], {
			systemPrompt: NOVA_SYSTEM_PROMPT,
			maxTokens: defaultMaxOutputTokens(),
			temperature: 0.7,
		});

		// chatCompletion is non-streaming: exactly one chunk carrying the whole reply.
		if (!sse.isClosed()) {
			sse.emit('chunk', { sessionId, index: 0, content: completion.content });
			sse.emit('done', {
				sessionId,
				chunks: 1,
				model: completion.model,
				usage: completion.usage,
				streaming: false,
			});
		}

		logger.info({ sessionId, userId: req.user!.id, model: completion.model }, 'Streamed assistant reply');
	} catch (err) {
		// Same graceful contract as the chat routes: report a machine-readable
		// error event instead of dropping the connection mid-stream.
		const assistantError = toAssistantError(err);
		logger.warn({ err, sessionId, code: assistantError.code }, 'Streaming completion failed');
		sse.emit('error', { sessionId, code: assistantError.code, message: assistantError.message });
		sse.emit('done', { sessionId, chunks: 0, streaming: false, error: assistantError.code });
	} finally {
		if (!res.writableEnded) res.end();
	}
}

// GET /streaming/chat/:sessionId?message=... — SSE stream (EventSource-friendly).
router.get('/chat/:sessionId', authenticate, async (req: AuthenticatedRequest, res, next) => {
	try {
		const sessionId = parseSessionId(req.params.sessionId);
		const raw = req.query.message ?? req.query.content;
		const message = typeof raw === 'string' ? raw : '';

		if (!message.trim()) {
			throw new HttpError(400, 'Query parameter "message" is required', 'VALIDATION_ERROR');
		}
		if (message.length > MAX_MESSAGE_CHARS) {
			throw new HttpError(400, `message must be at most ${MAX_MESSAGE_CHARS} characters`, 'VALIDATION_ERROR');
		}

		await streamAssistantReply(req, res, sessionId, message);
	} catch (err) { next(err); }
});

// POST /streaming/chat/:sessionId — SSE stream with the prompt in the body.
router.post('/chat/:sessionId', authenticate, validate(StreamBodySchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const sessionId = parseSessionId(req.params.sessionId);
		const body = (req as any).validatedBody as z.infer<typeof StreamBodySchema>;

		await streamAssistantReply(req, res, sessionId, body.message);
	} catch (err) { next(err); }
});

export { router as streamingRoutes };
