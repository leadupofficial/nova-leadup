/**
 * NOVA — Admin AI, voice and avatar routes.
 *
 * Mounted under the admin router behind `adminGate`, so `req.adminActor` and
 * `req.adminPermissions` are always populated by the time a handler runs and every
 * route names the permission it needs.
 *
 * Two honesty rules shape this file, because the alternative is a console that
 * implies control that does not exist:
 *
 * 1. **Secrets never leave.** Credentials are read through `listConfigViews()`,
 *    which forces `value: null` for anything in the `secret` scope and exposes only
 *    a masked hint. Nothing here ever calls `resolveConfig()` on a credential key,
 *    so a plaintext key cannot be placed in a response by accident.
 *
 * 2. **Configuration that nothing reads is labelled as such.** `STT_PROVIDER`,
 *    `TTS_PROVIDER` and the `AI_*` tuning keys exist in the catalog but no runtime
 *    module in this service reads them: STT is routed by language
 *    (`resolveSttProvider`), the realtime TTS primary is the hard-coded Sarvam
 *    stream (`PRIMARY_STREAM_PROVIDER`), the chat model id comes from
 *    `ANTHROPIC_MODEL`, and the secondary provider from `LLM_FALLBACK_*`. Every
 *    route that reports or writes one of those keys says so, rather than showing a
 *    value that looks effective and is not.
 *
 * The connectivity tests themselves are real network calls owned by
 * `admin/providers.ts`; this file only dispatches them and records who asked.
 */

import { Router, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { count } from 'drizzle-orm';
import { avatarAssets, systemConfigs } from '@nova/database';
import { type AdminRequest, adminGate, requirePermission } from '../../admin/access.js';
import { actorFromRequest, auditedOperation, recordAdminAction } from '../../admin/audit.js';
import {
	type ConfigKeyDefinition,
	type ConfigView,
	getConfigDefinition,
	invalidateConfigCache,
	listConfigViews,
	validateConfigValue,
} from '../../admin/config.js';
import { getRuntimeControls } from '../../admin/control.js';
import { getAiMetrics, type ModelUsage } from '../../admin/metrics.js';
import {
	PROVIDER_TESTS,
	type ProviderStatus,
	type ProviderTestResult,
	isKnownProvider,
	latestProviderHealth,
	runProviderTest,
} from '../../admin/providers.js';
import { AI_PRICING, estimateCost } from '../../admin/pricing.js';
import { HttpError } from '../../middleware/error-handler.js';
import { validate } from '../../middleware/validate.js';
import { getDb } from '../../db/connection.js';

const router: ReturnType<typeof Router> = Router();
router.use(adminGate);

// ─── Shared read helpers ─────────────────────────────────────────────────────

type ConfigViewMap = Map<string, ConfigView>;

/** Views keyed by config key. The map is what makes the lookups below readable. */
async function configViews(): Promise<ConfigViewMap> {
	return new Map((await listConfigViews()).map((view) => [view.key, view]));
}

/** Catalog lookup for a key this file knows exists; a miss is a code defect, not a user error. */
function definitionFor(key: string): ConfigKeyDefinition {
	const definition = getConfigDefinition(key);
	if (!definition) {
		throw new HttpError(500, `Config key ${key} is missing from the catalog.`, 'CONFIG_CATALOG_MISMATCH');
	}
	return definition;
}

/**
 * A credential's *state*, never its value.
 *
 * `effectiveSource` is `'unset'` when neither the encrypted store nor the process
 * environment supplies the key, which is the honest answer to "is this provider
 * usable at all".
 */
function credentialStateOf(views: ConfigViewMap, key: string) {
	const view = views.get(key);
	return {
		credentialConfigured: Boolean(view && view.effectiveSource !== 'unset'),
		credentialSource: view?.effectiveSource ?? 'unset',
		maskedHint: view?.secretHint ?? null,
	};
}

/** Price-table families for a vendor, matched the same way `estimateCost` matches. */
function pricingModelsFor(labelPrefix: string): Array<{ id: string; use: string }> {
	return Object.entries(AI_PRICING)
		.filter(([, price]) => price.label.startsWith(labelPrefix))
		.map(([id, price]) => ({
			id,
			// These are the price table's substring match keys, not necessarily exact
			// model ids — `estimateCost` matches by `includes`, longest key first.
			use: `price-table family — $${price.inputPerMillion}/M input, $${price.outputPerMillion}/M output (list price, not a billed figure)`,
		}));
}

// ─── Provider catalog ────────────────────────────────────────────────────────

type ProviderKind = 'ai' | 'stt' | 'tts';

type ProviderDescriptor = {
	id: string;
	label: string;
	/** The provider's primary role, for the flat `kind` field. */
	kind: ProviderKind;
	kinds: ProviderKind[];
	credentialKey: string;
	models: Array<{ id: string; use: string }>;
	modelNote?: string;
};

/**
 * Every provider the runtime is actually wired to.
 *
 * Google is included because the language catalog routes seven languages to it
 * (`as`, `mai`, `sa`, `sd`, `ks`, `doi`, `mni`) and `services/ai.ts` implements
 * both its STT and TTS calls. Brocode is included because it is tried *before*
 * `ANTHROPIC_API_KEY` for the chat completion. Neither has a `PROVIDER_TESTS`
 * entry, which is reported per provider as `testable: false`.
 */
const PROVIDERS: readonly ProviderDescriptor[] = [
	{
		id: 'anthropic',
		label: 'Anthropic',
		kind: 'ai',
		kinds: ['ai'],
		credentialKey: 'ANTHROPIC_API_KEY',
		models: pricingModelsFor('Anthropic'),
	},
	{
		id: 'brocode',
		label: 'Brocode gateway (Anthropic-compatible)',
		kind: 'ai',
		kinds: ['ai'],
		credentialKey: 'BROCODE_API_KEY',
		models: [],
		modelNote:
			'Brocode is a gateway credential, not a model catalogue: it answers the Anthropic wire format at ANTHROPIC_BASE_URL, and the model asked for is whichever id the caller resolves (ANTHROPIC_MODEL for the primary, LLM_FALLBACK_MODEL for the secondary).',
	},
	{
		id: 'openai',
		label: 'OpenAI (embeddings only)',
		kind: 'ai',
		kinds: ['ai'],
		credentialKey: 'OPENAI_API_KEY',
		models: [{ id: 'text-embedding-3-small', use: 'embeddings for memory recall (EMBEDDING_MODEL in services/ai.ts)' }],
		modelNote:
			'The OpenAI chat families in the price table (gpt-*, o1-*) are priced so historical rows can be costed; no chat call site on this service routes a completion to OpenAI.',
	},
	{
		id: 'sarvam',
		label: 'Sarvam',
		kind: 'tts',
		kinds: ['stt', 'tts'],
		credentialKey: 'SARVAM_API_KEY',
		models: [
			{ id: 'saaras:v3-realtime', use: 'streaming STT — stream_type=fast, VAD endpointing, 500 ms silence boundary, 16 kHz linear16' },
			{ id: 'bulbul:v3', use: 'TTS — realtime streaming primary and the REST provider for Indic languages; default speaker priya' },
		],
	},
	{
		id: 'elevenlabs',
		label: 'ElevenLabs',
		kind: 'tts',
		kinds: ['tts'],
		credentialKey: 'ELEVENLABS_API_KEY',
		models: [
			{ id: 'eleven_flash_v2_5', use: 'TTS — Flash rather than Turbo for time-to-first-byte; 32 languages including Tamil and Hindi' },
			{ id: '21m00Tcm4TlvDq8ikWAM', use: 'default voice id when a request names none (DEFAULT_ELEVENLABS_VOICE_ID)' },
		],
	},
	{
		id: 'deepgram',
		label: 'Deepgram',
		kind: 'stt',
		kinds: ['stt', 'tts'],
		credentialKey: 'DEEPGRAM_API_KEY',
		models: [
			{ id: 'nova-2', use: 'streaming STT for English' },
			{ id: 'nova-3', use: 'streaming STT for every other language, and `multi` for auto — only nova-3 covers Indic' },
			{ id: 'aura-2-*', use: 'TTS voices, one per language for en/de/es/fr/it/ja/nl; no Indic voices, so the fallback returns null for Tamil/Hindi/…' },
		],
	},
	{
		id: 'google',
		label: 'Google Cloud Speech',
		kind: 'stt',
		kinds: ['stt', 'tts'],
		credentialKey: 'GOOGLE_CLOUD_API_KEY',
		models: [
			{ id: 'latest_long', use: 'STT (speech:recognize) for the seven google-routed languages' },
			{ id: '<languageCode>-Wavenet-A', use: 'TTS voice name pattern; audioEncoding MP3, speakingRate 1.0' },
		],
	},
];

type SelectionContext = {
	anthropicConfigured: boolean;
	brocodeConfigured: boolean;
	openaiConfigured: boolean;
	sarvamConfigured: boolean;
	elevenConfigured: boolean;
	deepgramConfigured: boolean;
	googleConfigured: boolean;
};

/**
 * Whether the runtime picks this provider for a request, and the concrete reason.
 *
 * "Default" here means "the credential this service reaches for first on some real
 * path", which is why more than one provider can be default for different
 * modalities and languages. A provider that only ever runs as a fallback reports
 * `false` and says so.
 */
function selectionFor(id: string, ctx: SelectionContext): { defaultSelected: boolean; reason: string } {
	switch (id) {
		case 'anthropic':
			if (ctx.brocodeConfigured) {
				return {
					defaultSelected: false,
					reason: 'BROCODE_API_KEY is set and the chat path reads BROCODE_API_KEY || ANTHROPIC_API_KEY, so this key is the second choice here.',
				};
			}
			return {
				defaultSelected: ctx.anthropicConfigured,
				reason: ctx.anthropicConfigured
					? 'The chat path reads BROCODE_API_KEY || ANTHROPIC_API_KEY, so with no Brocode key this is the live LLM credential (base URL ANTHROPIC_BASE_URL).'
					: 'No LLM credential is configured. Every completion fails with "Neither BROCODE_API_KEY nor ANTHROPIC_API_KEY is configured".',
			};
		case 'brocode':
			return {
				defaultSelected: ctx.brocodeConfigured,
				reason: ctx.brocodeConfigured
					? 'BROCODE_API_KEY takes precedence over ANTHROPIC_API_KEY for the chat completion, speaking the Anthropic wire format.'
					: 'Not configured. When set, this gateway key is tried before ANTHROPIC_API_KEY.',
			};
		case 'openai':
			return {
				defaultSelected: ctx.openaiConfigured,
				reason: 'Embeddings only: memory recall calls text-embedding-3-small. No chat completion is routed to OpenAI on this service.',
			};
		case 'sarvam':
			return {
				defaultSelected: ctx.sarvamConfigured,
				reason: ctx.sarvamConfigured
					? "Realtime streaming TTS primary: realtime/tts.ts hard-codes PRIMARY_STREAM_PROVIDER = 'sarvam' (bulbul:v3, speaker priya). Also the routed STT provider for every non-English language and for `auto`."
					: 'Primary in code, but SARVAM_API_KEY is unset, so the realtime stream answers TTS_NOT_CONFIGURED and Indic STT fails; the Deepgram/ElevenLabs fallbacks only fire when their own keys exist.',
			};
		case 'elevenlabs':
			return {
				defaultSelected: ctx.elevenConfigured,
				reason: ctx.elevenConfigured
					? 'Primary TTS for English on REST /voice/tts, and the first cloud fallback when the realtime Sarvam stream refuses a sentence.'
					: 'Not configured: no ElevenLabs voice, so the REST English primary and the realtime first fallback are both skipped.',
			};
		case 'deepgram':
			return {
				defaultSelected: ctx.deepgramConfigured,
				reason: ctx.deepgramConfigured
					? 'Routed streaming STT provider for English (resolveSttProvider) and the single fatal-close fallback for every other language. Never the TTS primary: Deepgram Aura is REST TTS fallback #1 and realtime TTS fallback #2.'
					: 'Not configured: English STT has no provider and a fatal Indic STT failure has no backup recogniser.',
			};
		case 'google':
			return {
				defaultSelected: ctx.googleConfigured,
				reason: 'Routed STT and TTS provider for the seven languages whose catalog entry names google (as, mai, sa, sd, ks, doi, mni). No connectivity test is registered for it.',
			};
		default:
			return { defaultSelected: false, reason: 'Unknown provider.' };
	}
}

/** Models known for a provider, with the configured default/fallback folded in for Anthropic. */
function modelsFor(descriptor: ProviderDescriptor, views: ConfigViewMap): Array<{ id: string; use: string }> {
	const models = [...descriptor.models];

	if (descriptor.id === 'anthropic') {
		const defaultModel = views.get('AI_DEFAULT_MODEL')?.value;
		const fallbackModel = views.get('AI_FALLBACK_MODEL')?.value;
		if (defaultModel) {
			models.unshift({
				id: defaultModel,
				use: 'configured default (AI_DEFAULT_MODEL) — not read by the chat path today; the live model id is ANTHROPIC_MODEL',
			});
		}
		if (fallbackModel) {
			models.push({
				id: fallbackModel,
				use: 'configured fallback (AI_FALLBACK_MODEL) — the secondary provider is configured through LLM_FALLBACK_*',
			});
		}
	}

	const seen = new Set<string>();
	return models.filter((model) => {
		if (seen.has(model.id)) return false;
		seen.add(model.id);
		return true;
	});
}

// ─── Fallback chains (mirrored from the runtime, not invented) ───────────────

/** `realtime/tts.ts` — the streaming path, sentence by sentence. */
const REALTIME_TTS_CHAIN = [
	{ step: 1, provider: 'sarvam', detail: 'streaming primary, hard-coded in realtime/tts.ts (bulbul:v3)', requires: 'SARVAM_API_KEY' },
	{ step: 2, provider: 'elevenlabs', detail: 'synthesizeSpeech on eleven_flash_v2_5, one clip per sentence', requires: 'ELEVENLABS_API_KEY' },
	{ step: 3, provider: 'deepgram', detail: 'Aura single clip — only for the seven languages Aura covers', requires: 'DEEPGRAM_API_KEY' },
	{ step: 4, provider: 'device', detail: 'no cloud voice could serve the sentence; the client plays its own device voice', requires: null },
];

/** `routes/voice.ts` — the REST path, by language. */
const REST_TTS_CHAIN = [
	{ step: 1, provider: 'language catalog', detail: 'getVoiceProviderForLanguage(language): elevenlabs for en, sarvam for the Indic set, google for as/mai/sa/sd/ks/doi/mni', requires: null },
	{ step: 2, provider: 'deepgram', detail: 'Aura — only when the language has an Aura voice and the key is set', requires: 'DEEPGRAM_API_KEY' },
	{ step: 3, provider: 'sarvam', detail: 'bulbul:v3 — skipped when Sarvam was the provider that just failed', requires: 'SARVAM_API_KEY' },
	{ step: 4, provider: 'elevenlabs', detail: 'eleven_flash_v2_5 — skipped when ElevenLabs was the provider that just failed', requires: 'ELEVENLABS_API_KEY' },
	{ step: 5, provider: 'device', detail: 'the route answers 200 with audioData: null and provider: "fallback"', requires: null },
];

/** `realtime/stt/*` — language routing plus the one fatal-close fallback. */
const STT_ROUTING = {
	english: 'deepgram (resolveSttProvider: language "en" → deepgram)',
	otherLanguages: 'sarvam',
	auto: 'sarvam (language_code=auto on the realtime endpoint)',
	fatalFallback:
		'deepgram — opened once per utterance after a fatal provider close (4xxx / 1003 / 1008) with the received audio replayed; never from deepgram to itself',
};

// ─── GET /ai/providers ───────────────────────────────────────────────────────

router.get('/ai/providers', requirePermission('ai.read'), async (_req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const [views, health] = await Promise.all([configViews(), latestProviderHealth()]);
		const healthByProvider = new Map(health.map((row) => [row.provider, row]));

		const ctx: SelectionContext = {
			anthropicConfigured: credentialStateOf(views, 'ANTHROPIC_API_KEY').credentialConfigured,
			brocodeConfigured: credentialStateOf(views, 'BROCODE_API_KEY').credentialConfigured,
			openaiConfigured: credentialStateOf(views, 'OPENAI_API_KEY').credentialConfigured,
			sarvamConfigured: credentialStateOf(views, 'SARVAM_API_KEY').credentialConfigured,
			elevenConfigured: credentialStateOf(views, 'ELEVENLABS_API_KEY').credentialConfigured,
			deepgramConfigured: credentialStateOf(views, 'DEEPGRAM_API_KEY').credentialConfigured,
			googleConfigured: credentialStateOf(views, 'GOOGLE_CLOUD_API_KEY').credentialConfigured,
		};

		const providers = PROVIDERS.map((descriptor) => {
			const selection = selectionFor(descriptor.id, ctx);
			return {
				id: descriptor.id,
				label: descriptor.label,
				kind: descriptor.kind,
				kinds: descriptor.kinds,
				credentialKey: descriptor.credentialKey,
				...credentialStateOf(views, descriptor.credentialKey),
				/** False when `PROVIDER_TESTS` has no entry, so the test route answers 404. */
				testable: isKnownProvider(descriptor.id),
				defaultSelected: selection.defaultSelected,
				selectionReason: selection.reason,
				models: modelsFor(descriptor, views),
				modelNote: descriptor.modelNote ?? null,
				/** Latest recorded connectivity check, or null when never tested. */
				health: healthByProvider.get(descriptor.id) ?? null,
			};
		});

		const sttProviderView = views.get('STT_PROVIDER');
		const ttsProviderView = views.get('TTS_PROVIDER');

		res.json({
			success: true,
			data: {
				providers,
				configuredSelection: {
					sttProvider: {
						key: 'STT_PROVIDER',
						value: sttProviderView?.value ?? null,
						effectiveSource: sttProviderView?.effectiveSource ?? 'unset',
						readByRuntime: false,
					},
					ttsProvider: {
						key: 'TTS_PROVIDER',
						value: ttsProviderView?.value ?? null,
						effectiveSource: ttsProviderView?.effectiveSource ?? 'unset',
						readByRuntime: false,
					},
				},
				fallbackChains: {
					realtimeTts: REALTIME_TTS_CHAIN,
					restTts: REST_TTS_CHAIN,
					stt: STT_ROUTING,
				},
				notes: [
					'No credential value is returned. Credentials are read through listConfigViews(), which forces value: null for `secret` scope and exposes only a masked hint.',
					'STT_PROVIDER and TTS_PROVIDER are declared in the config catalog but no runtime module reads them: STT is routed by language (resolveSttProvider) and the realtime TTS primary is the hard-coded Sarvam stream. The values are reported for inspection only.',
					'Google has no entry in PROVIDER_TESTS, so POST /ai/providers/google/test answers 404 and its health can only be established by exercising a real voice turn.',
					'Brocode is a gateway credential rather than a separate API. The registered `anthropic` test reads ANTHROPIC_API_KEY only, so a Brocode-only deployment reports not_configured for a provider that is in fact serving completions.',
				],
				generatedAt: new Date().toISOString(),
			},
		});
	} catch (error) {
		next(error);
	}
});

// ─── GET /ai/models ──────────────────────────────────────────────────────────

type ModelEntry = {
	id: string;
	provider: string;
	label: string;
	inPriceTable: boolean;
	isDefault: boolean;
	isFallback: boolean;
	pricingKnown: boolean;
	pricingWarning: string | null;
	usage: ModelUsage | null;
};

/**
 * Which vendor a model id belongs to, for grouping.
 *
 * `estimateCost` cannot answer this: it matches price keys by substring and knows
 * nothing about vendors. Anything unrecognised is grouped as such rather than
 * assigned to a guess — `glm-5.3` appears in this environment's data and is a real
 * example of a model this build cannot attribute.
 */
function providerForModelId(model: string): string {
	const id = model.toLowerCase();
	if (id.includes('claude')) return 'anthropic';
	if (id.includes('gemini')) return 'google';
	if (id.includes('deepseek')) return 'deepseek';
	if (id.startsWith('glm')) return 'unknown-gateway';
	if (/^(gpt|o1|o3|o4|text-embedding)/.test(id)) return 'openai';
	if (id === '(not recorded)') return 'unattributed';
	return 'unrecognised';
}

router.get('/ai/models', requirePermission('ai.read'), async (_req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const [views, metrics] = await Promise.all([configViews(), getAiMetrics(30)]);

		const defaultView = views.get('AI_DEFAULT_MODEL');
		const fallbackView = views.get('AI_FALLBACK_MODEL');
		const defaultModel = defaultView?.value ?? null;
		const fallbackModel = fallbackView?.value ?? null;
		const usageByModel = new Map(metrics.byModel.map((entry) => [entry.model, entry]));

		const entries = new Map<string, ModelEntry>();
		const remember = (id: string): ModelEntry => {
			const existing = entries.get(id);
			if (existing) return existing;
			// `estimateCost` is the single definition of "is this model priced"; using
			// it here keeps this view and the cost figures in agreement.
			const estimate = estimateCost(id, 0, 0);
			const entry: ModelEntry = {
				id,
				provider: providerForModelId(id),
				label: estimate.rate?.label ?? 'not in the price table',
				inPriceTable: estimate.pricingKnown,
				isDefault: id === defaultModel,
				isFallback: id === fallbackModel,
				pricingKnown: false,
				pricingWarning: null,
				usage: null,
			};
			entries.set(id, entry);
			return entry;
		};

		for (const id of Object.keys(AI_PRICING)) remember(id);
		if (defaultModel) remember(defaultModel);
		if (fallbackModel) remember(fallbackModel);
		for (const observed of metrics.byModel) remember(observed.model);

		const modelsInUseWithoutPricing: Array<{ model: string; requests: number; totalTokens: number; reason: string }> = [];

		for (const entry of entries.values()) {
			entry.usage = usageByModel.get(entry.id) ?? null;
			entry.pricingKnown = entry.usage ? entry.usage.pricingKnown : entry.inPriceTable;
			if (entry.isDefault) entry.label = `${entry.label} — current default`;
			else if (entry.isFallback) entry.label = `${entry.label} — current fallback`;

			if (!entry.pricingKnown) {
				entry.pricingWarning = entry.usage
					? `In use (${entry.usage.requests} request${entry.usage.requests === 1 ? '' : 's'}) but absent from the price table, so its ${entry.usage.totalTokens.toLocaleString()} tokens are costed at $0 and the total understates spend.`
					: 'No published rate is in the price table for this model, so any cost shown for it would be invented.';
				if (entry.usage) {
					modelsInUseWithoutPricing.push({
						model: entry.id,
						requests: entry.usage.requests,
						totalTokens: entry.usage.totalTokens,
						reason: entry.pricingWarning,
					});
				}
			}
		}

		const groups = new Map<string, ModelEntry[]>();
		for (const entry of entries.values()) {
			const list = groups.get(entry.provider);
			if (list) list.push(entry);
			else groups.set(entry.provider, [entry]);
		}

		const byProvider = [...groups.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([provider, models]) => ({
				provider,
				modelCount: models.length,
				models: [...models].sort((a, b) => (b.usage?.requests ?? 0) - (a.usage?.requests ?? 0)),
			}));

		res.json({
			success: true,
			data: {
				default: {
					model: defaultModel,
					key: 'AI_DEFAULT_MODEL',
					effectiveSource: defaultView?.effectiveSource ?? 'unset',
					readByRuntime: false,
				},
				fallback: {
					model: fallbackModel,
					key: 'AI_FALLBACK_MODEL',
					effectiveSource: fallbackView?.effectiveSource ?? 'unset',
					readByRuntime: false,
				},
				byProvider,
				modelsInUseWithoutPricing,
				totals: {
					windowDays: 30,
					requestsToday: metrics.requestsToday,
					requestsThisWeek: metrics.requestsThisWeek,
					requestsThisMonth: metrics.requestsThisMonth,
					totalRequests: metrics.totalRequests,
					totalTokens: metrics.totalTokens,
					estimatedCostUsd: metrics.estimatedCostUsd,
					unattributedRequests: metrics.unattributedRequests,
				},
				notes: [
					'AI_DEFAULT_MODEL and AI_FALLBACK_MODEL are not read by the chat path. The live primary model id is the ANTHROPIC_MODEL environment variable (default claude-sonnet-4-20250514) and the secondary provider is configured through LLM_FALLBACK_BASE_URL / LLM_FALLBACK_API_KEY / LLM_FALLBACK_MODEL.',
					'Cost is estimated from persisted token counts multiplied by published list prices. It is not a billed figure. A model absent from the table is reported with pricingKnown: false rather than a guessed rate, so its share of the total is zero and the total understates real spend.',
					'`(not recorded)` groups assistant messages whose model column is null — typically a failed or interrupted call.',
				],
				generatedAt: new Date().toISOString(),
			},
		});
	} catch (error) {
		next(error);
	}
});

// ─── GET /ai/routing ─────────────────────────────────────────────────────────

router.get('/ai/routing', requirePermission('ai.read'), async (_req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const views = await configViews();

		const keyView = (key: string) => {
			const view = views.get(key);
			return {
				key,
				value: view?.value ?? null,
				effectiveSource: view?.effectiveSource ?? 'unset',
				description: view?.description ?? definitionFor(key).description,
				usedBy: view?.usedBy ?? [...definitionFor(key).usedBy],
			};
		};

		const defaultModel = keyView('AI_DEFAULT_MODEL');
		const fallbackModel = keyView('AI_FALLBACK_MODEL');
		const maxTokens = keyView('AI_MAX_TOKENS');
		const timeoutMs = keyView('AI_TIMEOUT_MS');
		const retryCount = keyView('AI_RETRY_COUNT');

		const usedBy = new Set<string>();
		for (const key of ['AI_DEFAULT_MODEL', 'AI_FALLBACK_MODEL', 'AI_MAX_TOKENS', 'AI_TIMEOUT_MS', 'AI_RETRY_COUNT']) {
			for (const service of definitionFor(key).usedBy) usedBy.add(service);
		}

		// What the process would actually use, read the same way `services/ai.ts` and
		// `services/llm-fallback.ts` read it. Reported separately from the catalog so
		// the two can never be mistaken for one another.
		const primaryModel = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
		const secondaryConfigured = Boolean(
			(process.env.LLM_FALLBACK_BASE_URL || '').trim() && (process.env.LLM_FALLBACK_API_KEY || '').trim(),
		);
		const secondaryModel = (process.env.LLM_FALLBACK_MODEL || '').trim() || primaryModel;

		const fallbackChain = [
			`1. ${primaryModel} — primary completion (env ANTHROPIC_MODEL; catalog AI_DEFAULT_MODEL = ${defaultModel.value ?? 'unset'})`,
			retryCount.value !== null
				? `2. retry the same model up to ${retryCount.value} time(s) before falling back (catalog AI_RETRY_COUNT; no runtime call site reads this yet)`
				: '2. no retry count is configured',
			secondaryConfigured
				? `3. ${secondaryModel} — secondary provider via LLM_FALLBACK_BASE_URL${process.env.LLM_FALLBACK_PROTOCOL ? ` (${process.env.LLM_FALLBACK_PROTOCOL})` : ' (protocol inferred from the auth style)'}`
				: '3. no secondary provider is configured (LLM_FALLBACK_BASE_URL / LLM_FALLBACK_API_KEY unset), so a primary failure is returned to the caller',
			'4. no further fallback — the request fails with the provider error, and the code is surfaced to the client',
		];

		res.json({
			success: true,
			data: {
				defaultModel,
				fallbackModel,
				maxTokens,
				timeoutMs,
				retryCount,
				runtime: {
					primaryModelEnv: 'ANTHROPIC_MODEL',
					primaryModel,
					maxOutputTokensEnv: 'LLM_MAX_OUTPUT_TOKENS',
					secondaryProviderConfigured: secondaryConfigured,
					secondaryModel: secondaryConfigured ? secondaryModel : null,
					credentialPrecedence: 'BROCODE_API_KEY || ANTHROPIC_API_KEY, base URL ANTHROPIC_BASE_URL',
				},
				fallbackChain,
				usedBy: [...usedBy],
				notes: [
					'None of the five AI_* keys is read by a runtime module yet: the model id comes from ANTHROPIC_MODEL, the ceiling from LLM_MAX_OUTPUT_TOKENS, and the secondary provider from LLM_FALLBACK_*. The catalog values are reported so the console and the running process can be compared honestly.',
					'"usedBy" is the catalog\'s own claim about which services will read each key; it is the same list the change-impact panel shows.',
				],
				generatedAt: new Date().toISOString(),
			},
		});
	} catch (error) {
		next(error);
	}
});

// ─── POST /ai/providers/:provider/test ───────────────────────────────────────

router.post(
	'/ai/providers/:provider/test',
	// Read-level on purpose: diagnosing an outage must not require `ai.secrets`.
	// The denial path of `requirePermission` is itself audited.
	requirePermission('services.read'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		const provider = String(req.params.provider ?? '');

		if (!isKnownProvider(provider)) {
			next(
				new HttpError(
					404,
					`Unknown provider "${provider}". Known providers: ${Object.keys(PROVIDER_TESTS).join(', ')}.`,
					'NOT_FOUND',
				),
			);
			return;
		}

		try {
			const result = await runProviderTest(provider, {
				trigger: 'manual',
				checkedBy: req.adminActor?.email ?? null,
			});

			await recordAdminAction({
				actor: actorFromRequest(req),
				action: 'ai.provider_test',
				permission: 'services.read',
				targetType: 'provider',
				targetId: provider,
				outcome: 'success',
				after: { status: result.status, latencyMs: result.latencyMs, method: result.method },
			});

			res.json({ success: true, data: result });
		} catch (error) {
			await recordAdminAction({
				actor: actorFromRequest(req),
				action: 'ai.provider_test',
				permission: 'services.read',
				targetType: 'provider',
				targetId: provider,
				outcome: 'failure',
				after: { error: error instanceof Error ? error.message : String(error) },
			});
			next(error);
		}
	},
);

// ─── GET /ai/metrics ─────────────────────────────────────────────────────────

const RangeSchema = z.object({
	days: z.coerce.number().int().min(1).max(365).default(30),
});

router.get(
	'/ai/metrics',
	requirePermission('ai.read'),
	validate(RangeSchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const { days } = (req as unknown as { validatedQuery: z.infer<typeof RangeSchema> }).validatedQuery;
			res.json({ success: true, data: await getAiMetrics(days) });
		} catch (error) {
			next(error);
		}
	},
);

// ─── Voice configuration ─────────────────────────────────────────────────────

const VOICE_CONFIG_KEYS = ['STT_PROVIDER', 'STT_LANGUAGE', 'STT_TIMEOUT_MS', 'TTS_PROVIDER', 'TTS_VOICE', 'TTS_SPEED'] as const;

/**
 * One voice config key as the console should see it.
 *
 * `readByRuntime` defaults to false and that is the honest answer for the six
 * voice keys: no module in this service reads any of them, so a value shown here
 * describes the catalog, not the running behaviour. It is passed as `true` only
 * where a call site genuinely resolves the key.
 */
function voiceConfigEntry(views: ConfigViewMap, key: string, readByRuntime = false) {
	const view = views.get(key);
	const definition = definitionFor(key);
	return {
		key,
		value: view?.value ?? null,
		effectiveSource: view?.effectiveSource ?? 'unset',
		description: view?.description ?? definition.description,
		usedBy: view?.usedBy ?? [...definition.usedBy],
		allowedValues: view?.allowedValues ?? null,
		updatedAt: view?.updatedAt ?? null,
		updatedBy: view?.updatedBy ?? null,
		readByRuntime,
	};
}

router.get('/voice/config', requirePermission('voice.read'), async (_req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const views = await configViews();

		res.json({
			success: true,
			data: {
				stt: {
					provider: voiceConfigEntry(views, 'STT_PROVIDER'),
					language: voiceConfigEntry(views, 'STT_LANGUAGE'),
					timeoutMs: voiceConfigEntry(views, 'STT_TIMEOUT_MS'),
				},
				tts: {
					provider: voiceConfigEntry(views, 'TTS_PROVIDER'),
					voice: voiceConfigEntry(views, 'TTS_VOICE'),
					speed: voiceConfigEntry(views, 'TTS_SPEED'),
				},
				wakeWord: {
					configurableOnServer: false,
					devicePreferenceEndpoint: 'PATCH /api/v1/device/wake-word/config',
				},
				avatar: {
					enabled: voiceConfigEntry(views, 'AVATAR_ENABLED', true),
				},
				keys: VOICE_CONFIG_KEYS,
				notes: [
					'The wake word is an on-device build asset and cannot be changed from the server. The phrase NOVA listens for is compiled into the app bundle (apps/mobile/android/app/src/main/assets/wakeword/models.json, consumed by WakeWordService.kt) and detection runs entirely offline in an Android foreground service. PATCH /api/v1/device/wake-word/config records only which installed classifier the user chose; it does not change what the device hears.',
					'No runtime module reads any of the six voice keys above. `resolveSttProvider` routes STT by language, `realtime/tts.ts` hard-codes the Sarvam streaming primary, and the REST TTS route uses its own default voice id (21m00Tcm4TlvDq8ikWAM) when a request names none. The values are reported for inspection; editing them would not change behaviour.',
					'There is no server-side voice *configuration* route in this file: changing STT/TTS selection currently means a code change or an environment change, not a console write.',
				],
				generatedAt: new Date().toISOString(),
			},
		});
	} catch (error) {
		next(error);
	}
});

// ─── GET /voice/health ───────────────────────────────────────────────────────

router.get('/voice/health', requirePermission('voice.read'), async (_req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const [health, controls] = await Promise.all([latestProviderHealth(), getRuntimeControls()]);

		res.json({
			success: true,
			data: {
				// Only the speech providers: the same table also carries database, cache,
				// storage, push and payment probes, which belong to the services screen.
				providers: health.filter((row) => row.kind === 'stt' || row.kind === 'tts'),
				controls: {
					sttEnabled: controls.sttEnabled,
					ttsEnabled: controls.ttsEnabled,
					voiceEnabled: controls.voiceEnabled,
					maintenanceMode: controls.maintenanceMode,
					anyDisabled: controls.anyDisabled,
				},
				notes: [
					'STT and TTS request counts and latency are not persisted. Both realtime providers stream over a WebSocket and write no per-request row, so there is no average to report — GET /admin/metrics/activity reports sttRequests and ttsRequests as explicitly unavailable for the same reason.',
					'`latencyMs` above is from the last recorded connectivity test in provider_health_checks, not from user traffic. A `pass` means the credential authenticated; it does not mean recognition or synthesis is succeeding for users.',
					'Tests run only on demand or from the scheduled sweep, so `checkedAt` may be stale. An empty list means no test has ever run for that provider.',
					'The kill switches are read through a 5-second memo, so a switch thrown just now may not appear here yet.',
				],
				generatedAt: new Date().toISOString(),
			},
		});
	} catch (error) {
		next(error);
	}
});

// ─── POST /voice/test ────────────────────────────────────────────────────────

const VoiceTestSchema = z
	.object({
		kind: z.enum(['stt', 'tts', 'pipeline']),
		provider: z.string().trim().min(1).max(50).optional(),
	})
	.strict();

const STT_CAPABLE = ['deepgram', 'sarvam', 'google'] as const;
const TTS_CAPABLE = ['elevenlabs', 'sarvam', 'deepgram', 'google'] as const;

/**
 * Rejects a provider this build cannot test.
 *
 * Two distinct refusals are kept separate because they need different actions:
 * "not a provider for this modality" is a bad request, while "no test is
 * registered" is a capability gap (Google) that the operator can only work around
 * by exercising a real turn.
 */
function assertTestable(provider: string, kind: 'stt' | 'tts'): void {
	const capable: readonly string[] = kind === 'stt' ? STT_CAPABLE : TTS_CAPABLE;
	if (!capable.includes(provider)) {
		throw new HttpError(
			400,
			`"${provider}" is not a ${kind.toUpperCase()} provider. ${kind.toUpperCase()} providers: ${capable.join(', ')}.`,
			'VALIDATION_ERROR',
		);
	}
	if (!isKnownProvider(provider)) {
		throw new HttpError(
			400,
			`No connectivity test is registered for "${provider}", so it cannot be exercised here. Registered tests: ${Object.keys(PROVIDER_TESTS).join(', ')}.`,
			'PROVIDER_NOT_TESTABLE',
		);
	}
}

/** Collapses per-step statuses into one verdict. Any failure dominates. */
function combineVerdict(steps: ProviderTestResult[]): ProviderStatus {
	if (steps.length === 0) return 'fail';
	if (steps.some((step) => step.status === 'fail')) return 'fail';
	if (steps.some((step) => step.status === 'degraded')) return 'degraded';
	if (steps.every((step) => step.status === 'not_configured')) return 'not_configured';
	// Some steps ran and something was not configured: the pipeline is only partly
	// verifiable, which is degradation rather than a clean pass.
	if (steps.some((step) => step.status === 'not_configured')) return 'degraded';
	return 'pass';
}

router.post(
	'/voice/test',
	requirePermission('voice.read'),
	validate(VoiceTestSchema, 'body'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const body = (req as unknown as { validatedBody: z.infer<typeof VoiceTestSchema> }).validatedBody;
			const views = await configViews();
			const configuredStt = views.get('STT_PROVIDER')?.value ?? 'sarvam';
			const configuredTts = views.get('TTS_PROVIDER')?.value ?? 'sarvam';

			const notes: string[] = [];
			const check = (provider: string) =>
				runProviderTest(provider, { trigger: 'manual', checkedBy: req.adminActor?.email ?? null });

			const outcome = await auditedOperation({
				req,
				action: 'voice.test',
				permission: 'voice.read',
				targetType: 'voice',
				targetId: body.provider ?? body.kind,
				reason: `voice ${body.kind} connectivity test`,
				run: async () => {
					const steps: ProviderTestResult[] = [];

					if (body.kind === 'tts') {
						const provider = body.provider ?? configuredTts;
						assertTestable(provider, 'tts');
						steps.push(await check(provider));
					} else if (body.kind === 'stt') {
						const provider = body.provider ?? configuredStt;
						assertTestable(provider, 'stt');
						steps.push(await check(provider));
					} else {
						// A pipeline test only makes sense on a provider that can do both,
						// so an explicit provider must be dual-capable; otherwise the
						// configured pair is used.
						let sttProviderName: string;
						let ttsProviderName: string;
						if (body.provider) {
							assertTestable(body.provider, 'stt');
							assertTestable(body.provider, 'tts');
							sttProviderName = body.provider;
							ttsProviderName = body.provider;
						} else {
							sttProviderName = configuredStt;
							ttsProviderName = configuredTts;
							assertTestable(sttProviderName, 'stt');
							assertTestable(ttsProviderName, 'tts');
						}

						notes.push(
							'The pipeline test exercises the STT and TTS credentials independently. It does not open a realtime WebSocket session, so barge-in, VAD endpointing, per-sentence streaming and the STT fatal-close fallback are not covered.',
						);

						const [sttResult, ttsResult] = await Promise.all([check(sttProviderName), check(ttsProviderName)]);
						steps.push(sttResult, ttsResult);
					}

					return { steps, verdict: combineVerdict(steps) };
				},
				after: (result) => ({
					verdict: result.verdict,
					steps: result.steps.map((step) => ({ provider: step.provider, status: step.status, latencyMs: step.latencyMs })),
				}),
			});

			if (outcome.steps.some((step) => step.provider === 'sarvam')) {
				notes.push(
					'The Sarvam probe is a real POST https://api.sarvam.ai/text-to-speech with a 1-character input ("a") — that synthesis is billed, and Sarvam exposes no read-only credential endpoint. The response message names the method so a `pass` is falsifiable.',
				);
			}
			if (outcome.steps.some((step) => step.provider === 'deepgram')) {
				notes.push(
					'Deepgram has no synthesis probe registered: its test calls GET /v1/projects, which proves the token authenticates but does not exercise Aura TTS or a recogniser session.',
				);
			}
			notes.push(
				'No streaming STT probe exists. The Deepgram and Sarvam tests authenticate the credential; neither opens a recogniser socket, so transcript accuracy is not covered by this check.',
				`Configured providers were read from STT_PROVIDER=${configuredStt} and TTS_PROVIDER=${configuredTts}. No runtime module reads those keys, so this test targets what the catalog declares rather than necessarily what a live turn uses.`,
			);

			res.json({
				success: true,
				data: {
					kind: body.kind,
					steps: outcome.steps,
					verdict: outcome.verdict,
					notes,
					testedAt: new Date().toISOString(),
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

// ─── POST /ai/config ─────────────────────────────────────────────────────────

const AiConfigSchema = z
	.object({
		defaultModel: z.string().trim().min(1).max(200).optional(),
		fallbackModel: z.string().trim().min(1).max(200).optional(),
		maxTokens: z.number().int().min(1).max(1_000_000).optional(),
		timeoutMs: z.number().int().min(1).max(3_600_000).optional(),
		retryCount: z.number().int().min(0).max(50).optional(),
		reason: z.string().trim().max(500).optional(),
	})
	.strict();

/**
 * Request field → catalog key.
 *
 * The bounds that matter live on the catalog definitions (min/max, allowed
 * values) and are applied by `validateConfigValue`; the zod schema above is only a
 * coarse guard so a nonsense number never reaches the catalog check.
 */
const AI_CONFIG_FIELDS: ReadonlyArray<{
	field: 'defaultModel' | 'fallbackModel' | 'maxTokens' | 'timeoutMs' | 'retryCount';
	key: string;
}> = [
	{ field: 'defaultModel', key: 'AI_DEFAULT_MODEL' },
	{ field: 'fallbackModel', key: 'AI_FALLBACK_MODEL' },
	{ field: 'maxTokens', key: 'AI_MAX_TOKENS' },
	{ field: 'timeoutMs', key: 'AI_TIMEOUT_MS' },
	{ field: 'retryCount', key: 'AI_RETRY_COUNT' },
];

router.post(
	'/ai/config',
	requirePermission('ai.configure'),
	validate(AiConfigSchema, 'body'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const body = (req as unknown as { validatedBody: z.infer<typeof AiConfigSchema> }).validatedBody;
			const views = await configViews();

			// Validate the whole batch before writing anything: a rejected value must
			// not leave a half-applied change behind.
			const planned: Array<{ key: string; definition: ConfigKeyDefinition; value: string; before: string | null }> = [];
			for (const entry of AI_CONFIG_FIELDS) {
				const supplied = body[entry.field];
				if (supplied === undefined) continue;

				const definition = definitionFor(entry.key);
				if (definition.envOnly) {
					throw new HttpError(
						400,
						`${entry.key} is environment-only; a database row would not change the running process.`,
						'VALIDATION_ERROR',
					);
				}

				const validation = validateConfigValue(definition, String(supplied));
				if (!validation.valid) {
					throw new HttpError(400, validation.error, 'VALIDATION_ERROR');
				}

				planned.push({
					key: entry.key,
					definition,
					value: validation.coerced,
					before: views.get(entry.key)?.value ?? null,
				});
			}

			if (planned.length === 0) {
				throw new HttpError(
					400,
					'Supply at least one setting to change: defaultModel, fallbackModel, maxTokens, timeoutMs or retryCount.',
					'VALIDATION_ERROR',
				);
			}

			const changed: Array<{ key: string; before: string | null; after: string }> = [];
			const affectedServices = new Set<string>();
			let restartRequired = false;
			const updatedBy = req.adminActor?.email ?? null;

			for (const item of planned) {
				await auditedOperation({
					req,
					action: 'ai.config.update',
					permission: 'ai.configure',
					targetType: 'system_config',
					targetId: item.key,
					reason: body.reason ?? null,
					before: { value: item.before },
					run: async () => {
						const db = getDb();
						// A config value is an operator override on top of the
						// environment, which is exactly what `source: 'database'` records.
						const row = {
							value: item.value,
							scope: item.definition.scope,
							category: item.definition.category,
							valueType: item.definition.valueType,
							description: item.definition.description,
							usedBy: [...item.definition.usedBy],
							restartRequired: item.definition.restartRequired,
							hotReloadable: !item.definition.restartRequired,
							displayOrder: item.definition.displayOrder ?? 0,
							source: 'database',
							updatedBy,
						};

						await db
							.insert(systemConfigs)
							.values({ key: item.key, ...row })
							.onConflictDoUpdate({
								target: systemConfigs.key,
								set: { ...row, updatedAt: new Date() },
							});

						return { key: item.key, before: item.before, after: item.value };
					},
					after: (result) => result,
				});

				changed.push({ key: item.key, before: item.before, after: item.value });
				for (const service of item.definition.usedBy) affectedServices.add(service);
				if (item.definition.restartRequired) restartRequired = true;
			}

			// Drops the read cache so the next read in *this* process sees the new
			// value; other replicas converge within the 15-second cache TTL.
			await invalidateConfigCache();

			const notes: string[] = [
				'The write is committed to system_configs and this process\'s config cache is invalidated immediately, so the new value is visible on the next read here and within the config cache TTL (15 seconds) in other replicas.',
				'Important limitation: no call site in this service reads AI_DEFAULT_MODEL, AI_FALLBACK_MODEL, AI_MAX_TOKENS, AI_TIMEOUT_MS or AI_RETRY_COUNT. The chat model id comes from the ANTHROPIC_MODEL environment variable (default claude-sonnet-4-20250514), the output ceiling from LLM_MAX_OUTPUT_TOKENS, and the secondary provider from LLM_FALLBACK_BASE_URL / LLM_FALLBACK_API_KEY / LLM_FALLBACK_MODEL. This change is recorded and visible to the console, but it does not by itself alter model selection until a call site resolves these keys through resolveConfig().',
			];

			// A real connectivity test against whichever provider the resulting default
			// model belongs to. Only an Anthropic-format model can be tested, because
			// `anthropic` is the only registered test for the LLM wire format.
			const effectiveDefaultModel = body.defaultModel ?? views.get('AI_DEFAULT_MODEL')?.value ?? null;
			let healthCheck: { provider: string; status: ProviderStatus; message: string } | null = null;

			if (effectiveDefaultModel && /claude/i.test(effectiveDefaultModel)) {
				const result = await runProviderTest('anthropic', {
					trigger: 'manual',
					checkedBy: req.adminActor?.email ?? null,
				});
				healthCheck = { provider: result.provider, status: result.status, message: result.message };
				notes.push(
					'The health check is a real GET https://api.anthropic.com/v1/models using ANTHROPIC_API_KEY (or ANTHROPIC_BASE_URL). It proves the credential authenticates; it is not a completion and does not prove the configured model id exists.',
				);
				if (credentialStateOf(views, 'BROCODE_API_KEY').credentialConfigured) {
					notes.push(
						'BROCODE_API_KEY is configured and is tried before ANTHROPIC_API_KEY by the chat path, so this health check may report not_configured while completions are in fact being served by Brocode.',
					);
				}
			} else {
				notes.push(
					`No health check was run: "${effectiveDefaultModel ?? 'no default model'}" does not look like a Claude model, and no registered test speaks the wire format of any other vendor.`,
				);
			}

			res.json({
				success: true,
				data: {
					changed,
					affectedServices: [...affectedServices],
					restartRequired,
					healthCheck,
					notes,
					updatedBy,
					updatedAt: new Date().toISOString(),
				},
			});
		} catch (error) {
			next(error);
		}
	},
);

// ─── GET /avatar/config ──────────────────────────────────────────────────────

router.get('/avatar/config', requirePermission('avatar.read'), async (_req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const views = await configViews();
		// AVATAR_ENABLED is public-scope and is genuinely resolved at runtime by
		// `GET /device/bootstrap` (`resolveConfigMap(publicConfigKeys())`), so unlike
		// the six voice keys it is marked as read.
		const entry = voiceConfigEntry(views, 'AVATAR_ENABLED', true);

		// The table exists and a row count is cheap, but that count is the whole of
		// the inventory this API can honestly report: no asset metadata, versioning
		// or per-user selection is exposed anywhere.
		let assetCount: number | null = null;
		try {
			const rows = await getDb().select({ total: count() }).from(avatarAssets);
			assetCount = Number(rows[0]?.total ?? 0);
		} catch {
			assetCount = null;
		}

		res.json({
			success: true,
			data: {
				enabled: entry,
				assetInventory: {
					available: false,
					assetCount,
					note:
						assetCount === null
							? 'The avatar_assets row count could not be read. Even when it can, it is only a count.'
							: `avatar_assets holds ${assetCount} row(s). This is a raw count of the table — asset names, model/texture URLs, versioning and per-user avatar selection are not exposed by any admin endpoint, and the avatar itself renders on the client.`,
				},
				notes: [
					'AVATAR_ENABLED is resolved and returned by GET /device/bootstrap as `config.AVATAR_ENABLED`. Note that the capability the client acts on, `capabilities.avatar`, is computed from the AVATAR feature flag and the maintenance kill switch — this key is delivered to clients but is not by itself what gates the capability.',
					'There is no server-side avatar asset inventory beyond the avatar_assets row count returned here.',
				],
				generatedAt: new Date().toISOString(),
			},
		});
	} catch (error) {
		next(error);
	}
});

export default router;
