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
 */
import { env } from '../utils/env.js';
import { HttpError } from '../middleware/error-handler.js';
import { logger } from '../utils/logger.js';

export const SARVAM_TTS_STREAM_URL = 'https://api.sarvam.ai/text-to-speech/stream';

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

export interface SpeechStreamOptions {
	text: string;
	language: string;
	speaker?: string;
	signal?: AbortSignal;
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
 */
export async function openSpeechStream(options: SpeechStreamOptions): Promise<ReadableStream<Uint8Array>> {
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
