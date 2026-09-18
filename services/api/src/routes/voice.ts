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
	type LanguageCode,
	type MixedLanguageCode,
	getLanguageByCode,
	getSttProviderForLanguage,
	getVoiceProviderForLanguage,
} from '@nova/shared-types';
import {
	transcribeAudio,
	transcribeAudioSarvam,
	transcribeAudioGoogle,
	synthesizeSpeech,
	synthesizeSpeechSarvam,
	synthesizeSpeechGoogle,
	translateText,
	ChatMessage,
} from '../services/ai.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { env } from '../utils/env.js';
import { toAssistantError } from '../services/assistant.js';
import { buildUserContext, composeSystemPrompt } from '../services/user-context.js';
import { ASSISTANT_TOOLS_PROMPT, runAssistantToolLoop } from '../services/assistant-tools.js';
import { validate } from '../middleware/validate.js';

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
			if (Buffer.isBuffer(body.audioData)) {
				audioBuffer = body.audioData;
			} else {
				// Clients send base64, optionally as a data: URL. Decoding with the
				// default utf8 encoding would hand the transcriber mojibake bytes;
				// the encoding argument is required.
				const raw = String(body.audioData);
				const comma = raw.indexOf(',');
				const b64 = raw.startsWith('data:') && comma !== -1 ? raw.slice(comma + 1) : raw;
				audioBuffer = Buffer.from(b64, 'base64');
			}
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
//
// Exported so the realtime voice socket (`src/realtime/session.ts`) speaks with
// exactly the same persona and language framing as this REST path.
export function buildSystemPromptForLanguage(language: string): string {
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

		const messages: ChatMessage[] = body.messages.map((m) => ({ role: m.role, content: m.content }));

		// Spoken turns get the same grounding as typed ones: a voice companion
		// that cannot see your reminders is not a companion. They also get the
		// same write tools, so "remind me to call the bank tomorrow at 5pm"
		// works when spoken, not just when typed.
		const context = await buildUserContext(req.user!.id);
		const systemPrompt = composeSystemPrompt({
			basePrompt: buildSystemPromptForLanguage(language),
			context: context.text,
			capabilities: ASSISTANT_TOOLS_PROMPT,
			language,
			languageName: getLanguageByCode(language)?.name,
			languageNative: getLanguageByCode(language)?.native,
		});

		const result = await runAssistantToolLoop(req.user!.id, messages, {
			systemPrompt,
			maxTokens: 1024,
			temperature: 0.7,
		});

		logger.info(
			{
				userId: req.user!.id,
				model: result.model,
				language,
				usage: result.usage,
				iterations: result.iterations,
				tools: result.toolCalls.map((t) => `${t.name}:${t.ok ? 'ok' : 'failed'}`),
				capped: result.capped,
			},
			'Voice chat completion',
		);

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
		// Surface the stable AI_* code so the client can distinguish "provider
		// not configured / credential rejected" from a generic failure instead
		// of rendering the provider's own error text as NOVA's reply.
		const assistantError = toAssistantError(err);
		next(
			new HttpError(
				assistantError.code === 'AI_NOT_CONFIGURED' ? 503 : 502,
				assistantError.message,
				assistantError.code
			)
		);
	}
});

const TtsSchema = z.object({
	text: z.string().min(1),
	voiceId: z.string().optional(),
	language: z.string().optional(),
});

const TranslateSchema = z.object({
	text: z.string().min(1).max(5000),
	// 'auto' asks Sarvam to detect the source language itself.
	sourceLanguage: z.string().optional(),
	targetLanguage: z.string().min(2),
});

/**
 * Sarvam expects region-tagged codes (`ta-IN`). The app works in bare ISO
 * codes (`ta`) and may hand us 'auto', so normalise here and leave anything
 * already tagged alone.
 */
function toSarvamLanguageCode(code: string): string {
	const value = (code || '').trim();
	if (!value) return 'auto';
	if (value === 'auto' || value.includes('-')) return value;
	return `${value}-IN`;
}

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
			// Fall back to Sarvam (bulbul:v3), which covers en-IN as well as the
			// Indian languages, so a dead ElevenLabs/Google credential degrades
			// to a working voice instead of silence. Sarvam is only skipped when
			// it was the provider that just failed.
			if (voiceProvider !== 'sarvam' && env.SARVAM_API_KEY) {
				try {
					const sarvamCode = language === 'tanglish' ? 'ta' : language;
					const fallback = await synthesizeSpeechSarvam(body.text, sarvamCode as string);
					logger.warn(
						{ language, voiceProvider, err: ttsErr },
						'TTS provider failed; served by the Sarvam fallback'
					);
					res.status(200).json({
						success: true,
						data: {
							audioData: fallback.audioBuffer.toString('base64'),
							url: null,
							contentType: fallback.contentType,
							voice: body.voiceId || 'default',
							durationMs: Math.round((fallback.audioBuffer.length / 16000) * 1000),
							provider: 'sarvam-fallback',
							language,
						},
					});
					return;
				} catch (fallbackErr) {
					logger.warn({ err: fallbackErr, language }, 'Sarvam TTS fallback also failed');
				}
			}
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

// POST /voice/translate — Sarvam translation, with 'auto' source detection.
//
// `translateText` has existed in services/ai.ts all along but was mounted
// nowhere, so the Translate screen had no endpoint to call.
router.post('/translate', authenticate, validate(TranslateSchema), async (req: AuthenticatedRequest, res, next) => {
	try {
		const body = (req as any).validatedBody as z.infer<typeof TranslateSchema>;
		const result = await translateText(
			body.text,
			toSarvamLanguageCode(body.sourceLanguage || 'auto'),
			toSarvamLanguageCode(body.targetLanguage)
		);
		res.status(200).json({
			success: true,
			data: {
				translatedText: result.translatedText,
				sourceLanguage: result.sourceLanguage,
				targetLanguage: result.targetLanguage,
				detectedLanguage: result.detectedLanguage,
			},
		});
	} catch (err) {
		logger.warn({ err }, 'Translate failed');
		next(new HttpError(502, 'Translation failed', 'TRANSLATE_ERROR'));
	}
});

// GET /voice/languages — list all supported languages (and their provider routes)
router.get('/languages', authenticate, (_req, res) => {
	// Which providers this deployment can actually reach.
	//
	// The catalogue names a provider per language, but that is the *intended*
	// route, not a promise: seven languages (Assamese, Maithili, Sanskrit,
	// Sindhi, Kashmiri, Dogri, Manipuri) are mapped to `google`, and this
	// deployment has no GOOGLE_CLOUD_API_KEY at all. A client reading only
	// `voiceProvider` would think those work. Reporting what is configured lets
	// it tell the two apart instead of discovering it one failed turn at a time.
	const configured = {
		sarvam: Boolean(env.SARVAM_API_KEY),
		elevenlabs: Boolean(env.ELEVENLABS_API_KEY),
		deepgram: Boolean(env.DEEPGRAM_API_KEY),
		google: Boolean(env.GOOGLE_CLOUD_API_KEY),
	};

	res.status(200).json({
		success: true,
		data: {
			languages: SUPPORTED_LANGUAGES.map((l) => {
				const sttReady = configured[l.sttProvider as keyof typeof configured] ?? false;
				const ttsReady = configured[l.voiceProvider as keyof typeof configured] ?? false;
				return {
					code: l.code,
					name: l.name,
					native: l.native,
					voiceProvider: l.voiceProvider,
					sttProvider: l.sttProvider,
					// False means the named provider has no credential here, so the
					// turn will fall back (Deepgram for recognition, the device voice
					// for speech) rather than using the provider named above.
					sttConfigured: sttReady,
					ttsConfigured: ttsReady,
				};
			}),
			providers: configured,
			mixed: MIXED_CODES,
			count: SUPPORTED_LANGUAGES.length,
		},
	});
});

export { router as voiceRoutes };
