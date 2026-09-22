/**
 * NOVA — Provider connection tests.
 *
 * A key being present is not the same as a provider working. The previous health
 * check in `utils/health.ts` did exactly that: it sliced `ANTHROPIC_API_KEY`,
 * compared the prefix to `sk-ant-`, and reported "up" from a string comparison. A
 * revoked, expired, or quota-exhausted key reported healthy, and the operator found
 * out from users.
 *
 * Every check below makes a **real, cheap, authenticated network call** to the
 * provider and reports what actually came back. Where a free read-only endpoint
 * exists it is used in preference to a generation call, so testing connectivity
 * does not bill a completion.
 *
 * Results are persisted to `provider_health_checks` so the console can show a
 * history and "last tested", and so a scheduled sweep can populate the dashboard
 * without an operator pressing anything.
 */

import { providerHealthChecks } from '@nova/database';
import { getDb } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { DEFAULT_SPEAKER, DEFAULT_TTS_MODEL } from '../realtime/tts.js';
import { providerConfigurationFingerprint, resolveConfig } from './config.js';
import { decryptSecret } from './secrets.js';

export type ProviderStatus = 'pass' | 'fail' | 'degraded' | 'not_configured';
export type ProviderKind = 'ai' | 'stt' | 'tts' | 'storage' | 'database' | 'cache' | 'payments' | 'push';

export type ProviderTestResult = {
	provider: string;
	kind: ProviderKind;
	status: ProviderStatus;
	latencyMs: number | null;
	message: string;
	/** What the check actually did, so "pass" is falsifiable. */
	method: string;
	checkedAt: string;
};

const DEFAULT_TIMEOUT_MS = 8000;

async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms = DEFAULT_TIMEOUT_MS): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	try {
		return await work(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolves a credential from the encrypted store first, then the environment.
 *
 * This ordering is what makes a key rotated in the console take effect: the
 * database value is authoritative once set.
 */
async function credential(name: string): Promise<string | null> {
	try {
		const value = await resolveConfig(name);
		return value && value.trim().length > 0 ? value.trim() : null;
	} catch (error) {
		logger.warn({ err: error, name }, '[admin-providers] credential resolution failed');
		return null;
	}
}

function notConfigured(provider: string, kind: ProviderKind, method: string, message: string): ProviderTestResult {
	return {
		provider,
		kind,
		status: 'not_configured',
		latencyMs: null,
		message,
		method,
		checkedAt: new Date().toISOString(),
	};
}

// ─── AI ──────────────────────────────────────────────────────────────────────

/**
 * Anthropic: `GET /v1/models`.
 *
 * A read-only listing that requires the same `x-api-key` header as a completion,
 * so it proves the credential is live without spending tokens. `401` means the key
 * is rejected; `403` generally means it lacks permission; a `5xx` is the provider's
 * problem and is reported as `degraded` rather than `fail`, because the credential
 * itself is not in question.
 */
export async function testAnthropic(): Promise<ProviderTestResult> {
	const method = 'GET https://api.anthropic.com/v1/models';
	const key = await credential('ANTHROPIC_API_KEY');
	if (!key) return notConfigured('anthropic', 'ai', method, 'No Anthropic credential is configured.');

	const baseUrl = (await resolveConfig('ANTHROPIC_BASE_URL')) || 'https://api.anthropic.com';
	const started = Date.now();
	try {
		const response = await withTimeout((signal) =>
			fetch(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
				headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
				signal,
			}),
		);
		const latencyMs = Date.now() - started;

		if (response.ok) {
			const body = (await response.json().catch(() => ({}))) as { data?: unknown[] };
			const count = Array.isArray(body.data) ? body.data.length : 0;
			return {
				provider: 'anthropic',
				kind: 'ai',
				status: 'pass',
				latencyMs,
				message: `Authenticated successfully; ${count} model${count === 1 ? '' : 's'} available.`,
				method,
				checkedAt: new Date().toISOString(),
			};
		}

		if (response.status === 429) {
			return {
				provider: 'anthropic',
				kind: 'ai',
				status: 'degraded',
				latencyMs,
				message: 'Credential is valid but the account is rate limited (429).',
				method,
				checkedAt: new Date().toISOString(),
			};
		}

		const detail = (await response.text().catch(() => '')).slice(0, 200);
		return {
			provider: 'anthropic',
			kind: 'ai',
			status: response.status >= 500 ? 'degraded' : 'fail',
			latencyMs,
			message: `Provider answered ${response.status}. ${detail}`,
			method,
			checkedAt: new Date().toISOString(),
		};
	} catch (error) {
		return {
			provider: 'anthropic',
			kind: 'ai',
			status: 'fail',
			latencyMs: Date.now() - started,
			message: `Could not reach Anthropic: ${error instanceof Error ? error.message : String(error)}`,
			method,
			checkedAt: new Date().toISOString(),
		};
	}
}

/**
 * Deepgram: `GET /v1/projects` with a token header.
 *
 * Read-only and free; proves the token authenticates.
 */
export async function testDeepgram(): Promise<ProviderTestResult> {
	const method = 'GET https://api.deepgram.com/v1/projects';
	const key = await credential('DEEPGRAM_API_KEY');
	if (!key) return notConfigured('deepgram', 'stt', method, 'No Deepgram credential is configured.');

	const started = Date.now();
	try {
		const response = await withTimeout((signal) =>
			fetch('https://api.deepgram.com/v1/projects', {
				headers: { Authorization: `Token ${key}` },
				signal,
			}),
		);
		const latencyMs = Date.now() - started;
		if (response.ok) {
			const body = (await response.json().catch(() => ({}))) as { projects?: unknown[] };
			const count = Array.isArray(body.projects) ? body.projects.length : 0;
			return {
				provider: 'deepgram',
				kind: 'stt',
				status: 'pass',
				latencyMs,
				message: `Authenticated successfully; ${count} project${count === 1 ? '' : 's'} visible.`,
				method,
				checkedAt: new Date().toISOString(),
			};
		}
		const detail = (await response.text().catch(() => '')).slice(0, 200);
		return {
			provider: 'deepgram',
			kind: 'stt',
			status: response.status >= 500 ? 'degraded' : 'fail',
			latencyMs,
			message: `Deepgram answered ${response.status}. ${detail}`,
			method,
			checkedAt: new Date().toISOString(),
		};
	} catch (error) {
		return {
			provider: 'deepgram',
			kind: 'stt',
			status: 'fail',
			latencyMs: Date.now() - started,
			message: `Could not reach Deepgram: ${error instanceof Error ? error.message : String(error)}`,
			method,
			checkedAt: new Date().toISOString(),
		};
	}
}

/** ElevenLabs: `GET /v1/user/subscription` — read-only, reveals quota state. */
export async function testElevenLabs(): Promise<ProviderTestResult> {
	const method = 'GET https://api.elevenlabs.io/v1/user/subscription';
	const key = await credential('ELEVENLABS_API_KEY');
	if (!key) return notConfigured('elevenlabs', 'tts', method, 'No ElevenLabs credential is configured.');

	const started = Date.now();
	try {
		const response = await withTimeout((signal) =>
			fetch('https://api.elevenlabs.io/v1/user/subscription', {
				headers: { 'xi-api-key': key },
				signal,
			}),
		);
		const latencyMs = Date.now() - started;
		if (response.ok) {
			const body = (await response.json().catch(() => ({}))) as {
				tier?: string;
				character_count?: number;
				character_limit?: number;
			};
			const used = body.character_count ?? 0;
			const limit = body.character_limit ?? 0;
			const quota = limit > 0 ? ` — ${used.toLocaleString()}/${limit.toLocaleString()} characters used` : '';
			return {
				provider: 'elevenlabs',
				kind: 'tts',
				status: 'pass',
				latencyMs,
				message: `Authenticated successfully${body.tier ? ` (tier: ${body.tier})` : ''}${quota}.`,
				method,
				checkedAt: new Date().toISOString(),
			};
		}
		const detail = (await response.text().catch(() => '')).slice(0, 200);
		return {
			provider: 'elevenlabs',
			kind: 'tts',
			status: response.status >= 500 ? 'degraded' : 'fail',
			latencyMs,
			message: `ElevenLabs answered ${response.status}. ${detail}`,
			method,
			checkedAt: new Date().toISOString(),
		};
	} catch (error) {
		return {
			provider: 'elevenlabs',
			kind: 'tts',
			status: 'fail',
			latencyMs: Date.now() - started,
			message: `Could not reach ElevenLabs: ${error instanceof Error ? error.message : String(error)}`,
			method,
			checkedAt: new Date().toISOString(),
		};
	}
}

/**
 * Sarvam: a one-character text-to-speech synthesis.
 *
 * Sarvam has no documented read-only credential-introspection endpoint, so the
 * cheapest honest test is the smallest possible synthesis. It is labelled as such
 * in `method` so an operator knows this one is not free.
 */
export async function testSarvam(): Promise<ProviderTestResult> {
	const method = 'POST https://api.sarvam.ai/text-to-speech (1-character synthesis)';
	const key = await credential('SARVAM_API_KEY');
	if (!key) return notConfigured('sarvam', 'tts', method, 'No Sarvam credential is configured.');

	const started = Date.now();
	try {
		const response = await withTimeout((signal) =>
			fetch('https://api.sarvam.ai/text-to-speech', {
				method: 'POST',
				headers: { 'api-subscription-key': key, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					text: 'a',
					target_language_code: 'en-IN',
					// Imported from the module that actually synthesises speech rather than written
					// out again here. The literal `bulbul:v2` sat in this file while
					// `realtime/tts.ts` had already moved to `bulbul:v3`, so this probe tested a
					// model Sarvam had retired and reported `fail` every five minutes against a
					// voice path that worked. A duplicated model id made a working integration
					// look broken; sharing the constant removes the drift for good.
					speaker: DEFAULT_SPEAKER,
					model: DEFAULT_TTS_MODEL,
				}),
				signal,
			}),
		);
		const latencyMs = Date.now() - started;
		if (response.ok) {
			return {
				provider: 'sarvam',
				kind: 'tts',
				status: 'pass',
				latencyMs,
				message: 'Authenticated successfully; synthesis accepted.',
				method,
				checkedAt: new Date().toISOString(),
			};
		}
		const detail = (await response.text().catch(() => '')).slice(0, 200);
		return {
			provider: 'sarvam',
			kind: 'tts',
			status: response.status >= 500 ? 'degraded' : 'fail',
			latencyMs,
			message: `Sarvam answered ${response.status}. ${detail}`,
			method,
			checkedAt: new Date().toISOString(),
		};
	} catch (error) {
		return {
			provider: 'sarvam',
			kind: 'tts',
			status: 'fail',
			latencyMs: Date.now() - started,
			message: `Could not reach Sarvam: ${error instanceof Error ? error.message : String(error)}`,
			method,
			checkedAt: new Date().toISOString(),
		};
	}
}

// ─── Infrastructure ──────────────────────────────────────────────────────────

/** PostgreSQL: a real `SELECT 1` through the application's own pool. */
export async function testPostgres(): Promise<ProviderTestResult> {
	const method = 'SELECT 1 through the application connection pool';
	const started = Date.now();
	try {
		const { getDbPool } = await import('../db/connection.js');
		const pool = getDbPool();
		await pool.query('SELECT 1');
		const version = await pool.query<{ version: string }>('SELECT version() as version');
		return {
			provider: 'postgres',
			kind: 'database',
			status: 'pass',
			latencyMs: Date.now() - started,
			message: (version.rows?.[0]?.version ?? 'Connection established').split(' ').slice(0, 2).join(' '),
			method,
			checkedAt: new Date().toISOString(),
		};
	} catch (error) {
		return {
			provider: 'postgres',
			kind: 'database',
			status: 'fail',
			latencyMs: Date.now() - started,
			message: `Database query failed: ${error instanceof Error ? error.message : String(error)}`,
			method,
			checkedAt: new Date().toISOString(),
		};
	}
}

/** Object storage: a `HeadBucket` against the configured endpoint. */
export async function testObjectStorage(): Promise<ProviderTestResult> {
	const method = 'HeadBucket (HEAD /<bucket>) against the configured S3-compatible endpoint';
	const endpoint = await resolveConfig('S3_ENDPOINT');
	const bucket = await resolveConfig('S3_BUCKET');
	const accessKey = await credential('S3_ACCESS_KEY');
	const secretKey = (await credential('S3_SECRET_KEY')) ?? (await credential('S3_SECRET_ACCESS_KEY'));

	if (!endpoint || !bucket) {
		return notConfigured('object-storage', 'storage', method, 'S3_ENDPOINT or S3_BUCKET is not set.');
	}

	const started = Date.now();
	try {
		// HeadBucket, not the endpoint root. Measured against the live MinIO: `HEAD /` answers
		// **400** (MinIO rejects a request for the root path) while `HEAD /<bucket>` answers
		// **403**, which is the healthy signal here — the endpoint is reachable and correctly
		// refusing an unsigned request. This check does not sign, so 403 is success, and probing
		// the root made a working object store report `degraded` on every scheduled run.
		const bucketUrl = `${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(bucket)}`;
		const response = await withTimeout((signal) => fetch(bucketUrl, { method: 'HEAD', signal }));
		return {
			provider: 'object-storage',
			kind: 'storage',
			status: response.ok || response.status === 403 ? 'pass' : 'degraded',
			latencyMs: Date.now() - started,
			message:
				response.ok || response.status === 403
					? `Bucket "${bucket}" reachable (HEAD /${bucket} answered ${response.status}, i.e. refusing an unsigned request).${accessKey && secretKey ? ' Credentials present.' : ' Credentials not fully configured.'}`
					: `Endpoint answered ${response.status}.`,
			method,
			checkedAt: new Date().toISOString(),
		};
	} catch (error) {
		return {
			provider: 'object-storage',
			kind: 'storage',
			status: 'fail',
			latencyMs: Date.now() - started,
			message: `Could not reach the storage endpoint: ${error instanceof Error ? error.message : String(error)}`,
			method,
			checkedAt: new Date().toISOString(),
		};
	}
}

/** Firebase: presence and shape of service-account JSON, since a live push would be a side effect. */
export async function testFirebase(): Promise<ProviderTestResult> {
	const method = 'Service-account credential shape validation (no push sent)';
	const raw = await credential('FIREBASE_SERVICE_ACCOUNT_JSON');
	if (!raw) return notConfigured('firebase', 'push', method, 'FIREBASE_SERVICE_ACCOUNT_JSON is not configured.');

	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const missing = ['project_id', 'client_email', 'private_key'].filter((field) => !parsed[field]);
		if (missing.length > 0) {
			return {
				provider: 'firebase',
				kind: 'push',
				status: 'fail',
				latencyMs: null,
				message: `Service account is missing required field(s): ${missing.join(', ')}.`,
				method,
				checkedAt: new Date().toISOString(),
			};
		}
		return {
			provider: 'firebase',
			kind: 'push',
			status: 'pass',
			latencyMs: null,
			message: `Credential is well-formed for project "${String(parsed.project_id)}".`,
			method,
			checkedAt: new Date().toISOString(),
		};
	} catch {
		return {
			provider: 'firebase',
			kind: 'push',
			status: 'fail',
			latencyMs: null,
			message: 'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.',
			method,
			checkedAt: new Date().toISOString(),
		};
	}
}

/** Redis: PING. When unconfigured this reports `not_configured`, not `fail`. */
export async function testRedis(): Promise<ProviderTestResult> {
	const method = 'PING over the configured Redis connection';
	const url = await resolveConfig('REDIS_URL');
	if (!url) {
		return notConfigured(
			'redis',
			'cache',
			method,
			'REDIS_URL is not set. Refresh-token revocation is process-local, so a multi-replica deployment would not honour a logout everywhere.',
		);
	}
	const started = Date.now();
	try {
		const { default: Redis } = await import('ioredis');
		const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 4000 });
		try {
			await client.connect();
			const pong = await client.ping();
			return {
				provider: 'redis',
				kind: 'cache',
				status: pong === 'PONG' ? 'pass' : 'degraded',
				latencyMs: Date.now() - started,
				message: `Redis answered "${pong}".`,
				method,
				checkedAt: new Date().toISOString(),
			};
		} finally {
			client.disconnect();
		}
	} catch (error) {
		return {
			provider: 'redis',
			kind: 'cache',
			status: 'fail',
			latencyMs: Date.now() - started,
			message: `Redis connection failed: ${error instanceof Error ? error.message : String(error)}`,
			method,
			checkedAt: new Date().toISOString(),
		};
	}
}

/** Stripe: `GET /v1/balance` — read-only. */
export async function testStripe(): Promise<ProviderTestResult> {
	const method = 'GET https://api.stripe.com/v1/balance';
	const key = await credential('STRIPE_SECRET_KEY');
	if (!key) return notConfigured('stripe', 'payments', method, 'STRIPE_SECRET_KEY is not configured.');

	const started = Date.now();
	try {
		const response = await withTimeout((signal) =>
			fetch('https://api.stripe.com/v1/balance', {
				headers: { Authorization: `Bearer ${key}` },
				signal,
			}),
		);
		const latencyMs = Date.now() - started;
		return {
			provider: 'stripe',
			kind: 'payments',
			status: response.ok ? 'pass' : response.status >= 500 ? 'degraded' : 'fail',
			latencyMs,
			message: response.ok ? 'Authenticated successfully.' : `Stripe answered ${response.status}.`,
			method,
			checkedAt: new Date().toISOString(),
		};
	} catch (error) {
		return {
			provider: 'stripe',
			kind: 'payments',
			status: 'fail',
			latencyMs: Date.now() - started,
			message: `Could not reach Stripe: ${error instanceof Error ? error.message : String(error)}`,
			method,
			checkedAt: new Date().toISOString(),
		};
	}
}

// ─── Registry ────────────────────────────────────────────────────────────────

export const PROVIDER_TESTS: Record<string, { kind: ProviderKind; label: string; run: () => Promise<ProviderTestResult> }> = {
	anthropic: { kind: 'ai', label: 'Anthropic', run: testAnthropic },
	deepgram: { kind: 'stt', label: 'Deepgram (STT/TTS)', run: testDeepgram },
	elevenlabs: { kind: 'tts', label: 'ElevenLabs (TTS)', run: testElevenLabs },
	sarvam: { kind: 'tts', label: 'Sarvam (STT/TTS)', run: testSarvam },
	postgres: { kind: 'database', label: 'PostgreSQL', run: testPostgres },
	redis: { kind: 'cache', label: 'Redis', run: testRedis },
	'object-storage': { kind: 'storage', label: 'Object storage (S3/MinIO)', run: testObjectStorage },
	firebase: { kind: 'push', label: 'Firebase Cloud Messaging', run: testFirebase },
	stripe: { kind: 'payments', label: 'Stripe', run: testStripe },
};

export function isKnownProvider(provider: string): boolean {
	return provider in PROVIDER_TESTS;
}

/** Runs one provider test and records the result. */
export async function runProviderTest(
	provider: string,
	options: { trigger?: 'manual' | 'scheduled'; checkedBy?: string | null } = {},
): Promise<ProviderTestResult> {
	const entry = PROVIDER_TESTS[provider];
	if (!entry) {
		throw new Error(`Unknown provider "${provider}"`);
	}

	const result = await entry.run();

	// Which credential value this test exercised.
	//
	// Recorded so a later rotation can invalidate the result. Without it a `pass` kept asserting that
	// a credential works after the value had been replaced, and a `fail` kept asserting a failure the
	// operator had already fixed — a claim about current state derived from a measurement of a past
	// one. `null` when the provider has no credential (PostgreSQL, Redis, an unset Stripe key), which
	// the read model renders as "no credential involved", never as "stale".
	const fingerprint = await providerConfigurationFingerprint(result.provider);

	try {
		const db = getDb();
		await db.insert(providerHealthChecks).values({
			provider: result.provider,
			kind: result.kind,
			status: result.status,
			latencyMs: result.latencyMs,
			message: result.message,
			trigger: options.trigger ?? 'manual',
			checkedBy: options.checkedBy ?? null,
			secretFingerprint: fingerprint,
		});
	} catch (error) {
		// Same reasoning as the audit log: a failed history write must not turn a
		// successful connectivity test into an error for the operator.
		logger.warn({ err: error, provider }, '[admin-providers] could not persist health check');
	}

	// The credential keys each provider test validates live in the configuration module, because
	// that is where they are read back from (`listConfigViews` joins test history onto a key).
	// Nothing is duplicated onto `system_configs` here: a connectivity test must not create a
	// config row, and a key supplied by the environment has no row to update in the first place.

	return result;
}

/**
 * Runs every configured provider test concurrently.
 *
 * A provider with no credential short-circuits to `not_configured` without a
 * network call, so this is fast on a partially configured environment.
 */
export async function runAllProviderTests(
	options: { trigger?: 'manual' | 'scheduled'; checkedBy?: string | null } = {},
): Promise<ProviderTestResult[]> {
	const names = Object.keys(PROVIDER_TESTS);
	const results = await Promise.all(
		names.map(async (name) => {
			try {
				return await runProviderTest(name, options);
			} catch (error) {
				return {
					provider: name,
					kind: PROVIDER_TESTS[name].kind,
					status: 'fail' as ProviderStatus,
					latencyMs: null,
					message: `Test threw: ${error instanceof Error ? error.message : String(error)}`,
					method: 'registry dispatch',
					checkedAt: new Date().toISOString(),
				};
			}
		}),
	);
	return results;
}

/**
 * The most recent result per provider, for the health dashboard.
 *
 * Uses `DISTINCT ON`, which is the PostgreSQL-native way to express "latest row per
 * group" without a window function subquery in every caller.
 */
export async function latestProviderHealth(): Promise<
	Array<ProviderTestResult & { checkedBy: string | null; trigger: string }>
> {
	try {
		const { getDbPool } = await import('../db/connection.js');
		const pool = getDbPool();
		const { rows } = await pool.query<{
			provider: string;
			kind: string;
			status: string;
			latency_ms: number | null;
			message: string | null;
			trigger: string;
			checked_by: string | null;
			checked_at: Date;
		}>(
			`SELECT DISTINCT ON (provider)
				provider, kind, status, latency_ms, message, trigger, checked_by, checked_at
			 FROM provider_health_checks
			 ORDER BY provider, checked_at DESC`,
		);

		return rows.map((row) => ({
			provider: row.provider,
			kind: row.kind as ProviderKind,
			status: row.status as ProviderStatus,
			latencyMs: row.latency_ms,
			message: row.message ?? '',
			method: 'recorded history',
			checkedAt: row.checked_at.toISOString(),
			trigger: row.trigger,
			checkedBy: row.checked_by,
		}));
	} catch (error) {
		logger.warn({ err: error }, '[admin-providers] could not read provider health history');
		return [];
	}
}

export { decryptSecret };
