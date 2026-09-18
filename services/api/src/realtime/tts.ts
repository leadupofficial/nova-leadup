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
import { synthesizeSpeechDeepgram, toDeepgramVoiceModel } from '../services/ai.js';

export const SARVAM_TTS_STREAM_URL = 'https://api.sarvam.ai/text-to-speech/stream';

/** The realtime path's primary (and, for now, only) streaming provider. */
export const PRIMARY_STREAM_PROVIDER = 'sarvam';

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
	return HAS_SPEAKABLE_CHAR.test(stripped) ? stripped : '';
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
		return await openSarvamSpeechStream(options);
	} catch (err) {
		if (options.signal?.aborted || (err as { name?: string } | null)?.name === 'AbortError') throw err;

		const model = toDeepgramVoiceModel(options.language);
		if (!model || !env.DEEPGRAM_API_KEY) {
			// No cloud voice for this language (Deepgram ships no Indic voices) or
			// no key: keep the primary's error so the client can play its device
			// voice rather than waiting on a fallback that cannot work.
			throw err;
		}

		logger.warn(
			{
				primary: PRIMARY_STREAM_PROVIDER,
				fallback: 'deepgram',
				model,
				language: options.language,
				reason: err instanceof Error ? err.message : String(err),
			},
			'Streaming TTS primary failed; Deepgram is speaking this sentence instead'
		);

		const clip = await synthesizeSpeechDeepgram(options.text, options.language, {
			signal: options.signal,
		});
		options.onFallback?.({
			from: PRIMARY_STREAM_PROVIDER,
			to: 'deepgram',
			reason: err instanceof Error ? err.message : String(err),
		});

		// Deepgram's `/v1/speak` is a single POST that returns the whole clip, so
		// a sentence arrives in one piece rather than progressively. The realtime
		// path still streams *sentence by sentence* — speech for sentence 1 starts
		// while the model is still writing sentence 3 — but there is no
		// within-sentence progression here. That is the accepted trade-off for
		// having a working cloud voice while the streaming primary is dead.
		return new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(clip.audioBuffer));
				controller.close();
			},
		});
	}
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
