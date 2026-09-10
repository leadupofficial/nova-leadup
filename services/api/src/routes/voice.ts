/**
 * NOVA API — Voice routes (STT via Deepgram/Sarvam/Google, TTS via ElevenLabs/Sarvam/Google, Claude chat).
 *
 * Language-aware routing:
 * - English → Deepgram (STT) + ElevenLabs (TTS)
 * - Indian languages supported by Sarvam → Sarvam (STT + TTS)
 * - Other Indian languages not in Sarvam's catalog → Google (STT + TTS)
 */
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
	SUPPORTED_LANGUAGES,
	getLanguageByCode,
	getSttProviderForLanguage,
	getVoiceProviderForLanguage,
	type LanguageCode,
	type MixedLanguageCode,
} from '@nova/shared-types';
import {
	transcribeAudio,
	transcribeAudioSarvam,
	transcribeAudioGoogle,
	synthesizeSpeech,
	synthesizeSpeechSarvam,
	synthesizeSpeechGoogle,
	chatCompletion,
	ChatMessage,
} from '../services/ai';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth';
import { HttpError } from '../middleware/error-handler';
import { logger } from '../utils/logger';
import { validate } from '../middleware/validate';

const router: ReturnType<typeof Router> = Router();

const SUPPORTED_CODES = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));
const MIXED_CODES: MixedLanguageCode[] = ['hinglish', 'tanglish', 'benglish', 'gujlish'];

const SttSchema = z.object({
	audioData: z.any().optional(),
	audioUrl: z.string().url().optional(),
	language: z.string().optional(),
});

// POST /voice/stt — transcribe audio; routes by language
router.post('/stt', authenticate, validate(SttSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof SttSchema>;
		const language = (body.language || 'en') as LanguageCode | MixedLanguageCode;
		const sttProvider = getSttProviderForLanguage(language);

		logger.info({ userId: req.user!.id, language, sttProvider }, 'STT request');

		let audioBuffer: Buffer;
		if (body.audioData) {
			audioBuffer = Buffer.isBuffer(body.audioData) ? body.audioData : Buffer.from(body.audioData);
		} else if (body.audioUrl) {
			const response = await fetch(body.audioUrl);
			const arrayBuffer = await response.arrayBuffer();
			audioBuffer = Buffer.from(arrayBuffer);
		} else {
			throw new HttpError(400, 'Either audioData or audioUrl is required', 'BAD_REQUEST');
		}

		let transcript = '';
		let confidence = 0;
		let detected = language;
		let provider = sttProvider;

		try {
			if (sttProvider === 'sarvam') {
				const sarvamCode = language === 'tanglish' ? 'ta' : language;
				const result = await transcribeAudioSarvam(audioBuffer, sarvamCode as string);
				transcript = result.transcript;
				confidence = result.confidence;
				detected = result.language || language;
				provider = 'sarvam';
			} else if (sttProvider === 'google') {
				const result = await transcribeAudioGoogle(audioBuffer, language);
				transcript = result.transcript;
				confidence = result.confidence;
				detected = result.language || language;
				provider = 'google';
			} else {
				// deepgram (default — English)
				const result = await transcribeAudio(audioBuffer, language);
				transcript = result.transcript;
				confidence = result.confidence;
				detected = result.language || language;
				provider = 'deepgram';
			}
		} catch (providerErr) {
			logger.warn({ err: providerErr, provider, language }, 'STT provider failed');
			throw providerErr instanceof HttpError
				? providerErr
				: new HttpError(500, `STT provider '${provider}' failed`, 'STT_ERROR');
		}

		res.status(200).json({
			success: true,
			data: {
				text: transcript,
				transcript,
				confidence,
				language: detected,
				provider,
			},
		});
	} catch (err) {
		next(err instanceof HttpError ? err : new HttpError(500, 'Transcription failed', 'STT_ERROR'));
	}
});

const ChatSchema = z.object({
	messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
	language: z.string().optional(),
});

// Build a language-aware covering all 22 supported languages
// and 4 mixed-language codes.
function buildSystemPromptForLanguage(language: string): string {
	const langInfo = getLanguageByCode(language);
	if (langInfo) {
		return `You are NOVA, a warm AI companion. The user is speaking ${langInfo.name} (${langInfo.native}). Respond fluently and naturally in ${langInfo.name}. Keep answers concise. Be helpful, friendly, and slightly playful.`;
	}

	if (language === 'hinglish') {
		return `You are NOVA, a warm AI companion. The user is writing in Hinglish (Hindi-English mix using Devanagari). Respond in the same mixed style — mixing Hindi (Devanagari) with English naturally. Keep answers concise, helpful, friendly, and slightly playful.`;
	}
	if (language === 'tanglish') {
		return `You are NOVA, a warm AI companion. The user is writing in Tanglish (Tamil-English mix). Respond in the same mixed style — mixing Tamil with English naturally. Keep answers concise, helpful, friendly, and slightly playful.`;
	}
	if (language === 'benglish') {
		return `You are NOVA, a warm AI companion. The user is writing in Benglish (Bengali-English mix). Respond in the same mixed style — mixing Bengali with English naturally. Keep answers concise, helpful, friendly, and slightly playful.`;
	}
	if (language === 'gujlish') {
		return `You are NOVA, a warm AI companion. The user is writing in Gujlish (Gujarati-English mix). Respond in the same mixed style — mixing Gujarati with English naturally. Keep answers concise, helpful, friendly, and slightly playful.`;
	}

	return `You are NOVA, a warm AI companion. Be helpful, friendly, and slightly playful. Keep answers concise.`;
}

// POST /voice/chat — Claude completion with conversation context
router.post('/chat', authenticate, validate(ChatSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof ChatSchema>;
		const language = body.language || 'en';
		const systemPrompt = buildSystemPromptForLanguage(language);

		const messages: ChatMessage[] = body.messages.map((m) => ({ role: m.role, content: m.content }));

		const result = await chatCompletion(messages, {
			systemPrompt,
			maxTokens: 1024,
			temperature: 0.7,
		});

		logger.info({ userId: req.user!.id, model: result.model, language, usage: result.usage }, 'Voice chat completion');

		res.status(200).json({
			success: true,
			data: {
				text: result.content,
				model: result.model,
				provider: 'anthropic',
				language,
			},
		});
	} catch (err) {
		logger.warn({ err }, 'Voice chat failed');
		next(err instanceof HttpError ? err : new HttpError(500, 'Chat completion failed', 'CHAT_ERROR'));
	}
});

const TtsSchema = z.object({
	text: z.string().min(1),
	voiceId: z.string().optional(),
	language: z.string().optional(),
});

// POST /voice/tts — synthesize speech; routes by language provider
router.post('/tts', authenticate, validate(TtsSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof TtsSchema>;
		const language = (body.language || 'en') as LanguageCode | MixedLanguageCode;
		const voiceProvider = getVoiceProviderForLanguage(language);
		const voiceId = body.voiceId || '21m00Tcm4TlvDq8ikWAM';

		logger.info({ userId: req.user!.id, language, voiceProvider }, 'TTS request');

		try {
			let audioBuffer: Buffer;
			let contentType: string;
			let provider: string;

			if (voiceProvider === 'sarvam') {
				const sarvamCode = language === 'tanglish' ? 'ta' : language;
				const result = await synthesizeSpeechSarvam(body.text, sarvamCode as string);
				audioBuffer = result.audioBuffer;
				contentType = result.contentType;
				provider = 'sarvam';
			} else if (voiceProvider === 'google') {
				const result = await synthesizeSpeechGoogle(body.text, language);
				audioBuffer = result.audioBuffer;
				contentType = result.contentType;
				provider = 'google';
			} else {
				const result = await synthesizeSpeech(body.text, voiceId);
				audioBuffer = result.audioBuffer;
				contentType = result.contentType;
				provider = 'elevenlabs';
			}

			const audioBase64 = audioBuffer.toString('base64');

			res.status(200).json({
				success: true,
				data: {
					audioData: audioBase64,
					url: null,
					contentType,
					voice: body.voiceId || 'default',
					durationMs: Math.round((audioBuffer.length / 16000) * 1000),
					provider,
					language,
				},
			});
			return;
		} catch (ttsErr) {
			logger.warn({ err: ttsErr, language, voiceProvider }, 'TTS provider failed');
			res.status(200).json({
				success: true,
				data: {
					audioData: null,
					url: null,
					contentType: 'audio/mpeg',
					voice: body.voiceId || 'default',
					provider: 'fallback',
					error: `TTS provider '${voiceProvider}' unavailable`,
					language,
				},
			});
			return;
		}
	} catch (err) {
		next(err instanceof HttpError ? err : new HttpError(500, 'Speech synthesis failed', 'TTS_ERROR'));
	}
});

// GET /voice/languages — list all supported languages (and their provider routes)
router.get('/languages', authenticate, (_req, res) => {
	res.status(200).json({
		success: true,
		data: {
			languages: SUPPORTED_LANGUAGES.map((l) => ({
				code: l.code,
				name: l.name,
				native: l.native,
				voiceProvider: l.voiceProvider,
				sttProvider: l.sttProvider,
			})),
			mixed: MIXED_CODES,
			count: SUPPORTED_LANGUAGES.length,
		},
	});
});

export { router as voiceRoutes };
