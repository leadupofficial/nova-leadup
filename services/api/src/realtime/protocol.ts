/**
 * NOVA API — Realtime voice WebSocket protocol.
 *
 * This is the frozen wire contract for `GET /api/v1/voice/realtime` (upgraded to
 * a WebSocket). One socket carries a whole spoken conversation: microphone PCM
 * up, interim transcripts / LLM tokens / MP3 audio down.
 *
 * Client → server
 *   binary frame                   16 kHz mono signed-16-bit little-endian PCM
 *   {"type":"start","language":"ta"} begin a turn (`en`/`ta`/`hi`/… or `auto`)
 *   {"type":"stop"}                  user pressed stop — finalise the utterance now
 *   {"type":"text","text":"…"}       typed input through the same pipeline
 *   {"type":"cancel"}                abort the turn in flight
 *
 * Server → client
 *   {"type":"ready"}
 *   {"type":"stt","provider":"deepgram","fallback":true,"reason":"…"}
 *                                    the routed recogniser rejected this turn
 *                                    (auth/quota/credit) and a backup is now
 *                                    transcribing it — not sent when the routed
 *                                    provider is serving the turn normally
 *   {"type":"tts","provider":"deepgram","fallback":true,"reason":"…"}
 *                                    the routed synthesiser rejected this turn
 *                                    and the Deepgram cloud voice is speaking it
 *                                    — sent at most once per turn, and never
 *                                    when the device voice had to take over
 *   {"type":"partial","text":"…"}    interim transcript while the user speaks
 *   {"type":"final","text":"…"}      end-of-turn transcript
 *   {"type":"token","text":"…"}      LLM delta
 *   {"type":"sentence","text":"…","index":N}  one sentence handed to TTS
 *   binary frame                    MP3 audio for the current sentence
 *   {"type":"speaking","value":true|false}
 *   {"type":"done","text":"…"}       the full reply
 *   {"type":"error","code":"…","message":"…"}
 *
 * `speaking:false` is the single, unambiguous "flush your player now" signal:
 * it is sent whenever the server stops producing audio for a turn — normal end,
 * cancellation, barge-in or error.
 */
import { z } from 'zod';

/** Path this socket is served on. Also the upgrade path checked in `index.ts`. */
export const REALTIME_PATH = '/api/v1/voice/realtime';

/** The protocol only accepts this input format — see the client contract above. */
export const INPUT_SAMPLE_RATE = 16_000;
export const INPUT_CHANNELS = 1;
export const INPUT_BITS_PER_SAMPLE = 16;

/** Client → server JSON. Unknown types and bad shapes are answered with an error. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('start'),
		// Bare ISO code (`en`, `ta`, `hi`) or `auto`. Region-tagged codes are
		// tolerated and normalised by the provider layer.
		language: z.string().min(1).max(24).optional(),
	}),
	z.object({ type: z.literal('stop') }),
	z.object({ type: z.literal('text'), text: z.string().min(1).max(4000) }),
	z.object({ type: z.literal('cancel') }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerEvent =
	| { type: 'ready' }
	| { type: 'stt'; provider: string; fallback: boolean; reason: string }
	| { type: 'tts'; provider: string; fallback: boolean; reason: string }
	| { type: 'partial'; text: string }
	| { type: 'final'; text: string }
	| { type: 'token'; text: string }
	| { type: 'sentence'; text: string; index: number }
	/**
	 * A write tool ran during this turn. `summary` is the server's one-line
	 * statement of what happened, so the app can acknowledge the action while
	 * the reply is still being written — a voice user who says "remind me"
	 * otherwise gets no sign that anything was recorded until the answer.
	 */
	| { type: 'tool'; name: string; ok: boolean; summary: string }
	| { type: 'speaking'; value: boolean }
	| { type: 'done'; text: string }
	| { type: 'error'; code: string; message: string };

/** Default turn language when the client sends `start` without one. */
export const DEFAULT_LANGUAGE = 'en';

/**
 * Close codes we treat as "operator problem, do not retry": Deepgram uses
 * 4001/4008/4029 for bad credentials and quota, Sarvam documents 4xxx for
 * application errors (auth/quota) and 1003 for invalid subscription key.
 * Nothing in this server auto-reconnects, but classifying the code lets the
 * client be told whether retrying is pointless.
 */
export function isFatalProviderClose(code: number): boolean {
	return (code >= 4000 && code <= 4999) || code === 1003 || code === 1008;
}
