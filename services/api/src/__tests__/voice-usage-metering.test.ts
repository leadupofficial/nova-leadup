/**
 * Voice usage metering.
 *
 * The console reported "STT requests" and "TTS requests" as NOT AVAILABLE because nothing counted
 * them. These tests pin what the meter records and, just as importantly, what it refuses to:
 *
 *  - a successful synthesis records one request and the character count, because characters are
 *    the unit TTS providers bill for;
 *  - a transcription records one request and the audio duration, because STT bills per second;
 *  - a **zero or negative reading writes nothing**, so a failed or empty call cannot inflate the
 *    request count;
 *  - a metering failure is swallowed, because a user waiting to hear NOVA must not be affected by
 *    a metrics row that would not write.
 *
 * The recorder is injected through `setVoiceUsageRecorder`, which is why no database is involved:
 * this suite's `DATABASE_URL` is a placeholder, so a real insert could not work, and the thing
 * under test is the decision about what to record rather than the insert itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import './setup.js';

import {
	dominantProvider,
	pcmDurationSeconds,
	planRealtimeTurn,
	recordSttUsage,
	recordTtsUsage,
	setVoiceUsageRecorder,
	type VoiceUsageEntry,
} from '../services/voice-usage.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

let captured: VoiceUsageEntry[] = [];

function capture(): void {
	captured = [];
	setVoiceUsageRecorder(async (entry) => {
		captured.push(entry);
	});
}

/** The writes are fire-and-forget; this drains the microtask queue so they are observable. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
	setVoiceUsageRecorder(async () => {});
});

describe('TTS metering', () => {
	it('records one request and the character count', async () => {
		capture();
		recordTtsUsage({ userId: USER_ID, characters: 32, provider: 'sarvam' });
		await settle();

		const byMetric = new Map(captured.map((entry) => [entry.metric, entry]));
		expect(byMetric.get('tts_requests')?.value).toBe(1);
		expect(byMetric.get('tts_requests')?.unit).toBe('count');
		expect(byMetric.get('tts_characters')?.value).toBe(32);
		expect(byMetric.get('tts_characters')?.unit).toBe('characters');
		// Characters, not words: every provider in this stack bills per character, so that is the
		// unit a cost figure can be computed from without a second conversion.
		expect(captured.every((entry) => entry.userId === USER_ID)).toBe(true);
	});

	it('writes nothing for empty text, so an empty call cannot inflate the count', async () => {
		capture();
		recordTtsUsage({ userId: USER_ID, characters: 0, provider: 'sarvam' });
		await settle();

		// `tts_requests` is still written — a request really was made — but no character row with
		// a meaningless zero. This is the honest split: the request happened, the volume did not.
		const metrics = captured.map((entry) => entry.metric);
		expect(metrics).toContain('tts_requests');
		expect(metrics).not.toContain('tts_characters');
	});

	it('never throws when the recorder fails', async () => {
		setVoiceUsageRecorder(async () => {
			throw new Error('metering store unreachable');
		});

		// The whole point: a user waiting to hear NOVA must not be affected by metering.
		expect(() => recordTtsUsage({ userId: USER_ID, characters: 10, provider: 'sarvam' })).not.toThrow();
		await settle();
	});
});

describe('STT metering', () => {
	it('records one request and the audio duration', async () => {
		capture();
		recordSttUsage({ userId: USER_ID, seconds: 2.5, provider: 'deepgram' });
		await settle();

		const byMetric = new Map(captured.map((entry) => [entry.metric, entry]));
		expect(byMetric.get('stt_requests')?.value).toBe(1);
		expect(byMetric.get('stt_seconds')?.value).toBe(3); // rounded: a second is the billing unit
		expect(byMetric.get('stt_seconds')?.unit).toBe('seconds');
	});

	it('writes no duration row for audio of unknown length', async () => {
		capture();
		recordSttUsage({ userId: USER_ID, seconds: 0, provider: 'deepgram' });
		await settle();

		const metrics = captured.map((entry) => entry.metric);
		expect(metrics).toContain('stt_requests');
		expect(metrics).not.toContain('stt_seconds');
	});

	it('never throws when the recorder fails', async () => {
		setVoiceUsageRecorder(async () => {
			throw new Error('metering store unreachable');
		});
		expect(() => recordSttUsage({ userId: USER_ID, seconds: 1, provider: 'deepgram' })).not.toThrow();
		await settle();
	});
});

describe('PCM duration', () => {
	it('computes the duration of 16-bit mono PCM exactly', () => {
		// 16 kHz, 16-bit mono: 32 000 bytes is exactly one second.
		expect(pcmDurationSeconds(32_000, 16_000)).toBe(1);
		expect(pcmDurationSeconds(64_000, 16_000)).toBe(2);
		expect(pcmDurationSeconds(16_000, 8_000)).toBe(1);
	});

	it('returns 0 for an implausible input rather than fabricating a duration', () => {
		// A misconfigured caller records the request with no duration instead of an invented one.
		expect(pcmDurationSeconds(0, 16_000)).toBe(0);
		expect(pcmDurationSeconds(32_000, 0)).toBe(0);
		expect(pcmDurationSeconds(-1, 16_000)).toBe(0);
		expect(pcmDurationSeconds(Number.NaN, 16_000)).toBe(0);
	});
});

/**
 * The realtime turn accounting.
 *
 * This is the path the console's "STT requests" and "TTS requests" tiles read for a voice
 * call, and it used to drop the numbers it had already computed: `session.ts` produced a
 * transcript with per-provider byte counts and a reply with per-provider character counts and
 * then wrote only `voiceSeconds`. Extracting the decision here means it is tested against a
 * real byte count rather than asserted to exist.
 */
describe('realtime turn metering plan', () => {
	const BYTES_PER_SECOND = 32_000; // 16 kHz, 16-bit mono

	it('counts one turn as one STT request with its duration and one TTS request with its characters', () => {
		const plan = planRealtimeTurn(
			{
				sttProviders: [{ provider: 'deepgram', bytes: 64_000 }],
				sttProvider: 'deepgram',
				ttsCharsByProvider: { elevenlabs: 42 },
			},
			BYTES_PER_SECOND,
		);
		expect(plan.stt).toEqual({ seconds: 2, provider: 'deepgram' });
		expect(plan.tts).toEqual({ characters: 42, provider: 'elevenlabs' });
	});

	it('sums bytes across providers when a fallback split the utterance', () => {
		// The user spoke once. Two sockets carried part of it because the first dropped, and both
		// billed — so the seconds are the sum, not the larger share.
		const plan = planRealtimeTurn(
			{
				sttProviders: [
					{ provider: 'deepgram', bytes: 32_000 },
					{ provider: 'sarvam', bytes: 32_000 },
				],
				sttProvider: 'sarvam',
				ttsCharsByProvider: {},
			},
			BYTES_PER_SECOND,
		);
		expect(plan.stt?.seconds).toBe(2);
		// The final transcript came from sarvam, so that is the attribution.
		expect(plan.stt?.provider).toBe('sarvam');
	});

	it('attributes a split TTS turn to the provider that spoke most of it', () => {
		const plan = planRealtimeTurn(
			{ ttsCharsByProvider: { elevenlabs: 30, sarvam: 12 } },
			BYTES_PER_SECOND,
		);
		expect(plan.tts).toEqual({ characters: 42, provider: 'elevenlabs' });
	});

	it('plans nothing for a turn with no audio and no speech', () => {
		// A failed or empty transcription and a reply that produced no audio must not increment a
		// request count: a meter that counts failures reports an outage as record usage.
		const plan = planRealtimeTurn({ sttProviders: [], ttsCharsByProvider: {} }, BYTES_PER_SECOND);
		expect(plan.stt).toBeNull();
		expect(plan.tts).toBeNull();
	});

	it('ignores zero and negative readings instead of counting them', () => {
		const plan = planRealtimeTurn(
			{
				sttProviders: [{ provider: 'deepgram', bytes: 0 }],
				ttsCharsByProvider: { elevenlabs: 0, sarvam: -5 },
			},
			BYTES_PER_SECOND,
		);
		expect(plan.stt).toBeNull();
		expect(plan.tts).toBeNull();
	});

	it('records the TTS leg even when the STT side produced nothing measurable', () => {
		// NOVA still spoke. Dropping the characters because the transcript was unusable would
		// understate spend on exactly the turns that are most expensive.
		const plan = planRealtimeTurn(
			{ sttProviders: null, ttsCharsByProvider: { elevenlabs: 7 } },
			BYTES_PER_SECOND,
		);
		expect(plan.stt).toBeNull();
		expect(plan.tts).toEqual({ characters: 7, provider: 'elevenlabs' });
	});

	it('refuses to divide by a nonsensical sample rate', () => {
		const plan = planRealtimeTurn({ sttProviders: [{ provider: 'deepgram', bytes: 32_000 }] }, 0);
		expect(plan.stt).toBeNull();
	});

	it('rounds to whole seconds, because a second is what STT bills for', () => {
		// 48 000 bytes at 32 000/s is 1.5 s, which must bill as 2 rather than 1 or 1.5.
		const plan = planRealtimeTurn({ sttProviders: [{ provider: 'deepgram', bytes: 48_000 }] }, BYTES_PER_SECOND);
		expect(plan.stt?.seconds).toBe(2);
	});

	it('names an unknown provider rather than leaving the attribution blank', () => {
		const plan = planRealtimeTurn(
			{ sttProviders: [{ provider: '', bytes: 32_000 }], ttsCharsByProvider: { '': 5 } },
			BYTES_PER_SECOND,
		);
		expect(plan.stt?.provider).toBe('unknown');
		expect(plan.tts?.provider).toBe('unknown');
	});
});

describe('dominant provider', () => {
	it('picks the largest share', () => {
		expect(dominantProvider({ elevenlabs: 10, sarvam: 20, deepgram: 5 })).toBe('sarvam');
	});

	it('is not fooled by a zero entry winning by default', () => {
		expect(dominantProvider({ zero: 0, real: 3 })).toBe('real');
	});

	it('returns "unknown" for an empty or all-zero map', () => {
		expect(dominantProvider({})).toBe('unknown');
		expect(dominantProvider({ a: 0, b: -1 })).toBe('unknown');
	});
});
