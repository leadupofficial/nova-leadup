/**
 * NOVA API — Sarvam streaming STT (Indian languages).
 *
 * Wire format, verified against production:
 *   wss://api.sarvam.ai/speech-to-text/ws
 *   header  api-subscription-key: <SARVAM_API_KEY>
 *   query   language_code=ta-IN&model=saaras:v3&mode=transcribe&sample_rate=16000
 *           &input_audio_codec=pcm_s16le&high_vad_sensitivity=true
 *           &vad_signals=true&flush_signal=true
 *   send    JSON text frames — {"audio":{"data":"<base64 PCM>","sample_rate":16000,
 *           "encoding":"audio/wav"}} (binary frames are rejected by this endpoint)
 *   recv    {"type":"events","data":{"signal_type":"START_SPEECH"|"END_SPEECH"}}
 *           {"type":"data","data":{"transcript":"…"}}   utterance final
 *
 * Two honest limitations, both from the provider rather than this wrapper:
 *
 * 1. This (legacy) endpoint has **no interim transcripts** — the docs state it
 *    emits "only a final transcript per utterance". Interim `partial` events are
 *    therefore a Deepgram/English feature; Sarvam turns surface text at the end
 *    of the utterance. Sarvam's newer `/speech-to-text-realtime/ws` endpoint
 *    does stream partials but is a different protocol, which the frozen client
 *    contract here does not cover.
 * 2. `encoding` on an audio message is fixed to `audio/wav` by the API schema;
 *    raw PCM is requested once, at connect time, with `input_audio_codec`.
 */
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { env } from '../../utils/env.js';
import { HttpError } from '../../middleware/error-handler.js';
import { logger } from '../../utils/logger.js';
import { isFatalProviderClose } from '../protocol.js';
import type { SttOptions, SttSession } from './types.js';

const SARVAM_STT_URL = 'wss://api.sarvam.ai/speech-to-text/ws';

/** ~30 s of 16 kHz mono s16le, queued only while the handshake completes. */
const MAX_PENDING_BYTES = 1_000_000;

/**
 * Map our bare language codes onto the codes this endpoint accepts.
 *
 * Follows `toSarvamLanguageCode` in `routes/voice.ts` (bare code → `xx-IN`) with
 * one provider quirk: the legacy streaming endpoint still spells Odia `od-IN`
 * (the newer realtime endpoint renamed it `or-IN`). `auto` becomes `unknown`,
 * which is this API's auto-detect value.
 */
export function toSarvamStreamLanguageCode(code: string): string {
	const value = (code || '').trim().toLowerCase();
	if (!value || value === 'auto' || value === 'unknown') return 'unknown';
	if (value.includes('-')) return value;
	if (value === 'or') return 'od-IN';
	return `${value}-IN`;
}

export function createSarvamStt(options: SttOptions): SttSession {
	const apiKey = env.SARVAM_API_KEY;
	if (!apiKey) {
		throw new HttpError(503, 'SARVAM_API_KEY is not configured', 'STT_NOT_CONFIGURED');
	}

	const query = new URLSearchParams({
		language_code: toSarvamStreamLanguageCode(options.language),
		model: 'saaras:v3',
		mode: 'transcribe',
		sample_rate: String(options.sampleRate),
		input_audio_codec: 'pcm_s16le',
		high_vad_sensitivity: 'true',
		vad_signals: 'true',
		flush_signal: 'true',
	});

	const socket = new WebSocket(`${SARVAM_STT_URL}?${query}`, {
		headers: { 'api-subscription-key': apiKey },
	});

	let closed = false;
	let opened = false;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	const send = (payload: unknown): void => {
		if (closed || socket.readyState !== WebSocket.OPEN) return;
		try {
			socket.send(JSON.stringify(payload));
		} catch (err) {
			logger.warn({ err }, 'Sarvam STT send failed');
		}
	};

	socket.on('open', () => {
		opened = true;
		logger.info({ provider: 'sarvam', queuedBytes: pendingBytes }, 'Streaming STT socket open');
		for (const chunk of pending) {
			send({ audio: { data: chunk.toString('base64'), sample_rate: options.sampleRate, encoding: 'audio/wav' } });
		}
		pending = [];
		pendingBytes = 0;
	});

	socket.on('message', (data: RawData) => {
		let message: any;
		try {
			message = JSON.parse(data.toString());
		} catch {
			return;
		}

		if (message.type === 'events') {
			const signal = message.data?.signal_type;
			if (signal === 'START_SPEECH') {
				options.handlers.onSpeechStart?.();
			} else if (signal === 'END_SPEECH') {
				options.handlers.onSpeechEnd?.();
			}
			return;
		}

		if (message.type === 'data') {
			const text: string = (message.data?.transcript ?? '').trim();
			if (text) options.handlers.onFinal?.(text);
			return;
		}

		if (message.type === 'error') {
			const detail = message.data?.message ?? message.data?.error ?? JSON.stringify(message.data ?? {});
			options.handlers.onError?.(new Error(`Sarvam STT: ${detail}`));
		}
	});

	socket.on('error', (err: Error) => {
		options.handlers.onError?.(err);
	});

	socket.on('close', (code: number, reason: Buffer) => {
		closed = true;
		options.handlers.onClose?.(code, reason?.toString() ?? '', isFatalProviderClose(code));
	});

	return {
		provider: 'sarvam',
		get closed() {
			return closed;
		},
		sendAudio(pcm: Buffer): void {
			if (closed || !pcm.length) return;
			if (!opened) {
				if (pendingBytes + pcm.length > MAX_PENDING_BYTES) return;
				pending.push(Buffer.from(pcm));
				pendingBytes += pcm.length;
				return;
			}
			send({ audio: { data: pcm.toString('base64'), sample_rate: options.sampleRate, encoding: 'audio/wav' } });
		},
		requestFinal(): void {
			// Requires flush_signal=true at connect time.
			send({ type: 'flush' });
		},
		keepAlive(): void {
			// This endpoint documents no keepalive message (the newer realtime
			// endpoint has `ping`); its inactivity timer is not something the
			// documented protocol lets us reset. The session closes the socket
			// when the conversation goes idle instead.
		},
		close(): void {
			if (closed) return;
			closed = true;
			pending = [];
			pendingBytes = 0;
			try {
				if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'session closed');
				else socket.terminate();
			} catch {
				/* already gone */
			}
			const termTimer = setTimeout(() => {
				try {
					if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
				} catch {
					/* already gone */
				}
			}, 2000) as unknown as { unref?: () => void };
			termTimer.unref?.();
		},
	};
}
