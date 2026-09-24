/**
 * NOVA API — one live voice conversation over one WebSocket.
 *
 * Shape of a turn:
 *
 *   mic PCM ──▶ STT socket ──▶ partial* / final ──▶ LLM (SSE, token by token)
 *                                                     │
 *                        sentence chunker ◀───────────┘
 *                                │
 *                                ▼
 *                          TTS stream ──▶ MP3 binary frames ──▶ client
 *
 * The reply is synthesised sentence by sentence while the model is still
 * generating, so audio starts long before the full answer exists. Barge-in
 * works because the STT socket stays open during playback: provider VAD (or a
 * sustained-energy fallback) aborts the LLM stream and the in-flight TTS fetch
 * the moment the user starts speaking again.
 *
 * Grounding is identical to the REST voice route — `buildUserContext` +
 * `composeSystemPrompt` + the same tool loop — so a spoken "remind me to…"
 * still creates a reminder.
 */
import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { toAssistantError } from '../services/assistant.js';
import { ClientMessageSchema, DEFAULT_LANGUAGE } from './protocol.js';
import type { ClientMessage, ServerEvent } from './protocol.js';
import { EnergyBargeIn, MAX_SOCKET_BUFFER_BYTES, sleep } from './audio.js';
import { isSupportedLanguage, normalizeLanguage } from './language.js';
import { SttController, type SttUtteranceUsage } from './stt/controller.js';
import { isAbortError } from './llm.js';
import { runReply } from './reply.js';
import { ToolApprovalBroker } from './tool-approval.js';
import { logTurnCost, INPUT_BYTES_PER_SECOND } from './cost.js';
import { recordSttUsage, recordTtsUsage, planRealtimeTurn } from '../services/voice-usage.js';
import {
	authorizeUsage,
	recordUsage,
	USAGE_METRICS,
	type QuotaDecision,
} from '../entitlements/index.js';
import type { ChatMessage } from '../services/ai.js';

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface RealtimeUser {
	id: string;
	email: string;
	role: string;
}

/** No client activity for this long and the socket is closed and cleaned up. */
const IDLE_TIMEOUT_MS = 120_000;
/** Deepgram drops a silent socket (~10s); nudge it well inside that window. */
const KEEPALIVE_INTERVAL_MS = 5_000;
/**
 * How long audio must be absent before a hands-free turn is closed for the
 * user. Long enough not to cut off a mid-sentence pause, short enough that
 * the reply still feels immediate.
 */
const END_OF_SPEECH_SILENCE_MS = 900;
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_HISTORY_MESSAGES = 12;

interface ActiveTurn {
	id: number;
	controller: AbortController;
	reply: string;
}

export class RealtimeVoiceSession {
	private readonly socket: WebSocket;
	private readonly user: RealtimeUser;

	private phase: Phase = 'idle';
	private language = DEFAULT_LANGUAGE;
	private readonly stt: SttController;
	private readonly energy = new EnergyBargeIn();

	private activeTurn: ActiveTurn | null = null;
	private turnSeq = 0;
	private speaking = false;
	/** STT usage of the utterance that produced the turn now starting. */
	private pendingStt: SttUtteranceUsage | null = null;

	private history: ChatMessage[] = [];

	private closed = false;
	private alive = true;
	private lastAudioAt = Date.now();

	/**
	 * Last time anything at all went to the STT provider — audio *or* a keepalive.
	 *
	 * Keepalives must be paced from this, not from `lastAudioAt`. Deepgram closes
	 * an idle stream with 1011 after roughly ten seconds without audio, and
	 * gating on `lastAudioAt` meant the first keepalive could arrive up to two
	 * intervals (~16s) after the user stopped talking — after the provider had
	 * already given up. That surfaced as a spurious STT_DISCONNECTED error at the
	 * end of an otherwise successful turn, because NOVA spends the whole reply
	 * not sending microphone audio.
	 */
	private lastSendAt = this.lastAudioAt;

	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private endOfSpeechTimer: ReturnType<typeof setTimeout> | null = null;
	private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	/**
	 * Confirms side-effecting tools before they run (§5.7).
	 *
	 * Per-session, and the only route by which the tool loop can learn the
	 * user's answer: without it, the loop refuses to run a tool it cannot
	 * confirm rather than executing it.
	 */
	private readonly approvals = new ToolApprovalBroker({
		emit: (event) => this.send(event),
	});

	constructor(socket: WebSocket, user: RealtimeUser) {
		this.socket = socket;
		this.user = user;

		// The provider socket outlives individual turns so the user can barge in
		// without the client reconnecting; the controller owns its lifecycle.
		this.stt = new SttController({
			userId: user.id,
			onPartial: (text) => {
				if (this.phase === 'listening' || this.phase === 'idle') {
					this.send({ type: 'partial', text });
				}
			},
			onFinal: (text) => {
				// Snapshot the utterance's STT usage before the next turn resets it.
				this.pendingStt = this.stt.lastUtteranceUsage();
				void this.beginTurn(text);
			},
			onSpeechStart: () => {
				// Provider VAD is authoritative for barge-in.
				this.bargeIn('provider-vad');
			},
			onError: (err) => {
				this.reportError('STT_ERROR', err);
			},
			// Say so out loud: this turn is on a backup recogniser. The controller
			// already logged the routed provider, close code and reason at warn.
			onFallback: (info) => this.send({ type: 'stt', provider: info.to, fallback: true, reason: info.message }),
			onDisconnected: (provider, code, reason, fatal) => {
				this.reportError(
					fatal ? 'STT_PROVIDER_REJECTED' : 'STT_DISCONNECTED',
					new Error(`${provider} closed the stream (${code})${reason ? `: ${reason}` : ''}`),
				);
			},
		});
	}

	// ─── Lifecycle ─────────────────────────────────────────────────────

	start(): void {
		this.socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
			// **A throw in here used to kill the whole API process.**
			//
			// `socket.on('message', …)` is an EventEmitter listener: nothing above it
			// catches, so a synchronous throw becomes an uncaught exception and Node
			// exits. And this path throws by design when a provider is not configured —
			// `createSttSession` raises `HttpError(503, 'SARVAM_API_KEY is not
			// configured')`, reached through `handleAudio` → the STT controller. The
			// observed result, on a deployment without the key: the first voice turn from
			// the first user terminated the server for everybody, and the log ended with
			//
			//     throw new HttpError(503, 'SARVAM_API_KEY is not configured', …)
			//     HttpError: SARVAM_API_KEY is not configured
			//
			// A voice feature that cannot start should tell that one user and leave the
			// process alone, so this reports the failure on the socket and ends the
			// session.
			try {
				this.touch();
				if (isBinary) {
					const buffer = Buffer.isBuffer(data)
						? data
						: Array.isArray(data)
							? Buffer.concat(data)
							: Buffer.from(data);
					this.handleAudio(buffer);
					return;
				}
				this.handleJson(Buffer.isBuffer(data) ? data.toString() : String(data));
			} catch (err) {
				this.reportError('SESSION_ERROR', err);
				this.dispose('handler-error');
			}
		});

		this.socket.on('pong', () => {
			this.alive = true;
		});

		this.socket.on('error', (err: Error) => {
			logger.warn({ err, userId: this.user.id }, 'Realtime socket error');
			this.dispose('socket-error');
		});

		this.socket.on('close', () => {
			this.dispose('client-close');
		});

		this.keepAliveTimer = setInterval(() => this.maybeKeepAlive(), KEEPALIVE_INTERVAL_MS);
		this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_INTERVAL_MS);
		this.touch();

		this.send({ type: 'ready' });
		logger.info({ userId: this.user.id }, 'Realtime voice session opened');
	}

	dispose(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.clearTimers();
		this.abortActiveTurn();
		this.endSpeaking();
		this.stt.close();
		try {
			if (this.socket.readyState === 1) this.socket.close(1000, 'session ended');
		} catch {
			/* already gone */
		}
		logger.info(
			{ userId: this.user.id, reason, turns: this.turnSeq, history: this.history.length },
			'Realtime voice session closed',
		);
	}

	private clearTimers(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		if (this.endOfSpeechTimer) clearTimeout(this.endOfSpeechTimer);
		this.idleTimer = null;
		this.keepAliveTimer = null;
		this.heartbeatTimer = null;
		this.endOfSpeechTimer = null;
	}

	/** Idle timeout: a forgotten socket must not hold a provider connection. */
	private touch(): void {
		if (this.closed) return;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			if (this.closed) return;
			this.send({ type: 'error', code: 'IDLE_TIMEOUT', message: 'Voice session timed out after inactivity.' });
			this.dispose('idle-timeout');
		}, IDLE_TIMEOUT_MS);
		const timer = this.idleTimer as unknown as { unref?: () => void };
		timer.unref?.();
	}

	private maybeKeepAlive(): void {
		if (this.closed || !this.stt.active) return;
		// Paced from the last thing we sent, so consecutive keepalives keep the
		// gap inside the provider's idle window rather than resting on audio age.
		if (Date.now() - this.lastSendAt < KEEPALIVE_INTERVAL_MS) return;
		this.lastSendAt = Date.now();
		this.stt.keepAlive();
	}

	private heartbeat(): void {
		if (this.closed) return;
		if (!this.alive) {
			logger.warn({ userId: this.user.id }, 'Realtime socket missed a heartbeat — terminating');
			try {
				this.socket.terminate();
			} catch {
				/* already gone */
			}
			this.dispose('heartbeat-timeout');
			return;
		}
		this.alive = false;
		try {
			this.socket.ping();
		} catch {
			/* already gone */
		}
	}

	// ─── Transport ─────────────────────────────────────────────────────

	private send(event: ServerEvent): void {
		if (this.closed) return;
		try {
			if (this.socket.readyState === 1) this.socket.send(JSON.stringify(event));
		} catch (err) {
			logger.warn({ err }, 'Realtime send failed');
		}
	}

	private reportError(code: string, err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn({ err, code, userId: this.user.id }, 'Realtime session error');
		this.send({ type: 'error', code, message: message.slice(0, 300) });
	}

	// ─── Client messages ───────────────────────────────────────────────

	private handleJson(raw: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			this.send({ type: 'error', code: 'BAD_MESSAGE', message: 'Expected a JSON object.' });
			return;
		}

		const result = ClientMessageSchema.safeParse(parsed);
		if (!result.success) {
			this.send({
				type: 'error',
				code: 'BAD_MESSAGE',
				message: result.error.errors[0]?.message ?? 'Unrecognised message.',
			});
			return;
		}
		this.handleClientMessage(result.data);
	}

	private handleClientMessage(message: ClientMessage): void {
		switch (message.type) {
			case 'start': {
				const language = normalizeLanguage(message.language);
				if (!isSupportedLanguage(language)) {
					this.send({
						type: 'error',
						code: 'UNSUPPORTED_LANGUAGE',
						message: `Language '${message.language}' is not supported.`,
					});
					return;
				}
				this.language = language;
				this.stt.ensure(language);
				this.phase = 'listening';
				this.energy.reset();
				logger.info({ userId: this.user.id, language }, 'Realtime turn started');
				return;
			}
			case 'stop': {
				// Manual end-of-turn: ask the provider to finalise what it has.
				this.stt.requestFinal();
				return;
			}
			case 'text': {
				// Typed input runs the identical pipeline, minus STT.
				this.abortActiveTurn();
				this.endSpeaking();
				this.phase = 'idle';
				void this.beginTurn(message.text);
				return;
			}
			case 'cancel': {
				const partial = this.activeTurn?.reply ?? '';
				this.abortActiveTurn();
				this.endSpeaking();
				this.phase = this.stt.active ? 'listening' : 'idle';
				this.send({ type: 'done', text: partial });
				return;
			}
			case 'approval_response': {
				// The user answered the confirmation sheet. A response for an id
				// this socket is not waiting on is ignored rather than treated as
				// a failure: the turn may already have been cancelled, and the
				// tool then simply does not run.
				this.approvals.respond(message);
				return;
			}
			default:
				return;
		}
	}

	// ─── Audio in ──────────────────────────────────────────────────────

	private handleAudio(pcm: Buffer): void {
		if (this.closed || !pcm.length) return;
		this.lastAudioAt = Date.now();
		// Tracked alongside audio so a keepalive is not sent on top of audio that
		// is already flowing, which is what the provider's idle timer measures.
		this.lastSendAt = this.lastAudioAt;
		if (!this.stt.active) return;

		this.stt.sendAudio(pcm);
		this.armEndOfSpeech();

		// Energy fallback for barge-in: works even when the provider's VAD
		// signal is late or absent (Deepgram has no speech_start event at all).
		if ((this.phase === 'thinking' || this.phase === 'speaking') && this.energy.observe(pcm)) {
			this.bargeIn('energy');
		}
	}

	/**
	 * Backstop for hands-free turns.
	 *
	 * A provider ends an utterance on silence it can *see in the audio*, so a
	 * client that simply stops sending frames — a paused microphone, a dropped
	 * uplink — leaves the turn open indefinitely and the user gets no reply
	 * unless they press stop. Measured: a client that streamed a whole sentence
	 * and then went quiet produced zero turns across two minutes. If audio stops
	 * arriving while listening, force the boundary the way an explicit stop does.
	 */
	private armEndOfSpeech(): void {
		if (this.phase !== 'listening') return;
		if (this.endOfSpeechTimer) clearTimeout(this.endOfSpeechTimer);
		const timer = setTimeout(() => {
			this.endOfSpeechTimer = null;
			if (this.closed || this.phase !== 'listening' || !this.stt.active) return;
			if (Date.now() - this.lastAudioAt < END_OF_SPEECH_SILENCE_MS) return;
			this.stt.requestFinal();
		}, END_OF_SPEECH_SILENCE_MS + 200);
		timer.unref?.();
		this.endOfSpeechTimer = timer;
	}

	// ─── Turn pipeline ─────────────────────────────────────────────────

	private isStale(turnId: number): boolean {
		return this.closed || !this.activeTurn || this.activeTurn.id !== turnId || this.activeTurn.controller.signal.aborted;
	}

	private abortActiveTurn(): void {
		const turn = this.activeTurn;
		this.activeTurn = null;
		if (!turn) return;
		// Release anything this turn was waiting on before it is dropped. The
		// tool does not run: an interrupted turn is not an approval, and leaving
		// the request outstanding would hold the loop until its timeout.
		const cancelled = this.approvals.cancelTurn(turn.id);
		if (cancelled) {
			logger.info(
				{ userId: this.user.id, turnId: turn.id, approvals: cancelled },
				'Turn aborted with approvals outstanding — refusing them',
			);
		}
		try {
			turn.controller.abort();
		} catch {
			/* already aborted */
		}
	}

	/** Cut off the reply in flight because the user started talking again. */
	private bargeIn(source: string): void {
		if (this.phase !== 'thinking' && this.phase !== 'speaking') return;
		if (!this.activeTurn) return;
		logger.info({ userId: this.user.id, source }, 'Barge-in — cancelling the reply in flight');
		const partial = this.activeTurn.reply ?? '';
		this.abortActiveTurn();
		this.endSpeaking();
		this.phase = 'listening';
		this.energy.reset();
		// The turn is over, so it needs the same terminal frame the client's
		// `cancel` gets. `endSpeaking()` alone sends `speaking:false`, which the
		// client reads as "the reply stopped — now thinking": with no `done` after
		// it, a barge-in that turns out to carry no new utterance (a door, a
		// cough, a clip that ends) left the handset showing "Thinking…" with the
		// reply already on screen, until the user spoke again. Committing the
		// partial is what `cancel` already does, so the two paths agree.
		this.send({ type: 'done', text: partial });
	}

	private async beginTurn(rawText: string): Promise<void> {
		const text = rawText.trim();
		// Consume the snapshot either way, so a later typed turn cannot inherit it.
		const sttUsage = this.pendingStt;
		this.pendingStt = null;
		if (this.closed || !text) return;

		// A final arriving mid-reply is a barge-in that the provider already
		// transcribed for us: drop the superseded turn and take this one.
		this.abortActiveTurn();
		this.energy.reset();
		this.send({ type: 'final', text });

		// ── Entitlement gate ───────────────────────────────────────────────
		// The brief requires hard limits to be enforced server-side by
		// entitlements, "never by prompting the model to behave within a limit".
		// So the check happens here, before a single model or TTS token is paid
		// for, and the refusal is a stable machine-readable code — the model is
		// never told a limit exists.
		//
		// `amount: 1` is a "is there any allowance left?" probe, because the
		// length of this turn is not known until it is over; the true seconds are
		// metered after it (see `recordTurnUsage`). Worst case a caller overruns
		// the plan by one turn, which is the honest trade for not refusing a turn
		// mid-sentence.
		const quota = await this.authorizeVoiceTurn();
		if (quota && !quota.allowed) {
			logger.info(
				{ userId: this.user.id, plan: quota.plan, used: quota.used, limit: quota.limit },
				'Realtime voice turn refused: voice allowance exhausted',
			);
			this.phase = 'idle';
			this.send({
				type: 'error',
				code: quota.code,
				message:
					`Voice allowance reached for the ${quota.plan} plan ` +
					`(${quota.used} of ${quota.limit} ${quota.unit} used this period).`,
			});
			// `done` still terminates the turn for the client's state machine; the
			// error event is what says it failed. Same shape as the provider-error
			// path below.
			this.send({ type: 'done', text: '' });
			return;
		}

		const turnId = ++this.turnSeq;
		const controller = new AbortController();
		const turn: ActiveTurn = { id: turnId, controller, reply: '' };
		this.activeTurn = turn;
		this.phase = 'thinking';

		const isCancelled = (): boolean => this.isStale(turnId);

		try {
			const result = await runReply({
				userId: this.user.id,
				language: this.language,
				history: this.history,
				userText: text,
				signal: controller.signal,
				turnId,
				// The gate: the loop asks here before it runs anything at or above
				// the configured level, and the answer only ever comes from this
				// socket. This is the voice path's equivalent of the typed path's
				// Tool Confirmation sheet (§5.7).
				approval: (request) => this.approvals.request(request),
				handlers: {
					isCancelled,
					onToken: (delta) => {
						if (isCancelled()) return;
						turn.reply += delta;
						this.send({ type: 'token', text: delta });
					},
					onSentence: (sentence, index) => {
						if (!isCancelled()) this.send({ type: 'sentence', text: sentence, index });
					},
					onAudio: (chunk) => this.sendAudio(chunk, turnId),
					onTtsError: (err) => {
						if (!isCancelled()) this.reportError('TTS_ERROR', err);
					},
					// The routed synthesiser refused the turn and Deepgram is
					// speaking it. Same shape as the STT notice above; the reply
					// pipeline already deduped it to once per turn and logged the
					// primary + reason at warn.
					onTtsFallback: (info) => {
						if (!isCancelled()) this.send({ type: 'tts', provider: info.to, fallback: true, reason: info.reason });
					},
					// Tell the client the moment a write tool runs, so it can say
					// something while the spoken reply is still being written. A
					// tool the approval gate stopped is reported the same way, with
					// the reason, so the user is never left thinking it ran.
					onTool: (call) => {
						if (!isCancelled()) {
							this.send({
								type: 'tool',
								name: call.name,
								ok: call.ok,
								summary: call.summary,
								approval: call.approval,
							});
						}
					},
				},
			});

			if (isCancelled()) return;

			logger.info(
				{
					userId: this.user.id,
					language: this.language,
					model: result.model,
					usage: result.usage,
					iterations: result.iterations,
					tools: result.toolCalls.map((t) => `${t.name}:${t.ok ? 'ok' : 'failed'}`),
					capped: result.capped,
					// Which provider served the turn, so a primary-provider outage is
					// visible in the logs rather than silently absorbed.
					provider: result.provider ?? 'anthropic',
					fellBack: result.fellBack === true,
				},
				'Realtime voice turn complete',
			);

			// Per-turn cost of the three billed legs. Logging only — synchronous,
			// no network call, no await, so it is off the reply's critical path.
			// `result.provider` is the provider that actually served the turn, so a
			// fallback is visible here and the leg is priced against the provider
			// that really billed it.
			logTurnCost({
				userId: this.user.id,
				turnId,
				language: this.language,
				stt: sttUsage,
				llm: {
					provider: result.provider ?? 'anthropic',
					model: result.model,
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
				},
				ttsCharsByProvider: result.ttsCharsByProvider,
			});

			// Meter the voice minutes this turn actually consumed. Fire-and-forget:
			// metering is off the reply's critical path and `recordUsage` never
			// throws, so a slow or unavailable `usage_records` cannot fail a turn.
			this.recordTurnUsage(sttUsage, result.ttsCharsByProvider);

			this.remember(text, result.text);
			this.activeTurn = null;
			this.endSpeaking();
			// Back to listening, not idle: the microphone is still open and the
			// provider is still transcribing, so the next thing the user says is
			// a new turn without touching anything. Reporting idle here also
			// stopped the end-of-speech backstop from arming, which is what left
			// a second utterance unanswered.
			this.phase = this.stt.active ? 'listening' : 'idle';
			this.send({ type: 'done', text: result.text });
		} catch (err) {
			if (isAbortError(err) || isCancelled()) return;
			// Same stable codes the REST voice route returns, so the client can
			// tell "provider not configured" from a generic failure.
			const assistantError = toAssistantError(err);
			logger.warn(
				{ err, code: assistantError.code, userId: this.user.id, turnId },
				'Realtime turn failed',
			);
			this.send({ type: 'error', code: assistantError.code, message: assistantError.message });
			this.activeTurn = null;
			this.endSpeaking();
			this.phase = 'idle';
			// `done` still terminates the turn for the client's state machine;
			// the error event is what says it failed.
			this.send({ type: 'done', text: turn.reply });
		}
	}

	/**
	 * The server-side entitlement gate for one spoken turn.
	 *
	 * Returns `null` when the check itself could not run, and the caller then
	 * treats the turn as allowed: `checkQuota` already fails open on a store
	 * error, and this second guard covers an unexpected throw. Locking every user
	 * out of voice because the entitlement layer hiccuped would be a worse
	 * failure than an unmetered turn, which is logged.
	 */
	private async authorizeVoiceTurn(): Promise<QuotaDecision | null> {
		try {
			return await authorizeUsage(this.user.id, USAGE_METRICS.voiceSeconds, 1);
		} catch (err) {
			logger.warn(
				{ err, userId: this.user.id },
				'Voice entitlement check failed; allowing the turn',
			);
			return null;
		}
	}

	/**
	 * Meters the caller audio this turn consumed.
	 *
	 * Metric: `voice_seconds`, unit `seconds`. The quantity is the PCM the turn
	 * sent to the recogniser (`sttUsage.providers[].bytes`), divided by the known
	 * input rate — the socket protocol fixes input at 16 kHz mono s16le, so this
	 * is exact rather than an estimate, and it is the same quantity the STT leg of
	 * `logTurnCost` already reports. Seconds, not minutes: a turn is typically
	 * 5–30 s and an integer minute meter would round nearly every turn to zero and
	 * silently allow unlimited use.
	 */
	/**
	 * Meters one completed turn: voice minutes, plus the STT and TTS counters.
	 *
	 * The session already computed everything needed for this and then dropped most of it.
	 * `sttUsage.providers[].bytes` gave the transcribed audio, and `ttsCharsByProvider` — built by
	 * `realtime/reply.ts` and used for the cost log line — gave the characters handed to synthesis.
	 * Only `voiceSeconds` was written, so the console's "STT requests" and "TTS requests" reported
	 * zero for a deployment transcribing constantly, and the tile said so in its caveat.
	 *
	 * A turn is one request per leg regardless of how many sentences it contained: the client made
	 * one voice call, and charging it one request is what the count is for.
	 */
	private recordTurnUsage(
		sttUsage: SttUtteranceUsage | null,
		ttsCharsByProvider: Record<string, number> | null,
	): void {
		// The decision lives in `services/voice-usage.ts` so it can be unit-tested without a
		// socket. See `planRealtimeTurn` for why a turn is one request per leg, why a zero
		// reading writes nothing, and how a mid-turn fallback is attributed.
		const plan = planRealtimeTurn(
			{
				sttProviders: sttUsage?.providers ?? null,
				sttProvider: sttUsage?.provider ?? null,
				ttsCharsByProvider,
			},
			INPUT_BYTES_PER_SECOND,
		);

		if (plan.stt) {
			// The existing voice-minutes meter, unchanged.
			void recordUsage(this.user.id, USAGE_METRICS.voiceSeconds, plan.stt.seconds);

			// The counters the console reads. Same audio, counted as a request and in seconds so a
			// spend change can be explained and a retry loop can be seen.
			recordSttUsage({
				userId: this.user.id,
				seconds: plan.stt.seconds,
				provider: plan.stt.provider,
			});
		}

		// Recorded even when the STT side produced no measurable audio — NOVA still spoke.
		if (plan.tts) {
			recordTtsUsage({
				userId: this.user.id,
				characters: plan.tts.characters,
				provider: plan.tts.provider,
			});
		}
	}

	private endSpeaking(): void {
		if (!this.speaking) return;
		this.speaking = false;
		this.send({ type: 'speaking', value: false });
	}

	private async sendAudio(chunk: Uint8Array, turnId: number): Promise<void> {
		if (this.isStale(turnId)) return;
		if (!this.speaking) {
			this.speaking = true;
			this.phase = 'speaking';
			this.send({ type: 'speaking', value: true });
		}
		// Backpressure: stop pulling from TTS while the client is behind, so
		// audio is never buffered without bound in this process.
		while (!this.closed && this.socket.bufferedAmount > MAX_SOCKET_BUFFER_BYTES) {
			if (this.isStale(turnId)) return;
			await sleep(20);
		}
		if (this.closed || this.socket.readyState !== 1) return;
		try {
			this.socket.send(chunk, { binary: true });
		} catch (err) {
			logger.warn({ err }, 'Realtime audio send failed');
		}
	}

	private remember(userText: string, reply: string): void {
		this.history.push({ role: 'user', content: userText });
		if (reply.trim()) this.history.push({ role: 'assistant', content: reply });
		while (this.history.length > MAX_HISTORY_MESSAGES) this.history.splice(0, 2);
	}
}
