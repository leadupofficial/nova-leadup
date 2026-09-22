/**
 * NOVA — Admin system console: configuration, feature flags, emergency controls,
 * environment, database, services, logs and correlation lookup.
 *
 * Behind `adminGate`, so `req.adminActor`/`req.adminPermissions` are always populated.
 * Every route names its permission and every mutation is audited with the operator's
 * reason. Two invariants are enforced rather than described: a secret's plaintext or
 * ciphertext never reaches a response, an audit row or a log; and anything this console
 * cannot do (change an env-only key, search logs, reconstruct a trace) is refused or
 * reported unavailable instead of being faked with an empty list.
 */

import { Router, type NextFunction, type Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { featureFlagOverrides, featureFlags, systemConfigs } from '@nova/database';
import { type AdminRequest, adminGate, holdsPermission, requirePermission } from '../../admin/access.js';
import { auditedOperation } from '../../admin/audit.js';
import {
	MAX_ROWS as AUDIT_EXPORT_MAX_ROWS,
	auditExportConditions,
	auditExportFilename,
	toCsv,
	type AuditExportRow,
} from '../../admin/audit-export.js';
import {
	CONFIG_CATALOG, getConfigDefinition, invalidateConfigCache, isKnownConfigKey, listConfigViews,
	secretStoreReady, validateConfigValue, type ConfigKeyDefinition, type ConfigView,
} from '../../admin/config.js';
import {
	CONTROL_DEFINITIONS, getRuntimeControls, invalidateControlCache, isControlKey, setControl, type ControlKey,
} from '../../admin/control.js';
import {
	FEATURE_FLAG_KEYS, FLAG_DESCRIPTIONS, evaluateFlag, invalidateFlagCache, isKnownFlagKey, rolloutBucket,
} from '../../admin/flags.js';
import { PROVIDER_TESTS, runAllProviderTests, runProviderTest } from '../../admin/providers.js';
import { encryptSecret, maskSecret } from '../../admin/secrets.js';
import {
	discoverServiceTargets, getDatabaseHealth, getMigrationStatus, getSelfMetrics, getSlowQueries, listServiceHealth,
} from '../../admin/system.js';
import { getDb, getDbPool } from '../../db/connection.js';
import { getLogSink, retentionDays, sinkLevel } from '../../utils/log-sink.js';
import { HttpError } from '../../middleware/error-handler.js';
import { validate } from '../../middleware/validate.js';

const router: ReturnType<typeof Router> = Router();
router.use(adminGate);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Validated body / query written by the `validate` middleware. */
function validatedBody<T>(req: AdminRequest): T {
	return (req as unknown as { validatedBody: T }).validatedBody;
}
function validatedQuery<T>(req: AdminRequest): T {
	return (req as unknown as { validatedQuery: T }).validatedQuery;
}
/** The environment the operator claims to act in. Recorded on every audit row, never trusted. */
function actingEnvironment(req: AdminRequest): string {
	return req.adminEnvironment ?? process.env.NODE_ENV ?? 'development';
}

/**
 * Refuses a console write to an env-only key. Those keys are read from `process.env`
 * at process start by code that never reads the database, so writing a row would change
 * a row and nothing else: the console would show a new value while the running process
 * kept the old one.
 */
function throwEnvOnly(key: string): never {
	const error = new HttpError(
		409,
		`"${key}" is read from the process environment when the process starts and cannot be changed from this console: a database row does not change a running process's environment. This requires: deployment-level environment change, followed by a restart or rolling restart of every service that reads it.`,
		'ENV_ONLY',
	);
	// Attached for programmatic consumers; the message repeats it because the error handler
	// only serialises message and code.
	(error as HttpError & { requires?: string }).requires = 'deployment-level environment change';
	throw error;
}

/** The secret-store sentence, in both states. */
function secretStoreNote(): string {
	return secretStoreReady()
		? 'A usable secret encryption key is present in this process, so secrets can be stored and rotated.'
		: 'NOVA_CONFIG_ENCRYPTION_KEY is not set in this process, so no secret can be encrypted or stored, and a stored secret cannot be decrypted for use. Set NOVA_CONFIG_ENCRYPTION_KEY (32 bytes, hex or base64) in the deployment environment and restart before storing credentials here. Outside production only, the secret module falls back to a key derived from JWT_SECRET; that fallback is deliberately unavailable in production.';
}

/** Re-asserts the secret invariant: this route family is where a mistake would leak live values. */
function sanitiseConfigViews(views: ConfigView[]): ConfigView[] {
	return views.map((view) => (view.scope === 'secret' ? { ...view, value: null } : view));
}

/** Column values shared by every `system_configs` write, derived from the catalog. */
function definitionColumns(definition: ConfigKeyDefinition) {
	return {
		scope: definition.scope,
		category: definition.category,
		valueType: definition.valueType,
		description: definition.description,
		usedBy: definition.usedBy,
		restartRequired: definition.restartRequired,
		hotReloadable: !definition.restartRequired,
		displayOrder: definition.displayOrder ?? 0,
	};
}

/** A readable label derived from the key: the catalog carries no display label. */
function humaniseKey(key: string): string {
	return key.split('_').filter(Boolean).map((part) => part.charAt(0) + part.slice(1).toLowerCase()).join(' ');
}

/** Secret-scope keys, for the "unknown secret" 404 message. Derived from the catalog. */
const SECRET_KEY_NAMES: string[] = CONFIG_CATALOG.filter((d) => d.scope === 'secret').map((d) => d.key);
/** Secret names are environment-variable shaped. */
const SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// ─── Configuration ───────────────────────────────────────────────────────────

/** `GET /admin/config` — the catalog with its effective sources, grouped by category. */
router.get('/config', requirePermission('config.read'), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const views = sanitiseConfigViews(await listConfigViews());
		const grouped = new Map<string, ConfigView[]>();
		for (const view of views) {
			const bucket = grouped.get(view.category);
			if (bucket) bucket.push(view);
			else grouped.set(view.category, [view]);
		}
		res.json({
			success: true,
			data: {
				environment: actingEnvironment(req),
				categories: [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, configs]) => ({ category, configs })),
				configs: views, // flat too, so a search box need not flatten groups
				secretStore: { ready: secretStoreReady(), note: secretStoreNote() },
				notes: [
					'Secret values are never returned by this API in any form. For a stored secret only the masked hint (last four characters) is shown; the value can be replaced or deleted but never read back.',
					'envOnly keys are listed so their presence and purpose are visible, but they are refused on write: they are read from the process environment at startup.',
				],
			},
		});
	} catch (error) { next(error); }
});

type ValidatorStatus = 'pass' | 'fail' | 'degraded' | 'not_configured' | 'unset';
type ValidatorCheck = { key: string; label: string; category: string; status: ValidatorStatus; required: boolean; detail: string; effectiveSource: string };

/**
 * `GET /admin/config/validate` — the configuration validator.
 *
 * Presence and connectivity are separate checks: a key can carry a value (`pass`)
 * while the live test for that credential fails because it was revoked. "Missing" and
 * "configured but broken" need different fixes.
 */
router.get('/config/validate', requirePermission('config.read'), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const checks: ValidatorCheck[] = [];
		for (const view of sanitiseConfigViews(await listConfigViews())) {
			// A secret has no catalog default by design, so "unset" means neither the store
			// nor the environment supplies it.
			const status: ValidatorStatus = view.effectiveSource === 'unset' ? (view.scope === 'secret' ? 'not_configured' : 'unset') : 'pass';
			checks.push({
				key: view.key,
				label: humaniseKey(view.key),
				category: view.category,
				status,
				// The catalog declares no requiredness. Here "required" means "no fallback and
				// not repairable from this console" — an env-only key, or a key with neither a
				// value nor a default. It does not claim the platform refuses to boot without it.
				required: view.envOnly || view.effectiveSource === 'unset',
				detail:
					status === 'pass'
						? `Resolved from ${view.effectiveSource}${view.secretHint ? ` (${view.secretHint})` : ''}.`
						: status === 'not_configured'
							? 'No value is stored and none is present in the process environment.'
							: 'No value is stored, none is present in the environment, and the catalog declares no default.',
				effectiveSource: view.effectiveSource,
			});
		}
		// Real connectivity, not cached history: live authenticated calls, so this endpoint
		// is slower than the rest of the screen by design.
		for (const result of await runAllProviderTests({ trigger: 'manual', checkedBy: req.adminActor?.email ?? null })) {
			checks.push({
				key: `provider:${result.provider}`,
				label: PROVIDER_TESTS[result.provider]?.label ?? result.provider,
				category: 'Connectivity',
				status: result.status, // ProviderStatus shares these names
				required: false,
				detail: `${result.message} — ${result.method}${result.latencyMs === null ? '' : ` (${result.latencyMs} ms)`}`,
				effectiveSource: 'live test just now',
			});
		}
		// Separate from the NOVA_CONFIG_ENCRYPTION_KEY catalog check: the variable being
		// present is not the same as the store being usable (outside production a key may be
		// derived from JWT_SECRET instead).
		const storeReady = secretStoreReady();
		checks.push({
			key: 'secret_store',
			label: 'Secret store',
			category: 'Security',
			status: storeReady ? 'pass' : 'not_configured',
			required: true,
			detail: secretStoreNote(),
			effectiveSource: storeReady ? (process.env.NOVA_CONFIG_ENCRYPTION_KEY ? 'environment (NOVA_CONFIG_ENCRYPTION_KEY)' : 'derived development key') : 'unset',
		});

		const summary: Record<ValidatorStatus, number> = { pass: 0, fail: 0, degraded: 0, not_configured: 0, unset: 0 };
		for (const check of checks) summary[check.status] += 1;

		res.json({
			success: true,
			data: {
				environment: actingEnvironment(req),
				checks,
				summary,
				notes: [
					'Every provider check above made a real authenticated network call just now — a "pass" means the credential was accepted, not that a key is present. Anthropic, Deepgram, ElevenLabs and Stripe are checked against read-only endpoints; Sarvam has no introspection endpoint, so the smallest possible synthesis is used.',
					'A configuration check in "pass" state does not imply the dependency works: the same credential can appear here as pass (a value is stored) and as fail (the provider rejected it). Those states have different fixes, which is why both are listed.',
					'A "required" check means the key has no fallback and cannot be repaired from this console; it does not mean the platform refuses to start without it.',
					secretStoreNote(),
				],
			},
		});
	} catch (error) { next(error); }
});

const ConfigValueSchema = z.object({ value: z.string().max(20000), reason: z.string().max(500).optional() }).strict();

/** `PATCH /admin/config/:key` — change a non-secret runtime configuration value. */
router.patch('/config/:key', requirePermission('config.write'), validate(ConfigValueSchema), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const key = req.params.key;
		const parsed = validatedBody<z.infer<typeof ConfigValueSchema>>(req);
		const definition = getConfigDefinition(key);
		if (!definition || !isKnownConfigKey(key)) {
			throw new HttpError(404, `Unknown configuration key "${key}". The catalog is fixed at build time, so a key that is not in it cannot be created here.`, 'UNKNOWN_CONFIG_KEY');
		}
		// envOnly before secret: DATABASE_URL and friends are both, and "the console cannot
		// change a process environment" is the reason that matters.
		if (definition.envOnly) throwEnvOnly(key);
		if (definition.scope === 'secret') {
			throw new HttpError(403, `"${key}" is a secret and cannot be written through the general configuration endpoint. Use PUT /config/secrets/:key, which encrypts the value and never returns it.`, 'SECRETS_REQUIRE_DEDICATED_ENDPOINT');
		}
		const validation = validateConfigValue(definition, parsed.value);
		if (!validation.valid) throw new HttpError(400, validation.error, 'INVALID_CONFIG_VALUE');

		const current = (await listConfigViews()).find((view) => view.key === key);
		const before = current?.value ?? null;
		const updatedBy = req.adminActor?.email ?? null;

		await auditedOperation({
			req, action: 'config.update', permission: 'config.write', targetType: 'system_config', targetId: key,
			reason: parsed.reason ?? null,
			before: { key, value: before, source: current?.effectiveSource ?? 'unset' },
			after: () => ({ key, value: validation.coerced }),
			run: async () => {
				await getDb().insert(systemConfigs)
					.values({ key, ...definitionColumns(definition), value: validation.coerced, updatedBy })
					.onConflictDoUpdate({ target: systemConfigs.key, set: { value: validation.coerced, updatedBy, updatedAt: new Date() } });
			},
		});

		// Makes the write visible to the next read in *this* process; other replicas converge
		// on their own 15-second cache TTL, which the response states rather than implying an
		// instant global change.
		await invalidateConfigCache();

		res.json({
			success: true,
			data: {
				key, before, after: validation.coerced,
				affectedServices: definition.usedBy,
				restartRequired: definition.restartRequired,
				propagation: definition.restartRequired
					? 'Applied immediately in this process (the config cache was invalidated, so the next read resolves the new value). Other replicas continue to serve the previous value until their 15-second config cache TTL lapses. This key is also captured once at process start by the services that read it, so a rolling restart is required before every caller honours the new value.'
					: 'Applied immediately in this process (the config cache was invalidated, so the next read resolves the new value). Other replicas continue to serve the previous value until their 15-second config cache TTL lapses.',
			},
		});
	} catch (error) { next(error); }
});

const SecretWriteSchema = z.object({ value: z.string().min(1).max(20000), reason: z.string().min(3).max(500) }).strict();

/**
 * `PUT /admin/config/secrets/:key` — store or rotate a secret.
 *
 * `validateConfigValue` is deliberately not used here: it rejects any whitespace in a
 * secret, which would make a multi-line service-account JSON
 * (`FIREBASE_SERVICE_ACCOUNT_JSON`, a real catalog key) impossible to store. The checks
 * that matter — non-empty and bounded — are on the schema.
 */
router.put('/config/secrets/:key', requirePermission('config.secrets'), validate(SecretWriteSchema), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const key = req.params.key;
		const parsed = validatedBody<z.infer<typeof SecretWriteSchema>>(req);
		const definition = getConfigDefinition(key);
		if (!definition || !isKnownConfigKey(key)) {
			throw new HttpError(404, `Unknown secret key "${key}". Known secret keys: ${SECRET_KEY_NAMES.join(', ')}.`, 'UNKNOWN_CONFIG_KEY');
		}
		if (definition.scope !== 'secret') {
			throw new HttpError(400, `"${key}" is not a secret-scope key. Use PATCH /config/${key} to change it.`, 'NOT_A_SECRET');
		}
		// Defence in depth: the catalog governs which keys exist, but a secret name is also
		// an environment-variable-shaped identifier everywhere else in the platform.
		if (!SECRET_KEY_PATTERN.test(key)) {
			throw new HttpError(400, `"${key}" is not a valid secret name; a secret name must match /^[A-Z][A-Z0-9_]*$/.`, 'INVALID_SECRET_NAME');
		}
		if (definition.envOnly) throwEnvOnly(key);
		if (!secretStoreReady()) {
			throw new HttpError(503, 'No secret encryption key is available, so the value cannot be encrypted and was not stored. Set NOVA_CONFIG_ENCRYPTION_KEY and restart.', 'SECRET_STORE_NOT_CONFIGURED');
		}

		const db = getDb();
		const existing = (await db
			.select({ secretCiphertext: systemConfigs.secretCiphertext, secretHint: systemConfigs.secretHint })
			.from(systemConfigs).where(eq(systemConfigs.key, key)).limit(1)) as unknown as Array<{ secretCiphertext: string | null; secretHint: string | null }>;

		const rotated = Boolean(existing[0]?.secretCiphertext);
		const hint = maskSecret(parsed.value);
		const updatedBy = req.adminActor?.email ?? null;
		// Encrypted before the audit scope opens: a failure here must not leave a "success"
		// row for a secret that was never written.
		const ciphertext = encryptSecret(parsed.value);

		await auditedOperation({
			req, action: 'config.secret_write', permission: 'config.secrets', targetType: 'system_config', targetId: key,
			reason: parsed.reason,
			// Neither snapshot may contain the value or the ciphertext.
			before: { key, scope: 'secret', hint: existing[0]?.secretHint ?? null, existed: rotated },
			after: () => ({ key, scope: 'secret', hint, rotated }),
			run: async () => {
				await db.insert(systemConfigs)
					.values({
						key, ...definitionColumns(definition), scope: 'secret',
						value: null, // a secret row must never also carry a plaintext value
						secretCiphertext: ciphertext, secretHint: hint, updatedBy,
					})
					.onConflictDoUpdate({
						target: systemConfigs.key,
						set: { ...definitionColumns(definition), scope: 'secret', value: null, secretCiphertext: ciphertext, secretHint: hint, updatedBy, updatedAt: new Date() },
					});
			},
		});

		await invalidateConfigCache();

		// Assembled entirely from locals: plaintext and ciphertext have no path into it.
		res.json({
			success: true,
			data: {
				key, hint, maskedDisplay: hint, rotated,
				affectedServices: definition.usedBy,
				environmentValuePresent: process.env[key] !== undefined,
				prose: 'The secret is stored encrypted (AES-256-GCM) and can never be read back through this API or any other — not by an operator and not by another admin. It can only be replaced by writing a new value, or deleted. It takes effect in this process immediately: the config cache was invalidated, and because a database value beats the environment, this stored value is now the one the platform uses.',
			},
		});
	} catch (error) { next(error); }
});

const SecretDeleteSchema = z.object({ reason: z.string().min(3).max(500), confirm: z.string() }).strict();

/** `DELETE /admin/config/secrets/:key` — remove a stored secret (typed confirmation). */
router.delete('/config/secrets/:key', requirePermission('config.secrets'), validate(SecretDeleteSchema), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const key = req.params.key;
		const parsed = validatedBody<z.infer<typeof SecretDeleteSchema>>(req);
		const definition = getConfigDefinition(key);
		if (!definition || !isKnownConfigKey(key)) throw new HttpError(404, `Unknown secret key "${key}".`, 'UNKNOWN_CONFIG_KEY');
		if (definition.scope !== 'secret') throw new HttpError(400, `"${key}" is not a secret-scope key.`, 'NOT_A_SECRET');
		if (parsed.confirm !== key) {
			throw new HttpError(400, `Confirmation does not match. Type the key name "${key}" exactly in "confirm" to delete it.`, 'CONFIRMATION_MISMATCH');
		}
		const updatedBy = req.adminActor?.email ?? null;
		const outcome = await auditedOperation({
			req, action: 'config.secret_delete', permission: 'config.secrets', targetType: 'system_config', targetId: key,
			reason: parsed.reason,
			before: { key, scope: 'secret' },
			after: (result) => result,
			run: async () => {
				const removed = await getDb().update(systemConfigs)
					.set({ secretCiphertext: null, secretHint: null, updatedBy, updatedAt: new Date() })
					.where(eq(systemConfigs.key, key)).returning({ id: systemConfigs.id });
				return { key, scope: 'secret', storedSecretRemoved: removed.length > 0 };
			},
		});
		await invalidateConfigCache();

		// Deleting a stored secret does not remove a value that lives in the process
		// environment, and once the row is gone that environment value is what
		// `resolveConfig` returns again — otherwise "I deleted the key and it still works"
		// is a mystery.
		const environmentValuePresent = process.env[key] !== undefined;
		res.json({
			success: true,
			data: {
				key,
				deleted: outcome.storedSecretRemoved,
				environmentValuePresent,
				envOnly: definition.envOnly,
				sourceAfterDelete: environmentValuePresent ? 'environment' : 'unset',
				warning: environmentValuePresent
					? `"${key}" is also set in this process's environment, so after this deletion that environment value is used again.${definition.envOnly ? ' This key is env-only, so the deletion changed nothing at runtime.' : ' To remove it entirely, change the deployment environment.'}`
					: definition.envOnly
						? `"${key}" is env-only: it is read from the process environment at startup, so deleting a stored row does not and cannot change a running process's behaviour.`
						: 'No value remains for this key in the store or the environment, so it now resolves to unset.',
			},
		});
	} catch (error) { next(error); }
});

/**
 * `POST /admin/config/test/:provider` — one real provider connectivity test.
 *
 * `services.read` rather than a secrets permission: this is non-mutating (it writes a
 * `provider_health_checks` history row and nothing else), and an operator diagnosing an
 * outage should not need `config.secrets` to discover a rejected key.
 */
router.post('/config/test/:provider', requirePermission('services.read'), validate(z.object({}).strict()), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const provider = req.params.provider;
		if (!Object.prototype.hasOwnProperty.call(PROVIDER_TESTS, provider)) {
			throw new HttpError(404, `Unknown provider "${provider}". Known providers: ${Object.keys(PROVIDER_TESTS).join(', ')}.`, 'UNKNOWN_PROVIDER');
		}
		const result = await auditedOperation({
			req, action: 'config.provider_test', permission: 'services.read', targetType: 'provider', targetId: provider,
			before: { provider },
			after: (tested) => ({ provider: tested.provider, status: tested.status, latencyMs: tested.latencyMs }),
			run: () => runProviderTest(provider, { trigger: 'manual', checkedBy: req.adminActor?.email ?? null }),
		});
		res.json({
			success: true,
			data: { ...result, note: 'This test just made a real authenticated call to the provider. A "pass" means the credential was accepted by the provider, not merely that a key is present in configuration.' },
		});
	} catch (error) { next(error); }
});

// ─── Feature flags ───────────────────────────────────────────────────────────

type FlagRow = { key: string; enabled: boolean; rolloutPercent: number | null; description: string | null };
type OverrideRow = { flagKey: string; scopeType: string; scopeValue: string; enabled: boolean; rolloutPercent: number | null; reason: string | null };

/**
 * Fixed sample subjects for the rollout preview: constants, not real users. The point is
 * that the same input yields the same bucket on every request; real user ids would leak
 * identifiers into a configuration screen for no benefit.
 */
const PREVIEW_SUBJECTS = ['preview-subject-0001', 'preview-subject-0002', 'preview-subject-0003'];
const FLAG_PROPAGATION = 'Applied immediately in this process (the flag cache is invalidated on write). Other API replicas continue to serve the previous value until their 15-second flag cache TTL lapses, and clients observe the change on their next config fetch.';
const OverrideScopeType = z.enum(['environment', 'user', 'organization']);

/** `GET /admin/feature-flags` — every known flag plus every flag row, with overrides. */
router.get('/feature-flags', requirePermission('feature_flags.read'), async (_req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const db = getDb();
		const [flagRows, overrideRows] = await Promise.all([
			db.select().from(featureFlags) as unknown as Promise<FlagRow[]>,
			db.select().from(featureFlagOverrides) as unknown as Promise<OverrideRow[]>,
		]);
		const byKey = new Map(flagRows.map((row) => [row.key, row]));
		// The union matters: a seeded row outside FEATURE_FLAG_KEYS is still evaluated, and a
		// known key with no row still falls back to the caller's default. Hiding either half
		// would misrepresent the system.
		const keys = [...new Set<string>([...FEATURE_FLAG_KEYS, ...flagRows.map((row) => row.key)])].sort();

		const flags = keys.map((key) => {
			const row = byKey.get(key);
			const rolloutPercent = row?.rolloutPercent ?? 0;
			return {
				key,
				description: isKnownFlagKey(key) ? FLAG_DESCRIPTIONS[key] : (row?.description ?? null),
				enabled: row?.enabled ?? false,
				rolloutPercent,
				rowExists: Boolean(row),
				overrides: overrideRows.filter((override) => override.flagKey === key).map((override) => ({
					scopeType: override.scopeType, scopeValue: override.scopeValue, enabled: override.enabled,
					rolloutPercent: override.rolloutPercent, reason: override.reason,
				})),
				// Demonstrates determinism instead of describing it: the bucket is a stable
				// sha256 of `key:subject`, so these numbers survive requests and restarts.
				evaluationPreview: PREVIEW_SUBJECTS.map((subjectId) => {
					const bucket = rolloutBucket(key, subjectId);
					const inside = bucket < rolloutPercent;
					return { subjectId, bucket, inside, enabled: Boolean(row?.enabled) && inside };
				}),
			};
		});

		res.json({
			success: true,
			data: {
				flags,
				knownKeys: [...FEATURE_FLAG_KEYS],
				notes: [
					'evaluationPreview buckets come from a stable sha256 of "flagKey:subject", so the same subject is consistently inside or outside a percentage rollout on every request, process and restart. The preview shows the global-rollout layer only; user, organization and environment overrides are evaluated before it and are listed alongside each flag.',
					'flags with rowExists=false have no global row, so evaluation falls back to the caller-supplied default until a row is created.',
				],
			},
		});
	} catch (error) { next(error); }
});

const CreateFlagSchema = z.object({
	key: z.string().min(1).max(100),
	enabled: z.boolean(),
	rolloutPercent: z.number().int().min(0).max(100).default(0),
	description: z.string().max(1000).optional(),
	reason: z.string().max(500).optional(),
}).strict();

/** `POST /admin/feature-flags` — create the global flag row. */
router.post('/feature-flags', requirePermission('feature_flags.write'), validate(CreateFlagSchema), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const parsed = validatedBody<z.infer<typeof CreateFlagSchema>>(req);
		const description = parsed.description ?? (isKnownFlagKey(parsed.key) ? FLAG_DESCRIPTIONS[parsed.key] : null);
		const created = await auditedOperation({
			req, action: 'feature_flag.create', permission: 'feature_flags.write', targetType: 'feature_flag', targetId: parsed.key,
			reason: parsed.reason ?? null,
			before: { key: parsed.key, existed: false },
			after: (row) => ({ key: row.key, enabled: row.enabled, rolloutPercent: row.rolloutPercent }),
			run: async () => {
				try {
					const [row] = await getDb().insert(featureFlags)
						.values({ key: parsed.key, enabled: parsed.enabled, rolloutPercent: parsed.rolloutPercent, description })
						.returning();
					return row;
				} catch (error) {
					// 23505 is PostgreSQL's unique violation; translating it keeps "you already
					// have this flag" a 409 instead of an unlabelled 500.
					if ((error as { code?: string }).code === '23505') {
						throw new HttpError(409, `A feature flag named "${parsed.key}" already exists. Edit it instead of creating a duplicate.`, 'DUPLICATE_FLAG');
					}
					throw error;
				}
			},
		});
		invalidateFlagCache();
		res.json({
			success: true,
			data: {
				flag: created, propagation: FLAG_PROPAGATION,
				note: 'A newly created flag with enabled=true and rolloutPercent=0 is on for nobody: the percentage narrows an enabled flag, it does not turn one on.',
			},
		});
	} catch (error) { next(error); }
});

const UpdateFlagSchema = z.object({
	enabled: z.boolean().optional(),
	rolloutPercent: z.number().int().min(0).max(100).optional(),
	description: z.string().max(1000).optional(),
	reason: z.string().max(500).optional(),
}).strict();

/** `PATCH /admin/feature-flags/:key` — update the global row, addressed by key. */
router.patch('/feature-flags/:key', requirePermission('feature_flags.write'), validate(UpdateFlagSchema), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const key = req.params.key;
		const parsed = validatedBody<z.infer<typeof UpdateFlagSchema>>(req);
		if (parsed.enabled === undefined && parsed.rolloutPercent === undefined && parsed.description === undefined) {
			throw new HttpError(400, 'Provide at least one of "enabled", "rolloutPercent" or "description".', 'NO_CHANGES');
		}
		const db = getDb();
		// Looked up by key, not id: the console navigates by key, and a key is what appears
		// in logs, audit rows and client code.
		const current = ((await db.select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1)) as unknown as FlagRow[])[0];
		if (!current) throw new HttpError(404, `No global feature-flag row exists for "${key}". Create it with POST /feature-flags first.`, 'FLAG_NOT_FOUND');

		const patch: { enabled?: boolean; rolloutPercent?: number; description?: string; updatedAt: Date } = { updatedAt: new Date() };
		if (parsed.enabled !== undefined) patch.enabled = parsed.enabled;
		if (parsed.rolloutPercent !== undefined) patch.rolloutPercent = parsed.rolloutPercent;
		if (parsed.description !== undefined) patch.description = parsed.description;

		const updated = await auditedOperation({
			req, action: 'feature_flag.update', permission: 'feature_flags.write', targetType: 'feature_flag', targetId: key,
			reason: parsed.reason ?? null,
			before: { key, enabled: current.enabled, rolloutPercent: current.rolloutPercent, description: current.description },
			after: (row) => ({ key: row.key, enabled: row.enabled, rolloutPercent: row.rolloutPercent, description: row.description }),
			run: async () => {
				const [row] = await db.update(featureFlags).set(patch).where(eq(featureFlags.key, key)).returning();
				return row;
			},
		});
		invalidateFlagCache();
		res.json({ success: true, data: { flag: updated, propagation: FLAG_PROPAGATION } });
	} catch (error) { next(error); }
});

/** `DELETE /admin/feature-flags/:key` — delete the global row and all its overrides. */
router.delete('/feature-flags/:key', requirePermission('feature_flags.write'), validate(z.object({ confirm: z.string(), reason: z.string().max(500).optional() }).strict()), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const key = req.params.key;
		const parsed = validatedBody<{ confirm: string; reason?: string }>(req);
		if (parsed.confirm !== key) {
			throw new HttpError(400, `Confirmation does not match. Type the flag key "${key}" exactly in "confirm" to delete it.`, 'CONFIRMATION_MISMATCH');
		}
		const db = getDb();
		const current = ((await db.select().from(featureFlags).where(eq(featureFlags.key, key)).limit(1)) as unknown as FlagRow[])[0];
		if (!current) throw new HttpError(404, `No global feature-flag row exists for "${key}".`, 'FLAG_NOT_FOUND');

		const outcome = await auditedOperation({
			req, action: 'feature_flag.delete', permission: 'feature_flags.write', targetType: 'feature_flag', targetId: key,
			reason: parsed.reason ?? null,
			before: { key, enabled: current.enabled, rolloutPercent: current.rolloutPercent },
			after: (result) => result,
			// One transaction: overrides are evaluated *before* the global row, so an override
			// left behind by a partial delete would keep deciding the flag for its scope after
			// the flag was reported as deleted.
			run: () => db.transaction(async (tx) => {
				const overrides = await tx.delete(featureFlagOverrides).where(eq(featureFlagOverrides.flagKey, key)).returning({ id: featureFlagOverrides.id });
				const flag = await tx.delete(featureFlags).where(eq(featureFlags.key, key)).returning({ id: featureFlags.id });
				return { key, flagDeleted: flag.length > 0, overridesDeleted: overrides.length };
			}),
		});
		invalidateFlagCache();
		res.json({
			success: true,
			data: {
				...outcome,
				warning: 'Every evaluation of this flag now falls back to the caller-supplied default (normally "off") until a row is created again. If the key is one of the built-in flags it keeps appearing in this console as an unseeded flag; a key outside that list disappears entirely.',
			},
		});
	} catch (error) { next(error); }
});

const UpsertOverrideSchema = z.object({
	scopeType: OverrideScopeType,
	scopeValue: z.string().min(1).max(100),
	enabled: z.boolean(),
	rolloutPercent: z.number().int().min(0).max(100).nullable().optional(),
	reason: z.string().max(500).optional(),
}).strict();

/** `PUT /admin/feature-flags/:key/overrides` — upsert one scoped override. */
router.put('/feature-flags/:key/overrides', requirePermission('feature_flags.write'), validate(UpsertOverrideSchema), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const key = req.params.key;
		const parsed = validatedBody<z.infer<typeof UpsertOverrideSchema>>(req);
		const db = getDb();
		const previous = ((await db.select().from(featureFlagOverrides).where(eq(featureFlagOverrides.flagKey, key))) as unknown as OverrideRow[])
			.find((row) => row.scopeType === parsed.scopeType && row.scopeValue === parsed.scopeValue);

		const override = await auditedOperation({
			req, action: 'feature_flag.override_upsert', permission: 'feature_flags.write', targetType: 'feature_flag_override',
			targetId: `${key}:${parsed.scopeType}:${parsed.scopeValue}`,
			reason: parsed.reason ?? null,
			before: previous ? { enabled: previous.enabled, rolloutPercent: previous.rolloutPercent, reason: previous.reason } : { existed: false },
			after: (row) => ({ scopeType: row.scopeType, scopeValue: row.scopeValue, enabled: row.enabled, rolloutPercent: row.rolloutPercent }),
			run: async () => {
				const [row] = await db.insert(featureFlagOverrides)
					.values({
						flagKey: key, scopeType: parsed.scopeType, scopeValue: parsed.scopeValue, enabled: parsed.enabled,
						rolloutPercent: parsed.rolloutPercent ?? null, reason: parsed.reason ?? null,
						createdBy: req.adminActor?.email ?? null,
					})
					.onConflictDoUpdate({
						target: [featureFlagOverrides.flagKey, featureFlagOverrides.scopeType, featureFlagOverrides.scopeValue],
						set: { enabled: parsed.enabled, rolloutPercent: parsed.rolloutPercent ?? null, reason: parsed.reason ?? null, updatedAt: new Date() },
					})
					.returning();
				return row;
			},
		});

		// Invalidated before the preview below, so the evaluation shown is the result of the
		// write the operator just made.
		invalidateFlagCache();
		const globalRowExists = ((await db.select({ key: featureFlags.key }).from(featureFlags).where(eq(featureFlags.key, key)).limit(1)) as unknown as Array<{ key: string }>).length > 0;
		// Only a user-scoped override has a subject the resolver can evaluate; for
		// environment/organization scopes there is nothing to hash, so no preview is invented.
		const evaluation = parsed.scopeType === 'user' ? await evaluateFlag(key, { userId: parsed.scopeValue }) : null;

		res.json({
			success: true,
			data: {
				override: {
					flagKey: key, scopeType: override.scopeType, scopeValue: override.scopeValue,
					enabled: override.enabled, rolloutPercent: override.rolloutPercent, reason: override.reason,
				},
				evaluation,
				globalRowExists,
				propagation: FLAG_PROPAGATION,
				note: evaluation
					? "The evaluation above is the resolver's real answer for this user, after the write, and shows which layer decided (source) and why (reason)."
					: 'No evaluation preview is shown because only a user-scoped override has a subject to evaluate; use GET /feature-flags/:key/evaluate with the relevant context to see the effect.',
			},
		});
	} catch (error) { next(error); }
});

const DeleteOverrideSchema = z.object({ scopeType: OverrideScopeType, scopeValue: z.string().min(1).max(100), reason: z.string().max(500).optional() }).strict();

/** `DELETE /admin/feature-flags/:key/overrides` — remove one scoped override. */
router.delete('/feature-flags/:key/overrides', requirePermission('feature_flags.write'), validate(DeleteOverrideSchema), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const key = req.params.key;
		const parsed = validatedBody<z.infer<typeof DeleteOverrideSchema>>(req);
		const outcome = await auditedOperation({
			req, action: 'feature_flag.override_delete', permission: 'feature_flags.write', targetType: 'feature_flag_override',
			targetId: `${key}:${parsed.scopeType}:${parsed.scopeValue}`,
			reason: parsed.reason ?? null,
			before: { flagKey: key, scopeType: parsed.scopeType, scopeValue: parsed.scopeValue },
			after: (result) => result,
			run: async () => {
				// All three columns, not just the flag key: deleting every override for the flag
				// would silently discard the user- and organization-scoped ones this request
				// never mentioned.
				const removed = await getDb().delete(featureFlagOverrides)
					.where(and(
						eq(featureFlagOverrides.flagKey, key),
						eq(featureFlagOverrides.scopeType, parsed.scopeType),
						eq(featureFlagOverrides.scopeValue, parsed.scopeValue),
					))
					.returning({ id: featureFlagOverrides.id });
				return { key, scopeType: parsed.scopeType, scopeValue: parsed.scopeValue, deleted: removed.length > 0 };
			},
		});
		invalidateFlagCache();
		res.json({
			success: true,
			data: {
				...outcome,
				propagation: FLAG_PROPAGATION,
				note: outcome.deleted
					? 'The scope now falls through to the next most specific layer (organization, then environment, then the global row, then the caller default).'
					: 'No override existed for that scope, so nothing changed.',
			},
		});
	} catch (error) { next(error); }
});

const EvaluateQuerySchema = z.object({
	userId: z.string().uuid().optional(),
	organizationId: z.string().uuid().optional(),
	environment: z.string().min(1).max(50).optional(),
}).strict();

/**
 * `GET /admin/feature-flags/:key/evaluate` — resolve one flag for one subject.
 *
 * This is the endpoint that proves a flag's behaviour instead of leaving an operator to
 * infer it from a row: the resolver reports which layer decided (`source`), the rollout
 * percentage in force and a sentence explaining the outcome.
 */
router.get('/feature-flags/:key/evaluate', requirePermission('feature_flags.read'), validate(EvaluateQuerySchema, 'query'), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const key = req.params.key;
		const query = validatedQuery<z.infer<typeof EvaluateQuerySchema>>(req);
		const evaluation = await evaluateFlag(key, {
			userId: query.userId ?? null,
			organizationId: query.organizationId ?? null,
			environment: query.environment ?? null,
		});
		res.json({
			success: true,
			data: {
				...evaluation,
				context: { userId: query.userId ?? null, organizationId: query.organizationId ?? null, environment: query.environment ?? actingEnvironment(req) },
				knownFlagKey: isKnownFlagKey(key),
				note: isKnownFlagKey(key)
					? 'source names the layer that decided. "default" means no row and no override exist, so the caller-supplied fallback is in force.'
					: `"${key}" is not one of the built-in flag keys. It can still be created and evaluated, but only code that asks for this exact key will observe it.`,
			},
		});
	} catch (error) { next(error); }
});

// ─── Emergency controls and maintenance ──────────────────────────────────────

/**
 * The user-visible consequence of switching each control off, and who reads it. Shown at
 * the moment of the change: "AI off" is a label, while "every chat reply stops" is the
 * decision the operator is actually making.
 */
const CONTROL_IMPACT: Record<ControlKey, { consequence: string; services: string[] }> = {
	CONTROL_AI_ENABLED: { consequence: 'Disabling AI stops every chat reply: requests are refused before a completion is attempted and no tokens are billed.', services: ['api-server', 'ai-service', 'worker'] },
	CONTROL_VOICE_ENABLED: { consequence: 'Disabling voice refuses new realtime voice sessions. Sessions already open are not terminated, but no new one can be established after one drops.', services: ['api-server', 'realtime-gateway', 'voice-api'] },
	CONTROL_STT_ENABLED: { consequence: 'Disabling STT makes the voice session reject audio with a transcription-unavailable error; text chat is unaffected.', services: ['realtime-gateway', 'voice-api'] },
	CONTROL_TTS_ENABLED: { consequence: 'Disabling TTS makes NOVA reply with text only; the mobile client falls back to on-device speech.', services: ['realtime-gateway', 'voice-api', 'mobile-client'] },
	CONTROL_REALTIME_ENABLED: { consequence: 'Disabling realtime makes the gateway refuse new WebSocket connections immediately.', services: ['realtime-gateway'] },
	CONTROL_BACKGROUND_JOBS_ENABLED: { consequence: 'Disabling background jobs makes the scheduled engines (follow-up, retention sweep, recording reaper) skip their runs until it is re-enabled; missed runs are not replayed.', services: ['worker', 'follow-up-engine', 'retention-sweep', 'recording-reaper'] },
	CONTROL_PROACTIVE_ENABLED: { consequence: 'Disabling proactive means NOVA never initiates contact — no follow-ups and no nudges — regardless of any feature flag.', services: ['worker', 'follow-up-engine', 'notification-service'] },
	CONTROL_NOTIFICATIONS_ENABLED: { consequence: 'Disabling notifications stops all outbound push and email delivery; in-app records are still written.', services: ['notification-service'] },
	CONTROL_MAINTENANCE_MODE: { consequence: 'Enabling maintenance makes clients show the maintenance message and makes the API refuse AI and voice requests with a 503. Existing sessions are not destroyed.', services: ['api-server', 'realtime-gateway', 'voice-api', 'mobile-client'] },
	CONTROL_MAINTENANCE_MESSAGE: { consequence: 'The maintenance message is the text users see while maintenance mode is active.', services: ['api-server', 'mobile-client'] },
	CONTROL_OPERATOR_NOTE: { consequence: 'The operator note is shown on the dashboard so the next operator knows why controls are set as they are.', services: ['admin-console'] },
};
const CONTROL_PROPAGATION = 'Applied in this process within the 5-second control cache; because the cache is invalidated on write, this replica observes it on its next read and other replicas converge within the same 5 seconds. The realtime gateway refuses new sockets immediately when realtime or voice is switched off.';

/** `GET /admin/controls` — current control state plus the definitions the UI renders. */
router.get('/controls', requirePermission('config.read'), async (_req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		res.json({
			success: true,
			data: {
				controls: await getRuntimeControls(),
				definitions: CONTROL_DEFINITIONS,
				notes: [
					'Controls are operational state, not configuration: a flag decides who gets a feature, a control decides whether the capability runs at all.',
					'Controls are read on the hot path and default to "on" when the store is unreachable, so a configuration outage does not itself take the platform down.',
				],
			},
		});
	} catch (error) { next(error); }
});

/**
 * `PUT /admin/controls/:key` — throw or release one emergency control.
 *
 * The route guard is `kill_switch.manage`, which covers capability keys. A
 * maintenance-scope key additionally requires `maintenance.manage`, checked inside the
 * handler because `requirePermission` is per-route and cannot express "a different
 * permission for one key". Both are held by PLATFORM_ADMIN and OPERATIONS_ADMIN today,
 * but the split is enforced rather than assumed, so a future role holding only one of
 * them cannot reach the other's keys.
 */
router.put('/controls/:key', requirePermission('kill_switch.manage'), validate(z.object({ value: z.union([z.boolean(), z.string()]), reason: z.string().min(3).max(500) }).strict()), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const key = req.params.key;
		const parsed = validatedBody<{ value: boolean | string; reason: string }>(req);
		if (!isControlKey(key)) {
			throw new HttpError(404, `Unknown control "${key}". Known controls: ${CONTROL_DEFINITIONS.map((d) => d.key).join(', ')}.`, 'UNKNOWN_CONTROL');
		}
		const definition = CONTROL_DEFINITIONS.find((candidate) => candidate.key === key) ?? null;
		if (!definition) throw new HttpError(500, `Control "${key}" is in the ControlKey type but missing from CONTROL_DEFINITIONS.`, 'CONTROL_DEFINITION_MISSING');
		if (definition.scope === 'maintenance' && !holdsPermission(req, 'maintenance.manage')) {
			throw new HttpError(403, `Forbidden — "${key}" is a maintenance-scope control and additionally requires the "maintenance.manage" permission.`, 'FORBIDDEN');
		}
		if (definition.type === 'boolean' && typeof parsed.value !== 'boolean') {
			throw new HttpError(400, `"${key}" is a boolean control; send true or false.`, 'INVALID_CONTROL_VALUE');
		}
		if (definition.type === 'string' && typeof parsed.value !== 'string') {
			throw new HttpError(400, `"${key}" is a text control; send a string.`, 'INVALID_CONTROL_VALUE');
		}
		// The schema requires a reason for every control change; for a boolean it is
		// non-negotiable, because a kill switch thrown without a recorded reason is exactly
		// the action a later review needs explained.
		if (definition.type === 'boolean' && parsed.reason.trim().length < 3) {
			throw new HttpError(400, 'A boolean control change requires a reason of at least 3 characters so the switch can be explained later.', 'REASON_REQUIRED');
		}

		const result = await auditedOperation({
			req, action: 'control.update', permission: 'kill_switch.manage', targetType: 'control', targetId: key,
			reason: parsed.reason,
			before: { key },
			after: (outcome) => ({ previous: outcome.previous, next: outcome.next }),
			run: () => setControl(key, parsed.value, req.adminActor?.email ?? null),
		});

		// `setControl` already drops the control cache; called again because the route promises
		// it and a future change to `setControl` must not break that.
		invalidateControlCache();
		const changed = result.previous !== result.next;
		const warnings: string[] = [];
		if (definition.type === 'boolean' && parsed.value === false) warnings.push(CONTROL_IMPACT[key].consequence);
		if (!changed) {
			warnings.push(`No change: "${key}" was already ${result.previous ?? 'unset'} and remains ${result.next}. The audit row records that the operator asked for the state already in force.`);
		}
		res.json({
			success: true,
			data: {
				key,
				previous: result.previous,
				next: result.next,
				changed,
				affectedServices: CONTROL_IMPACT[key].services,
				propagation: CONTROL_PROPAGATION,
				warnings,
			},
		});
	} catch (error) { next(error); }
});

const MaintenanceSchema = z.object({ enabled: z.boolean(), message: z.string().max(500).optional(), note: z.string().max(500).optional(), reason: z.string().min(3).max(500) }).strict();

/** `PUT /admin/maintenance` — the one-button maintenance switch plus its message. */
router.put('/maintenance', requirePermission('maintenance.manage'), validate(MaintenanceSchema), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const parsed = validatedBody<z.infer<typeof MaintenanceSchema>>(req);
		const changes: Array<{ key: ControlKey; value: string | boolean }> = [{ key: 'CONTROL_MAINTENANCE_MODE', value: parsed.enabled }];
		if (parsed.message !== undefined) changes.push({ key: 'CONTROL_MAINTENANCE_MESSAGE', value: parsed.message });
		if (parsed.note !== undefined) changes.push({ key: 'CONTROL_OPERATOR_NOTE', value: parsed.note });

		// One audit row per changed key rather than one row covering three writes: "who changed
		// the maintenance message, and when" must be answerable without reading a difference
		// between two composite snapshots.
		const results: Array<{ key: ControlKey; previous: string | null; next: string }> = [];
		for (const change of changes) {
			const outcome = await auditedOperation({
				req, action: 'maintenance.update', permission: 'maintenance.manage', targetType: 'control', targetId: change.key,
				reason: parsed.reason,
				before: { key: change.key },
				after: (result) => ({ previous: result.previous, next: result.next }),
				run: () => setControl(change.key, change.value, req.adminActor?.email ?? null),
			});
			results.push({ key: outcome.key, previous: outcome.previous, next: outcome.next });
		}
		invalidateControlCache();
		res.json({
			success: true,
			data: {
				controls: await getRuntimeControls(),
				changes: results,
				warnings: parsed.enabled
					? ['Maintenance mode is ON: clients will show the maintenance message and the API refuses AI and voice requests with 503. Remember to turn it off when the work is done.']
					: [],
				propagation: CONTROL_PROPAGATION,
			},
		});
	} catch (error) { next(error); }
});

// ─── Environment, services, database, logs and traces ────────────────────────

/** `GET /admin/environment` — where this console is pointed, and what to distrust. */
router.get('/environment', requirePermission('config.read'), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		// Guarded: a database that cannot answer statistics must not blank the whole panel —
		// this is the screen an operator opens during an incident. The failure is reported as
		// `database: null` plus a warning.
		const database = await getDatabaseHealth().catch(() => null);
		const migrations = await getMigrationStatus();
		const storeReady = secretStoreReady();

		const warnings: string[] = [];
		// A production console must be impossible to mistake for a development one.
		warnings.push(process.env.NODE_ENV === 'production'
			? 'NODE_ENV is "production": this console is talking to the production deployment. Every change made here affects real users immediately, with no staging step in between.'
			: `NODE_ENV is "${process.env.NODE_ENV ?? 'unset'}", so this is NOT the production deployment. Changes made here do not affect production.`);
		if (!storeReady) warnings.push(secretStoreNote());
		if (!database) warnings.push('Database statistics could not be read, so the database panel is empty. The API may still be serving traffic — this check is not a liveness probe.');
		if (migrations.state === 'unknown') warnings.push('Migration status could not be read from drizzle.__drizzle_migrations, so the applied-migration count is unknown rather than zero.');

		res.json({
			success: true,
			data: {
				environment: actingEnvironment(req),
				nodeEnv: process.env.NODE_ENV ?? null,
				self: getSelfMetrics(),
				services: discoverServiceTargets(),
				database,
				migrations,
				secretStore: { ready: storeReady },
				warnings,
			},
		});
	} catch (error) { next(error); }
});

/** `GET /admin/database/health` — read-only operational views, and what is missing. */
router.get('/database/health', requirePermission('services.read'), async (_req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const [database, slowQueries, migrations] = await Promise.all([getDatabaseHealth(), getSlowQueries(), getMigrationStatus()]);
		res.json({
			success: true,
			data: {
				database,
				slowQueries,
				migrations,
				notes: [
					'A SQL console is deliberately not provided. This API connects as a role that can read and write application data, so exposing arbitrary SQL through an authenticated web form would let any holder of services.read mutate or drop production data, bypassing the audit trail every other admin route writes. The views above are the safe subset.',
					'"Slow queries" comes from pg_stat_activity: it shows the SQL text of other sessions (truncated to 500 characters in admin/system.ts). It is a live snapshot of currently running statements, not a historical slow-query log — PostgreSQL keeps history only when log_min_duration_statement is configured in the deployment, which this repository does not control.',
					'Backup status is not available: no backup system is integrated with this repository, so the console cannot report the last successful backup, its size, or offer a restore. That information lives in the deployment platform and must be checked there.',
					'Migration status is read from drizzle.__drizzle_migrations and reports "unknown" rather than 0 when that table cannot be read.',
				],
			},
		});
	} catch (error) { next(error); }
});

/** `GET /admin/services` — service and dependency health without forcing provider spend. */
router.get('/services', requirePermission('services.read'), async (_req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		// runTests:false uses recorded provider history, so opening this page does not bill a
		// provider or spend a rate-limit slot; POST /config/test/:provider and
		// POST /providers/test-all force fresh tests.
		res.json({ success: true, data: await listServiceHealth({ runTests: false }) });
	} catch (error) { next(error); }
});

/**
 * `GET /admin/logs` — the durable log store, queryable.
 *
 * This route used to answer `available: false` with a precise explanation: the API wrote pino JSON
 * to stdout, nothing persisted it, and a search would have had to invent its results. That response
 * also named the fix — *"wire a sink to the pino stream and add a query route over it"* — and this
 * is the query half; `utils/log-sink.ts` is the other.
 *
 * ## What it can and cannot see
 *
 * `available` is now `true`, and the response says plainly what the store contains so an empty result
 * is never read as "nothing happened": only entries at or above `LOG_SINK_LEVEL` (default `warn`) are
 * persisted, so a quiet-looking window means no warnings — not no requests. `info` and `debug` lines
 * exist in the process's stdout and nowhere in this table.
 *
 * The level in force, the retention window and the sink's drop counter all travel with the response,
 * because each of them changes how a reader should interpret the rows.
 */
const LogQuerySchema = z.object({
	level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
	service: z.string().max(50).optional(),
	q: z.string().max(200).optional(),
	requestId: z.string().max(100).optional(),
	userId: z.string().max(100).optional(),
	from: z.string().datetime().optional(),
	to: z.string().datetime().optional(),
	page: z.coerce.number().int().min(1).default(1),
	pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

router.get(
	'/logs',
	requirePermission('logs.read'),
	validate(LogQuerySchema, 'query'),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: z.infer<typeof LogQuerySchema> }).validatedQuery;
			const pool = getDbPool();
			const offset = (q.page - 1) * q.pageSize;

			const conditions: string[] = [];
			const params: unknown[] = [];
			if (q.level) {
				params.push(q.level);
				// At or above the requested level. `error` in a log viewer means "errors", not a
				// literal string match that hides `fatal` beside it.
				//
				// Expressed with `array_position` over the level order rather than a CASE ladder or a
				// database function: Postgres has no notion of pino's severity order, and one shared
				// literal is easier to keep in step with `log-sink.ts` than a second definition.
				conditions.push(
					`array_position(ARRAY['trace','debug','info','warn','error','fatal'], level) >= array_position(ARRAY['trace','debug','info','warn','error','fatal'], $${params.length})`,
				);
			}
			if (q.service) {
				params.push(q.service);
				conditions.push(`service = $${params.length}`);
			}
			if (q.requestId) {
				params.push(q.requestId);
				conditions.push(`request_id = $${params.length}`);
			}
			if (q.userId) {
				params.push(q.userId);
				conditions.push(`user_id = $${params.length}`);
			}
			if (q.from) {
				params.push(q.from);
				conditions.push(`occurred_at >= $${params.length}`);
			}
			if (q.to) {
				params.push(q.to);
				conditions.push(`occurred_at <= $${params.length}`);
			}
			if (q.q) {
				params.push(`%${q.q.toLowerCase()}%`);
				const p = `$${params.length}`;
				conditions.push(
					`(lower(coalesce(msg, '')) LIKE ${p} OR lower(coalesce(error_message, '')) LIKE ${p} OR lower(coalesce(error_type, '')) LIKE ${p} OR lower(coalesce(route, '')) LIKE ${p} OR lower(coalesce(stack, '')) LIKE ${p})`,
				);
			}
			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

			const [totals, rows, levels, services] = await Promise.all([
				pool.query<{ total: string }>(`SELECT count(*)::int AS total FROM service_logs ${where}`, params),
				pool.query(
					`SELECT id, occurred_at, level, service, msg, request_id, user_id, route, method,
					        status_code, duration_ms, error_type, error_message, stack, context
					 FROM service_logs ${where}
					 ORDER BY occurred_at DESC, id DESC
					 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
					[...params, q.pageSize, offset],
				),
				// Tally over the whole store, not the filtered page: "no errors in this window" and
				// "no errors at all" are different statements and the console shows both.
				pool.query<{ level: string; count: string }>(
					`SELECT level, count(*)::int AS count FROM service_logs GROUP BY level`,
				),
				pool.query<{ service: string; count: string }>(
					`SELECT service, count(*)::int AS count FROM service_logs GROUP BY service ORDER BY count DESC LIMIT 10`,
				),
			]);

			const totalItems = Number(totals.rows[0]?.total ?? 0);
			const sink = getLogSink();

			res.json({
				success: true,
				data: {
					available: true,
					// Stated rather than implied: the console prints these beside the table.
					level: sinkLevel(),
					retentionDays: retentionDays(),
					droppedSinceBoot: sink.droppedCount,
					failedFlushes: sink.failureCount,
					pendingRows: sink.pending,
					rows: rows.rows.map((row: Record<string, unknown>) => ({
						id: String(row.id),
						occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
						level: row.level,
						service: row.service,
						msg: row.msg,
						requestId: row.request_id,
						userId: row.user_id,
						route: row.route,
						method: row.method,
						statusCode: row.status_code,
						durationMs: row.duration_ms,
						errorType: row.error_type,
						errorMessage: row.error_message,
						stack: row.stack,
						context: row.context,
					})),
					totalItems,
					page: q.page,
					pageSize: q.pageSize,
					totalPages: Math.max(1, Math.ceil(totalItems / q.pageSize)),
					byLevel: levels.rows.map((row) => ({ level: row.level, count: Number(row.count) })),
					byService: services.rows.map((row) => ({ service: row.service, count: Number(row.count) })),
					notes: [
						`Only entries at ${sinkLevel()} and above are persisted (LOG_SINK_LEVEL). A quiet window means no warnings or errors, not no requests: info and debug lines are written to the service's stdout and are not in this table.`,
						`Rows are deleted after ${retentionDays()} days (LOG_RETENTION_DAYS), so this is a troubleshooting window rather than an archive.`,
						'The sink batches in memory and drops the oldest entries if the database cannot keep up. A drop is recorded as a row of its own naming the count, so a gap is visible rather than silent.',
						'Redaction happens in the logger before the sink sees a line, so a token, password or apiKey field arrives here as [redacted] and never as the value.',
					],
				},
			});
		} catch (error) { next(error); }
	},
);

type AuditTraceRow = { id: string; action: string; actor_email: string | null; target_type: string | null; target_id: string | null; outcome: string; reason: string | null; request_id: string | null; trace_id: string | null; occurred_at: Date };
type JobTraceRow = { id: string; job_name: string; queue_name: string | null; status: string; attempt: number; error_message: string | null; duration_ms: number | null; request_id: string | null; created_at: Date };
type ToolTraceRow = { id: string; tool_id: string; success: boolean; error_code: string | null; error_message: string | null; duration_ms: number | null; request_id: string; created_at: Date };
type LogTraceRow = { id: string; level: string; msg: string | null; error_type: string | null; error_message: string | null; route: string | null; status_code: number | null; occurred_at: Date };
type TraceEvent = { timestamp: string; source: 'admin_audit_logs' | 'job_executions' | 'tool_executions' | 'service_logs'; correlation: 'request_id' | 'trace_id'; summary: string; detail: Record<string, unknown> };
const TRACE_ROW_LIMIT = 200;

/**
 * `GET /admin/traces/:traceId` — correlation lookup over the ids that actually exist.
 *
 * `available` is always false and that is deliberate: no OpenTelemetry spans are emitted
 * anywhere in this stack, so the rows below are independent records that share an id, not
 * a causal chain. Reporting `available: true` because some rows matched would tell an
 * operator the trace is complete when the AI call, the database queries, the notification
 * send and the realtime frames are not represented at all.
 */
router.get('/traces/:traceId', requirePermission('traces.read'), async (req: AdminRequest, res: Response, next: NextFunction) => {
	try {
		const traceId = req.params.traceId;
		// `auditedOperation` is used for a read because it is the one place that records success
		// *and* failure with the actor: a trace lookup touches operational history, so "who
		// looked up this id" belongs in the audit log too.
		const outcome = await auditedOperation({
			req, action: 'logs.trace_read', permission: 'traces.read', targetType: 'trace', targetId: traceId,
			before: { traceId },
			after: (result) => ({ counts: result.counts, returned: result.timeline.length }),
			run: async () => {
				// Parameterised ($1): the id comes from the URL path.
				const pool = getDbPool();
				const [audit, jobs, tools, logs] = await Promise.all([
					pool.query<AuditTraceRow>(
						`SELECT id::text AS id, action, actor_email, target_type, target_id, outcome, reason, request_id, trace_id, occurred_at FROM admin_audit_logs WHERE request_id = $1 OR trace_id = $1 ORDER BY occurred_at ASC LIMIT ${TRACE_ROW_LIMIT}`,
						[traceId],
					),
					// payload/result are deliberately not selected: they can hold user content and,
					// for a job wrapping an API call, credentials. A trace view must not become a
					// data-exfiltration path.
					pool.query<JobTraceRow>(
						`SELECT id::text AS id, job_name, queue_name, status, attempt, error_message, duration_ms, request_id, created_at FROM job_executions WHERE request_id = $1 ORDER BY created_at ASC LIMIT ${TRACE_ROW_LIMIT}`,
						[traceId],
					),
					// Same reason: tool_executions.input/output are not selected.
					pool.query<ToolTraceRow>(
						`SELECT id::text AS id, tool_id::text AS tool_id, success, error_code, error_message, duration_ms, request_id, created_at FROM tool_executions WHERE request_id = $1 ORDER BY created_at ASC LIMIT ${TRACE_ROW_LIMIT}`,
						[traceId],
					),
					// The durable log lines for this id. This is the source that makes the timeline
					// useful for a *failed* request: the three tables above record what the platform
					// chose to do, and this records what it said while doing it.
					pool.query<LogTraceRow>(
						`SELECT id::text AS id, level, msg, error_type, error_message, route, status_code, occurred_at FROM service_logs WHERE request_id = $1 ORDER BY occurred_at ASC LIMIT ${TRACE_ROW_LIMIT}`,
						[traceId],
					),
				]);

				const timeline: TraceEvent[] = [
					...audit.rows.map((row): TraceEvent => ({
						timestamp: row.occurred_at.toISOString(),
						source: 'admin_audit_logs',
						correlation: row.request_id === traceId ? 'request_id' : 'trace_id',
						summary: `${row.action} → ${row.outcome}${row.target_type ? ` (${row.target_type}${row.target_id ? `:${row.target_id}` : ''})` : ''}`,
						detail: { actor: row.actor_email, reason: row.reason, requestId: row.request_id, traceId: row.trace_id },
					})),
					...jobs.rows.map((row): TraceEvent => ({
						timestamp: row.created_at.toISOString(),
						source: 'job_executions',
						correlation: 'request_id',
						summary: `${row.job_name} → ${row.status} (attempt ${row.attempt})`,
						detail: { queue: row.queue_name, errorMessage: row.error_message, durationMs: row.duration_ms, requestId: row.request_id },
					})),
					...tools.rows.map((row): TraceEvent => ({
						timestamp: row.created_at.toISOString(),
						source: 'tool_executions',
						correlation: 'request_id',
						summary: `tool ${row.tool_id} → ${row.success ? 'success' : 'failure'}${row.error_code ? ` (${row.error_code})` : ''}`,
						detail: { errorMessage: row.error_message, durationMs: row.duration_ms, requestId: row.request_id },
					})),
					...logs.rows.map((row): TraceEvent => ({
						timestamp: row.occurred_at.toISOString(),
						source: 'service_logs',
						correlation: 'request_id',
						summary: `${row.level.toUpperCase()} ${row.msg ?? ''}${row.error_type ? ` — ${row.error_type}` : ''}`.trim(),
						detail: { route: row.route, statusCode: row.status_code, errorMessage: row.error_message },
					})),
				].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

				return {
					timeline,
					counts: {
						adminAuditLogs: audit.rows.length,
						jobExecutions: jobs.rows.length,
						toolExecutions: tools.rows.length,
						serviceLogs: logs.rows.length,
					},
					truncated:
						audit.rows.length >= TRACE_ROW_LIMIT ||
						jobs.rows.length >= TRACE_ROW_LIMIT ||
						tools.rows.length >= TRACE_ROW_LIMIT ||
						logs.rows.length >= TRACE_ROW_LIMIT,
				};
			},
		});

		res.json({
			success: true,
			data: {
				traceId,
				available: false,
				found: outcome.timeline.length > 0,
				correlatedEvents: outcome.timeline.length,
				reason: 'No OpenTelemetry spans are emitted anywhere in this stack and there is no span store. The only correlation that exists is the request/trace id written onto admin audit rows, job executions, tool executions and the durable log, so this is a set of independent records sharing an id — sorted by time, but not a causal chain. The AI provider call, the individual database queries, the notification send and the realtime frames are not represented at all and cannot be reconstructed from this data.',
				note: 'To make this a real trace, instrument the API with an OpenTelemetry SDK, export spans to a collector (OTLP, Tempo or Jaeger) and propagate the trace context through the realtime gateway, the worker and the AI transport. The request_id/trace_id columns already on these tables would then become the join key between records and spans. Until then, absence of an event here is not evidence the work did not happen — a process that never received the id writes no row.',
				timeline: outcome.timeline,
				counts: outcome.counts,
				truncated: outcome.truncated,
				limitations: [
					'No spans: the timeline is assembled from three tables, not from a causal chain, so ordering is by timestamp only.',
					'tool_executions.input/output and job_executions.payload/result are deliberately excluded — they can contain user content and credentials.',
					'Only correlation ids are searched: request_id across all three tables, plus trace_id on admin_audit_logs. Session, user and conversation ids are not joined here.',
					`Each source is capped at ${TRACE_ROW_LIMIT} rows; the "truncated" flag says whether a cap was reached.`,
				],
			},
		});
	} catch (error) { next(error); }
});

/**
 * `GET /control/audit-logs`
 *
 * The append-only record of privileged admin actions, including refusals.
 *
 * This is a different table from `audit_logs`, which records what *users* and the
 * platform did. `admin_audit_logs` records what *operators* did to the platform, and a
 * BEFORE UPDATE/DELETE trigger installed by migration 0006 makes it genuinely
 * tamper-resistant: the database refuses the write rather than the application merely
 * declining to issue one.
 *
 * Filtering is server-side and paginated; the table grows without bound by design (it
 * cannot be pruned), so nothing here loads it whole.
 */
/**
 * `GET /control/audit-logs/export` — a CSV copy of the audit log.
 *
 * The implementation notes, the row cap and the CSV-injection handling live in
 * `admin/audit-export.ts`. What belongs here is the ordering: the audit row is written **before**
 * the data is read, so a failed or abandoned export is still recorded — "who asked for a copy" is
 * the security-relevant fact, and it must not depend on the copy succeeding.
 *
 * Responds with `text/csv` rather than the API's usual JSON envelope, because the whole point is a
 * file. The parameterised filters are the same ones the listing validates, so an operator exports
 * what they were looking at rather than the entire table by default.
 */
router.get(
	'/audit-logs/export',
	requirePermission('audit.export'),
	validate(
		z.object({
			action: z.string().max(100).optional(),
			actorId: z.string().max(100).optional(),
			outcome: z.enum(['success', 'failure', 'denied']).optional(),
			targetType: z.string().max(50).optional(),
			search: z.string().max(200).optional(),
			from: z.string().datetime().optional(),
			to: z.string().datetime().optional(),
		}),
		'query',
	),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as { validatedQuery: Record<string, string | undefined> }).validatedQuery;
			const pool = getDbPool();

			// Recorded first, and awaited, so the audit log contains the request even if the read
			// below fails. The row states the filters rather than the row count: the count is not
			// known yet, and inventing it would be worse than omitting it.
			await auditedOperation({
				req,
				action: 'audit_log.export',
				permission: 'audit.export',
				targetType: 'admin_audit_logs',
				targetId: null,
				reason: 'Exported the administrator audit log',
				before: { filters: q },
				run: async () => ({ requestedAt: new Date().toISOString() }),
			});

			const params: unknown[] = [];
			const conditions = auditExportConditions(q, params);
			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

			// `LIMIT max + 1` so the response can say whether the cap was reached without a second
			// count query — one row too many is the cheapest possible "there is more".
			const { rows } = await pool.query<AuditExportRow>(
				`SELECT occurred_at, action, outcome, actor_email, actor_role, permission,
				        target_type, target_id, reason, request_id, ip_address, user_agent,
				        before, after
				 FROM admin_audit_logs
				 ${where}
				 ORDER BY occurred_at DESC
				 LIMIT $${params.length + 1}`,
				[...params, AUDIT_EXPORT_MAX_ROWS + 1],
			);

			const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS;
			const exported = truncated ? rows.slice(0, AUDIT_EXPORT_MAX_ROWS) : rows;

			res.setHeader('Content-Type', 'text/csv; charset=utf-8');
			res.setHeader(
				'Content-Disposition',
				`attachment; filename="${auditExportFilename()}"`,
			);
			// Both facts travel in headers as well as the body, because a client that streams the
			// file to disk never renders a body note.
			res.setHeader('X-Nova-Export-Rows', String(exported.length));
			res.setHeader('X-Nova-Export-Truncated', truncated ? 'true' : 'false');
			res.send(toCsv(exported));
		} catch (error) {
			next(error);
		}
	},
);

router.get(
	'/audit-logs',
	requirePermission('audit.read'),
	validate(
		z.object({
			page: z.coerce.number().int().positive().default(1),
			pageSize: z.coerce.number().int().min(1).max(200).default(50),
			action: z.string().max(100).optional(),
			actorId: z.string().max(100).optional(),
			outcome: z.enum(['success', 'failure', 'denied']).optional(),
			targetType: z.string().max(50).optional(),
			search: z.string().max(200).optional(),
			from: z.string().datetime().optional(),
			to: z.string().datetime().optional(),
		}),
		'query',
	),
	async (req: AdminRequest, res: Response, next: NextFunction) => {
		try {
			const q = (req as unknown as {
				validatedQuery: {
					page: number;
					pageSize: number;
					action?: string;
					actorId?: string;
					outcome?: 'success' | 'failure' | 'denied';
					targetType?: string;
					search?: string;
					from?: string;
					to?: string;
				};
			}).validatedQuery;

			const pool = getDbPool();
			const offset = (q.page - 1) * q.pageSize;
			const conditions: string[] = [];
			const params: unknown[] = [];

			if (q.action) {
				params.push(q.action);
				conditions.push(`action = $${params.length}`);
			}
			if (q.actorId) {
				params.push(q.actorId);
				conditions.push(`actor_id = $${params.length}`);
			}
			if (q.outcome) {
				params.push(q.outcome);
				conditions.push(`outcome = $${params.length}`);
			}
			if (q.targetType) {
				params.push(q.targetType);
				conditions.push(`target_type = $${params.length}`);
			}
			if (q.from) {
				params.push(q.from);
				conditions.push(`occurred_at >= $${params.length}`);
			}
			if (q.to) {
				params.push(q.to);
				conditions.push(`occurred_at <= $${params.length}`);
			}
			if (q.search) {
				params.push(`%${q.search.toLowerCase()}%`);
				conditions.push(
					`(lower(coalesce(actor_email, '')) LIKE $${params.length} OR lower(action) LIKE $${params.length} OR lower(coalesce(target_id, '')) LIKE $${params.length})`,
				);
			}

			const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

			const countResult = await pool.query<{ total: string }>(
				`SELECT count(*)::int AS total FROM admin_audit_logs ${where}`,
				params,
			);
			const totalItems = Number(countResult.rows[0]?.total ?? 0);

			const rows = await pool.query(
				`SELECT id, actor_id, actor_email, actor_role, action, permission, target_type, target_id,
				        outcome, reason, before, after, request_id, ip_address, user_agent, trace_id, occurred_at
				 FROM admin_audit_logs
				 ${where}
				 ORDER BY occurred_at DESC
				 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
				[...params, q.pageSize, offset],
			);

			const outcomes = await pool.query<{ outcome: string; count: string }>(
				`SELECT outcome, count(*)::int AS count FROM admin_audit_logs GROUP BY outcome`,
			);
			const topActions = await pool.query<{ action: string; count: string }>(
				`SELECT action, count(*)::int AS count FROM admin_audit_logs GROUP BY action ORDER BY count DESC LIMIT 20`,
			);

			res.json({
				success: true,
				data: {
					data: rows.rows,
					page: q.page,
					pageSize: q.pageSize,
					totalItems,
					totalPages: Math.ceil(totalItems / q.pageSize) || 1,
					outcomes: outcomes.rows,
					topActions: topActions.rows,
					notes: [
						'This table is append-only: a database trigger rejects UPDATE and DELETE, so these rows cannot be edited even with direct database access.',
						'Refused attempts are recorded with outcome "denied", which is how an over-reaching or compromised admin account becomes visible.',
						'`before`/`after` snapshots are passed through a redactor that replaces any secret-shaped field with [REDACTED] before the row is written, so a credential cannot end up here.',
					],
				},
			});
		} catch (error) { next(error); }
	},
);

export default router;
