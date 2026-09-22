/**
 * NOVA — Voice usage metering (STT and TTS).
 *
 * The console reported "STT requests" and "TTS requests" as **NOT AVAILABLE**, because nothing
 * counted them. `usage_records` held only `voice_seconds` and `recording_seconds`, which the
 * recording pipeline writes — so the platform could see how much audio it *stored* and nothing
 * about how much speech it *transcribed or spoke*. That is the figure a cost conversation
 * needs, because both providers bill per unit of speech, not per stored byte.
 *
 * ## What is recorded, and why these units
 *
 * Per call, one row per metric:
 *
 * | Metric | Unit | Why |
 * |---|---|---|
 * | `stt_requests` | count | The request count the console shows. |
 * | `stt_seconds` | seconds | STT bills per second of audio. |
 * | `tts_requests` | count | The request count the console shows. |
 * | `tts_characters` | characters | TTS bills per character. |
 *
 * Recording both a count and a volume is deliberate: a count alone cannot answer "why did spend
 * triple", and a volume alone cannot answer "is a client retry-looping". Both are needed and
 * neither is derivable from the other.
 *
 * ## Fire-and-forget, and why
 *
 * `recordVoiceUsage` returns a promise a caller **should not await**. Metering must never delay
 * or fail a user's speech: a user waiting to hear NOVA does not care that a metrics row was
 * slow. Every function here catches its own errors and logs them, so an unawaited call cannot
 * become an unhandled rejection.
 *
 * ## Not reusing the entitlement store
 *
 * `entitlements/store.ts` has a `recordUsage`, but it is scoped to *limited* metrics for quota
 * enforcement. Voice usage is operational telemetry rather than a quota input, so it goes through
 * this module instead; both end up in the same append-only table, which is what the console reads.
 *
 * `userId` is required, matching the schema: `usage_records.user_id` is `NOT NULL`.
 */

import { usageRecords } from '@nova/database';
import { getDb } from '../db/connection.js';
import { logger } from '../utils/logger.js';

/** Metrics this module writes. Exported so the console and tests share one list. */
export const VOICE_USAGE_METRICS = [
	'stt_requests',
	'stt_seconds',
	'tts_requests',
	'tts_characters',
] as const;

export type VoiceUsageMetric = (typeof VOICE_USAGE_METRICS)[number];

export type VoiceUsageEntry = {
	/**
	 * The acting user. **Required**, because `usage_records.user_id` is `NOT NULL` — there is no
	 * such thing as an unattributed usage row in this schema, and the console's per-user views
	 * depend on that. A caller with no user (there is none on the speech paths today) must skip
	 * metering rather than invent an owner.
	 */
	userId: string;
	tenantId?: string | null;
	metric: VoiceUsageMetric;
	value: number;
	unit: 'count' | 'seconds' | 'characters';
};

type Recorder = (entry: VoiceUsageEntry) => Promise<void>;

/**
 * The default recorder: one append-only row.
 *
 * Extracted so a test can substitute it. Injecting here rather than mocking the database keeps
 * the test about *what is recorded* rather than about the database double's shape.
 */
async function defaultRecorder(entry: VoiceUsageEntry): Promise<void> {
	const db = getDb();
	await db.insert(usageRecords).values({
		userId: entry.userId,
		tenantId: entry.tenantId ?? null,
		metric: entry.metric,
		value: entry.value,
		unit: entry.unit,
		recordedAt: new Date(),
	});
}

let recorder: Recorder = defaultRecorder;

/** Test seam. Returns a restore function so a test cannot leak the substitution. */
export function setVoiceUsageRecorder(next: Recorder): () => void {
	const previous = recorder;
	recorder = next;
	return () => {
		recorder = previous;
	};
}

/** Writes one entry, swallowing every failure. Never throws, never rejects. */
async function write(entry: VoiceUsageEntry): Promise<void> {
	if (!Number.isFinite(entry.value) || entry.value <= 0) {
		// A zero or negative reading is not worth a row, and a non-finite one indicates a bug
		// upstream rather than a real measurement.
		return;
	}
	try {
		await recorder({ ...entry, value: Math.round(entry.value) });
	} catch (error) {
		logger.warn({ err: error, metric: entry.metric }, '[voice-usage] could not record usage');
	}
}

/**
 * Records a completed transcription.
 *
 * `seconds` is the audio duration, which the caller must know — it is not derivable from the
 * byte count, because the sample rate varies by client.
 */
export function recordSttUsage(options: {
	userId: string;
	tenantId?: string | null;
	seconds: number;
	provider: string;
}): void {
	void write({ userId: options.userId, tenantId: options.tenantId, metric: 'stt_requests', value: 1, unit: 'count' });
	void write({
		userId: options.userId,
		tenantId: options.tenantId,
		metric: 'stt_seconds',
		value: options.seconds,
		unit: 'seconds',
	});
	logger.debug?.({ provider: options.provider, seconds: options.seconds }, 'STT usage recorded');
}

/**
 * Records a completed synthesis.
 *
 * Characters, not words: every TTS provider in this stack bills per character, so that is the
 * unit a cost figure can be computed from without a second conversion.
 */
export function recordTtsUsage(options: {
	userId: string;
	tenantId?: string | null;
	characters: number;
	provider: string;
}): void {
	void write({ userId: options.userId, tenantId: options.tenantId, metric: 'tts_requests', value: 1, unit: 'count' });
	void write({
		userId: options.userId,
		tenantId: options.tenantId,
		metric: 'tts_characters',
		value: options.characters,
		unit: 'characters',
	});
	logger.debug?.({ provider: options.provider, characters: options.characters }, 'TTS usage recorded');
}

/**
 * Audio duration in seconds from a raw PCM buffer.
 *
 * The realtime and REST capture paths both send 16-bit mono PCM, which is the format the
 * provider clients are configured with (`encoding: 'linear16'`, `channels: 1`). Bytes ÷ (2 ×
 * sampleRate) is therefore exact for that format rather than an estimate.
 *
 * Returns 0 for anything implausible, so a misconfigured caller records a request with no
 * duration rather than a fabricated one.
 */
export function pcmDurationSeconds(byteLength: number, sampleRate: number): number {
	if (!Number.isFinite(byteLength) || byteLength <= 0) return 0;
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
	return byteLength / (2 * sampleRate);
}

export type VoiceUsageTotals = {
	sttRequests: number;
	sttSeconds: number;
	ttsRequests: number;
	ttsCharacters: number;
};

/**
 * Which provider served the most of a turn's speech.
 *
 * Only used when a mid-turn fallback split the text across providers: the turn is still
 * one request, and attributing it to the provider that spoke most of it is more honest
 * than picking whichever happened to be first or last.
 */
export function dominantProvider(charsByProvider: Record<string, number>): string {
	const entries = Object.entries(charsByProvider).filter(
		([provider, chars]) => provider.trim() !== '' && Number.isFinite(chars) && chars > 0,
	);
	if (entries.length === 0) return 'unknown';
	return entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

/** What one realtime voice turn should be metered as. */
export type RealtimeTurnPlan = {
	stt: { seconds: number; provider: string } | null;
	tts: { characters: number; provider: string } | null;
};

/**
 * Decides what a finished realtime turn contributes to the counters.
 *
 * Extracted from the session class so the decision is testable without a WebSocket, a
 * provider socket or a database — the session's own wiring is one call site and the
 * arithmetic here is where the numbers can actually go wrong.
 *
 * Three rules, each of which was a real defect or a near miss:
 *
 *  - **A turn is one request per leg, not one per sentence.** The `_requests` counters are
 *    incremented by `recordSttUsage`/`recordTtsUsage` per call, so this must be called once
 *    per turn; the characters and seconds are what give volume.
 *  - **Zero writes nothing.** A failed or empty transcription and a reply that produced no
 *    audio must not increment a request count — a meter that counts failures reports an
 *    outage as record usage.
 *  - **A fallback split is attributed, not dropped.** Bytes are summed across every provider
 *    that carried part of the utterance, and the TTS side is attributed to the dominant
 *    provider, because a fallback mid-turn billed both and discarding either would understate
 *    the spend.
 *
 * `bytesPerSecond` is passed in rather than imported so this module does not depend on the
 * realtime cost tables.
 */
export function planRealtimeTurn(
	input: {
		/** Bytes per provider for the utterance that produced this turn. */
		sttProviders?: Array<{ provider: string; bytes: number }> | null;
		/** The provider that produced the final transcript, when one is known. */
		sttProvider?: string | null;
		/** Characters handed to synthesis, per provider. */
		ttsCharsByProvider?: Record<string, number> | null;
	},
	bytesPerSecond: number,
): RealtimeTurnPlan {
	const providers = (input.sttProviders ?? []).filter(
		(entry) => Number.isFinite(entry.bytes) && entry.bytes > 0,
	);
	const bytes = providers.reduce((sum, entry) => sum + entry.bytes, 0);
	const seconds =
		Number.isFinite(bytesPerSecond) && bytesPerSecond > 0 ? Math.round(bytes / bytesPerSecond) : 0;

	const charsByProvider = Object.fromEntries(
		Object.entries(input.ttsCharsByProvider ?? {}).filter(
			([, chars]) => Number.isFinite(chars) && chars > 0,
		),
	);
	const characters = Object.values(charsByProvider).reduce((sum, value) => sum + value, 0);

	// A blank provider name is a missing attribution, not a provider called "". Falling back to
	// the provider that carried the most bytes is what keeps the row useful when the transcript
	// leg did not say who produced it.
	const namedSttProvider = (input.sttProvider ?? '').trim();

	return {
		stt:
			seconds > 0
				? {
						seconds,
						provider:
							namedSttProvider ||
							dominantProvider(
								Object.fromEntries(providers.map((entry) => [entry.provider, entry.bytes])),
							),
					}
				: null,
		tts: characters > 0 ? { characters, provider: dominantProvider(charsByProvider) } : null,
	};
}

/**
 * Reads the totals over a window, for the console.
 *
 * A missing metric reads as 0 here on purpose: the caller renders "no speech processed yet",
 * which is true and actionable, and the *metric's* availability is decided by whether any
 * provider is configured — not by whether a row exists.
 */
export async function readVoiceUsageTotals(days = 30): Promise<VoiceUsageTotals> {
	const { getDbPool } = await import('../db/connection.js');
	const pool = getDbPool();

	const { rows } = await pool.query<{ metric: string; total: string }>(
		`SELECT metric, COALESCE(SUM(value), 0)::bigint AS total
		 FROM usage_records
		 WHERE metric = ANY($1) AND recorded_at > now() - ($2::int * interval '1 day')
		 GROUP BY metric`,
		[[...VOICE_USAGE_METRICS], days],
	);

	const byMetric = new Map(rows.map((row) => [row.metric, Number(row.total)]));
	return {
		sttRequests: byMetric.get('stt_requests') ?? 0,
		sttSeconds: byMetric.get('stt_seconds') ?? 0,
		ttsRequests: byMetric.get('tts_requests') ?? 0,
		ttsCharacters: byMetric.get('tts_characters') ?? 0,
	};
}
