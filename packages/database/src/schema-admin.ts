/**
 * NOVA — Admin Control Center schema.
 *
 * These tables back the operational control plane. They are deliberately kept in
 * their own module (re-exported from `./schema.js`) so the platform tables in
 * `schema.ts` stay readable.
 *
 * Design notes that matter:
 *
 * - `admin_audit_logs` is **append-only in practice**. It does not reference
 *   `users` with a cascade, and it stores the actor's email/role at the time of
 *   the action so a later role change or account deletion cannot rewrite history.
 *   A trigger installed by the matching migration rejects UPDATE and DELETE, which
 *   is what makes the log tamper-resistant rather than merely "we promise not to".
 *
 * - `system_configs.secret_ciphertext` holds AES-256-GCM output. The plaintext
 *   never reaches the database and is never returned by any API. Only the last
 *   four characters (`secret_hint`) are readable.
 *
 * - `feature_flag_overrides` is what makes flags actually control behaviour:
 *   environment- and user-scoped overrides resolve ahead of the global row in
 *   `feature_flags`.
 */
import {
	pgTable,
	uuid,
	text,
	varchar,
	boolean,
	integer,
	bigint,
	bigserial,
	timestamp,
	jsonb,
	index,
	uniqueIndex,
	unique,
} from 'drizzle-orm/pg-core';
// NOTE: this module deliberately imports **nothing**. It is consumed by two very
// different loaders:
//
//   - `tsc` → Node ESM, which requires an explicit `.js` extension on relative
//     specifiers;
//   - `drizzle-kit generate` → CommonJS `require`, which cannot resolve that
//     `.js` specifier against the TypeScript sources.
//
// A `./schema.js` import satisfies the first and breaks the second; `./schema`
// does the reverse. Rather than pin this file to one loader, the foreign keys to
// `users` and `organizations` are declared with raw SQL in the generated
// migration — which is also where the append-only trigger and the CHECK
// constraints live. Keeping this module dependency-free is what lets the same
// source drive both the type checker and the migration generator.

// ─── Admin audit log (append-only) ──────────────────────────────

export const adminAuditLogs = pgTable(
	'admin_audit_logs',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		// Actor identity is denormalised on purpose: the log must survive the
		// admin's account being deleted, and it must show what role they held
		// when they acted, not what role they hold now.
		actorId: varchar('actor_id', { length: 100 }),
		actorEmail: varchar('actor_email', { length: 255 }),
		actorRole: varchar('actor_role', { length: 50 }),
		// Machine-readable action, e.g. `feature_flag.update`, `user.suspend`.
		action: varchar('action', { length: 100 }).notNull(),
		// The permission that authorised this action, e.g. `feature_flags.write`.
		permission: varchar('permission', { length: 100 }),
		targetType: varchar('target_type', { length: 50 }),
		targetId: varchar('target_id', { length: 255 }),
		// 'success' | 'failure' | 'denied'
		outcome: varchar('outcome', { length: 50 }).notNull(),
		reason: text('reason'),
		// Redacted before/after snapshots. Secret values are replaced with a mask
		// by `redact()` before they ever reach this column.
		before: jsonb('before').default({}),
		after: jsonb('after').default({}),
		requestId: varchar('request_id', { length: 100 }),
		ipAddress: varchar('ip_address', { length: 45 }),
		userAgent: text('user_agent'),
		// Correlation id so an admin action can be traced through services.
		traceId: varchar('trace_id', { length: 100 }),
		occurredAt: timestamp('occurred_at').defaultNow().notNull(),
	},
	(table) => [
		index('admin_audit_occurred_idx').on(table.occurredAt),
		index('admin_audit_actor_idx').on(table.actorId),
		index('admin_audit_action_idx').on(table.action),
		index('admin_audit_target_idx').on(table.targetType, table.targetId),
	],
);

// ─── Runtime configuration + secrets ────────────────────────────

export const systemConfigs = pgTable(
	'system_configs',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		// The exact environment-variable / config key name, e.g. `AI_DEFAULT_MODEL`.
		key: varchar('key', { length: 150 }).notNull(),
		// 'public' | 'private' | 'secret'
		scope: varchar('scope', { length: 20 }).notNull().default('private'),
		category: varchar('category', { length: 50 }).notNull().default('general'),
		// Plaintext value for public/private settings. NULL for secrets.
		value: text('value'),
		// AES-256-GCM payload for secrets. Format: v1:<iv>:<tag>:<ciphertext>.
		secretCiphertext: text('secret_ciphertext'),
		// Last 4 characters of a secret, for "is this the key I think it is".
		secretHint: varchar('secret_hint', { length: 12 }),
		// 'env' when the effective value comes from the process environment,
		// 'database' when an operator has overridden it at runtime.
		source: varchar('source', { length: 20 }).notNull().default('database'),
		valueType: varchar('value_type', { length: 20 }).notNull().default('string'),
		description: text('description'),
		// Which services read this key. Drives the "impact" panel before a change.
		usedBy: jsonb('used_by').default([]),
		// True when the owning process must restart to pick the new value up.
		restartRequired: boolean('restart_required').notNull().default(false),
		// True when a change can be hot-applied (config cache invalidation).
		hotReloadable: boolean('hot_reloadable').notNull().default(true),
		// Declaration order for the UI; lower sorts first.
		displayOrder: integer('display_order').default(0).notNull(),
		updatedBy: varchar('updated_by', { length: 100 }),
		lastTestedAt: timestamp('last_tested_at'),
		lastTestStatus: varchar('last_test_status', { length: 20 }),
		lastTestMessage: text('last_test_message'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
	},
	(table) => [
		unique('system_configs_key_unique').on(table.key),
		index('system_configs_scope_idx').on(table.scope),
		index('system_configs_category_idx').on(table.category),
	],
);

// ─── Feature flag overrides ─────────────────────────────────────

export const featureFlagOverrides = pgTable(
	'feature_flag_overrides',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		flagKey: varchar('flag_key', { length: 100 }).notNull(),
		// 'environment' | 'user' | 'organization'
		scopeType: varchar('scope_type', { length: 20 }).notNull(),
		// 'production' | 'staging' | 'development' | 'local', or a user/org uuid.
		scopeValue: varchar('scope_value', { length: 100 }).notNull(),
		enabled: boolean('enabled').notNull(),
		// Overrides the global rollout percentage when present.
		rolloutPercent: integer('rollout_percent'),
		reason: text('reason'),
		createdBy: varchar('created_by', { length: 100 }),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex('feature_flag_overrides_unique').on(
			table.flagKey,
			table.scopeType,
			table.scopeValue,
		),
		index('feature_flag_overrides_key_idx').on(table.flagKey),
	],
);

// ─── Provider health snapshots ──────────────────────────────────

export const providerHealthChecks = pgTable(
	'provider_health_checks',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		// 'anthropic' | 'deepgram' | 'elevenlabs' | 'sarvam' | 'postgres' | ...
		provider: varchar('provider', { length: 50 }).notNull(),
		// 'ai' | 'stt' | 'tts' | 'storage' | 'database' | 'payments' | 'push'
		kind: varchar('kind', { length: 30 }).notNull(),
		// 'pass' | 'fail' | 'degraded' | 'not_configured'
		status: varchar('status', { length: 20 }).notNull(),
		latencyMs: integer('latency_ms'),
		message: text('message'),
		trigger: varchar('trigger', { length: 20 }).notNull().default('manual'),
		checkedBy: varchar('checked_by', { length: 100 }),
		/**
		 * Fingerprint of the credential value this test exercised.
		 *
		 * The check records *what was tested*; the config row holds what is stored now. Staleness is
		 * the comparison, computed on read — see `drizzle/0012_provider_check_fingerprint.sql` for
		 * the two misleading states this closes. `NULL` means no credential was involved (PostgreSQL,
		 * Redis, an unset Stripe key), which is not the same as stale.
		 */
		secretFingerprint: varchar('secret_fingerprint', { length: 64 }),
		checkedAt: timestamp('checked_at').defaultNow().notNull(),
	},
	(table) => [
		index('provider_health_provider_idx').on(table.provider, table.checkedAt),
	],
);

// ─── Background job executions ──────────────────────────────────

export const jobExecutions = pgTable(
	'job_executions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		// Logical job/queue name, e.g. `follow-up-engine`, `recording-reaper`.
		jobName: varchar('job_name', { length: 100 }).notNull(),
		queueName: varchar('queue_name', { length: 100 }),
		workerId: varchar('worker_id', { length: 100 }),
		// 'queued' | 'running' | 'succeeded' | 'failed' | 'dead_letter' | 'cancelled'
		status: varchar('status', { length: 20 }).notNull(),
		// FK to users/organizations is declared in the migration (see module note).
		userId: uuid('user_id'),
		organizationId: uuid('organization_id'),
		relatedType: varchar('related_type', { length: 50 }),
		relatedId: varchar('related_id', { length: 100 }),
		attempt: integer('attempt').default(1).notNull(),
		maxAttempts: integer('max_attempts').default(3).notNull(),
		payload: jsonb('payload').default({}),
		result: jsonb('result').default({}),
		errorMessage: text('error_message'),
		durationMs: integer('duration_ms'),
		requestId: varchar('request_id', { length: 100 }),
		startedAt: timestamp('started_at'),
		finishedAt: timestamp('finished_at'),
		/**
		 * When the row becomes claimable.
		 *
		 * A retry backoff and a scheduled job are the same thing expressed here, which is what lets the
		 * in-process engines move onto this queue. See `drizzle/0015_job_queue.sql`.
		 */
		runAt: timestamp('run_at').defaultNow().notNull(),
		/** Who enqueued it. A console-triggered retry is a privileged action and is attributable. */
		enqueuedBy: varchar('enqueued_by', { length: 100 }),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		index('job_executions_claim_idx').on(table.status, table.runAt),
		index('job_executions_name_created_idx').on(table.jobName, table.createdAt),
		index('job_executions_status_idx').on(table.status),
		index('job_executions_user_idx').on(table.userId),
	],
);

// ─── Admin sessions ─────────────────────────────────────────────

/**
 * An admin console session, distinct from a mobile `sessions` row.
 *
 * Admin sessions are tracked separately so that "force logout" on the admin side
 * cannot touch a user's phone, and so security reporting can answer "who is in the
 * control plane right now" without filtering a million mobile sessions.
 */
export const adminSessions = pgTable(
	'admin_sessions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		// FK to users is declared in the migration (see module note).
		userId: uuid('user_id').notNull(),
		jti: varchar('jti', { length: 100 }).notNull(),
		role: varchar('role', { length: 50 }).notNull(),
		ipAddress: varchar('ip_address', { length: 45 }),
		userAgent: text('user_agent'),
		expiresAt: timestamp('expires_at').notNull(),
		revokedAt: timestamp('revoked_at'),
		lastSeenAt: timestamp('last_seen_at').defaultNow().notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
	},
	(table) => [
		unique('admin_sessions_jti_unique').on(table.jti),
		index('admin_sessions_user_idx').on(table.userId),
		index('admin_sessions_expires_idx').on(table.expiresAt),
	],
);

// ─── Platform admin role grants ─────────────────────────────────

/**
 * Platform-level operator role grants.
 *
 * Deliberately **not** `roles` + `role_bindings`. Those model *tenant* roles:
 * `roles.organization_id` is `NOT NULL` and uniqueness is per organization, so a platform
 * operator — who acts on the whole platform rather than inside one tenant — does not fit.
 * Reusing them would have meant inventing an organization called "platform", which the next
 * reader has to decode before they can trust the table.
 *
 * One row per account: a second grant replaces the first, so "what can this person do" is
 * answerable from one row. The permission set is computed from the same role matrix the JWT
 * claim path uses, so there is a single definition of what a role means.
 *
 * `granted_by` records the operator who assigned it and `reason` why — a role that grants
 * every other permission must be explicable after the fact.
 */
export const platformAdminRoles = pgTable(
	'platform_admin_roles',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		// One grant per account; the unique constraint is what makes "replace" safe.
		userId: uuid('user_id').notNull().unique(),
		// 'SUPER_ADMIN' | 'PLATFORM_ADMIN' | 'SUPPORT_ADMIN' | ... (admin/permissions.ts)
		role: varchar('role', { length: 50 }).notNull(),
		// Denormalised so the audit value survives the granter's account being deleted.
		grantedBy: varchar('granted_by', { length: 100 }),
		grantedByEmail: varchar('granted_by_email', { length: 255 }),
		reason: text('reason'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
	},
	(table) => [
		index('platform_admin_roles_role_idx').on(table.role),
	],
);

// ─── Administrator MFA ──────────────────────────────────────────

/**
 * An administrator's second factor.
 *
 * **One row per account, and its existence is the statement "this account has a second factor".**
 * The design notes — why a separate table, why the secret is ciphertext, why `confirmed_at` gates
 * it — are in `drizzle/0011_admin_mfa.sql`, which is where the constraints are enforced.
 *
 * Deliberately **not** three nullable columns on `users`: MFA is enrolled per account and only for
 * administrators, and a nullable credential column on every user row is a column nothing reads.
 */
export const adminMfa = pgTable(
	'admin_mfa',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		/** FK to users is declared in the migration (see module note). */
		userId: uuid('user_id').notNull().unique(),
		/** AES-256-GCM payload from `admin/secrets.ts`: `v1:<iv>:<tag>:<ciphertext>`. Never raw. */
		secretCiphertext: text('secret_ciphertext').notNull(),
		/** NULL until the operator has proved possession by submitting a valid code. */
		confirmedAt: timestamp('confirmed_at'),
		/** The last TOTP step accepted, so a code cannot be replayed inside its drift window. */
		lastUsedCounter: bigint('last_used_counter', { mode: 'number' }),
		/** `[{ hash, usedAt }]` — SHA-256 of each single-use recovery code, never the code. */
		recoveryCodes: jsonb('recovery_codes').default([]).notNull(),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
	},
	(table) => [
		index('admin_mfa_confirmed_idx').on(table.confirmedAt),
	],
);

// ─── Durable logs ────────────────────────────────────────────────

/**
 * The queryable log store behind the console's Logs & Traces page.
 *
 * The design notes — why only `warn`+ by default, why the sink receives already-redacted JSON,
 * and the three ways growth is bounded — are in `drizzle/0013_service_logs.sql`. The column set is
 * what the console filters on, and nothing else: a column nothing reads is a column that will rot.
 */
export const serviceLogs = pgTable(
	'service_logs',
	{
		// bigserial: this table is append-only and can outgrow `integer` in a busy deployment, and a
		// log row that fails to insert because the sequence ran out is a bad failure mode.
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		occurredAt: timestamp('occurred_at').notNull(),
		level: varchar('level', { length: 10 }).notNull(),
		service: varchar('service', { length: 50 }).notNull().default('nova-api'),
		msg: text('msg'),
		requestId: varchar('request_id', { length: 100 }),
		userId: varchar('user_id', { length: 100 }),
		route: varchar('route', { length: 200 }),
		method: varchar('method', { length: 10 }),
		statusCode: integer('status_code'),
		durationMs: integer('duration_ms'),
		errorType: varchar('error_type', { length: 200 }),
		errorMessage: text('error_message'),
		stack: text('stack'),
		context: jsonb('context').default({}).notNull(),
	},
	(table) => [
		index('service_logs_occurred_idx').on(table.occurredAt),
		index('service_logs_level_occurred_idx').on(table.level, table.occurredAt),
	],
);

// ─── Shared token revocations ────────────────────────────────────

/**
 * Revocations visible to every replica.
 *
 * See `drizzle/0014_revoked_tokens.sql` for why this is a table rather than a pub/sub message, and for
 * the exact guarantee: immediate on the replica that revoked, within one poll interval everywhere else.
 */
export const revokedTokens = pgTable(
	'revoked_tokens',
	{
		jti: varchar('jti', { length: 120 }).primaryKey(),
		sub: varchar('sub', { length: 100 }).notNull(),
		expiresAt: timestamp('expires_at').notNull(),
		revokedAt: timestamp('revoked_at').defaultNow().notNull(),
	},
	(table) => [
		index('revoked_tokens_revoked_at_idx').on(table.revokedAt),
		index('revoked_tokens_expires_idx').on(table.expiresAt),
	],
);
