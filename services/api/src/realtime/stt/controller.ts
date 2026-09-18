/**
 * NOVA API — the lifecycle of one streaming STT socket.
 *
 * The provider socket outlives turns: it is opened on the first `start`,
 * reused for every later utterance (so the user can interrupt NOVA without the
 * client reconnecting) and closed exactly once when the voice session ends.
 * Keeping that ownership here means `session.ts` never has to reason about
 * provider close codes or "was this close mine?".
 */
import { logger } from '../../utils/logger.js';
import { INPUT_SAMPLE_RATE } from '../protocol.js';
import { createSttSession, type SttSession } from './index.js';

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
}

export class SttController {
	private session: SttSession | null = null;
	private language: string | null = null;

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
		if (this.session && !this.session.closed && this.language === language) return;
		this.close();
		this.language = language;

		// Captured so the handlers can tell a close we asked for from a drop.
		const session = createSttSession({
			language,
			sampleRate: INPUT_SAMPLE_RATE,
			handlers: {
				onPartial: (text) => this.options.onPartial(text),
				onFinal: (text) => this.options.onFinal(text),
				onSpeechStart: () => this.options.onSpeechStart(),
				onError: (err) => {
					if (this.session === session) this.options.onError(err);
				},
				onClose: (code, reason, fatal) => {
					// `close()` nulls `this.session` first, so anything still
					// current here is the provider dropping the stream under us.
					if (this.session !== session) return;
					this.session = null;
					this.language = null;
					logger.warn(
						{ userId: this.options.userId, provider: session.provider, code, reason, fatal },
						'STT provider closed',
					);
					this.options.onDisconnected(session.provider, code, reason, fatal);
				},
			},
		});
		this.session = session;
	}

	sendAudio(pcm: Buffer): void {
		this.session?.sendAudio(pcm);
	}

	/** Client pressed stop: finalise what the provider has buffered. */
	requestFinal(): void {
		this.session?.requestFinal();
	}

	keepAlive(): void {
		this.session?.keepAlive();
	}

	/** Idempotent teardown; never throws. */
	close(): void {
		const session = this.session;
		this.session = null;
		this.language = null;
		if (!session || session.closed) return;
		try {
			session.close();
		} catch (err) {
			logger.warn({ err }, 'Failed to close STT session');
		}
	}
}
