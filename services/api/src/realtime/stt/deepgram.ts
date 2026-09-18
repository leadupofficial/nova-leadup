/**
 * NOVA API — Deepgram streaming STT (English).
 *
 * Wire format, verified against production:
 *   wss://api.deepgram.com/v1/listen
 *   header  Authorization: Token <DEEPGRAM_API_KEY>
 *   query   model=nova-2|nova-3&encoding=linear16&sample_rate=16000&channels=1
 *           &interim_results=true&punctuate=true&smart_format=true&endpointing=300
 *   send    raw PCM binary frames
 *   recv    JSON where type==='Results' carries channel.alternatives[0].transcript
 *           and the is_final / speech_final flags.
 *
 * English uses `nova-2`; every other language selects `nova-3`, which is the
 * model that covers the Indic languages — see `toDeepgramModel`.
 *
 * `is_final` marks a segment the recogniser will not revise again; `speech_final`
 * is Deepgram's endpointing deciding the speaker stopped — that is end-of-turn.
 */
import { WebSocket } from 'ws';
import type { RawData } from 'ws';
import { env } from '../../utils/env.js';
import { HttpError } from '../../middleware/error-handler.js';
import { logger } from '../../utils/logger.js';
import { isFatalProviderClose } from '../protocol.js';
import type { SttOptions, SttSession } from './types.js';

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';

/** ~30 s of 16 kHz mono s16le. Only reached if the provider handshake stalls. */
const MAX_PENDING_BYTES = 1_000_000;

/**
 * The model carries the language. English has always used `nova-2` and keeps
 * it; everything else selects `nova-3`, which is the only streaming model that
 * actually knows the Indic languages. Measured against a real Tamil clip:
 * `nova-2` + `language=ta` is rejected with HTTP 400 before the socket opens,
 * while `nova-3` + `language=ta` returns the correct transcript. This matters
 * most on the fallback path, where a Deepgram session is opened for a language
 * the normal routing would have sent to Sarvam.
 */
function toDeepgramModel(language: string): 'nova-2' | 'nova-3' {
	const bare = (language || 'en').trim().toLowerCase();
	if (!bare || bare === 'en' || bare.startsWith('en-')) return 'nova-2';
	return 'nova-3';
}

/**
 * Deepgram wants BCP-47-ish tags; bare `en` is not accepted for English.
 *
 * `auto`/`unknown` map to `multi`, nova-3's streaming multilingual mode — the
 * closest thing to auto-detection Deepgram offers, since streaming
 * `detect_language` is rejected with HTTP 400 (measured). `multi` is
 * best-effort on code-mixed speech: on a *pure* Tamil clip it transliterates
 * into Devanagari. That is acceptable here because the client sends an explicit
 * code (`ta`/`hi`) for those languages and reserves `auto` for the mixed
 * long tail the app cannot name.
 */
function toDeepgramLanguage(language: string): string | null {
	const bare = (language || 'en').trim().toLowerCase();
	if (!bare) return null;
	if (bare === 'auto' || bare === 'unknown') return 'multi';
	if (bare.includes('-')) return bare;
	if (bare === 'en') return 'en-US';
	// Mixed-code pseudo-languages lean on a base language, mirroring the Sarvam
	// stream mapping so a fallback recognises the code-mixed speech it hears.
	if (bare === 'tanglish') return 'ta-IN';
	if (bare === 'hinglish') return 'hi-IN';
	if (bare === 'benglish') return 'bn-IN';
	if (bare === 'gujlish') return 'gu-IN';
	return bare;
}

export function createDeepgramStt(options: SttOptions): SttSession {
	const apiKey = env.DEEPGRAM_API_KEY;
	if (!apiKey) {
		throw new HttpError(503, 'DEEPGRAM_API_KEY is not configured', 'STT_NOT_CONFIGURED');
	}

	const query = new URLSearchParams({
		model: toDeepgramModel(options.language),
		encoding: 'linear16',
		sample_rate: String(options.sampleRate),
		channels: '1',
		interim_results: 'true',
		punctuate: 'true',
		smart_format: 'true',
		// 300 ms of trailing silence ends a turn — short enough to feel live,
		// long enough not to cut the user off mid-thought.
		endpointing: '300',
	});
	const language = toDeepgramLanguage(options.language);
	if (language) query.set('language', language);

	const socket = new WebSocket(`${DEEPGRAM_URL}?${query}`, {
		headers: { Authorization: `Token ${apiKey}` },
	});

	let closed = false;
	let opened = false;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let committed = '';
	let lastSegment = '';
	let inUtterance = false;

	const send = (payload: unknown): void => {
		if (closed || socket.readyState !== WebSocket.OPEN) return;
		try {
			socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
		} catch (err) {
			logger.warn({ err }, 'Deepgram send failed');
		}
	};

	socket.on('open', () => {
		opened = true;
		logger.info({ provider: 'deepgram', queuedBytes: pendingBytes }, 'Streaming STT socket open');
		for (const chunk of pending) socket.send(chunk, { binary: true });
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

		if (message.type === 'Results') {
			const text: string = (message.channel?.alternatives?.[0]?.transcript ?? '').trim();

			if (text && !inUtterance && !message.is_final) {
				// First reviseable interim of a new utterance: this is the
				// earliest reliable "the user has started speaking" signal
				// Deepgram gives, and it is what drives barge-in.
				inUtterance = true;
				options.handlers.onSpeechStart?.();
			}

			if (text) {
				if (message.is_final) {
					// Deepgram can repeat the same segment on the message that
					// also carries speech_final; do not count it twice.
					if (text !== lastSegment) {
						committed = committed ? `${committed} ${text}` : text;
						lastSegment = text;
					}
					options.handlers.onPartial?.(committed);
				} else {
					options.handlers.onPartial?.(committed ? `${committed} ${text}` : text);
				}
			}

			if (message.speech_final || message.from_finalize === true) {
				// `speech_final` is endpointing deciding the speaker stopped.
				// `from_finalize` is the answer to our explicit `Finalize` (the
				// client pressed stop, or a provider fallback replayed a turn
				// that already ended). Measured: Finalize returns
				// `is_final:true, speech_final:false, from_finalize:true`, so
				// gating on `speech_final` alone silently produced no turn at
				// all when the stop was what ended the utterance.
				const full = committed.trim();
				committed = '';
				lastSegment = '';
				inUtterance = false;
				if (full) options.handlers.onFinal?.(full);
				else options.handlers.onSpeechEnd?.();
			}
			return;
		}

		if (message.type === 'UtteranceEnd') {
			inUtterance = false;
			options.handlers.onSpeechEnd?.();
			return;
		}

		if (message.type === 'Error' || message.error) {
			options.handlers.onError?.(new Error(`Deepgram: ${message.description ?? message.error ?? 'unknown error'}`));
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
		provider: 'deepgram',
		get closed() {
			return closed;
		},
		sendAudio(pcm: Buffer): void {
			if (closed || !pcm.length) return;
			if (!opened) {
				if (pendingBytes + pcm.length > MAX_PENDING_BYTES) return;
				pending.push(pcm);
				pendingBytes += pcm.length;
				return;
			}
			try {
				socket.send(pcm, { binary: true });
			} catch (err) {
				logger.warn({ err }, 'Deepgram audio send failed');
			}
		},
		requestFinal(): void {
			send({ type: 'Finalize' });
		},
		keepAlive(): void {
			send({ type: 'KeepAlive' });
		},
		close(): void {
			if (closed) return;
			closed = true;
			pending = [];
			pendingBytes = 0;
			try {
				if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'CloseStream' }));
				socket.close(1000, 'session closed');
			} catch {
				/* already gone */
			}
			// The provider can ignore the close frame; do not leak the handle.
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
