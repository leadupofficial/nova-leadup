/**
 * NOVA API — Realtime streaming TTS.
 *
 * The REST path synthesises the whole reply and returns base64 audio, so the
 * first sound can only start after the last token is generated *and* the whole
 * clip is synthesised. The streaming endpoint returns `audio/mpeg` as a raw
 * binary body and starts pushing bytes almost immediately — measured
 * time-to-first-audio 315 ms, versus seconds for the full-synthesis route.
 *
 * This module is intentionally thin: it opens the stream and hands back the
 * `ReadableStream` so the session can forward chunks to the client as they
 * arrive and abort the fetch the instant the user barges in.
 *
 * Provider choice: Sarvam `bulbul:v3` for **every** language, including
 * English. The REST route prefers ElevenLabs for English, but its streaming
 * endpoint is not what was verified here and `bulbul:v3` covers `en-IN`, so the
 * realtime path uses one verified provider rather than two divergent ones.
 *
 * Fallback chain per sentence: the streaming primary above → **Deepgram Aura**
 * (English and the other six languages it ships — see `toDeepgramVoiceModel`)
 * → nothing, at which point the client plays its own device voice. Deepgram is
 * never the primary here; it only fires once the primary has refused the turn
 * (today Sarvam answers HTTP 402 "No credits available" for every language).
 */
import { env } from '../utils/env.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';
import { synthesizeSpeech, synthesizeSpeechDeepgram, toDeepgramVoiceModel } from '../services/ai.js';

export const SARVAM_TTS_STREAM_URL = 'https://api.sarvam.ai/text-to-speech/stream';

/** The realtime path's primary (and, for now, only) streaming provider. */
export const PRIMARY_STREAM_PROVIDER = 'sarvam';

/** ElevenLabs' stock narrator voice, used when the request names none. */
export const DEFAULT_ELEVENLABS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

/** Sarvam's default v3 speaker; overridable so the voice can change later. */
export const DEFAULT_SPEAKER = 'priya';
export const DEFAULT_TTS_MODEL = 'bulbul:v3';

/**
 * Target-language code for TTS. Mirrors `toSarvamLanguageCode` in
 * `routes/voice.ts` (bare code → `xx-IN`), except that `auto` has no meaning
 * when synthesising and falls back to Indian English. The streaming TTS
 * endpoint uses `or-IN` for Odia (only the legacy STT endpoint says `od-IN`).
 */
export function toSarvamTtsLanguageCode(code: string): string {
	const value = (code || '').trim().toLowerCase();
	if (!value || value === 'auto' || value === 'unknown') return 'en-IN';
	if (value.includes('-')) return value;
	return `${value}-IN`;
}

/** Why a sentence is not being served by the primary streaming provider. */
export interface TtsFallbackInfo {
	/** Provider that was tried first and failed. */
	from: string;
	/** Provider now serving the sentence. */
	to: string;
	/** Human-readable failure from the primary, for the client's notice. */
	reason: string;
}

export interface SpeechStreamOptions {
	text: string;
	language: string;
	speaker?: string;
	signal?: AbortSignal;
	/**
	 * Fired once per sentence when the primary fails and the Deepgram cloud
	 * fallback takes over. Mirrors the STT `{type:'stt', …}` notice so the client
	 * can say "the backup voice is speaking" instead of pretending nothing
	 * happened. Absent when the language has no Deepgram voice.
	 */
	onFallback?: (info: TtsFallbackInfo) => void;
	/**
	 * Fired exactly once per sentence with the provider that actually
	 * synthesised it, so cost accounting can bill the fallback's rate rather
	 * than the primary's. Not called for a sentence that no provider could voice.
	 */
	onProvider?: (provider: string) => void;
}

/**
 * True when the text contains at least one letter or digit in any script.
 * Sarvam rejects anything else with
 * `400 Text must contain at least one character from the allowed languages.`,
 * which is exactly what an LLM reply full of emoji produces — a lone "🎙️" or
 * "🌊" line between paragraphs became a 400 and (before this) killed the rest
 * of the spoken reply.
 */
const HAS_SPEAKABLE_CHAR = /[\p{L}\p{N}]/u;

/**
 * Prepares a chunk of an LLM reply for speech: drops Markdown emphasis markers
 * the model likes to write (`**bold**`, `` `code` ``, `# headings`) so the
 * voice does not read punctuation, collapses whitespace, and returns `''` when
 * nothing speakable is left so the caller can skip the TTS call entirely.
 */
export function toSpeakableText(text: string): string {
	const stripped = text
		.replace(/[*_`~]+/g, '')
		.replace(/^#{1,6}\s*/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
	const spoken = dropEmptyMinutes(stripped);
	return HAS_SPEAKABLE_CHAR.test(spoken) ? spoken : '';
}

/**
 * Rewrites `5:00` as `5`, so an on-the-hour time is read as a time.
 *
 * ElevenLabs' Flash models ship with text normalisation disabled — their docs
 * say so, and re-enabling it is Enterprise-only — so clock times reach the
 * model as digits. That is not uniformly handled:
 *
 *   English  "5:00 pm"  -> "five PM"        correct
 *   Hindi    "5:00"     -> "पांच"             correct
 *   Tamil    "5:00"     -> "ஐஞ்சர்"          wrong — a mangled non-word
 *   Tamil    "5"        -> "ஐந்து"            correct ("five")
 *
 * Verified by synthesising each form and transcribing the audio back, so the
 * fix is measured rather than assumed. Dropping `:00` leaves English and Hindi
 * reading exactly as before, so this runs for every language.
 *
 * Only the on-the-hour case is handled. A time with minutes is still wrong in
 * Tamil — "7:30" comes back as the English "seven thirty" inside an otherwise
 * Tamil sentence, and none of the Tamil rewrites tried (`7 மணி 30 நிமிடம்`,
 * `7.30`, spelled out) survived the model intact. The reliable fix for those is
 * the one the ElevenLabs docs recommend: have the LLM write times out in words
 * before they reach the synthesiser, rather than trying to patch digits here.
 */
function dropEmptyMinutes(text: string): string {
	return text.replace(/(\d{1,2}):00(?=\D|$)/g, '$1');
}

/**
 * Opens a streaming synthesis request and resolves once response headers are
 * in — i.e. as soon as audio is about to flow. Errors are mapped onto
 * `HttpError` so the session can report a stable `TTS_ERROR` code.
 *
 * When the streaming primary refuses the sentence, this falls back to Deepgram
 * for the languages it supports and only throws when neither cloud voice could
 * produce audio — the caller then reports `TTS_ERROR` once per turn and the
 * client's device voice is the last resort (which this server never reaches
 * into). A cancelled turn is not a provider failure and is rethrown untouched.
 */
export async function openSpeechStream(options: SpeechStreamOptions): Promise<ReadableStream<Uint8Array>> {
	try {
		const body = await openSarvamSpeechStream(options);
		options.onProvider?.(PRIMARY_STREAM_PROVIDER);
		return body;
	} catch (err) {
		if (options.signal?.aborted || (err as { name?: string } | null)?.name === 'AbortError') throw err;

		const reason = err instanceof Error ? err.message : String(err);

		// Cloud fallback #1 — ElevenLabs, on Flash. Fastest of the two: measured
		// ~700 ms to first byte, and it covers 32 languages including the whole
		// Indic set, so it is both the quicker and the broader choice.
		if (env.ELEVENLABS_API_KEY) {
			logger.warn(
				{ primary: PRIMARY_STREAM_PROVIDER, fallback: 'elevenlabs', language: options.language, reason },
				'Streaming TTS primary failed; ElevenLabs is speaking this sentence instead'
			);
			const clip = await synthesizeSpeech(options.text, DEFAULT_ELEVENLABS_VOICE_ID, {
				signal: options.signal,
			});
			options.onProvider?.('elevenlabs');
			options.onFallback?.({ from: PRIMARY_STREAM_PROVIDER, to: 'elevenlabs', reason });
			return singleClip(clip.audioBuffer);
		}

		// Cloud fallback #2 — Deepgram Aura. Tried second because it is markedly
		// slower: its time to first byte is a fixed ~1.7 s regardless of text
		// length, against ElevenLabs' ~0.7 s. It was first, and English replies
		// were paying 1.6-3.7 s of synthesis for it — measured, while Tamil on
		// ElevenLabs took 0.17-0.40 s in the same runs. It also covers only seven
		// languages, all of which ElevenLabs already does, so nothing loses a
		// voice by moving it down.
		const model = toDeepgramVoiceModel(options.language);
		if (model && env.DEEPGRAM_API_KEY) {
			logger.warn(
				{ primary: PRIMARY_STREAM_PROVIDER, fallback: 'deepgram', model, language: options.language, reason },
				'Streaming TTS primary failed; Deepgram is speaking this sentence instead'
			);
			const clip = await synthesizeSpeechDeepgram(options.text, options.language, {
				signal: options.signal,
			});
			options.onProvider?.('deepgram');
			options.onFallback?.({ from: PRIMARY_STREAM_PROVIDER, to: 'deepgram', reason });
			return singleClip(clip.audioBuffer);
		}

		// Nothing cloud-side can voice this language: keep the primary's error so
		// the client plays its device voice rather than waiting on a fallback that
		// cannot work.
		throw err;
	}
}

/**
 * Wraps a whole clip as a one-chunk stream.
 *
 * Neither fallback streams progressively — both are single POSTs returning the
 * finished audio — so a *sentence* arrives in one piece. The realtime path still
 * streams sentence by sentence: speech for sentence 1 begins while the model is
 * still writing sentence 3. There is just no within-sentence progression here,
 * which is the accepted trade for having a working cloud voice at all.
 */
function singleClip(audio: Buffer): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(audio));
			controller.close();
		},
	});
}

/** The primary streaming attempt, isolated so `openSpeechStream` can fall back. */
async function openSarvamSpeechStream(options: SpeechStreamOptions): Promise<ReadableStream<Uint8Array>> {
	if (!env.SARVAM_API_KEY) {
		throw new HttpError(503, 'SARVAM_API_KEY is not configured', 'TTS_NOT_CONFIGURED');
	}

	const response = await fetch(SARVAM_TTS_STREAM_URL, {
		method: 'POST',
		headers: {
			'api-subscription-key': env.SARVAM_API_KEY,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			text: options.text,
			target_language_code: toSarvamTtsLanguageCode(options.language),
			speaker: options.speaker || DEFAULT_SPEAKER,
			model: DEFAULT_TTS_MODEL,
		}),
		signal: options.signal,
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		logger.warn({ status: response.status, detail: detail.slice(0, 200) }, 'Sarvam TTS stream failed');
		throw new HttpError(502, `TTS provider failed (${response.status})`, 'TTS_ERROR');
	}
	if (!response.body) {
		throw new HttpError(502, 'TTS provider returned no audio body', 'TTS_ERROR');
	}

	return response.body;
}
