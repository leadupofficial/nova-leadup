/**
 * NOVA API — the lifecycle of one streaming STT socket.
 *
 * The provider socket outlives turns: it is opened on the first `start`,
 * reused for every later utterance (so the user can interrupt NOVA without the
 * client reconnecting) and closed exactly once when the voice session ends.
 * Keeping that ownership here means `session.ts` never has to reason about
 * provider close codes or "was this close mine?".
 *
 * Fallback
 * --------
 * A routed provider can reject a turn outright rather than blip: Sarvam answers
 * a depleted account with HTTP 402 "No credits available", an `is_fatal` error
 * event and then a 1003 "Credits exhausted" close. Reconnecting to Sarvam would
 * fail identically and the utterance would simply be lost. When the close is
 * fatal — the existing `isFatalProviderClose` rule the provider sessions
 * already apply, never a second classification — this controller opens a
 * Deepgram `nova-3` session, replays the audio already received for the turn
 * into it, and reports the switch.
 *
 * The boundaries that keep that honest:
 *  - It fires only on a *fatal* close (4xxx / 1003 / 1008). A transient network
 *    drop does not change recogniser.
 *  - Only a non-Deepgram session has a fallback target, so an English turn that
 *    loses Deepgram fails the way it always did instead of falling back to
 *    itself.
 *  - At most once per turn. If the fallback also rejects the turn, that is an
 *    ordinary STT error, not another attempt.
 *  - The next `start` re-opens the *routed* provider, so a degraded Sarvam never
 *    becomes a silent Deepgram primary: every turn tries Sarvam first, and the
 *    fallback is re-decided per turn.
 */
import { logger } from '../../utils/logger.js';
import { INPUT_SAMPLE_RATE } from '../protocol.js';
import { createSttSession, type SttSession } from './index.js';
import { resolveSttProvider, type SttProviderName } from './types.js';

/**
 * Audio kept for replay: ~30 s of 16 kHz mono s16le, matching the providers'
 * own pre-open queue ceiling. Longer utterances lose their earliest audio from
 * the replay only; the live session still receives every frame.
 */
const MAX_REPLAY_BYTES = 1_000_000;

export interface SttFallbackInfo {
	from: SttProviderName;
	to: SttProviderName;
	code: number;
	/** Client-facing explanation, already formatted and length-capped. */
	message: string;
}

export interface SttControllerOptions {
	userId: string;
	/** Interim transcript from the provider. */
	onPartial(text: string): void;
	/** The provider decided the utterance ended. */
	onFinal(text: string): void;
	/** Provider VAD says the user started speaking (barge-in cue). */
	onSpeechStart(): void;
	/** A provider-side error, already human-readable. */
	onError(err: unknown): void;
	/** The provider dropped the stream; `fatal` codes must not be retried. */
	onDisconnected(provider: string, code: number, reason: string, fatal: boolean): void;
	/** A backup recogniser is now transcribing this turn. */
	onFallback?(info: SttFallbackInfo): void;
}

/**
 * The backup provider for a routed one, or `null` when there is nothing to fall
 * back to. Deepgram is the only backup this service can open; falling back from
 * Deepgram to Deepgram would just replay the same failure.
 */
function fallbackTarget(provider: SttProviderName): SttProviderName | null {
	return provider === 'deepgram' ? null : 'deepgram';
}

export class SttController {
	private session: SttSession | null = null;
	private language: string | null = null;
	/** True while `session` is a fallback rather than the routed provider. */
	private fallbackActive = false;
	/** True once this turn has spent its single fallback. */
	private fellBack = false;
	/** Audio of the current utterance, replayed if the provider rejects it. */
	private replay: Buffer[] = [];
	private replayBytes = 0;
	private replayCapped = false;
	/** Set by `requestFinal`, re-sent if the fallback socket is not open yet. */
	private finalRequested = false;

	constructor(private readonly options: SttControllerOptions) {}

	/** True when a usable provider socket exists. */
	get active(): boolean {
		return !!this.session && !this.session.closed;
	}

	get provider(): string | null {
		return this.session?.provider ?? null;
	}

	/** Opens a socket for `language`, reusing the current one when it matches. */
	ensure(language: string): void {
		// Every `start` begins a new utterance: the previous turn's replay
		// buffer and fallback budget must not carry over.
		this.resetTurn();

		// Reuse the routed socket for the same language — except when it is a
		// fallback. The next turn has to try the routed provider again, so a
		// temporarily dead Sarvam never becomes a silent Deepgram primary.
		if (this.session && !this.session.closed && this.language === language && !this.fallbackActive) return;

		this.close();
		this.language = language;
		this.open(language, resolveSttProvider(language), false);
	}

	/**
	 * Open a provider session. `provider` is the session to construct and
	 * `fallback` marks it as a backup rather than the routed choice; normal
	 * turns derive `provider` from `resolveSttProvider`, so routing is unchanged.
	 */
	private open(language: string, provider: SttProviderName, fallback: boolean): SttSession {
		// Captured so the handlers can tell a close we asked for from a drop.
		const session = createSttSession(
			{
				language,
				sampleRate: INPUT_SAMPLE_RATE,
				handlers: {
					onOpen: () => {
						if (this.session !== session) return;
						// A `requestFinal` sent while this socket was still
						// handshaking was dropped; now it can reach the provider.
						if (this.finalRequested) session.requestFinal();
					},
					onPartial: (text) => {
						if (this.session === session) this.options.onPartial(text);
					},
					onFinal: (text) => {
						if (this.session !== session) return;
						// The utterance is done, so its replay buffer is spent.
						this.resetTurn();
						this.options.onFinal(text);
					},
					onSpeechStart: () => {
						if (this.session === session) this.options.onSpeechStart();
					},
					onError: (err) => {
						if (this.session === session) this.options.onError(err);
					},
					onClose: (code, reason, fatal) => {
						// `close()` nulls `this.session` first, so anything still
						// current here is the provider dropping the stream under us.
						if (this.session !== session) return;
						this.session = null;
						logger.warn(
							{ userId: this.options.userId, provider: session.provider, code, reason, fatal },
							'STT provider closed',
						);
						this.handleClose(session.provider, code, reason, fatal);
					},
				},
			},
			provider,
		);
		this.session = session;
		this.fallbackActive = fallback;
		this.fellBack = fallback;
		return session;
	}

	/** A routed provider dropped us: fall back once on a fatal rejection, else report it. */
	private handleClose(from: SttProviderName, code: number, reason: string, fatal: boolean): void {
		const target = fatal && !this.fellBack ? fallbackTarget(from) : null;
		if (target && this.language) {
			this.fellBack = true;
			this.startFallback(from, target, code, reason);
			return;
		}
		// Terminal: nothing else can serve this turn.
		this.fallbackActive = false;
		this.language = null;
		this.options.onDisconnected(from, code, reason, fatal);
	}

	/**
	 * Move the turn to the backup recogniser. The close code was already
	 * classified fatal by the provider session, so this is an auth/quota
	 * rejection, not a network blip.
	 */
	private startFallback(from: SttProviderName, to: SttProviderName, code: number, reason: string): void {
		const language = this.language;
		if (!language) {
			this.options.onDisconnected(from, code, reason, true);
			return;
		}

		logger.warn(
			{ userId: this.options.userId, provider: from, fallback: to, code, reason },
			'STT provider rejected the turn — falling back to the backup recogniser',
		);

		let session: SttSession;
		try {
			session = this.open(language, to, true);
		} catch (err) {
			// The backup could not even be constructed (missing key, bad config).
			const detail = err instanceof Error ? err.message : String(err);
			logger.warn({ err, provider: from, fallback: to }, 'STT fallback could not be opened');
			this.fallbackActive = false;
			this.language = null;
			this.options.onDisconnected(from, code, `${reason} (fallback unavailable: ${detail})`, true);
			return;
		}

		// Say what the client is being switched to, and why, without the raw
		// provider text being able to bloat the frame.
		const message = reason
			? `${from} closed the stream (${code}): ${reason}`
			: `${from} closed the stream (${code})`;
		this.options.onFallback?.({ from, to, code, message: message.slice(0, 300) });

		// Replay what the user already said. The fallback queues it until its own
		// handshake completes, so nothing is lost while it connects.
		for (const chunk of this.replay) session.sendAudio(chunk);
		this.replay = [];
		this.replayBytes = 0;
		this.replayCapped = false;
	}

	sendAudio(pcm: Buffer): void {
		if (!this.session) return;
		// Keep this utterance's audio so a fatal rejection can be replayed into
		// the fallback. After the turn has fallen back nothing else can consume
		// it, so buffering stops there.
		if (!this.fellBack) {
			if (this.replayBytes + pcm.length <= MAX_REPLAY_BYTES) {
				this.replay.push(Buffer.from(pcm));
				this.replayBytes += pcm.length;
			} else if (!this.replayCapped) {
				this.replayCapped = true;
				logger.warn(
					{ userId: this.options.userId, cap: MAX_REPLAY_BYTES },
					'STT replay buffer full — the start of this turn cannot be replayed',
				);
			}
		}
		this.session.sendAudio(pcm);
	}

	/** Client pressed stop: finalise what the provider has buffered. */
	requestFinal(): void {
		this.finalRequested = true;
		this.session?.requestFinal();
	}

	keepAlive(): void {
		this.session?.keepAlive();
	}

	/** Called at the start of every utterance and once one is transcribed. */
	private resetTurn(): void {
		this.replay = [];
		this.replayBytes = 0;
		this.replayCapped = false;
		this.finalRequested = false;
	}

	/** Idempotent teardown; never throws. */
	close(): void {
		const session = this.session;
		this.session = null;
		this.language = null;
		this.fallbackActive = false;
		this.fellBack = false;
		this.resetTurn();
		if (!session || session.closed) return;
		try {
			session.close();
		} catch (err) {
			logger.warn({ err }, 'Failed to close STT session');
		}
	}
}
