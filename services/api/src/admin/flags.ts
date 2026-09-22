/**
 * NOVA — Runtime feature flag resolution.
 *
 * `feature_flags` existed as a table with an admin CRUD screen, and **nothing read
 * it**. Toggling a flag changed a row and nothing else: there was no resolver, no
 * call site, and no client contract. This module is the missing half.
 *
 * Precedence, most specific first:
 *
 *   1. user override        (`feature_flag_overrides` scope_type = 'user')
 *   2. organization override(scope_type = 'organization')
 *   3. environment override (`scope_type` = 'environment')
 *   4. global flag row      (`feature_flags.enabled`, gated by `rolloutPercent`)
 *   5. caller default       (so an unseeded flag cannot accidentally enable a feature)
 *
 * A **percentage rollout is deterministic**, never random: it hashes
 * `(flagKey, userId)` into 0–99 and compares against the percentage. A coin flip
 * per request would let a user be inside a 50% rollout on one request and outside
 * it on the next, which is not a rollout but a bug. The hash is stable across
 * processes and restarts, so the same user is consistently in or out.
 *
 * The resolver fails **closed**: a database error returns the caller's default
 * rather than assuming enabled.
 */

import { createHash } from 'node:crypto';
import { featureFlags, featureFlagOverrides } from '@nova/database';
import { getDb } from '../db/connection.js';
import { logger } from '../utils/logger.js';

export const FEATURE_FLAG_KEYS = [
	'VOICE_ASSISTANT',
	'BACKGROUND_ASSISTANT',
	'PROACTIVE_ASSISTANT',
	'AVATAR',
	'OVERLAY',
	'MEMORY',
	'TASKS',
	'REMINDERS',
	'FOLLOW_UP',
	'AI_TOOLS',
	'WEB_SEARCH',
	'VOICE_STT',
	'VOICE_TTS',
	'WAKE_WORD',
	'NOTIFICATIONS',
	'REALTIME',
	'AI',
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number];

const FLAG_KEY_SET: ReadonlySet<string> = new Set<string>(FEATURE_FLAG_KEYS);

export function isKnownFlagKey(key: string): key is FeatureFlagKey {
	return FLAG_KEY_SET.has(key);
}

/** Human descriptions, so the flag screen is self-explanatory. */
export const FLAG_DESCRIPTIONS: Record<FeatureFlagKey, string> = {
	VOICE_ASSISTANT: 'Voice conversations end to end (STT + AI + TTS).',
	BACKGROUND_ASSISTANT: 'Background workers may perform work for a user while the app is closed.',
	PROACTIVE_ASSISTANT: 'NOVA may initiate contact without being asked (follow-ups, nudges).',
	AVATAR: 'Animated avatar rendering in the app.',
	OVERLAY: 'Android floating overlay for hands-free use over other apps.',
	MEMORY: 'Long-term memory storage and recall.',
	TASKS: 'Task creation and management.',
	REMINDERS: 'Reminder scheduling and delivery.',
	FOLLOW_UP: 'Automatic follow-up on commitments NOVA detected.',
	AI_TOOLS: 'Tool/function calling from the assistant.',
	WEB_SEARCH: 'Web search grounding for answers.',
	VOICE_STT: 'Speech-to-text transcription.',
	VOICE_TTS: 'Text-to-speech synthesis.',
	WAKE_WORD: 'Always-on wake-word detection.',
	NOTIFICATIONS: 'Push and in-app notifications.',
	REALTIME: 'Realtime websocket transport.',
	AI: 'Master switch for all AI calls.',
};

export type FlagSource =
	| 'user_override'
	| 'organization_override'
	| 'environment_override'
	| 'global_rollout'
	| 'global'
	| 'default';

export type FlagEvaluation = {
	key: string;
	enabled: boolean;
	source: FlagSource;
	rolloutPercent: number | null;
	reason: string;
};

type FlagRow = { key: string; enabled: boolean; rolloutPercent: number | null };
type OverrideRow = {
	flagKey: string;
	scopeType: string;
	scopeValue: string;
	enabled: boolean;
	rolloutPercent: number | null;
	reason: string | null;
};

let flagCache: Map<string, FlagRow> | null = null;
let overrideCache: OverrideRow[] | null = null;
let loadedAt = 0;
const CACHE_TTL_MS = 15_000;

/**
 * Drops the cached flag state.
 *
 * Called on every flag mutation from the console, which is what makes an
 * "officially" immediate control actually immediate in this process. Other
 * replicas pick the change up when their 15-second TTL lapses; that bound is
 * deliberate and is reported in the console as the propagation window, rather than
 * claiming instantaneous global effect.
 */
export function invalidateFlagCache(): void {
	flagCache = null;
	overrideCache = null;
	loadedAt = 0;
}

async function loadFlags(): Promise<{ flags: Map<string, FlagRow>; overrides: OverrideRow[] }> {
	const now = Date.now();
	if (flagCache && overrideCache && now - loadedAt < CACHE_TTL_MS) {
		return { flags: flagCache, overrides: overrideCache };
	}

	try {
		const db = getDb();
		const [flagRows, overrideRows] = await Promise.all([
			db.select().from(featureFlags) as unknown as Promise<FlagRow[]>,
			db.select().from(featureFlagOverrides) as unknown as Promise<OverrideRow[]>,
		]);
		flagCache = new Map(flagRows.map((row) => [row.key, row]));
		overrideCache = overrideRows;
		loadedAt = now;
	} catch (error) {
		logger.warn({ err: error }, '[admin-flags] could not load feature flags; falling back to defaults');
		flagCache = flagCache ?? new Map();
		overrideCache = overrideCache ?? [];
		loadedAt = now;
	}

	return { flags: flagCache, overrides: overrideCache };
}

/**
 * Deterministic cohort membership.
 *
 * `sha256(flagKey:userId)` → first 4 bytes → 0–99. A stable hash means a user's
 * bucket does not change between requests or processes, so a 50% rollout gives the
 * same half of users the feature every time.
 */
export function rolloutBucket(flagKey: string, subjectId: string): number {
	const digest = createHash('sha256').update(`${flagKey}:${subjectId}`).digest();
	return digest.readUInt32BE(0) % 100;
}

export type FlagContext = {
	userId?: string | null;
	organizationId?: string | null;
	environment?: string | null;
};

function currentEnvironment(): string {
	const explicit = process.env.NOVA_ENVIRONMENT ?? process.env.APP_ENV;
	if (explicit) return explicit.toLowerCase();
	if (process.env.NODE_ENV === 'production') return 'production';
	if (process.env.NODE_ENV === 'test') return 'test';
	return process.env.NODE_ENV ?? 'development';
}

/**
 * Resolves one flag for one subject.
 *
 * `fallback` is returned when no row and no override exists. Callers pass the
 * value that preserves the pre-flag behaviour, so introducing a flag cannot change
 * behaviour until an operator sets it.
 */
export async function evaluateFlag(
	key: string,
	context: FlagContext = {},
	fallback = false,
): Promise<FlagEvaluation> {
	try {
		const { flags, overrides } = await loadFlags();
		const environment = (context.environment ?? currentEnvironment()).toLowerCase();

		// Most specific first. Each scope is checked in turn rather than collecting
		// all matches, so the precedence is visible in the code and cannot be changed
		// by the order rows happen to come back from the database.
		const scopes: Array<{ type: string; value: string | null | undefined; source: FlagSource }> = [
			{ type: 'user', value: context.userId, source: 'user_override' },
			{ type: 'organization', value: context.organizationId, source: 'organization_override' },
			{ type: 'environment', value: environment, source: 'environment_override' },
		];

		for (const scope of scopes) {
			if (!scope.value) continue;
			const match = overrides.find(
				(o) => o.flagKey === key && o.scopeType === scope.type && o.scopeValue === scope.value,
			);
			if (!match) continue;

			// An override may itself carry a rollout percentage; when it does, the
			// same deterministic bucket applies, scoped to the subject so one user's
			// membership is stable.
			if (match.rolloutPercent !== null && match.rolloutPercent !== undefined && context.userId) {
				const bucket = rolloutBucket(key, context.userId);
				const inside = bucket < match.rolloutPercent;
				return {
					key,
					enabled: match.enabled && inside,
					source: scope.source,
					rolloutPercent: match.rolloutPercent,
					reason: `${scope.type} override ${scope.value} at ${match.rolloutPercent}% — bucket ${bucket} is ${inside ? 'inside' : 'outside'}`,
				};
			}

			return {
				key,
				enabled: match.enabled,
				source: scope.source,
				rolloutPercent: match.rolloutPercent ?? null,
				reason: `${scope.type} override ${scope.value} = ${match.enabled ? 'on' : 'off'}`,
			};
		}

		const global = flags.get(key);
		if (!global) {
			return { key, enabled: fallback, source: 'default', rolloutPercent: null, reason: 'no flag row; using default' };
		}

		const percent = global.rolloutPercent ?? 0;
		// A disabled global flag is off regardless of percentage: the percentage
		// narrows an enabled flag, it does not enable a disabled one.
		if (!global.enabled) {
			return { key, enabled: false, source: 'global', rolloutPercent: percent, reason: 'global flag disabled' };
		}
		if (percent >= 100) {
			return { key, enabled: true, source: 'global', rolloutPercent: percent, reason: 'global flag enabled at 100%' };
		}
		if (percent <= 0) {
			// enabled=true with rollout 0 is the "on for nobody yet" state. With no
			// subject to hash there is nothing to roll out to, so an anonymous caller
			// is outside the cohort.
			return {
				key,
				enabled: false,
				source: 'global_rollout',
				rolloutPercent: 0,
				reason: 'global flag enabled but rollout is 0%',
			};
		}

		if (!context.userId) {
			return {
				key,
				enabled: false,
				source: 'global_rollout',
				rolloutPercent: percent,
				reason: `${percent}% rollout requires a user identity; caller is anonymous`,
			};
		}

		const bucket = rolloutBucket(key, context.userId);
		const inside = bucket < percent;
		return {
			key,
			enabled: inside,
			source: 'global_rollout',
			rolloutPercent: percent,
			reason: `${percent}% rollout — bucket ${bucket} is ${inside ? 'inside' : 'outside'}`,
		};
	} catch (error) {
		logger.error({ err: error, key }, '[admin-flags] evaluation failed; failing closed');
		return { key, enabled: fallback, source: 'default', rolloutPercent: null, reason: 'evaluation error' };
	}
}

/** Shorthand for the common boolean question. */
export async function isFlagEnabled(
	key: string,
	context: FlagContext = {},
	fallback = false,
): Promise<boolean> {
	return (await evaluateFlag(key, context, fallback)).enabled;
}

/** Every flag evaluated for one subject, for the mobile bootstrap response. */
export async function evaluateAllFlags(
	context: FlagContext = {},
	fallbacks: Record<string, boolean> = {},
): Promise<FlagEvaluation[]> {
	const { flags } = await loadFlags();
	const keys = new Set<string>([...FEATURE_FLAG_KEYS, ...flags.keys()]);
	const results = await Promise.all(
		[...keys].map((key) => evaluateFlag(key, context, fallbacks[key] ?? false)),
	);
	return results.sort((a, b) => a.key.localeCompare(b.key));
}
