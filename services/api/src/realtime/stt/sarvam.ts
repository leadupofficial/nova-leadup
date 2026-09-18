/**
 * NOVA API — Sarvam streaming STT (Indian languages).
 *
 * Wire format, verified against production:
 *   wss://api.sarvam.ai/speech-to-text-realtime/ws
 *   header  api-subscription-key: <SARVAM_API_KEY>
 *   query   language_code=ta-IN&model=saaras:v3-realtime&stream_type=fast
 *           &endpointing=vad&encoding=linear16&sample_rate=16000
 *   send    {"event":"audio_input","audio":"<base64 linear16 PCM>"}
 *   recv    {"event":"transcript.partial","text":"…"}   interim, as they speak
 *           {"event":"transcript.final","text":"…"}     end of utterance
 *           {"event":"vad.speech_start"} / {"event":"vad.speech_end"}
 *           {"event":"error","code":…,"is_fatal":…,"message":…}
 *
 * This replaces the legacy `/speech-to-text/ws` endpoint, which emitted **no
 * interim transcripts at all** — its docs say so, and a measured Tamil turn
 * produced zero `partial` events. That made live text an English-only feature,
 * which is the wrong way round for a companion whose users speak Tamil, Hindi
 * and the other Indic languages. The realtime endpoint streams real partials and
 * also brings a documented `ping` keepalive, millisecond VAD tuning, and
 * `language_code=auto` with the detected language reported back.
 *
 * `stream_type=fast` is the provider's own recommendation for conversational
 * agents, where partial latency matters more than the last few points of
 * accuracy.
 */
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { env } from '../../utils/env.js';
import { HttpError } from '../../middleware/error-handler.js';
import { logger } from '../../utils/logger.js';
import { isFatalProviderClose } from '../protocol.js';
import type { SttOptions, SttSession } from './types.js';

const SARVAM_STT_URL = 'wss://api.sarvam.ai/speech-to-text-realtime/ws';

/** ~30 s of 16 kHz mono s16le, queued only while the handshake completes. */
const MAX_PENDING_BYTES = 1_000_000;

/**
 * Silence that ends a turn. The provider defaults to 500 ms, and this is the
 * single largest fixed cost in the wait for a reply: the boundary cannot fire
 * until that much silence has been observed, so it lands directly in the latency.
 *
 * Tried tightening this to 350 ms to shave the boundary and reverted: across
 * three measured turns it produced no final at all once, and the two that
 * completed were no faster (553 ms and 1660 ms boundaries, against 635 ms
 * before) because the wait is dominated by the provider's own processing rather
 * than by the configured threshold. Not worth a reliability regression for no
 * measurable gain.
 */
const SILENCE_DURATION_MS = 500;

/** One 100 ms frame of 16 kHz mono s16le, the shape the provider expects. */
const SILENCE_FRAME_BYTES = 16_000 * 2 * 0.1;

/**
 * Map our bare language codes onto the codes this endpoint accepts.
 *
 * Bare code → `xx-IN`. Unlike the legacy endpoint this one knows Odia as
 * `or-IN` (it renamed `od-IN`), and `auto` really is `auto` here rather than the
 * legacy `unknown` — so auto-detected turns get partials too.
 */
export function toSarvamStreamLanguageCode(code: string): string {
	const value = (code || '').trim().toLowerCase();
	if (!value || value === 'auto' || value === 'unknown') return 'auto';
	if (value.includes('-')) return value;
	// The mixed-code pseudo-languages lean on a base language for recognition;
	// the model still transcribes the code-mixed speech it hears.
	if (value === 'tanglish') return 'ta-IN';
	if (value === 'hinglish') return 'hi-IN';
	if (value === 'benglish') return 'bn-IN';
	if (value === 'gujlish') return 'gu-IN';
	return `${value}-IN`;
}

export function createSarvamStt(options: SttOptions): SttSession {
	const apiKey = env.SARVAM_API_KEY;
	if (!apiKey) {
		throw new HttpError(503, 'SARVAM_API_KEY is not configured', 'STT_NOT_CONFIGURED');
	}

	const query = new URLSearchParams({
		language_code: toSarvamStreamLanguageCode(options.language),
		model: 'saaras:v3-realtime',
		stream_type: 'fast',
		endpointing: 'vad',
		encoding: 'linear16',
		sample_rate: String(options.sampleRate),
		silence_duration_ms: String(SILENCE_DURATION_MS),
	});

	const socket = new WebSocket(`${SARVAM_STT_URL}?${query}`, {
		headers: { 'api-subscription-key': apiKey },
	});

	let closed = false;
	let opened = false;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	/** The last partial we surfaced, so a repeated one is not re-sent. */
	let lastPartial = '';
	/**
	 * Set between a client-initiated stop and the resulting final.
	 *
	 * Forcing the VAD boundary means feeding real silence, and the recogniser
	 * transcribes part of that silence as a re-hearing of the last words: a
	 * measured Tamil turn flashed "நாளை நாளைக்கு என்ன என்ன வேலை" on its way to the
	 * clean final "நாளைக்கு என்ன வேலை". The turn is over at that point — the final
	 * is what matters — so partials are dropped rather than shown garbled.
	 */
	let finalizing = false;

	const send = (payload: unknown): void => {
		if (closed || socket.readyState !== WebSocket.OPEN) return;
		try {
			socket.send(JSON.stringify(payload));
		} catch (err) {
			logger.warn({ err }, 'Sarvam STT send failed');
		}
	};

	const sendAudio = (pcm: Buffer): void => {
		send({ event: 'audio_input', audio: pcm.toString('base64') });
	};

	/**
	 * Silence pushed into the recogniser to force the VAD boundary.
	 *
	 * `flush` does NOT finalise under `endpointing=vad` — measured directly
	 * against the provider, it produced no `transcript.final` at all, despite the
	 * documentation saying it force-finalises buffered audio. Feeding real
	 * silence does work: `vad.speech_end` fires and the final follows. So a
	 * client-initiated "stop" is answered with silence rather than a flush.
	 */
	const pushSilence = (ms: number): void => {
		const frames = Math.ceil((options.sampleRate * 2 * ms) / 1000 / SILENCE_FRAME_BYTES);
		const silence = Buffer.alloc(SILENCE_FRAME_BYTES);
		for (let i = 0; i < frames; i++) sendAudio(silence);
	};

	socket.on('open', () => {
		opened = true;
		logger.info({ provider: 'sarvam', queuedBytes: pendingBytes }, 'Streaming STT socket open');
		for (const chunk of pending) sendAudio(chunk);
		pending = [];
		pendingBytes = 0;
		options.handlers.onOpen?.();
	});

	socket.on('message', (data: RawData) => {
		let message: any;
		try {
			message = JSON.parse(data.toString());
		} catch {
			return;
		}

		switch (message.event) {
			case 'transcript.partial': {
				if (finalizing) return;
				const text = String(message.text ?? '').trim();
				// The provider emits each partial two or three times over, and
				// sometimes restates a shorter hypothesis before extending it.
				// Forward only a genuine advance, so the client is not redrawn
				// with text that repeats or visibly goes backwards.
				if (text && text !== lastPartial && !lastPartial.startsWith(text)) {
					lastPartial = text;
					options.handlers.onPartial?.(text);
				}
				return;
			}
			case 'transcript.final': {
				const text = String(message.text ?? '').trim();
				lastPartial = '';
				finalizing = false;
				if (text) options.handlers.onFinal?.(text);
				return;
			}
			case 'vad.speech_start':
				options.handlers.onSpeechStart?.();
				return;
			case 'vad.speech_end':
				options.handlers.onSpeechEnd?.();
				return;
			case 'error': {
				const detail = message.message ?? message.code ?? 'unknown error';
				// A fatal error (quota/credits/auth) is followed by a 1003 close.
				// Report it through the close path, not here: the controller uses
				// the fatal close to decide whether to replay this turn into a
				// backup provider, and an STT_ERROR sent first would surface a
				// failure for a turn that is about to succeed. Measured: the
				// credits-exhausted error arrives ~75 ms before the 1003 close.
				if (message.is_fatal === true || message.is_fatal === 'true') {
					logger.warn(
						{
							provider: 'sarvam',
							code: message.code,
							statusCode: message.status_code,
							detail,
						},
						'Sarvam STT reported a fatal error; awaiting the close',
					);
					return;
				}
				options.handlers.onError?.(new Error(`Sarvam STT: ${detail}`));
				return;
			}
			default:
				// `session.begin`, `pong`, `config.updated`, `session.end` are
				// informational; nothing to do.
				return;
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
			sendAudio(pcm);
		},
		requestFinal(): void {
			// See pushSilence: `flush` is a no-op under VAD, so force the
			// boundary with real silence and let `vad.speech_end` finalise.
			finalizing = true;
			pushSilence(SILENCE_DURATION_MS + 400);
		},
		keepAlive(): void {
			// This endpoint documents `ping` and closes an inactive socket with
			// 1008, which the legacy endpoint gave us no way to prevent.
			send({ event: 'ping' });
		},
		close(): void {
			if (closed) return;
			closed = true;
			pending = [];
			pendingBytes = 0;
			try {
				if (socket.readyState === WebSocket.OPEN) {
					// `end` is the documented graceful close; it also reports the
					// billed audio duration back in `session.end`.
					send({ event: 'end' });
					socket.close(1000, 'session closed');
				} else {
					socket.terminate();
				}
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
