/**
 * NOVA API — AI utility routes (summarize, embeddings, model catalogue, reporting).
 *
 * These are thin, authenticated wrappers over `services/ai.js`. The heavy
 * lifting (guardrails, PII redaction, timeouts, provider init) lives there.
 */
import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { logger } from '../utils/logger.js';
import { getDb } from '../db/connection.js';
import { auditLogs } from '@nova/database';
import {
	chatCompletion,
	defaultMaxOutputTokens,
	embeddingsAvailable,
	generateEmbedding,
	EMBEDDING_MODEL,
	type ChatMessage,
} from '../services/ai.js';
import { toAssistantError, assistantErrorStatus } from '../services/assistant.js';
import { AISummarizeSchema, AIEmbedSchema, AIReportSchema } from '../schemas/index.js';

const router: ReturnType<typeof Router> = Router();

/**
 * Chat models this API can actually reach, mirrored from the defaults in
 * `services/ai.js`:
 *   - `chatCompletion()`         → `options.model || 'claude-sonnet-4-20250514'`
 *   - `openAIChatCompletion()`   → `options.model || 'gpt-4o'`
 *
 * `services/ai.js` exports no model registry, so this list is a documented
 * mirror rather than a runtime derivation — keep it in sync when a provider
 * default changes. `available` *is* derived at runtime from the same env vars
 * `getAnthropic()`/`getOpenAI()` read.
 *
 * Embeddings are deliberately not listed as a chat model: `generateEmbedding()`
 * documents that the Anthropic SDK exposes no embeddings endpoint, so `/embed`
 * reports its own capability separately.
 */
const CHAT_MODELS = [
	{
		id: 'claude-sonnet-4-20250514',
		name: 'Claude Sonnet 4',
		provider: 'anthropic',
		contextWindow: 200_000,
		default: true,
		apiKeyEnv: 'ANTHROPIC_API_KEY',
		brocodeFallback: true,
	},
	{
		id: 'gpt-4o',
		name: 'GPT-4o',
		provider: 'openai',
		contextWindow: 128_000,
		default: false,
		apiKeyEnv: 'OPENAI_API_KEY',
		brocodeFallback: false,
	},
] as const;

function isModelAvailable(model: (typeof CHAT_MODELS)[number]): boolean {
	if (process.env[model.apiKeyEnv]) return true;
	return model.brocodeFallback ? Boolean(process.env.BROCODE_API_KEY) : false;
}

function providerHttpError(err: unknown, fallbackMessage: string): HttpError {
	const assistantError = toAssistantError(err);
	return new HttpError(
		assistantErrorStatus(assistantError.code),
		assistantError.message || fallbackMessage,
		assistantError.code,
	);
}

// POST /ai/summarize — summarize text with the chat model.
router.post('/summarize', authenticate, validate(AISummarizeSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof AISummarizeSchema>;

		const lengthInstruction = body.maxLength
			? ` Keep the summary under ${body.maxLength} characters.`
			: ' Keep the summary under 200 words.';

		const messages: ChatMessage[] = [{ role: 'user', content: body.text }];

		let completion: Awaited<ReturnType<typeof chatCompletion>>;
		try {
			completion = await chatCompletion(messages, {
				systemPrompt: `You summarize text for NOVA, a personal AI companion. Return only the summary, with no preamble.${lengthInstruction}`,
				maxTokens: defaultMaxOutputTokens(),
				temperature: 0.3,
			});
		} catch (aiErr) {
			throw providerHttpError(aiErr, 'Summarization failed');
		}

		let summary = completion.content.trim();
		// The instruction is advisory; enforce the caller's hard cap if the model overshoots.
		if (body.maxLength && summary.length > body.maxLength) {
			summary = summary.slice(0, body.maxLength);
		}

		logger.info(
			{ userId: req.user!.id, model: completion.model, originalLength: body.text.length, summaryLength: summary.length },
			'AI summarize',
		);

		res.status(200).json({
			success: true,
			summary,
			originalLength: body.text.length,
			summaryLength: summary.length,
			maxLength: body.maxLength ?? null,
			model: completion.model,
			usage: completion.usage,
		});
	} catch (err) { next(err); }
});

// POST /ai/embed — generate an embedding vector for text.
router.post('/embed', authenticate, validate(AIEmbedSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof AIEmbedSchema>;

		// `generateEmbedding()` reports availability explicitly. It used to return
		// `{ embedding: [], dimensions: 0 }` for every input, which this route could
		// only distinguish by inspecting the length — the same shape a real
		// zero-dimension success would have had.
		const result = await generateEmbedding(body.text);
		const available = result.available;

		logger.info({ userId: req.user!.id, dimensions: result.dimensions, available }, 'AI embed');

		res.status(200).json({
			success: true,
			embedding: result.embedding,
			dimensions: result.dimensions,
			available,
			// Only present when there is no vector, so a client can say *why*
			// instead of guessing.
			...(result.available ? {} : { reason: result.reason }),
		});
	} catch (err) { next(err); }
});

// GET /ai/models — models this service can select, with runtime availability.
router.get('/models', authenticate, (_req, res) => {
	const models = CHAT_MODELS.map((model) => ({
		id: model.id,
		name: model.name,
		provider: model.provider,
		capabilities: ['chat'] as const,
		contextWindow: model.contextWindow,
		default: model.default,
		available: isModelAvailable(model),
	}));

	res.status(200).json({
		success: true,
		models,
		embeddings: {
			// Derived, not hard-coded: this said `available: false` unconditionally,
			// which would become a lie the moment a key was configured.
			available: embeddingsAvailable(),
			// Mirrors the reason `generateEmbedding()` reports in the same condition.
			reason: embeddingsAvailable()
				? `Embeddings are served by ${EMBEDDING_MODEL}.`
				: 'No embeddings provider is configured; the Anthropic SDK exposes no embeddings endpoint.',
		},
	});
});

// POST /ai/reports — in-app reporting of an offensive or unsafe AI reply.
//
// Google Play's AI-Generated Content policy requires apps that generate content with
// AI to provide in-app reporting "without needing to exit the app", and App Review
// Guideline 1.2 asks for the same for apps that surface generated content. The report
// lands in `audit_logs` rather than a new table: it is an accountability record, not
// user content, and `audit_logs` already carries actor, target, outcome and a free-form
// `details` payload.
//
// The excerpt is capped at 500 characters by the schema. A report must not become a
// second copy of the conversation.
router.post('/reports', authenticate, validate(AIReportSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof AIReportSchema>;
		const db = getDb();

		await db.insert(auditLogs).values({
			userId: req.user!.id,
			actorType: 'user',
			actorId: req.user!.id,
			action: 'ai.response.reported',
			targetType: 'message',
			targetId: body.messageId,
			outcome: 'success',
			details: {
				reason: body.reason,
				excerpt: body.excerpt ?? null,
				reportedFrom: 'app',
			},
		});

		logger.info(
			{ userId: req.user!.id, messageId: body.messageId, reason: body.reason },
			'AI response reported',
		);

		res.status(201).json({ success: true, data: { recorded: true } });
	} catch (err) { next(err); }
});

export { router as aiRoutes };
