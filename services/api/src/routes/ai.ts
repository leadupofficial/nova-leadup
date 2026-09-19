/**
 * NOVA API — AI utility routes (summarize, embeddings, model catalogue).
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
import { chatCompletion, generateEmbedding, type ChatMessage } from '../services/ai.js';
import { toAssistantError } from '../services/assistant.js';
import { AISummarizeSchema, AIEmbedSchema } from '../schemas/index.js';

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
	const status = assistantError.code === 'AI_NOT_CONFIGURED' ? 503 : 502;
	return new HttpError(status, assistantError.message || fallbackMessage, assistantError.code);
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
				maxTokens: 1024,
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

		// NOTE: `generateEmbedding()` is itself a documented no-op today — it returns
		// `{ embedding: [], dimensions: 0 }` because the Anthropic SDK has no
		// embeddings endpoint and no other provider is wired into services/ai.js.
		// This route now calls the real function rather than fabricating a vector, and
		// reports `available: false` so clients can detect the gap.
		const result = await generateEmbedding(body.text);
		const available = result.dimensions > 0 && result.embedding.length > 0;

		logger.info({ userId: req.user!.id, dimensions: result.dimensions, available }, 'AI embed');

		res.status(200).json({
			success: true,
			embedding: result.embedding,
			dimensions: result.dimensions,
			available,
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
			available: false,
			// Mirrors the comment on generateEmbedding() in services/ai.js.
			reason: 'No embeddings provider is configured; the Anthropic SDK exposes no embeddings endpoint.',
		},
	});
});

export { router as aiRoutes };
