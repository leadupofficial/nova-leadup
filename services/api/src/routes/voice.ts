/**
 * NOVA API — Voice routes (STT via Deepgram/Sarvam/Google, TTS via ElevenLabs/Sarvam/Google, Claude chat).
 *
 * Language-aware routing:
 * - English → Deepgram (STT) + ElevenLabs (TTS)
 * - Indian languages supported by Sarvam → Sarvam (STT + TTS)
 * - Other Indian languages not in Sarvam's catalog → Google (STT + TTS)
 */
import { Router, Request, Response, NextFunction } from 'express';
import { pcmDurationSeconds, recordSttUsage, recordTtsUsage } from '../services/voice-usage.js';
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
	synthesizeSpeechDeepgram,
	toDeepgramVoiceModel,
	translateText,
	SpeechProviderError,
	ChatMessage,
	defaultMaxOutputTokens,
	getAnthropicHttpConfig,
} from '../services/ai.js';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { env } from '../utils/env.js';
import { toAssistantError, assistantErrorStatus } from '../services/assistant.js';
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

/**
 * The HTTP failure an STT provider error deserves.
 *
 * Unusable audio is a **client** error. The provider read the request, could not
 * decode the payload and rejected it — posting the same bytes again fails the
 * same way — so the caller is told to record again instead of being handed a 500
 * that reads like an outage. Everything else (a rejected credential, rate
 * limiting, a timeout, an upstream 5xx) is this service's or the provider's
 * problem and stays 5xx.
 *
 * The upstream body is never forwarded: it names the provider's account,
 * request ids and key state, none of which is the caller's business.
 */
function toSttError(err: unknown, provider: string): HttpError {
	if (err instanceof HttpError) return err;
	if (err instanceof SpeechProviderError && err.isUnusableInput) {
		return new HttpError(
			400,
			"That audio couldn't be transcribed. Please record again and try once more.",
			'STT_UNUSABLE_AUDIO',
		);
	}
	return new HttpError(
		502,
		`The speech-to-text provider (${provider}) is unavailable right now. Please try again.`,
		'STT_ERROR',
	);
}

// POST /voice/stt — transcribe audio; routes by language
/**
 * The capture sample rate, in Hz.
 *
 * The client streams 16 kHz 16-bit mono PCM and the provider clients are configured with
 * `encoding: 'linear16', channels: 1`, so this is the format every audio length in this file is
 * computed against rather than a guess. It was a bare `16000` in four places; naming it keeps the
 * duration calculations and the usage meter from drifting apart.
 */
const PCM_SAMPLE_RATE = 16000;

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

		// Nothing was recorded, or the value decoded to nothing. Sending it on
		// would make the provider's "no audio" rejection look like our failure,
		// and an empty payload can never produce a transcript.
		if (audioBuffer.length === 0) {
			throw new HttpError(
				400,
				'No audio was received, so there was nothing to transcribe. Please record again.',
				'STT_UNUSABLE_AUDIO',
			);
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
			throw toSttError(providerErr, provider);
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

		// Metered after a successful transcription, so a failed call does not inflate the
		// request count. Not awaited: metering must never delay a user's speech. The capture
		// format is 16-bit mono PCM, which is what the provider clients are configured with.
		recordSttUsage({
			userId: req.user!.id,
			seconds: pcmDurationSeconds(audioBuffer.length, PCM_SAMPLE_RATE),
			provider,
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
		// works when spoken, not just when typed. The last thing the user said is
		// the turn the memory block is ranked against.
		const context = await buildUserContext(req.user!.id, {}, undefined, {
			userTurn: body.messages.at(-1)?.content,
		});
		const systemPrompt = composeSystemPrompt({
		spoken: true,
			basePrompt: buildSystemPromptForLanguage(language),
			context: context.text,
			capabilities: ASSISTANT_TOOLS_PROMPT,
			language,
			languageName: getLanguageByCode(language)?.name,
			languageNative: getLanguageByCode(language)?.native,
		});

		const result = await runAssistantToolLoop(req.user!.id, messages, {
			systemPrompt,
			// The spoken model, not the general one. This route is the one-shot
			// voice turn the app uses when the realtime socket is unavailable, and
			// it was inheriting `ANTHROPIC_MODEL` — the model chosen for typed
			// reasoning. Measured on the live route, that made a spoken reminder
			// take 15–131 s and turned one ordinary advice question into a 502.
			// `ANTHROPIC_VOICE_MODEL` names the spoken tier explicitly so the two
			// surfaces can be tuned apart instead of sharing one compromise.
			model: getAnthropicHttpConfig().voiceModel,
			// So the one reply the server writes itself — the "nothing has been
			// changed" floor under an unbacked claim — is in the language the user
			// actually spoke, rather than English on a Tamil turn.
			language,
			maxTokens: defaultMaxOutputTokens(),
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
				// True when the model's narration claimed a change the tool results
				// did not support and the reply the user heard was replaced.
				claimCorrected: result.claimCorrected,
				// Which provider served the turn, so a primary-provider outage is
				// visible in the logs rather than silently absorbed.
				provider: result.provider ?? 'anthropic',
				fellBack: result.fellBack === true,
			},
			'Voice chat completion',
		);

		res.status(200).json({
			success: true,
			data: {
				text: result.content,
				model: result.model,
				// The provider that actually answered, not a hardcoded assumption:
				// when the primary relay is unusable this is the fallback, and the
				// client can see that a fallback served the turn. `fellBack` is the
				// machine-readable form of the same fact.
				provider: result.provider ?? 'anthropic',
				fellBack: result.fellBack === true,
				language,
			},
		});
	} catch (err) {
		logger.warn({ err }, 'Voice chat failed');
		// Surface the stable AI_* code so the client can distinguish "provider
		// not configured / credential rejected" from a generic failure instead
		// of rendering the provider's own error text as NOVA's reply — and the
		// status that code deserves, so a refused input (AI_BLOCKED) is not
		// reported as the service being broken.
		const assistantError = toAssistantError(err);
		next(
			new HttpError(
				assistantErrorStatus(assistantError.code),
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

			// Metered once per synthesis, on the characters actually sent to the provider —
			// which is what TTS bills for. Not awaited: see `services/voice-usage.ts`.
			recordTtsUsage({ userId: req.user!.id, characters: body.text.length, provider });

			res.status(200).json({
				success: true,
				data: {
					audioData: audioBase64,
					url: null,
					contentType,
					voice: body.voiceId || 'default',
					voiceId: body.voiceId || 'default',
					durationMs: Math.round((audioBuffer.length / PCM_SAMPLE_RATE) * 1000),
					provider,
					language,
				},
			});
			return;
		} catch (ttsErr) {
			// Cloud fallback #1 — Deepgram Aura. It covers English and the six
			// other languages Deepgram ships (de/es/fr/it/ja/nl) but has no Indic
			// voices, so `toDeepgramVoiceModel` returns null for Tamil/Hindi/… and
			// those requests fall through to the Sarvam fallback below and then to
			// the client's device voice. Deepgram is never the primary here.
			const deepgramModel = toDeepgramVoiceModel(language);
			if (deepgramModel && env.DEEPGRAM_API_KEY) {
				try {
					const fallback = await synthesizeSpeechDeepgram(body.text, language);
					logger.warn(
						{ language, primary: voiceProvider, fallback: 'deepgram', model: deepgramModel, reason: ttsErr },
						'TTS provider failed; served by the Deepgram fallback'
					);
					res.status(200).json({
						success: true,
						data: {
							audioData: fallback.audioBuffer.toString('base64'),
							url: null,
							contentType: fallback.contentType,
							voice: body.voiceId || 'default',
						// `voiceId` echoes the request field name; `voice` is the
						// original key and is kept for existing clients.
						voiceId: body.voiceId || 'default',
							durationMs: Math.round((fallback.audioBuffer.length / PCM_SAMPLE_RATE) * 1000),
							provider: 'deepgram',
							language,
						},
					});
					return;
				} catch (deepgramErr) {
					logger.warn({ err: deepgramErr, language, model: deepgramModel }, 'Deepgram TTS fallback also failed');
				}
			}

			// Cloud fallback #2 — Sarvam (bulbul:v3), which covers en-IN as well as
			// the Indian languages, so a dead ElevenLabs/Google credential degrades
			// to a working voice instead of silence. Sarvam is only skipped when
			// it was the provider that just failed.
			if (voiceProvider !== 'sarvam' && env.SARVAM_API_KEY) {
				try {
					const sarvamCode = language === 'tanglish' ? 'ta' : language;
					const fallback = await synthesizeSpeechSarvam(body.text, sarvamCode as string);
					logger.warn(
						{ language, primary: voiceProvider, fallback: 'sarvam', reason: ttsErr },
						'TTS provider failed; served by the Sarvam fallback'
					);
					res.status(200).json({
						success: true,
						data: {
							audioData: fallback.audioBuffer.toString('base64'),
							url: null,
							contentType: fallback.contentType,
							voice: body.voiceId || 'default',
						// `voiceId` echoes the request field name; `voice` is the
						// original key and is kept for existing clients.
						voiceId: body.voiceId || 'default',
							durationMs: Math.round((fallback.audioBuffer.length / PCM_SAMPLE_RATE) * 1000),
							provider: 'sarvam-fallback',
							language,
						},
					});
					return;
				} catch (fallbackErr) {
					logger.warn({ err: fallbackErr, language }, 'Sarvam TTS fallback also failed');
				}
			}
			// Cloud fallback #3 — ElevenLabs on its multilingual model, which covers
			// Tamil, Hindi and the rest of the Indic set. This is what stops an
			// unfunded Sarvam account from meaning "the user hears nothing": with
			// both Sarvam and the Deepgram voices unavailable (Deepgram has no Indic
			// voices at all), this is the only cloud path left for Tamil.
			if (voiceProvider !== 'elevenlabs' && env.ELEVENLABS_API_KEY) {
				try {
					const fallback = await synthesizeSpeech(
						body.text,
						body.voiceId || '21m00Tcm4TlvDq8ikWAM'
					);
					logger.warn(
						{ language, primary: voiceProvider, fallback: 'elevenlabs', reason: ttsErr },
						'TTS provider failed; served by the ElevenLabs fallback'
					);
					res.status(200).json({
						success: true,
						data: {
							audioData: fallback.audioBuffer.toString('base64'),
							url: null,
							contentType: fallback.contentType,
							voice: body.voiceId || 'default',
						// `voiceId` echoes the request field name; `voice` is the
						// original key and is kept for existing clients.
						voiceId: body.voiceId || 'default',
							durationMs: Math.round((fallback.audioBuffer.length / PCM_SAMPLE_RATE) * 1000),
							provider: 'elevenlabs-fallback',
							language,
						},
					});
					return;
				} catch (fallbackErr) {
					logger.warn({ err: fallbackErr, language }, 'ElevenLabs TTS fallback also failed');
				}
			}
			logger.warn(
				{ language, primary: voiceProvider, fallback: 'device', reason: ttsErr },
				'No cloud TTS voice available; the client must use its device voice'
			);
			res.status(200).json({
				success: true,
				data: {
					audioData: null,
					url: null,
					contentType: 'audio/mpeg',
					voice: body.voiceId || 'default',
					voiceId: body.voiceId || 'default',
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
	// Which providers this deployment has a credential for.
	//
	// The catalogue names a provider per language, but that is the *intended*
	// route, not a promise: seven languages (Assamese, Maithili, Sanskrit,
	// Sindhi, Kashmiri, Dogri, Manipuri) are mapped to `google`, and this
	// deployment has no GOOGLE_CLOUD_API_KEY at all. A client reading only
	// `voiceProvider` would think those work. Reporting what is configured lets
	// it tell the two apart instead of discovering it one failed turn at a time.
	//
	// This is presence, not proof. ElevenLabs reports as configured while its key
	// is in fact invalid, so a `true` here means "a value is set", not "this will
	// work" — verifying live would mean calling every provider on every request.
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
