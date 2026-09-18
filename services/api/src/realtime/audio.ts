/**
 * NOVA API — realtime audio helpers.
 *
 * Barge-in needs a signal that does not depend on any provider: the client's
 * microphone PCM arrives on every frame, so sustained energy above a threshold
 * means the user has started talking. Deepgram offers no `speech_start` event
 * at all, and Sarvam's VAD signal can arrive a second late, so this is what
 * makes an interruption feel immediate.
 */

/** Pause reading TTS once the client socket buffer is this full (backpressure). */
export const MAX_SOCKET_BUFFER_BYTES = 512 * 1024;

/** Sustained loud input (ms) that counts as barge-in. */
export const BARGE_IN_SPEECH_MS = 200;

/** RMS/full-scale threshold. Normal speech is 0.05–0.3; room tone is far below. */
export const BARGE_IN_RMS = Number(process.env.REALTIME_BARGE_IN_RMS ?? '0.045');

/** 16 kHz mono s16le: 32 bytes per millisecond. */
const BYTES_PER_MS = 32;

/** RMS of a 16-bit little-endian mono PCM buffer, normalised to 0..1. */
export function frameRms(pcm: Buffer): number {
	const samples = Math.floor(pcm.length / 2);
	if (!samples) return 0;
	let sum = 0;
	for (let i = 0; i < samples; i++) {
		const sample = pcm.readInt16LE(i * 2) / 32768;
		sum += sample * sample;
	}
	return Math.sqrt(sum / samples);
}

/**
 * Tracks how much sustained loud audio has arrived. Frame-size independent:
 * it accumulates bytes rather than counting frames, so a client sending 20 ms
 * frames and one sending 100 ms frames trigger at the same real-world moment.
 */
export class EnergyBargeIn {
	private speechBytes = 0;

	constructor(
		private readonly threshold: number = BARGE_IN_RMS,
		private readonly minSpeechMs: number = BARGE_IN_SPEECH_MS,
	) {}

	reset(): void {
		this.speechBytes = 0;
	}

	/** Returns true exactly once per sustained interruption. */
	observe(pcm: Buffer): boolean {
		if (frameRms(pcm) < this.threshold) {
			this.speechBytes = 0;
			return false;
		}
		this.speechBytes += pcm.length;
		if (this.speechBytes < this.minSpeechMs * BYTES_PER_MS) return false;
		this.speechBytes = 0;
		return true;
	}
}

/** Timer-backed sleep that never keeps the process alive on its own. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms) as unknown as { unref?: () => void };
		timer.unref?.();
	});
}
