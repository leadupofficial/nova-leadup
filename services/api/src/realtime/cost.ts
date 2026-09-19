/**
 * NOVA API — per-turn voice cost instrumentation.
 *
 * A spoken turn bills three ways: STT per unit of audio sent, the LLM per input
 * and output token, and TTS per character synthesised. The *quantities* are
 * measurable here; the *unit rates* are the owner's contracted rates and are
 * not known to this service. So this module does no pricing of its own — it
 * counts what the turn consumed and multiplies by whatever rate the
 * environment supplies (`VOICE_COST_*` in `utils/env.ts`).
 *
 * Two rules matter more than the arithmetic:
 *
 *  - A leg whose rate is unset is reported with its quantity and
 *    `costUsd: null` ("unknown"), never 0. A silently-zero leg would make an
 *    unpriced turn look cheap.
 *  - If any leg is unknown the total is `null` too, so a partial sum is never
 *    mistaken for the whole price.
 *
 * It also reports which provider served each leg, because a fallback changes
 * the price (STT: Sarvam or Deepgram, TTS: Sarvam, ElevenLabs or Deepgram).
 *
 * Logging only: no network call, no cache, no database, no await. Nothing here
 * touches the reply pipeline's ordering or latency.
 */
import { env } from '../utils/env.js';
import { logger } from '../utils/logger.js';
import { INPUT_BITS_PER_SAMPLE, INPUT_CHANNELS, INPUT_SAMPLE_RATE } from './protocol.js';

/** Bytes of PCM in one second of the realtime input stream (16 kHz mono s16le). */
export const INPUT_BYTES_PER_SECOND = (INPUT_SAMPLE_RATE * INPUT_CHANNELS * INPUT_BITS_PER_SAMPLE) / 8;

/** Bytes sent to one STT provider during one utterance, live audio plus replay. */
export interface SttProviderBytes {
	provider: string;
	bytes: number;
}

export interface SttTurnUsage {
	/** Provider that produced the transcript; `null` for typed (non-spoken) input. */
	provider: string | null;
	/** Every provider that received audio for this utterance. */
	providers: SttProviderBytes[];
}

export interface LlmTurnUsage {
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
}

export interface TurnCostInput {
	userId: string;
	turnId: number;
	language: string;
	stt: SttTurnUsage | null;
	llm: LlmTurnUsage;
	/** Characters handed to synthesis, keyed by the provider that served them. */
	ttsCharsByProvider: Record<string, number>;
}

/** One provider's share of a leg, when a fallback split the leg. */
export interface CostBreakdownEntry {
	provider: string;
	quantity: number;
	unit: 'seconds' | 'characters';
	rateUsd: number | null;
	costUsd: number | null;
}

export interface SttCostLeg {
	provider: string | null;
	/** Audio the provider was sent, in seconds (derived from PCM bytes). */
	seconds: number;
	bytes: number;
	ratePerMinute: number | null;
	costUsd: number | null;
	/** Present only when more than one provider received audio this turn. */
	breakdown?: CostBreakdownEntry[];
}

export interface LlmCostLeg {
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	tokens: number;
	inputRatePerMTok: number | null;
	outputRatePerMTok: number | null;
	costUsd: number | null;
}

export interface TtsCostLeg {
	/** Serving provider, `'mixed'` when a fallback split the reply, or `null` when nothing spoke. */
	provider: string | null;
	characters: number;
	ratePer1kChars: number | null;
	costUsd: number | null;
	/** Present only when more than one provider synthesised part of the reply. */
	breakdown?: CostBreakdownEntry[];
}

export interface VoiceTurnCost {
	userId: string;
	turnId: number;
	language: string;
	currency: 'USD';
	stt: SttCostLeg;
	llm: LlmCostLeg;
	tts: TtsCostLeg;
	totalUsd: number | null;
	/** Legs with a billed quantity but no configured rate. */
	unknownLegs: Array<'stt' | 'llm' | 'tts'>;
	complete: boolean;
}

/** Parse a configured rate. Unset, blank or non-numeric all mean "unknown". */
function rate(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const value = Number(raw.trim());
	return Number.isFinite(value) && value >= 0 ? value : null;
}

const STT_RATE_ENV: Record<string, () => string | undefined> = {
	sarvam: () => env.VOICE_COST_STT_SARVAM_PER_MINUTE,
	deepgram: () => env.VOICE_COST_STT_DEEPGRAM_PER_MINUTE,
};

/** USD per minute of audio for an STT provider; per-provider rate first. */
export function sttRatePerMinute(provider: string): number | null {
	return rate(STT_RATE_ENV[provider]?.()) ?? rate(env.VOICE_COST_STT_PER_MINUTE);
}

const TTS_RATE_ENV: Record<string, () => string | undefined> = {
	sarvam: () => env.VOICE_COST_TTS_SARVAM_PER_1K_CHARS,
	elevenlabs: () => env.VOICE_COST_TTS_ELEVENLABS_PER_1K_CHARS,
	deepgram: () => env.VOICE_COST_TTS_DEEPGRAM_PER_1K_CHARS,
};

/** USD per 1,000 characters for a TTS provider; per-provider rate first. */
export function ttsRatePer1kChars(provider: string): number | null {
	return rate(TTS_RATE_ENV[provider]?.()) ?? rate(env.VOICE_COST_TTS_PER_1K_CHARS);
}

/** Cost is logged in USD with enough precision for sub-cent turns. */
function usd(value: number): number {
	return Number(value.toFixed(8));
}

function seconds(value: number): number {
	return Number(value.toFixed(3));
}

/** Sum of costs, or `null` if any component's rate was unknown. */
function sumKnown(costs: Array<number | null>): number | null {
	if (costs.some((cost) => cost === null)) return null;
	return usd(costs.reduce<number>((sum, cost) => sum + (cost as number), 0));
}

function buildSttLeg(usage: SttTurnUsage | null): SttCostLeg {
	// Only providers that actually received audio can bill for it.
	const received = (usage?.providers ?? []).filter((entry) => entry.bytes > 0);
	if (!received.length) {
		// Typed input, or an utterance with no audio: nothing was billed, so a
		// known 0 is correct here rather than an unknown.
		return { provider: usage?.provider ?? null, seconds: 0, bytes: 0, ratePerMinute: null, costUsd: 0 };
	}

	const breakdown: CostBreakdownEntry[] = received.map((entry) => {
		const audioSeconds = entry.bytes / INPUT_BYTES_PER_SECOND;
		const ratePerMinute = sttRatePerMinute(entry.provider);
		return {
			provider: entry.provider,
			quantity: seconds(audioSeconds),
			unit: 'seconds',
			rateUsd: ratePerMinute,
			costUsd: ratePerMinute === null ? null : usd((audioSeconds / 60) * ratePerMinute),
		};
	});

	const bytes = received.reduce((sum, entry) => sum + entry.bytes, 0);
	const single = received.length === 1;
	return {
		provider: single ? received[0].provider : (usage?.provider ?? null),
		seconds: seconds(bytes / INPUT_BYTES_PER_SECOND),
		bytes,
		ratePerMinute: single ? breakdown[0].rateUsd : null,
		costUsd: sumKnown(breakdown.map((entry) => entry.costUsd)),
		...(single ? {} : { breakdown }),
	};
}

function buildLlmLeg(usage: LlmTurnUsage): LlmCostLeg {
	const inputRate = rate(env.VOICE_COST_LLM_INPUT_PER_MTOK);
	const outputRate = rate(env.VOICE_COST_LLM_OUTPUT_PER_MTOK);
	const costUsd =
		inputRate === null || outputRate === null
			? null
			: usd((usage.inputTokens / 1_000_000) * inputRate + (usage.outputTokens / 1_000_000) * outputRate);
	return {
		provider: usage.provider,
		model: usage.model,
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		tokens: usage.inputTokens + usage.outputTokens,
		inputRatePerMTok: inputRate,
		outputRatePerMTok: outputRate,
		costUsd,
	};
}

function buildTtsLeg(charsByProvider: Record<string, number>): TtsCostLeg {
	const entries = Object.entries(charsByProvider).filter(([, chars]) => chars > 0);
	if (!entries.length) {
		// The device voice spoke, or the reply was silent: no provider billed.
		return { provider: null, characters: 0, ratePer1kChars: null, costUsd: 0 };
	}

	const breakdown: CostBreakdownEntry[] = entries.map(([provider, chars]) => {
		const ratePer1kChars = ttsRatePer1kChars(provider);
		return {
			provider,
			quantity: chars,
			unit: 'characters',
			rateUsd: ratePer1kChars,
			costUsd: ratePer1kChars === null ? null : usd((chars / 1000) * ratePer1kChars),
		};
	});

	const single = entries.length === 1;
	return {
		provider: single ? entries[0][0] : 'mixed',
		characters: entries.reduce((sum, [, chars]) => sum + chars, 0),
		ratePer1kChars: single ? breakdown[0].rateUsd : null,
		costUsd: sumKnown(breakdown.map((entry) => entry.costUsd)),
		...(single ? {} : { breakdown }),
	};
}

/**
 * Adds up the three billed legs for one turn. Pure and synchronous: it reads
 * already-collected quantities and the configured rates, nothing else.
 */
export function buildTurnCost(input: TurnCostInput): VoiceTurnCost {
	const stt = buildSttLeg(input.stt);
	const llm = buildLlmLeg(input.llm);
	const tts = buildTtsLeg(input.ttsCharsByProvider);

	const legs: Array<['stt' | 'llm' | 'tts', number | null]> = [
		['stt', stt.costUsd],
		['llm', llm.costUsd],
		['tts', tts.costUsd],
	];
	const unknownLegs = legs.filter(([, cost]) => cost === null).map(([name]) => name);

	return {
		userId: input.userId,
		turnId: input.turnId,
		language: input.language,
		currency: 'USD',
		stt,
		llm,
		tts,
		totalUsd: unknownLegs.length
			? null
			: usd(legs.reduce((sum, [, cost]) => sum + (cost as number), 0)),
		unknownLegs,
		complete: unknownLegs.length === 0,
	};
}

/**
 * Logs one structured cost record per turn — a single object so turns can be
 * aggregated later. No await, no I/O beyond the log write.
 *
 * The record is serialised here because the shared logger pretty-prints plain
 * objects across several lines; a per-turn cost record has to be one line to be
 * greppable and aggregatable.
 */
export function logTurnCost(input: TurnCostInput): VoiceTurnCost {
	const record = buildTurnCost(input);
	logger.info(JSON.stringify(record), 'Realtime voice turn cost');
	return record;
}
