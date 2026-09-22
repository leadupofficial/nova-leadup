/**
 * NOVA — Runtime configuration catalog and resolver.
 *
 * The catalog below is the **actual set of keys this repository reads**. It was
 * derived by inspecting `services/api/src/utils/env.ts`, the realtime STT/TTS
 * providers, `utils/health.ts` and the mobile-facing bootstrap, not invented from
 * a generic list — a configuration screen full of variables nothing reads is worse
 * than no screen, because it implies control that does not exist.
 *
 * Each entry records where its value may come from:
 *
 *   - `envOnly: true`  — the value is read from the process environment at boot by
 *     code that has no database access, or is itself a bootstrap secret
 *     (`JWT_SECRET`, `DATABASE_URL`). The console may *inspect* it and report
 *     whether it is set and what it is for, but cannot change it: a database row
 *     does not change a process's environment, and pretending otherwise is the
 *     single most misleading thing this screen could do.
 *
 *   - otherwise — the database value wins over the environment, and
 *     `invalidateConfigCache()` is called on write so the next read in this process
 *     sees it. `restartRequired` marks keys that are captured at module load and
 *     therefore need a rolling restart to take effect elsewhere.
 *
 * Everything is resolved through `resolveConfig` / `readRuntimeConfig`, never by
 * reading `process.env` directly in a route, so there is exactly one precedence
 * order to reason about.
 */

import { systemConfigs } from '@nova/database';
import { getDb, getDbPool } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { decryptSecret, fingerprintSecret, isSecretStoreConfigured, maskSecret } from './secrets.js';
import { isKeyReadByRuntime, runtimeWiringNote } from './runtime-config.js';

export type ConfigScope = 'public' | 'private' | 'secret';
export type ConfigValueType = 'string' | 'number' | 'boolean' | 'json' | 'url';

export type ConfigKeyDefinition = {
	key: string;
	scope: ConfigScope;
	category: string;
	valueType: ConfigValueType;
	description: string;
	defaultValue?: string;
	/** Services that read this key. Drives the change-impact panel. */
	usedBy: string[];
	/** True when the value is captured at process start and needs a restart. */
	restartRequired: boolean;
	/** True when the process environment is the only usable source. */
	envOnly: boolean;
	/**
	 * True when running code actually reads this value.
	 *
	 * This is not decoration. The console showed a configuration key as though editing
	 * it would change behaviour, while a grep proved nothing read it — the most
	 * misleading thing this screen could do. `runtime-config.ts` owns the list of keys
	 * that are genuinely wired, and it also knows which keys are read by a dedicated
	 * subsystem (the control gate, the mobile bootstrap) rather than by a service.
	 */
	readByRuntime?: boolean;
	allowedValues?: readonly string[];
	min?: number;
	max?: number;
	displayOrder?: number;
};

/**
 * The catalog.
 *
 * `usedBy` names the concrete call sites, which is what makes the pre-change
 * impact panel honest: "AI Service, Conversation Service, Background Assistant"
 * is only useful if it is true.
 */
export const CONFIG_CATALOG: readonly ConfigKeyDefinition[] = [
	// ─── AI ────────────────────────────────────────────────────────────────────
	{
		key: 'AI_DEFAULT_MODEL',
		scope: 'private',
		category: 'AI',
		valueType: 'string',
		// No `defaultValue` on purpose. The resolver's order is database -> ANTHROPIC_MODEL
		// -> this default, and a default here would shadow ANTHROPIC_MODEL entirely,
		// silently ignoring a documented environment variable. The built-in model id
		// lives in `admin/runtime-config.ts` where the AI service reads it.
		description: 'Model NOVA uses for the primary chat completion. Falls back to ANTHROPIC_MODEL, then the built-in default.',
		usedBy: ['ai-service', 'conversation-service', 'background-assistant'],
		restartRequired: false,
		envOnly: false,
		readByRuntime: true,
		displayOrder: 10,
	},
	{
		// The environment name the AI service read *before* this console existed. Kept
		// as a first-class catalog entry rather than a hidden alias so an operator can
		// see which one is winning: `AI_DEFAULT_MODEL` beats this, and this beats the
		// built-in default.
		key: 'ANTHROPIC_MODEL',
		scope: 'private',
		category: 'AI',
		valueType: 'string',
		description:
			'Legacy environment variable for the chat model. Read when AI_DEFAULT_MODEL is not set.',
		usedBy: ['ai-service'],
		restartRequired: false,
		envOnly: false,
		readByRuntime: true,
		displayOrder: 10,
	},
	{
		key: 'LLM_MAX_OUTPUT_TOKENS',
		scope: 'private',
		category: 'AI',
		valueType: 'number',
		description:
			'Legacy environment variable for the per-reply token ceiling. Read when AI_MAX_TOKENS is not set.',
		usedBy: ['ai-service'],
		restartRequired: false,
		envOnly: false,
		readByRuntime: true,
		min: 256,
		max: 32768,
		displayOrder: 12,
	},
	{
		key: 'AI_FALLBACK_MODEL',
		scope: 'private',
		category: 'AI',
		valueType: 'string',
		description: 'Model tried when the primary model fails or is rate limited.',
		defaultValue: 'claude-3-5-haiku-latest',
		usedBy: ['ai-service', 'llm-fallback'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 11,
	},
	{
		key: 'AI_MAX_TOKENS',
		scope: 'private',
		category: 'AI',
		valueType: 'number',
		description: 'Upper bound on completion tokens per request. Defaults to LLM_MAX_OUTPUT_TOKENS, then 4096.',
		// Must agree with `LLM_MAX_OUTPUT_TOKENS`' default and bounds in utils/env.ts, or a
		// console value would be silently out of the range the AI service accepts.
		defaultValue: '4096',
		min: 256,
		max: 32768,
		usedBy: ['ai-service'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 12,
		readByRuntime: true,
	},
	{
		key: 'AI_TIMEOUT_MS',
		scope: 'private',
		category: 'AI',
		valueType: 'number',
		description: 'Per-request timeout for the LLM provider, in milliseconds.',
		defaultValue: '60000',
		min: 1000,
		max: 600000,
		usedBy: ['ai-service', 'llm-transport'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 13,
	},
	{
		key: 'AI_RETRY_COUNT',
		scope: 'private',
		category: 'AI',
		valueType: 'number',
		description: 'How many times a failed LLM call is retried before fallback.',
		defaultValue: '2',
		min: 0,
		max: 10,
		usedBy: ['ai-service', 'llm-fallback'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 14,
	},
	{
		key: 'ANTHROPIC_BASE_URL',
		scope: 'private',
		category: 'AI',
		valueType: 'url',
		description: 'Override the Anthropic API base URL (proxy or gateway deployments).',
		usedBy: ['ai-service'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 15,
	},

	// ─── Voice: STT ────────────────────────────────────────────────────────────
	{
		key: 'STT_PROVIDER',
		scope: 'private',
		category: 'Voice',
		valueType: 'string',
		description: 'Speech-to-text provider used by the realtime voice session.',
		defaultValue: 'sarvam',
		allowedValues: ['sarvam', 'deepgram'],
		usedBy: ['realtime-stt', 'voice-session'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 20,
	},
	{
		key: 'STT_LANGUAGE',
		scope: 'private',
		category: 'Voice',
		valueType: 'string',
		description: 'BCP-47 language code passed to the STT provider.',
		defaultValue: 'en-IN',
		usedBy: ['realtime-stt'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 21,
		readByRuntime: true,
	},
	{
		key: 'STT_TIMEOUT_MS',
		scope: 'private',
		category: 'Voice',
		valueType: 'number',
		description: 'How long to wait for a transcript before giving up.',
		defaultValue: '15000',
		min: 1000,
		max: 120000,
		usedBy: ['realtime-stt'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 22,
	},

	// ─── Voice: TTS ────────────────────────────────────────────────────────────
	{
		key: 'TTS_PROVIDER',
		scope: 'private',
		category: 'Voice',
		valueType: 'string',
		description: 'Text-to-speech provider. `elevenlabs` is tried first when configured.',
		defaultValue: 'sarvam',
		allowedValues: ['elevenlabs', 'deepgram', 'sarvam'],
		usedBy: ['realtime-tts'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 30,
	},
	{
		key: 'TTS_VOICE',
		scope: 'private',
		category: 'Voice',
		valueType: 'string',
		description: 'Provider voice identifier. Empty means the provider default.',
		usedBy: ['realtime-tts'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 31,
	},
	{
		key: 'TTS_SPEED',
		scope: 'private',
		category: 'Voice',
		valueType: 'number',
		description: 'Speech rate multiplier. 1.0 is the provider default.',
		defaultValue: '1.0',
		min: 0.25,
		max: 4,
		usedBy: ['realtime-tts'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 32,
	},

	// ─── Assistant behaviour flags ─────────────────────────────────────────────
	{
		key: 'REMINDER_ENABLED',
		scope: 'private',
		category: 'Assistant',
		valueType: 'boolean',
		description: 'Master switch for reminder scheduling and the follow-up engine.',
		defaultValue: 'true',
		usedBy: ['reminders-route', 'follow-up-engine'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 40,
		readByRuntime: true,
	},
	{
		key: 'BACKGROUND_ASSISTANT_ENABLED',
		scope: 'private',
		category: 'Assistant',
		valueType: 'boolean',
		description: 'Allows background workers to run proactive work per user.',
		defaultValue: 'true',
		usedBy: ['worker', 'follow-up-engine'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 41,
		readByRuntime: true,
	},
	{
		key: 'PROACTIVE_ASSISTANT_ENABLED',
		scope: 'private',
		category: 'Assistant',
		valueType: 'boolean',
		description: 'Enables NOVA reaching out unprompted (follow-ups, nudges).',
		defaultValue: 'true',
		usedBy: ['follow-up-engine', 'notification-service'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 42,
		readByRuntime: true,
	},
	{
		key: 'MEMORY_ENABLED',
		scope: 'private',
		category: 'Assistant',
		valueType: 'boolean',
		description: 'Whether NOVA stores and recalls long-term memory.',
		defaultValue: 'true',
		usedBy: ['memory-service', 'ai-service'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 43,
		readByRuntime: true,
	},
	{
		key: 'MEMORY_RETENTION_DAYS',
		scope: 'private',
		category: 'Assistant',
		valueType: 'number',
		description: 'How long memory entries are retained before the retention sweep removes them.',
		defaultValue: '365',
		min: 1,
		max: 3650,
		usedBy: ['retention-sweep'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 44,
	},

	// ─── Notifications ─────────────────────────────────────────────────────────
	{
		key: 'NOTIFICATION_ENABLED',
		scope: 'private',
		category: 'Notifications',
		valueType: 'boolean',
		description: 'Master switch for outbound notifications.',
		defaultValue: 'true',
		usedBy: ['notification-service'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 50,
	},
	{
		key: 'PUSH_ENABLED',
		scope: 'private',
		category: 'Notifications',
		valueType: 'boolean',
		description: 'Whether Firebase push delivery is attempted.',
		defaultValue: 'true',
		usedBy: ['notification-service'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 51,
	},

	// ─── Mobile app contract ───────────────────────────────────────────────────
	{
		key: 'MOBILE_MIN_SUPPORTED_VERSION',
		scope: 'public',
		category: 'Mobile App',
		valueType: 'string',
		description: 'Oldest app build allowed to use this backend. Older clients are told to update.',
		defaultValue: '1.0.0',
		usedBy: ['mobile-bootstrap'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 60,
		readByRuntime: true,
	},
	{
		key: 'MOBILE_LATEST_VERSION',
		scope: 'public',
		category: 'Mobile App',
		valueType: 'string',
		description: 'Newest released app build, shown as the update target.',
		defaultValue: '1.0.0',
		usedBy: ['mobile-bootstrap'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 61,
		readByRuntime: true,
	},
	{
		key: 'MOBILE_FORCE_UPDATE',
		scope: 'public',
		category: 'Mobile App',
		valueType: 'boolean',
		description: 'When true, clients below the minimum version must update before continuing.',
		defaultValue: 'false',
		usedBy: ['mobile-bootstrap'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 62,
		readByRuntime: true,
	},
	{
		key: 'MAINTENANCE_MODE',
		scope: 'public',
		category: 'Maintenance',
		valueType: 'boolean',
		description: 'Global maintenance switch. When on, clients are told NOVA is unavailable.',
		defaultValue: 'false',
		usedBy: ['mobile-bootstrap', 'ai-service', 'voice-session'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 70,
		readByRuntime: true,
	},
	{
		key: 'MAINTENANCE_MESSAGE',
		scope: 'public',
		category: 'Maintenance',
		valueType: 'string',
		description: 'Message shown to users while maintenance mode is active.',
		defaultValue: 'NOVA is briefly unavailable while we perform scheduled maintenance.',
		usedBy: ['mobile-bootstrap'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 71,
		readByRuntime: true,
	},
	{
		key: 'AVATAR_ENABLED',
		scope: 'public',
		category: 'Mobile App',
		valueType: 'boolean',
		description: 'Whether the avatar UI is available to clients.',
		defaultValue: 'true',
		usedBy: ['mobile-bootstrap', 'avatar'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 63,
		readByRuntime: true,
	},
	{
		key: 'OVERLAY_ENABLED',
		scope: 'public',
		category: 'Mobile App',
		valueType: 'boolean',
		description: 'Whether the Android floating overlay is offered to clients.',
		defaultValue: 'true',
		usedBy: ['mobile-bootstrap'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 64,
		readByRuntime: true,
	},

	// ─── Limits ────────────────────────────────────────────────────────────────
	{
		key: 'RATE_LIMIT_ENABLED',
		scope: 'private',
		category: 'Limits',
		valueType: 'boolean',
		description: 'Whether API rate limiting is enforced.',
		defaultValue: 'true',
		usedBy: ['rate-limit-middleware'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 80,
	},
	{
		key: 'MAX_REQUEST_SIZE',
		scope: 'private',
		category: 'Limits',
		valueType: 'string',
		description: 'Maximum accepted request body size, e.g. `5mb`.',
		defaultValue: '5mb',
		usedBy: ['api-server'],
		restartRequired: true,
		envOnly: false,
		displayOrder: 81,
	},
	{
		key: 'S3_BUCKET',
		scope: 'private',
		category: 'Storage',
		valueType: 'string',
		description: 'Object-storage bucket for recordings and uploads.',
		defaultValue: 'nova-recordings',
		usedBy: ['audio-storage'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 90,
	},

	// ─── Bootstrap secrets: inspectable, never editable from the console ──────
	{
		key: 'DATABASE_URL',
		scope: 'secret',
		category: 'Bootstrap',
		valueType: 'string',
		description: 'PostgreSQL connection string. Read at process start; changing it requires a deployment-level update.',
		usedBy: ['api-server', 'all-services'],
		restartRequired: true,
		envOnly: true,
		displayOrder: 5,
	},
	{
		key: 'JWT_SECRET',
		scope: 'secret',
		category: 'Bootstrap',
		valueType: 'string',
		description: 'Access-token signing secret. Read at process start; rotating it invalidates every live session.',
		usedBy: ['auth'],
		restartRequired: true,
		envOnly: true,
		displayOrder: 6,
	},
	{
		key: 'JWT_REFRESH_TOKEN_SECRET',
		scope: 'secret',
		category: 'Bootstrap',
		valueType: 'string',
		description: 'Refresh-token signing secret. Read at process start.',
		usedBy: ['auth'],
		restartRequired: true,
		envOnly: true,
		displayOrder: 7,
	},
	{
		key: 'REDIS_URL',
		scope: 'secret',
		category: 'Bootstrap',
		valueType: 'string',
		description: 'Redis connection string, used for caching and the distributed token denylist.',
		usedBy: ['api-server'],
		restartRequired: true,
		envOnly: true,
		displayOrder: 8,
	},

	// ─── Provider credentials: write-only secrets ─────────────────────────────
	{
		key: 'ANTHROPIC_API_KEY',
		scope: 'secret',
		category: 'AI',
		valueType: 'string',
		description: 'Anthropic API key for the primary LLM.',
		usedBy: ['ai-service'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 100,
	},
	{
		key: 'BROCODE_API_KEY',
		scope: 'secret',
		category: 'AI',
		valueType: 'string',
		description: 'Brocode gateway key, accepted as an alternative LLM credential.',
		usedBy: ['ai-service'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 101,
	},
	{
		key: 'OPENAI_API_KEY',
		scope: 'secret',
		category: 'AI',
		valueType: 'string',
		description: 'OpenAI API key. Read by the env schema; wire-up depends on the configured provider.',
		usedBy: ['ai-service'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 102,
	},
	{
		key: 'GOOGLE_CLOUD_API_KEY',
		scope: 'secret',
		category: 'AI',
		valueType: 'string',
		description: 'Google Cloud key (Gemini / Speech).',
		usedBy: ['ai-service'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 103,
	},
	{
		key: 'DEEPGRAM_API_KEY',
		scope: 'secret',
		category: 'Voice',
		valueType: 'string',
		description: 'Deepgram key for speech-to-text and its TTS voices.',
		usedBy: ['realtime-stt', 'realtime-tts'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 110,
	},
	{
		key: 'ELEVENLABS_API_KEY',
		scope: 'secret',
		category: 'Voice',
		valueType: 'string',
		description: 'ElevenLabs key for text-to-speech. Preferred TTS provider when present.',
		usedBy: ['realtime-tts'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 111,
	},
	{
		key: 'SARVAM_API_KEY',
		scope: 'secret',
		category: 'Voice',
		valueType: 'string',
		description: 'Sarvam key for Indian-language speech-to-text and text-to-speech.',
		usedBy: ['realtime-stt', 'realtime-tts'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 112,
	},
	{
		key: 'S3_ACCESS_KEY',
		scope: 'secret',
		category: 'Storage',
		valueType: 'string',
		description: 'Object-storage access key.',
		usedBy: ['audio-storage'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 120,
	},
	{
		key: 'S3_SECRET_KEY',
		scope: 'secret',
		category: 'Storage',
		valueType: 'string',
		description: 'Object-storage secret key. Resolved from `S3_SECRET_ACCESS_KEY` when that is the name in use.',
		usedBy: ['audio-storage'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 121,
	},
	{
		key: 'FIREBASE_SERVICE_ACCOUNT_JSON',
		scope: 'secret',
		category: 'Notifications',
		valueType: 'string',
		description: 'Firebase service-account credentials for push delivery.',
		usedBy: ['notification-service'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 130,
	},
	{
		key: 'STRIPE_SECRET_KEY',
		scope: 'secret',
		category: 'Payments',
		valueType: 'string',
		description: 'Stripe secret key for subscriptions.',
		usedBy: ['subscriptions'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 140,
	},
	{
		key: 'SMTP_URL',
		scope: 'secret',
		category: 'Notifications',
		valueType: 'string',
		description: 'SMTP connection URL for outbound email.',
		usedBy: ['notification-service'],
		restartRequired: false,
		envOnly: false,
		displayOrder: 131,
	},
	{
		key: 'NOVA_CONFIG_ENCRYPTION_KEY',
		scope: 'secret',
		category: 'Bootstrap',
		valueType: 'string',
		description: 'Key that encrypts all other stored secrets. Read at process start and must not be changed from the console.',
		usedBy: ['secret-store'],
		restartRequired: true,
		envOnly: true,
		displayOrder: 9,
	},
];

const CATALOG_BY_KEY = new Map(CONFIG_CATALOG.map((definition) => [definition.key, definition]));

export function getConfigDefinition(key: string): ConfigKeyDefinition | undefined {
	return CATALOG_BY_KEY.get(key);
}

export function isKnownConfigKey(key: string): boolean {
	return CATALOG_BY_KEY.has(key);
}

// ─── Resolution ──────────────────────────────────────────────────────────────

type CachedRow = {
	key: string;
	scope: string;
	value: string | null;
	secretCiphertext: string | null;
	secretHint: string | null;
	source: string;
	updatedAt: Date;
	updatedBy: string | null;
	lastTestedAt: Date | null;
	lastTestStatus: string | null;
	lastTestMessage: string | null;
};

let cache: Map<string, CachedRow> | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 15_000;

/**
 * Drops the cache **and republishes the synchronous overlay**, returning once the overlay
 * reflects the write.
 *
 * The overlay is what the hot paths read — `getAnthropicHttpConfig`, and the proactive and
 * background-jobs gates. Clearing it without republishing left it empty, and an empty overlay
 * means `runtimeConfigValue` falls through to the environment and the catalog default, so a
 * value an operator had just stored read as unset until the next 15-second refresh.
 *
 * That was a real defect, not a theoretical one: writing `PROACTIVE_ASSISTANT_ENABLED=false`
 * left `proactiveGate` allowing the run, which is precisely the "the console says it is off and
 * it is not" failure the gate exists to prevent. Found by `scripts/verify-control-gates.ts`,
 * which writes the key and observes the gate.
 *
 * Awaiting makes the write path honest: when the route returns, the value is in effect.
 */
export async function invalidateConfigCache(): Promise<void> {
	cache = null;
	cacheLoadedAt = 0;
	const { refreshRuntimeOverlay } = await import('./runtime-config.js');
	await refreshRuntimeOverlay();
}

async function loadCache(): Promise<Map<string, CachedRow>> {
	const now = Date.now();
	if (cache && now - cacheLoadedAt < CACHE_TTL_MS) return cache;

	try {
		const db = getDb();
		const rows = (await db.select().from(systemConfigs)) as unknown as CachedRow[];
		cache = new Map(rows.map((row) => [row.key, row]));
		cacheLoadedAt = now;

		// Republish the synchronous overlay that hot paths read.
		//
		// This is the bridge that makes a console write change real runtime behaviour:
		// `getAnthropicHttpConfig()` cannot await, so it reads the overlay, and the
		// overlay is refreshed here — on the same 15-second cadence as this cache.
		// Imported lazily to avoid a circular module dependency (runtime-config imports
		// this file's `resolveConfigMap`).
		const { refreshRuntimeOverlay } = await import('./runtime-config.js');
		void refreshRuntimeOverlay();
	} catch (error) {
		logger.warn({ err: error }, '[admin-config] could not load system_configs; falling back to environment');
		// An empty map, not a thrown error: configuration reads happen on hot
		// paths (a chat request asks whether proactive is enabled), and a database
		// hiccup must degrade to environment defaults rather than fail the request.
		cache = cache ?? new Map();
		cacheLoadedAt = now;
	}
	return cache;
}

/**
 * The raw value for a key, following precedence:
 *
 *   1. database row (when the key is not `envOnly` and a value/secret exists)
 *   2. process environment
 *   3. catalog default
 *
 * Returns `null` when none of the three supply anything.
 */
export async function resolveConfig(key: string): Promise<string | null> {
	const definition = getConfigDefinition(key);

	if (!definition?.envOnly) {
		const rows = await loadCache();
		const row = rows.get(key);
		if (row) {
			if (row.secretCiphertext) {
				try {
					return decryptSecret(row.secretCiphertext);
				} catch (error) {
					logger.error({ err: error, key }, '[admin-config] stored secret could not be decrypted');
					return null;
				}
			}
			if (row.value !== null && row.value !== undefined) return row.value;
		}
	}

	const fromEnv = process.env[key];
	if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

	return definition?.defaultValue ?? null;
}

export async function resolveConfigBoolean(key: string, fallback = false): Promise<boolean> {
	const raw = await resolveConfig(key);
	if (raw === null) return fallback;
	return raw === 'true' || raw === '1' || raw === 'yes';
}

export async function resolveConfigNumber(key: string, fallback: number): Promise<number> {
	const raw = await resolveConfig(key);
	if (raw === null) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Resolves a whole set of keys at once.
 *
 * Callers that need several values (the mobile bootstrap needs six) should use this
 * rather than awaiting `resolveConfig` in a loop, which would re-read the cache map
 * per key.
 */
export async function resolveConfigMap(keys: readonly string[]): Promise<Record<string, string | null>> {
	const rows = await loadCache();
	const out: Record<string, string | null> = {};

	for (const key of keys) {
		const definition = CATALOG_BY_KEY.get(key);
		let value: string | null = null;

		if (!definition?.envOnly) {
			const row = rows.get(key);
			if (row?.secretCiphertext) {
				try {
					value = decryptSecret(row.secretCiphertext);
				} catch {
					value = null;
				}
			} else if (row?.value != null) {
				value = row.value;
			}
		}

		if (value === null) {
			const fromEnv = process.env[key];
			if (fromEnv !== undefined && fromEnv !== '') value = fromEnv;
		}
		if (value === null) value = definition?.defaultValue ?? null;

		out[key] = value;
	}

	return out;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export type ConfigValidationResult = { valid: true; coerced: string } | { valid: false; error: string };

/**
 * Validates and normalises a candidate value for a key.
 *
 * Rejects rather than coerces where coercion would hide a mistake: `allowedValues`
 * is an exact match, and a non-numeric string for a number is an error, not `NaN`.
 */
export function validateConfigValue(definition: ConfigKeyDefinition, raw: string): ConfigValidationResult {
	const value = raw.trim();

	if (definition.scope === 'secret') {
		if (value.length === 0) return { valid: false, error: 'A secret cannot be empty.' };
		if (value.length > 20000) return { valid: false, error: 'Secret is implausibly long.' };
		if (/\s/.test(value)) {
			return { valid: false, error: 'A secret must not contain whitespace.' };
		}
		return { valid: true, coerced: value };
	}

	switch (definition.valueType) {
		case 'number': {
			const parsed = Number(value);
			if (!Number.isFinite(parsed)) return { valid: false, error: `"${value}" is not a number.` };
			if (definition.min !== undefined && parsed < definition.min) {
				return { valid: false, error: `Must be at least ${definition.min}.` };
			}
			if (definition.max !== undefined && parsed > definition.max) {
				return { valid: false, error: `Must be at most ${definition.max}.` };
			}
			return { valid: true, coerced: String(parsed) };
		}

		case 'boolean': {
			const lower = value.toLowerCase();
			if (['true', '1', 'yes', 'on'].includes(lower)) return { valid: true, coerced: 'true' };
			if (['false', '0', 'no', 'off'].includes(lower)) return { valid: true, coerced: 'false' };
			return { valid: false, error: `"${value}" is not a boolean (use true or false).` };
		}

		case 'url': {
			try {
				const url = new URL(value);
				if (!['http:', 'https:'].includes(url.protocol)) {
					return { valid: false, error: 'Only http and https URLs are accepted.' };
				}
				return { valid: true, coerced: value };
			} catch {
				return { valid: false, error: `"${value}" is not a valid URL.` };
			}
		}

		case 'json': {
			try {
				JSON.parse(value);
				return { valid: true, coerced: value };
			} catch {
				return { valid: false, error: 'Value is not valid JSON.' };
			}
		}

		default: {
			if (value.length > 4000) return { valid: false, error: 'Value is too long.' };
			if (definition.allowedValues && !definition.allowedValues.includes(value)) {
				return {
					valid: false,
					error: `Must be one of: ${definition.allowedValues.join(', ')}.`,
				};
			}
			return { valid: true, coerced: value };
		}
	}
}

// ─── Read model for the console ──────────────────────────────────────────────

export type ConfigView = {
	key: string;
	scope: ConfigScope;
	category: string;
	valueType: ConfigValueType;
	description: string;
	usedBy: string[];
	restartRequired: boolean;
	envOnly: boolean;
	allowedValues?: readonly string[];
	/** `secret` | `environment` | `database` | `default` | `unset` */
	effectiveSource: 'secret' | 'environment' | 'database' | 'default' | 'unset';
	/**
	 * Whether editing this key changes running behaviour.
	 *
	 * The console shows this next to every key. A key whose stored value is inert is
	 * not hidden — an operator may legitimately prepare a value — but it is labelled,
	 * because "I saved it and nothing happened" is otherwise indistinguishable from a
	 * broken console.
	 */
	readByRuntime: boolean;
	runtimeWiringNote: string;
	/** Present for non-secret keys. Never populated for `secret` scope. */
	value: string | null;
	/** Legacy environment name actually present in the process, when it differs. */
	envKeyPresent: boolean;
	/** Masked hint for a secret, e.g. `••••••••91AB`. */
	secretHint: string | null;
	secretFingerprint: string | null;
	updatedAt: string | null;
	updatedBy: string | null;
	/**
	 * The most recent provider connectivity test that exercised this credential.
	 *
	 * Sourced from `provider_health_checks`, **not** from `system_configs.last_tested_*`. Those
	 * three columns were created by the control-center migration and never written by anything,
	 * so both `/configuration` and `/ai/secrets` reported "never tested" beside credentials that
	 * had been tested minutes earlier. Joining the history table is also the only approach that
	 * works for the normal production case: a credential supplied by the environment has no
	 * `system_configs` row to update.
	 */
	lastTestedAt: string | null;
	lastTestStatus: string | null;
	/**
	 * True when the recorded test ran against a **different value** than the one stored now.
	 *
	 * The result is then not a statement about this credential at all. It is reported rather than
	 * hidden, because "the last test passed, against the key you have since replaced" is a real and
	 * useful thing to know — what was misleading was presenting it as the current status.
	 */
	testStale: boolean;
	/** Fingerprint of the value the recorded test exercised, for the operator to compare. */
	lastTestedFingerprint: string | null;
	lastTestMessage: string | null;
	/**
	 * The provider connectivity tests that cover this key, by provider id.
	 *
	 * Distinct from `usedBy`, which is the catalog's statement of which *services* read the key.
	 * S3_ACCESS_KEY and STRIPE_SECRET_KEY are read by infrastructure that is not in the AI/voice
	 * provider list, yet both have a real end-to-end test — so a screen that equated "no in-app
	 * provider references this" with "untested" would be wrong about them.
	 */
	testedBy: string[];
};

/**
 * Which config keys each provider connectivity test validates.
 *
 * This is what turns "the provider answered at 14:02" into "this credential was proven to work at
 * 14:02" on the configuration screens. It lives here rather than beside the tests because it is
 * read *backwards* — from a key to the tests that cover it — by `listConfigViews`.
 *
 * A provider may validate more than one key (object storage needs a key and a secret), and a key
 * is not always named after the test that uses it, so the mapping is explicit.
 */
/**
 * Fingerprint of the credential values a provider test uses.
 *
 * **One definition, used by both sides of the staleness comparison.** The first version of this
 * feature computed `"KEY=value"` here and a bare `value` in the read model, so the two sides were
 * fingerprinting different strings and *every* result read stale — including one from a test that had
 * just run against the value in force. The live check caught it immediately, which is the whole
 * reason the comparison is verified end to end rather than asserted in a unit test on one side.
 *
 * Combines every key the provider reads, so a provider that validates two keys (object storage) goes
 * stale when *either* changes. Names are joined with the values using a NUL separator, so
 * `A=ab, B=c` and `A=a, B=bc` cannot collide.
 *
 * Unset keys contribute the literal `unset` rather than being skipped: a provider that goes from
 * configured to unconfigured has changed state, and the previous result must stop being shown as
 * current. Never throws — an uncomputable fingerprint is `null`, which the read model treats as
 * "nothing describes this credential" rather than as a match.
 */
export async function providerConfigurationFingerprint(provider: string): Promise<string | null> {
	const keys = PROVIDER_CREDENTIAL_KEYS[provider];
	if (!keys || keys.length === 0) return null;
	try {
		const parts: string[] = [];
		for (const key of keys) {
			const value = await resolveConfig(key);
			parts.push(`${key}=${value === null || value === '' ? 'unset' : value}`);
		}
		return fingerprintSecret(parts.join('\u0000'));
	} catch (error) {
		logger.warn({ err: error, provider }, '[admin-config] could not fingerprint the credential');
		return null;
	}
}

export const PROVIDER_CREDENTIAL_KEYS: Record<string, string[]> = {
	anthropic: ['ANTHROPIC_API_KEY'],
	deepgram: ['DEEPGRAM_API_KEY'],
	elevenlabs: ['ELEVENLABS_API_KEY'],
	sarvam: ['SARVAM_API_KEY'],
	postgres: ['DATABASE_URL'],
	redis: ['REDIS_URL'],
	'object-storage': ['S3_ACCESS_KEY', 'S3_SECRET_KEY'],
	firebase: ['FIREBASE_SERVICE_ACCOUNT_JSON'],
	stripe: ['STRIPE_SECRET_KEY'],
};

/** Credential key → the provider tests that cover it. Inverted once, from the map above. */
const PROVIDERS_FOR_CONFIG_KEY: Map<string, string[]> = (() => {
	const inverted = new Map<string, string[]>();
	for (const [provider, keys] of Object.entries(PROVIDER_CREDENTIAL_KEYS)) {
		for (const key of keys) {
			inverted.set(key, [...(inverted.get(key) ?? []), provider]);
		}
	}
	return inverted;
})();

type ProviderCheck = {
	provider: string;
	status: string;
	message: string | null;
	checkedAt: Date;
	/** Fingerprint of the credential the test used. `null` when none was involved. */
	secretFingerprint: string | null;
};

/**
 * The most recent connectivity check per provider.
 *
 * Read from `provider_health_checks` with `DISTINCT ON`, the same shape `latestProviderHealth()`
 * uses. A failure here returns an empty map rather than throwing: this is presentation data on a
 * configuration screen, and an unreadable history table must not blank the page. `lastTestedAt`
 * then reads `null`, which the console renders as "no recorded test" rather than "passed".
 */
async function latestProviderChecks(): Promise<Map<string, ProviderCheck>> {
	try {
		const pool = getDbPool();
		const { rows } = await pool.query<ProviderCheck>(
			`SELECT DISTINCT ON (provider) provider, status, message, checked_at AS "checkedAt",
			        secret_fingerprint AS "secretFingerprint"
			 FROM provider_health_checks
			 ORDER BY provider, checked_at DESC`,
		);
		return new Map(rows.map((row) => [row.provider, row]));
	} catch {
		return new Map();
	}
}

/**
 * The latest test result for a credential key, across every provider test that covers it.
 *
 * When two tests cover one key, the more recent result wins — that is the one an operator most
 * likely just ran. Where a key is covered by nothing, the result is `null` and the console says
 * "no connectivity test covers this key" rather than implying one ran and failed.
 */
function latestCheckFor(key: string, checks: Map<string, ProviderCheck>): ProviderCheck | null {
	const providers = PROVIDERS_FOR_CONFIG_KEY.get(key) ?? [];
	let best: ProviderCheck | null = null;
	for (const provider of providers) {
		const check = checks.get(provider);
		if (check && (!best || check.checkedAt > best.checkedAt)) best = check;
	}
	return best;
}

/**
 * Builds the console's read model.
 *
 * A secret's plaintext is never placed in the returned object — the `value` field
 * is explicitly `null` for anything in the `secret` scope, so no route can leak it
 * by spreading this object into a response.
 */
export async function listConfigViews(): Promise<ConfigView[]> {
	const rows = await loadCache();
	// Test provenance, keyed by provider. One extra query for the whole page, not one per key.
	const checks = await latestProviderChecks();

	// The value in force, fingerprinted per provider, computed once for the page rather than once per
	// key. This is the other half of the staleness comparison: a recorded check describes the
	// credential only when its fingerprint matches the one computed here, now.
	const currentFingerprints = new Map<string, string | null>();
	for (const provider of Object.keys(PROVIDER_CREDENTIAL_KEYS)) {
		currentFingerprints.set(provider, await providerConfigurationFingerprint(provider));
	}

	return CONFIG_CATALOG.map((definition) => {
		const row = rows.get(definition.key);
		const envValue = process.env[definition.key];
		const envKeyPresent = envValue !== undefined && envValue !== '';
		// Test history is only meaningful for something that has a credential to test. A display
		// setting is covered by no provider test, so both stay null and the console says so.
		const check = definition.scope === 'secret' ? latestCheckFor(definition.key, checks) : null;

		if (definition.scope === 'secret') {
			const hasStored = Boolean(row?.secretCiphertext);

			// The fingerprints of the configuration as it stands now, for whichever provider tests
			// cover this key. A key is covered by exactly one provider in every case today except
			// object storage's two keys, and this handles both by asking only "does *a* current
			// fingerprint match what the test exercised".
			const expectedFingerprints = (PROVIDERS_FOR_CONFIG_KEY.get(definition.key) ?? [])
				.map((provider) => currentFingerprints.get(provider) ?? null)
				.filter((value): value is string => value !== null);

			// Stale only when the check recorded a credential and none of the current fingerprints
			// match it. An unknown on either side is reported as unknown rather than as a match —
			// the same rule the Security Center applies to an untested credential.
			const testStale =
				check?.secretFingerprint != null &&
				expectedFingerprints.length > 0 &&
				!expectedFingerprints.includes(check.secretFingerprint);
			return {
				key: definition.key,
				scope: definition.scope,
				category: definition.category,
				valueType: definition.valueType,
				description: definition.description,
				usedBy: definition.usedBy,
				restartRequired: definition.restartRequired,
				envOnly: definition.envOnly,
				allowedValues: definition.allowedValues,
				effectiveSource: hasStored ? 'secret' : envKeyPresent ? 'environment' : 'unset',
				readByRuntime: isKeyReadByRuntime(definition.key),
				runtimeWiringNote: runtimeWiringNote(definition.key),
				value: null,
				envKeyPresent,
				secretHint: hasStored
					? (row?.secretHint ?? '••••••••')
					: envKeyPresent
						? maskSecret(envValue)
						: null,
				secretFingerprint: expectedFingerprints[0] ?? null,
				updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
				updatedBy: row?.updatedBy ?? null,
				lastTestedAt: check ? check.checkedAt.toISOString() : null,
				lastTestStatus: check?.status ?? null,
				lastTestMessage: check?.message ?? null,
				testStale,
				lastTestedFingerprint: check?.secretFingerprint ?? null,
				testedBy: PROVIDERS_FOR_CONFIG_KEY.get(definition.key) ?? [],
			};
		}

		const storedValue = row?.value ?? null;
		const effective = storedValue ?? (envKeyPresent ? envValue! : (definition.defaultValue ?? null));

		return {
			key: definition.key,
			scope: definition.scope,
			category: definition.category,
			valueType: definition.valueType,
			description: definition.description,
			usedBy: definition.usedBy,
			restartRequired: definition.restartRequired,
			envOnly: definition.envOnly,
			allowedValues: definition.allowedValues,
			effectiveSource:
				storedValue !== null
					? 'database'
					: envKeyPresent
						? 'environment'
						: definition.defaultValue !== undefined
							? 'default'
							: 'unset',
			readByRuntime: isKeyReadByRuntime(definition.key),
			runtimeWiringNote: runtimeWiringNote(definition.key),
			value: effective,
			envKeyPresent,
			secretHint: null,
			secretFingerprint: null,
			updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
			updatedBy: row?.updatedBy ?? null,
			// Non-secret keys carry no connectivity test, so all four test fields are null rather
			// than inherited from a `system_configs` column nothing writes.
			lastTestedAt: null,
			lastTestStatus: null,
			lastTestMessage: null,
			// A non-secret key has no credential, so it can be neither tested nor stale. Reporting
			// `false` here is a statement about the key, not a placeholder.
			testStale: false,
			lastTestedFingerprint: null,
			testedBy: [],
		};
	});
}

/** Keys the mobile client is allowed to see. Used by the bootstrap endpoint. */
export function publicConfigKeys(): string[] {
	return CONFIG_CATALOG.filter((definition) => definition.scope === 'public').map((d) => d.key);
}

/** True when the secret store can encrypt. Surfaced by the config validator. */
export function secretStoreReady(): boolean {
	return isSecretStoreConfigured();
}
