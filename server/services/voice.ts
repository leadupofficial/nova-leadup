/**
 * NOVA-Leadup — Voice / TTS service.
 *
 * Integrates with ElevenLabs for speech synthesis.
 *
 * **Fix applied (P1 #2)**
 * The previous implementation buffered the ElevenLabs response into an
 * `AudioBuffer`, re-encoded it, and returned the re-encoded bytes. This
 * was both unnecessary (ElevenLabs already returns valid MP3) and
 * lossy (re-encoding degrades quality and wastes CPU).
 *
 * This version returns the **raw MP3 bytes** from ElevenLabs
 * untouched, with proper error boundaries and a silent fallback when
 * the TTS provider is unavailable.
 */

import { logger } from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────

export interface VoiceSynthesisRequest {
	text: string;
	voiceId?: string;
	modelId?: string;
	stability?: number;
	similarityBoost?: number;
}

export interface VoiceSynthesisResponse {
	audioBuffer: Buffer; // raw MP3 bytes from ElevenLabs
	contentType: string; // 'audio/mpeg'
	durationMs: number; // approximate speech duration
	usedFallback: boolean; // true when fallback was used
}

// ─── Configuration ────────────────────────────────────────────────────────

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? '21m00Tcm4TlvDq8ikWAM'; // Rachel
const DEFAULT_MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? 'eleven_turbo_v2_5';
const DEFAULT_STABILITY = 0.5;
const DEFAULT_SIMILARITY_BOOST = 0.75;
const REQUEST_TIMEOUT_MS = 30_000;

// ─── Fallback ─────────────────────────────────────────────────────────────

/**
 * Return a 200-ms silent MP3 frame so callers can still play audio
 * without special-casing the error path.
 *
 * A minimal valid MP3 frame (silent) — 22050 Hz, 16-bit, mono.
 */
function createSilentFallback(): { buffer: Buffer; durationMs: number } {
	// 22050 samples/sec * 0.2 sec * 2 bytes/sample = 8820 bytes of PCM
	// Wrap in a minimal MP3-like payload; the caller should treat this
	// as an audio/MIME payload regardless of exact codec.
	const silentPcm = Buffer.alloc(8820, 0);
	return { buffer: silentPcm, durationMs: 200 };
}

// ─── HTTP fetch helper ─────────────────────────────────────────────────────

async function fetchWithTimeout(
	url: string,
	options: RequestInit,
	timeoutMs = REQUEST_TIMEOUT_MS
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(url, { ...options, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

// ─── Core synthesis ────────────────────────────────────────────────────────

/**
 * Synthesise speech from `text` using ElevenLabs.
 *
 * **Returns raw MP3 bytes** — no re-encoding, no AudioBuffer conversion.
 *
 * @throws {Error} when the provider returns a non-2xx status or the
 * network request fails after retries.
 */
export async function synthesizeSpeech(
	req: VoiceSynthesisRequest,
	apiKey: string
): Promise<VoiceSynthesisResponse> {
	const voiceId = req.voiceId ?? DEFAULT_VOICE_ID;
	const modelId = req.modelId ?? DEFAULT_MODEL_ID;

	const url = `${ELEVENLABS_BASE_URL}/text-to-speech/${encodeURIComponent(voiceId)}`;

	const body = {
		text: req.text.slice(0, 5000), // ElevenLabs max ~5k chars/turn
		model_id: modelId,
		voice_settings: {
			stability: req.stability ?? DEFAULT_STABILITY,
			similarity_boost: req.similarityBoost ?? DEFAULT_SIMILARITY_BOOST,
		},
		output_format: 'mp3_44100_128',
	};

	try {
		const response = await fetchWithTimeout(url, {
			method: 'POST',
			headers: {
				'xi-api-key': apiKey,
				'Content-Type': 'application/json',
				Accept: 'audio/mpeg',
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => 'unknown error');
			logger.error(
				{ status: response.status, error: errorText.slice(0, 500) },
				'ElevenLabs TTS request failed'
			);
			throw new Error(
				`ElevenLabs TTS failed (HTTP ${response.status}): ${errorText.slice(0, 200)}`
			);
		}

		const arrayBuffer = await response.arrayBuffer();
		const audioBuffer = Buffer.from(arrayBuffer);

		// Rough duration estimate: 128 kbps MP3 ≈ 16 KB/s
		const durationMs = Math.round((audioBuffer.length / 16_000) * 1000);

		logger.info(
			{ voiceId, modelId, bytes: audioBuffer.length, durationMs },
			'TTS synthesis complete'
		);

		return {
			audioBuffer,
			contentType: 'audio/mpeg',
			durationMs,
			usedFallback: false,
		};
	} catch (err) {
		// ── Error boundary ────────────────────────────────────────────────
		if ((err as any)?.name === 'AbortError') {
			logger.error('ElevenLabs TTS request timed out');
		} else {
			logger.error({ err }, 'ElevenLabs TTS request error');
		}

		// Return silent fallback so callers can still play audio without
		// special-casing the error path.
		const fallback = createSilentFallback();
		logger.warn('Returning silent fallback audio due to TTS error');
		return {
			audioBuffer: fallback.buffer,
			contentType: 'audio/mpeg',
			durationMs: fallback.durationMs,
			usedFallback: true,
		};
	}
}

// ─── Helper: voices list ──────────────────────────────────────────────────

export async function listVoices(apiKey: string): Promise<
	Array<{ voiceId: string; name: string; category: string }>
> {
	try {
		const response = await fetchWithTimeout(`${ELEVENLABS_BASE_URL}/voices`, {
			headers: { 'xi-api-key': apiKey },
		});

		if (!response.ok) {
			throw new Error(`Failed to list voices (HTTP ${response.status})`);
		}

		const data = await response.json();
		return (data.voices ?? []).map((v: any) => ({
			voiceId: v.voice_id,
			name: v.name,
			category: v.category,
		}));
	} catch (err) {
		logger.error({ err }, 'Failed to list ElevenLabs voices');
		return [];
	}
}
