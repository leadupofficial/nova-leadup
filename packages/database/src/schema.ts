/**
 * NOVA — Database Schema
 *
 * All tables per blueprint Section 12.2:
 * organizations, workspaces, users, user_profiles, roles, role_bindings,
 * sessions, devices, personas, avatars, avatar_assets,
 * conversations, conversation_messages, audio_recordings,
 * transcripts, transcript_segments, recording_summaries,
 * memories, memory_embeddings, tasks, reminders, notifications,
 * integrations, integration_connections, tool_definitions,
 * tool_executions, tool_approvals, consent_records, privacy_preferences,
 * retention_policies, audit_logs, usage_records, subscriptions,
 * feature_flags, provider_configs, incident_events, companion_configs
 */
import {
 pgTable,
 uuid,
 text,
 varchar,
 boolean,
 integer,
 timestamp,
 jsonb,
 index,
 unique,
 primaryKey,
 date,
 numeric,
 uniqueIndex,
 vector,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm/relations';

// ─── Organizations ──────────────────────────────────────────────

export const organizations = pgTable('organizations', {
 id: uuid('id').defaultRandom().primaryKey(),
 name: varchar('name', { length: 255 }).notNull(),
 slug: varchar('slug', { length: 100 }).notNull().unique(),
 plan: varchar('plan', { length: 50 }).default('free').notNull(),
 settings: jsonb('settings').default({}),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Workspaces ─────────────────────────────────────────────────

export const workspaces = pgTable('workspaces', {
 id: uuid('id').defaultRandom().primaryKey(),
 organizationId: uuid('organization_id')
 .references(() => organizations.id, { onDelete: 'cascade' })
 .notNull(),
 name: varchar('name', { length: 255 }).notNull(),
 slug: varchar('slug', { length: 100 }).notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
 unique('workspaces_org_slug').on(table.organizationId, table.slug),
]);

// ─── Users ──────────────────────────────────────────────────────

export const users = pgTable('users', {
 id: uuid('id').defaultRandom().primaryKey(),
 organizationId: uuid('organization_id')
 .references(() => organizations.id, { onDelete: 'set null' }),
 workspaceId: uuid('workspace_id')
 .references(() => workspaces.id, { onDelete: 'set null' }),
 email: varchar('email', { length: 255 }).unique(),
 phone: varchar('phone', { length: 20 }).unique(),
 emailVerified: boolean('email_verified').default(false).notNull(),
 phoneVerified: boolean('phone_verified').default(false).notNull(),
 passwordHash: text('password_hash'),
 name: varchar('name', { length: 255 }).notNull(),
 avatarUrl: text('avatar_url'),
 locale: varchar('locale', { length: 10 }).default('en-IN'),
 timezone: varchar('timezone', { length: 50 }).default('Asia/Kolkata'),
 disabled: boolean('disabled').default(false).notNull(),
 lastLoginAt: timestamp('last_login_at'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── User Profiles ──────────────────────────────────────────────

export const userProfiles = pgTable('user_profiles', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
 preferences: jsonb('preferences').default({}),
 metadata: jsonb('metadata').default({}),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Roles ──────────────────────────────────────────────────────

export const roles = pgTable('roles', {
 id: uuid('id').defaultRandom().primaryKey(),
 organizationId: uuid('organization_id')
 .references(() => organizations.id, { onDelete: 'cascade' })
 .notNull(),
 name: varchar('name', { length: 100 }).notNull(),
 slug: varchar('slug', { length: 50 }).notNull(),
 permissions: jsonb('permissions').default([]).notNull(),
 isSystem: boolean('is_system').default(false).notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 unique('roles_org_slug').on(table.organizationId, table.slug),
]);

// ─── Role Bindings ──────────────────────────────────────────────

export const roleBindings = pgTable('role_bindings', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 roleId: uuid('role_id').references(() => roles.id, { onDelete: 'cascade' }).notNull(),
 scope: varchar('scope', { length: 50 }).default('organization').notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 unique('role_bindings_user_role').on(table.userId, table.roleId),
]);

// ─── Sessions ───────────────────────────────────────────────────

export const sessions = pgTable('sessions', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 refreshTokenHash: text('refresh_token_hash').notNull(),
 deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
 ipAddress: varchar('ip_address', { length: 45 }),
 userAgent: text('user_agent'),
 expiresAt: timestamp('expires_at').notNull(),
 revokedAt: timestamp('revoked_at'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 index('sessions_user_idx').on(table.userId),
 index('sessions_expires_idx').on(table.expiresAt),
]);

// ─── Devices ────────────────────────────────────────────────────

/**
 * A device the app runs on.
 *
 * `userId` is **nullable** because the app registers a device at first launch, which is
 * before sign-in. Requiring an owner would have meant either not reporting pre-login devices
 * at all, or inventing one; neither is acceptable for an inventory whose purpose is to answer
 * "which app versions and platforms are in the field".
 *
 * `appVersion`, `platformVersion` and `model` exist because the client previously reported
 * nothing, so the console's device and app-version views were empty by construction and the
 * version gate had no adoption data to target. `pushToken` stays nullable and unwritten — the
 * Flutter app has no FCM integration yet, and a fabricated token would be worse than none.
 */
export const devices = pgTable('devices', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
 /** Stable per-install identifier from the client, so re-registration updates one row. */
 installationId: varchar('installation_id', { length: 100 }),
 name: varchar('name', { length: 255 }),
 platform: varchar('platform', { length: 50 }),
 platformVersion: varchar('platform_version', { length: 50 }),
 model: varchar('model', { length: 100 }),
 appVersion: varchar('app_version', { length: 50 }),
 pushToken: text('push_token'),
 lastSeenAt: timestamp('last_seen_at'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 index('devices_user_idx').on(table.userId),
 // An installation re-registers on every launch; this index is what lets that be an upsert
 // rather than a new row per start.
 uniqueIndex('devices_installation_id_idx').on(table.installationId),
]);

// ─── Personas ───────────────────────────────────────────────────

export const personas = pgTable('personas', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
 name: varchar('name', { length: 100 }).default('NOVA').notNull(),
 personality: varchar('personality', { length: 50 }).default('companion').notNull(),
 voiceSpeed: integer('voice_speed').default(100),
 voiceTone: varchar('voice_tone', { length: 50 }).default('warm'),
 languagePolicy: varchar('language_policy', { length: 50 }).default('auto').notNull(),
 wakeWordEnabled: boolean('wake_word_enabled').default(false).notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Avatars ────────────────────────────────────────────────────

export const avatars = pgTable('avatars', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
 assetId: uuid('asset_id').references(() => avatarAssets.id),
 emotion: varchar('emotion', { length: 50 }).default('neutral'),
 animationDensity: varchar('animation_density', { length: 20 }).default('medium'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Avatar Assets ──────────────────────────────────────────────

export const avatarAssets = pgTable('avatar_assets', {
 id: uuid('id').defaultRandom().primaryKey(),
 name: varchar('name', { length: 255 }).notNull(),
 modelUrl: text('model_url').notNull(),
 textureUrl: text('texture_url'),
 thumbnailUrl: text('thumbnail_url'),
 isBuiltIn: boolean('is_built_in').default(false).notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Conversations ──────────────────────────────────────────────

export const conversations = pgTable('conversations', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 tenantId: uuid('tenant_id').references(() => organizations.id),
 title: varchar('title', { length: 500 }),
 mode: varchar('mode', { length: 50 }).default('text'),
 metadata: jsonb('metadata').default({}),
 endedAt: timestamp('ended_at'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
 index('conversations_user_idx').on(table.userId),
]);

// ─── Conversation Messages ──────────────────────────────────────

export const conversationMessages = pgTable('conversation_messages', {
 id: uuid('id').defaultRandom().primaryKey(),
 conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
 role: varchar('role', { length: 20 }).notNull(), // 'user' | 'assistant'
 content: text('content').notNull(),
 toolCalls: jsonb('tool_calls'),
 toolResults: jsonb('tool_results'),
 model: varchar('model', { length: 50 }),
 tokenUsage: jsonb('token_usage'),
 /**
  * Wall-clock duration of the model call that produced this message, in milliseconds.
  *
  * Added because "AI latency" was reported as NOT AVAILABLE: nothing recorded how long a
  * completion took, so the console had no figure to show and no way to detect a provider
  * slowing down. Only assistant rows carry it — a user message is not a model call.
  *
  * It is the full tool loop, not a single HTTP round trip: `runAssistantToolLoop` may make
  * several model calls, and the number a user experiences is the total.
  */
 durationMs: integer('duration_ms'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 index('messages_conversation_idx').on(table.conversationId),
]);

// ─── Audio Recordings ───────────────────────────────────────────

export const audioRecordings = pgTable('audio_recordings', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 tenantId: uuid('tenant_id').references(() => organizations.id),
 title: varchar('title', { length: 500 }).notNull(),
 durationSeconds: integer('duration_seconds'),
 language: varchar('language', { length: 50 }),
 participants: jsonb('participants').default([]),
 status: varchar('status', { length: 50 }).default('recording').notNull(),
 // Why a recording entered `failed`. The reaper knows the reason
 // (`capture-abandoned`, `audio-missing-after-upload`,
 // `audio-missing-while-processing`) but the client only ever saw `failed`.
 // Nullable and free-form on purpose: rows that failed before this column
 // existed have no reason, and only the writer's vocabulary is meaningful.
 failureReason: text('failure_reason'),
 storageKey: text('storage_key').notNull(),
 storageChecksum: text('storage_checksum'),
 consentRecorded: boolean('consent_recorded').default(false).notNull(),
 completedAt: timestamp('completed_at'),
 deletedAt: timestamp('deleted_at'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
 index('recordings_user_idx').on(table.userId),
 index('recordings_status_idx').on(table.status),
]);

// ─── Transcripts ────────────────────────────────────────────────

export const transcripts = pgTable('transcripts', {
 id: uuid('id').defaultRandom().primaryKey(),
 recordingId: uuid('recording_id').references(() => audioRecordings.id, { onDelete: 'cascade' }).notNull().unique(),
 fullText: text('full_text').notNull(),
 language: varchar('language', { length: 50 }),
 createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Transcript Segments ────────────────────────────────────────

export const transcriptSegments = pgTable('transcript_segments', {
 id: uuid('id').defaultRandom().primaryKey(),
 transcriptId: uuid('transcript_id').references(() => transcripts.id, { onDelete: 'cascade' }).notNull(),
 speakerIndex: integer('speaker_index').notNull(),
 startMs: integer('start_ms').notNull(),
 endMs: integer('end_ms').notNull(),
 text: text('text').notNull(),
 confidence: integer('confidence'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 index('segments_transcript_idx').on(table.transcriptId),
]);

// ─── Recording Summaries ────────────────────────────────────────

export const recordingSummaries = pgTable('recording_summaries', {
 id: uuid('id').defaultRandom().primaryKey(),
 recordingId: uuid('recording_id').references(() => audioRecordings.id, { onDelete: 'cascade' }).notNull().unique(),
 transcriptId: uuid('transcript_id').references(() => transcripts.id),
 summary: text('summary').notNull(),
 decisions: jsonb('decisions').default([]),
 actionItems: jsonb('action_items').default([]),
 extractedContacts: jsonb('extracted_contacts').default([]),
 createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Memories ───────────────────────────────────────────────────

export const memories = pgTable('memories', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 tenantId: uuid('tenant_id').references(() => organizations.id),
 visibility: varchar('visibility', { length: 50 }).default('private').notNull(),
 category: varchar('category', { length: 50 }).notNull(),
 content: text('content').notNull(),
 normalizedFacts: jsonb('normalized_facts').default({}),
 sourceType: varchar('source_type', { length: 50 }).notNull(),
 sourceIds: jsonb('source_ids').default([]),
 confidence: integer('confidence').default(50),
 importance: integer('importance').default(50),
 sensitivity: varchar('sensitivity', { length: 50 }).default('normal').notNull(),
 status: varchar('status', { length: 50 }).default('proposed').notNull(),
 expiresAt: timestamp('expires_at'),
 embeddingId: uuid('embedding_id'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
 index('memories_user_idx').on(table.userId),
 index('memories_status_idx').on(table.status),
 // Bounds `content ILIKE '%term%'`. A leading wildcard can never use btree,
 // and "contains" semantics inherently require it, so only a trigram index
 // (pg_trgm) narrows the scan.
 index('memories_content_trgm_idx').using('gin', table.content.op('gin_trgm_ops')),
]);

// ─── Memory Embeddings ──────────────────────────────────────────

export const memoryEmbeddings = pgTable('memory_embeddings', {
 id: uuid('id').defaultRandom().primaryKey(),
 memoryId: uuid('memory_id').references(() => memories.id, { onDelete: 'cascade' }).notNull().unique(),
 embedding: jsonb('embedding').notNull(), // pgvector stored as JSON array
 // The same vector as a real `vector(1536)` value. `embedding` is jsonb, so no
 // ANN index can exist on it; this column is what the HNSW index below is
 // built on. Nullable because rows written before this column existed have no
 // vector, and the writer is free to fill it lazily.
 embeddingVec: vector('embedding_vec', { dimensions: 1536 }),
 model: varchar('model', { length: 100 }).notNull(),
 dimensions: integer('dimensions').notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 // HNSW + cosine, matching the normalised embedding geometry. `m` and
 // `ef_construction` are the pgvector defaults made explicit.
 index('memory_embeddings_embedding_hnsw_idx')
  .using('hnsw', table.embeddingVec.op('vector_cosine_ops'))
  .with({ m: 16, ef_construction: 64 }),
]);

// ─── Tasks ──────────────────────────────────────────────────────

export const tasks = pgTable('tasks', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 tenantId: uuid('tenant_id').references(() => organizations.id),
 title: varchar('title', { length: 500 }).notNull(),
 description: text('description'),
 status: varchar('status', { length: 50 }).default('pending').notNull(),
 priority: varchar('priority', { length: 50 }).default('medium').notNull(),
 // The task's owner/delegate, per the master document §5.8 ("owner" and
 // "Waiting on others"). Nullable: an unassigned task is the normal case.
 // `set null`, not `cascade`, deliberately — a task belongs to its creator
 // (`userId`), not to the person it was handed to, so deleting the assignee's
 // account must clear the delegation, never destroy the creator's task.
 // Mirrors `reminders.linkedTaskId`.
 assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
 dueAt: timestamp('due_at'),
 completedAt: timestamp('completed_at'),
 source: varchar('source', { length: 50 }).default('manual').notNull(),
 tags: jsonb('tags').default([]),
 aiConfidence: integer('ai_confidence'),
 // Create-idempotency identity: a hash of (user, normalised title, 60-second
 // window bucket), or of (user, caller-supplied idempotency key). NULL for rows
 // written before the column existed and for writers that do not supply one
 // (the migration's BEFORE INSERT trigger fills it in for those).
 dedupeKey: varchar('dedupe_key', { length: 64 }),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
 index('tasks_user_idx').on(table.userId),
 index('tasks_status_idx').on(table.status),
 // The create path is `INSERT ... ON CONFLICT (dedupe_key) DO UPDATE`, so this
 // index is what makes two concurrent identical creates produce one row. It is
 // a plain unique index, not a partial one: Postgres treats NULLs as distinct,
 // so rows written without a key never collide.
 uniqueIndex('tasks_dedupe_key_idx').on(table.dedupeKey),
]);

// ─── Reminders ──────────────────────────────────────────────────

export const reminders = pgTable('reminders', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 title: varchar('title', { length: 500 }).notNull(),
 triggerAt: timestamp('trigger_at').notNull(),
 timezone: varchar('timezone', { length: 50 }).default('Asia/Kolkata').notNull(),
 repeatRule: text('repeat_rule'),
 notificationChannel: jsonb('notification_channel').default(['push']),
 linkedTaskId: uuid('linked_task_id').references(() => tasks.id, { onDelete: 'set null' }),
 linkedContactId: uuid('linked_contact_id'),
 sourceAudit: text('source_audit'),
 dismissed: boolean('dismissed').default(false).notNull(),
 triggeredAt: timestamp('triggered_at'),
 // Create-idempotency identity. Expected values (see
 // services/api/src/services/create-dedupe.ts):
 //   * no idempotency key  — md5(user | normalised title | trigger_at | window bucket)
 //   * idempotency key     — md5(user | 'idem' | key)
 // The bucket is the current 60-second window, which is what keeps a genuine
 // repeat ("Call Kumar" today at 10:00 and again tomorrow at 10:00) from being
 // absorbed: the trigger instants differ, so the keys differ.
 dedupeKey: varchar('dedupe_key', { length: 64 }),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 index('reminders_user_trigger_idx').on(table.userId, table.triggerAt),
 // See the matching comment on `tasks_dedupe_key_idx`.
 uniqueIndex('reminders_dedupe_key_idx').on(table.dedupeKey),
]);

// ─── Reminder Events ────────────────────────────────────────────

/**
 * The exact record of a reminder being moved.
 *
 * `reminders` has no history: it holds the current `trigger_at` only, and
 * `reminders.triggered_at` is never written by anything, so before this table
 * "this reminder was pushed back more than once" could only count the
 * push-backs NOVA happened to witness in its own process memory.
 *
 * A journal answers both halves of the question the follow-up engine asks —
 * *how many* times, and *when* — which a `revision` counter cannot: a counter
 * gives the count but throws away the timestamps and the from→to pairs.
 *
 * Rows are written by the `reminders_trigger_at_change` trigger installed in
 * the matching `drizzle/0004_*.sql`, not by application code. Every writer that
 * updates `reminders.trigger_at` — `PATCH /reminders/:id` and the assistant's
 * `update_reminder`, both of which are a plain single-row `UPDATE` — is
 * captured automatically, so no service change is required to populate it.
 *
 * `onDelete: 'cascade'` matches the rest of the schema (a reminder is owned by
 * its user, and every reminder row cascades when the user is deleted): a
 * deletion makes the question moot, and orphan history is worse than no
 * history.
 */
export const reminderEvents = pgTable('reminder_events', {
 id: uuid('id').defaultRandom().primaryKey(),
 reminderId: uuid('reminder_id').references(() => reminders.id, { onDelete: 'cascade' }).notNull(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 // 'postponed' when `trigger_at` moved later, 'rescheduled_earlier' when it
 // moved earlier. Free-form text rather than an enum: adding a value must not
 // need a type migration.
 event: varchar('event', { length: 50 }).notNull(),
 fromTriggerAt: timestamp('from_trigger_at'),
 toTriggerAt: timestamp('to_trigger_at'),
 occurredAt: timestamp('occurred_at').defaultNow().notNull(),
}, (table) => [
 // "How many times was this reminder postponed, and when" reads exactly this
 // way: filter by reminder, order by time.
 index('reminder_events_reminder_occurred_idx').on(table.reminderId, table.occurredAt),
]);

// ─── Notifications ──────────────────────────────────────────────

export const notifications = pgTable('notifications', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 type: varchar('type', { length: 100 }).notNull(),
 title: varchar('title', { length: 500 }).notNull(),
 body: text('body'),
 payload: jsonb('payload').default({}),
 read: boolean('read').default(false).notNull(),
 readAt: timestamp('read_at'),
 occurredAt: timestamp('occurred_at').defaultNow().notNull(),
}, (table) => [
 index('notifications_user_idx').on(table.userId),
]);

// ─── Integrations ───────────────────────────────────────────────

export const integrations = pgTable('integrations', {
 id: uuid('id').defaultRandom().primaryKey(),
 name: varchar('name', { length: 100 }).notNull(),
 provider: varchar('provider', { length: 100 }).notNull().unique(),
 configSchema: jsonb('config_schema'),
 enabled: boolean('enabled').default(true).notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Integration Connections ────────────────────────────────────

export const integrationConnections = pgTable('integration_connections', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 tenantId: uuid('tenant_id').references(() => organizations.id),
 integrationId: uuid('integration_id').references(() => integrations.id, { onDelete: 'cascade' }).notNull(),
 status: varchar('status', { length: 50 }).default('disconnected').notNull(),
 encryptedCredentials: text('encrypted_credentials'),
 scopes: jsonb('scopes').default([]),
 lastUsedAt: timestamp('last_used_at'),
 disconnectedAt: timestamp('disconnected_at'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
 unique('integration_connections_user_integration').on(table.userId, table.integrationId),
 index('integration_connections_user_idx').on(table.userId),
]);

// ─── Tool Definitions ───────────────────────────────────────────

export const toolDefinitions = pgTable('tool_definitions', {
 id: uuid('id').defaultRandom().primaryKey(),
 name: varchar('name', { length: 100 }).notNull().unique(),
 version: varchar('version', { length: 20 }).notNull(),
 description: text('description'),
 inputSchema: jsonb('input_schema').notNull(),
 outputSchema: jsonb('output_schema'),
 tenantScope: varchar('tenant_scope', { length: 20 }).default('personal').notNull(),
 permissionLevel: integer('permission_level').default(0).notNull(),
 confirmationRequired: boolean('confirmation_required').default(false).notNull(),
 idempotencyRequired: boolean('idempotency_required').default(true).notNull(),
 enabled: boolean('enabled').default(true).notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Tool Executions ────────────────────────────────────────────

export const toolExecutions = pgTable('tool_executions', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 tenantId: uuid('tenant_id').references(() => organizations.id),
 toolId: uuid('tool_id').references(() => toolDefinitions.id).notNull(),
 input: jsonb('input').notNull(),
 output: jsonb('output'),
 success: boolean('success').notNull(),
 errorCode: varchar('error_code', { length: 100 }),
 errorMessage: text('error_message'),
 durationMs: integer('duration_ms'),
 requestId: varchar('request_id', { length: 100 }).notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 index('tool_executions_user_idx').on(table.userId),
]);

// ─── Tool Approvals ─────────────────────────────────────────────

export const toolApprovals = pgTable('tool_approvals', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 tenantId: uuid('tenant_id').references(() => organizations.id),
 toolId: uuid('tool_id').references(() => toolDefinitions.id).notNull(),
 toolInput: jsonb('tool_input').notNull(),
 permissionLevel: integer('permission_level').notNull(),
 status: varchar('status', { length: 50 }).default('pending').notNull(),
 expiresAt: timestamp('expires_at').notNull(),
 decidedAt: timestamp('decided_at'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 index('approvals_user_idx').on(table.userId),
]);

// ─── Consent Records ────────────────────────────────────────────

export const consentRecords = pgTable('consent_records', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 purpose: varchar('purpose', { length: 100 }).notNull(),
 granted: boolean('granted').notNull(),
 method: varchar('method', { length: 50 }).notNull(),
 ipAddress: varchar('ip_address', { length: 45 }),
 userAgent: text('user_agent'),
 consentedAt: timestamp('consented_at').defaultNow().notNull(),
 revokedAt: timestamp('revoked_at'),
}, (table) => [
 index('consents_user_idx').on(table.userId),
]);

// ─── Privacy Preferences ────────────────────────────────────────

export const privacyPreferences = pgTable('privacy_preferences', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
 saveConversations: boolean('save_conversations').default(true).notNull(),
 saveRecordings: boolean('save_recordings').default(true).notNull(),
 saveTranscripts: boolean('save_transcripts').default(true).notNull(),
 saveMemories: boolean('save_memories').default(true).notNull(),
 autoDeleteRecordingsDays: integer('auto_delete_recordings_days').default(30),
 autoDeleteTranscriptsDays: integer('auto_delete_transcripts_days').default(7),
 cloudProcessing: boolean('cloud_processing').default(true).notNull(),
 localProcessing: boolean('local_processing').default(false).notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Notification & Appearance Preferences ──────────────────────
//
// Backs `GET/PATCH /api/v1/settings/preferences`, which previously had no
// storage at all — the GET returned hardcoded values and the PATCH echoed its
// body back without writing, so every notification toggle silently reverted.
//
// NOTE: the deployed database already has this table (created directly, since
// this package's dist cannot currently be rebuilt — see lead.repository.ts type
// errors). This entry keeps schema.ts as the source of truth for a future
// migration run.
export const notificationPreferences = pgTable('notification_preferences', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  push: boolean('push').default(true).notNull(),
  email: boolean('email').default(true).notNull(),
  sms: boolean('sms').default(false).notNull(),
  inApp: boolean('in_app').default(true).notNull(),
  theme: varchar('theme', { length: 20 }).default('system').notNull(),
  fontSize: varchar('font_size', { length: 20 }).default('medium').notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Retention Policies ─────────────────────────────────────────

export const retentionPolicies = pgTable('retention_policies', {
 id: uuid('id').defaultRandom().primaryKey(),
 organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }).notNull(),
 artifactType: varchar('artifact_type', { length: 50 }).notNull(),
 retentionDays: integer('retention_days').notNull(),
 autoDelete: boolean('auto_delete').default(true).notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
 unique('retention_policies_org_type').on(table.organizationId, table.artifactType),
]);

// ─── Deletion Requests ─────────────────────────────────────────

export const deletionRequests = pgTable('deletion_requests', {
	id: uuid('id').defaultRandom().primaryKey(),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
	artifactType: varchar('artifact_type', { length: 50 }).notNull(),
	reason: text('reason'),
	status: varchar('status', { length: 50 }).default('pending').notNull(),
	scheduledFor: timestamp('scheduled_for'),
	processedAt: timestamp('processed_at'),
	redactedTranscripts: boolean('redacted_transcripts').default(true).notNull(),
	redactedMemories: boolean('redacted_memories').default(true).notNull(),
	auditTrailId: uuid('audit_trail_id'),
	createdAt: timestamp('created_at').defaultNow().notNull(),
	updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
	index('deletion_requests_user_idx').on(table.userId),
	index('deletion_requests_status_idx').on(table.status),
]);

// ─── Data Exports ──────────────────────────────────────────────

export const dataExports = pgTable('data_exports', {
	id: uuid('id').defaultRandom().primaryKey(),
	userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
	format: varchar('format', { length: 10 }).notNull(),
	status: varchar('status', { length: 50 }).default('pending').notNull(),
	downloadUrl: text('download_url'),
	expiresAt: timestamp('expires_at'),
	sizeBytes: integer('size_bytes'),
	itemCount: jsonb('item_count').default({}),
	requestedAt: timestamp('requested_at').defaultNow().notNull(),
	completedAt: timestamp('completed_at'),
	errorMessage: text('error_message'),
}, (table) => [
	index('data_exports_user_idx').on(table.userId),
	index('data_exports_status_idx').on(table.status),
]);

// ─── Audit Logs ─────────────────────────────────────────────────

export const auditLogs = pgTable('audit_logs', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id),
 tenantId: uuid('tenant_id').references(() => organizations.id),
 requestId: varchar('request_id', { length: 100 }),
 sourceDevice: varchar('source_device', { length: 255 }),
 actorType: varchar('actor_type', { length: 50 }).notNull(), // 'user' | 'system' | 'agent'
 actorId: varchar('actor_id', { length: 100 }),
 action: varchar('action', { length: 100 }).notNull(),
 targetType: varchar('target_type', { length: 50 }),
 targetId: varchar('target_id', { length: 100 }),
 outcome: varchar('outcome', { length: 50 }).notNull(), // 'success' | 'failure' | 'denied'
 details: jsonb('details').default({}),
 redactedFields: jsonb('redacted_fields').default([]),
 occurredAt: timestamp('occurred_at').defaultNow().notNull(),
}, (table) => [
 index('audit_logs_user_idx').on(table.userId),
 index('audit_logs_tenant_idx').on(table.tenantId),
 index('audit_logs_occurred_idx').on(table.occurredAt),
]);

// ─── Usage Records ──────────────────────────────────────────────

export const usageRecords = pgTable('usage_records', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 tenantId: uuid('tenant_id').references(() => organizations.id),
 metric: varchar('metric', { length: 100 }).notNull(),
 value: integer('value').notNull(),
 unit: varchar('unit', { length: 50 }).default('count'),
 recordedAt: timestamp('recorded_at').defaultNow().notNull(),
}, (table) => [
 index('usage_records_user_metric_idx').on(table.userId, table.metric),
]);

// ─── Subscriptions ──────────────────────────────────────────────

export const subscriptions = pgTable('subscriptions', {
 id: uuid('id').defaultRandom().primaryKey(),
 organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }).notNull(),
 plan: varchar('plan', { length: 50 }).notNull(),
 status: varchar('status', { length: 50 }).default('active').notNull(),
 provider: varchar('provider', { length: 50 }),
 externalSubscriptionId: varchar('external_subscription_id', { length: 255 }),
 currentPeriodStart: timestamp('current_period_start'),
 currentPeriodEnd: timestamp('current_period_end'),
 cancelledAt: timestamp('cancelled_at'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Feature Flags ──────────────────────────────────────────────

export const featureFlags = pgTable('feature_flags', {
 id: uuid('id').defaultRandom().primaryKey(),
 key: varchar('key', { length: 100 }).notNull().unique(),
 enabled: boolean('enabled').default(false).notNull(),
 rolloutPercent: integer('rollout_percent').default(0),
 description: text('description'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Provider Configs ───────────────────────────────────────────

export const providerConfigs = pgTable('provider_configs', {
 id: uuid('id').defaultRandom().primaryKey(),
 organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
 provider: varchar('provider', { length: 50 }).notNull(),
 config: jsonb('config').default({}),
 enabled: boolean('enabled').default(true).notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
 unique('provider_configs_org_provider').on(table.organizationId, table.provider),
]);

// ─── Incident Events ────────────────────────────────────────────

export const incidentEvents = pgTable('incident_events', {
 id: uuid('id').defaultRandom().primaryKey(),
 organizationId: uuid('organization_id').references(() => organizations.id),
 severity: varchar('severity', { length: 20 }).notNull(),
 title: varchar('title', { length: 500 }).notNull(),
 description: text('description'),
 resolved: boolean('resolved').default(false).notNull(),
 resolvedAt: timestamp('resolved_at'),
 occurredAt: timestamp('occurred_at').defaultNow().notNull(),
});

// ─── Translations ─────────────────────────────────────────────────────────────

export const translations = pgTable('translations', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 originalText: text('original_text').notNull(),
 translatedText: text('translated_text').notNull(),
 sourceLanguage: varchar('source_language', { length: 10 }).notNull(),
 targetLanguage: varchar('target_language', { length: 10 }).notNull(),
 tanglishDetected: boolean('tanglish_detected').default(false).notNull(),
 confidence: integer('confidence').default(0),
 provider: varchar('provider', { length: 100 }).notNull(),
 processingMs: integer('processing_ms').default(0),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 index('translations_user_idx').on(table.userId),
 index('translations_user_created_idx').on(table.userId, table.createdAt),
]);

// ─── Relations ──────────────────────────────────────────────────────────────────

export const organizationsRelations = relations(organizations, ({ many }) => ({
 workspaces: many(workspaces),
 users: many(users),
 roles: many(roles),
 retentionPolicies: many(retentionPolicies),
 subscriptions: many(subscriptions),
 providerConfigs: many(providerConfigs),
 auditLogs: many(auditLogs),
 usageRecords: many(usageRecords),
 incidentEvents: many(incidentEvents),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
 organization: one(organizations, {
 fields: [workspaces.organizationId],
 references: [organizations.id],
 }),
 users: many(users),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
 organization: one(organizations, {
 fields: [users.organizationId],
 references: [organizations.id],
 }),
 workspace: one(workspaces, {
 fields: [users.workspaceId],
 references: [workspaces.id],
 }),
 profile: one(userProfiles, {
 fields: [users.id],
 references: [userProfiles.userId],
 }),
 persona: one(personas, {
 fields: [users.id],
 references: [personas.userId],
 }),
 avatar: one(avatars, {
 fields: [users.id],
 references: [avatars.userId],
 }),
 sessions: many(sessions),
 devices: many(devices),
 roleBindings: many(roleBindings),
 conversations: many(conversations),
 recordings: many(audioRecordings),
 tasks: many(tasks),
 reminders: many(reminders),
 notifications: many(notifications),
 integrationConnections: many(integrationConnections),
 taskExecutions: many(toolExecutions),
 approvals: many(toolApprovals),
 memories: many(memories),
 translations: many(translations),
 privacyPreferences: one(privacyPreferences, {
 fields: [users.id],
 references: [privacyPreferences.userId],
 }),
 auditLogs: many(auditLogs),
 usageRecords: many(usageRecords),
 consentRecords: many(consentRecords),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
 user: one(users, {
 fields: [sessions.userId],
 references: [users.id],
 }),
}));

export const devicesRelations = relations(devices, ({ one }) => ({
 user: one(users, {
 fields: [devices.userId],
 references: [users.id],
 }),
}));

// ─── Companion Configs ────────────────────────────────────────

export const companionConfigs = pgTable('companion_configs', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
 companionMode: varchar('companion_mode', { length: 20 }).default('passive').notNull(),
 // Wake-word settings (JSON — configurable per user)
 wakeWordEnabled: boolean('wake_word_enabled').default(false).notNull(),
 wakeWord: jsonb('wake_word').default({ word: 'NOVA', sensitivity: 0.7 }),
 // Notification filter settings
 notificationFilter: jsonb('notification_filter').default({
 otpBlocked: true,
 bankingBlocked: true,
 spamBlocked: true,
 blockedKeywords: [] as string[],
 allowedPackages: [] as string[],
 blockedPackages: [] as string[],
 }),
 // Overlay settings
 overlay: jsonb('overlay').default({
 state: 'hidden',
 avatarEmotion: 'neutral',
 showText: true,
 draggable: true,
 position: { x: 0, y: 0 },
 }),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
 index('companion_configs_user_idx').on(table.userId),
]);

export const companionConfigsRelations = relations(companionConfigs, ({ one }) => ({
 user: one(users, {
 fields: [companionConfigs.userId],
 references: [users.id],
 }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
 user: one(users, {
 fields: [conversations.userId],
 references: [users.id],
 }),
 messages: many(conversationMessages),
}));

export const conversationMessagesRelations = relations(conversationMessages, ({ one }) => ({
 conversation: one(conversations, {
 fields: [conversationMessages.conversationId],
 references: [conversations.id],
 }),
}));

export const audioRecordingsRelations = relations(audioRecordings, ({ one, many }) => ({
 user: one(users, {
 fields: [audioRecordings.userId],
 references: [users.id],
 }),
 transcript: one(transcripts, {
 fields: [audioRecordings.id],
 references: [transcripts.recordingId],
 }),
 summary: one(recordingSummaries, {
 fields: [audioRecordings.id],
 references: [recordingSummaries.recordingId],
 }),
}));

export const transcriptsRelations = relations(transcripts, ({ one, many }) => ({
 recording: one(audioRecordings, {
 fields: [transcripts.recordingId],
 references: [audioRecordings.id],
 }),
 segments: many(transcriptSegments),
}));

export const memoriesRelations = relations(memories, ({ one }) => ({
 user: one(users, {
 fields: [memories.userId],
 references: [users.id],
 }),
 embedding: one(memoryEmbeddings, {
 fields: [memories.embeddingId],
 references: [memoryEmbeddings.id],
 }),
}));

export const memoryEmbeddingsRelations = relations(memoryEmbeddings, ({ one }) => ({
 memory: one(memories, {
 fields: [memoryEmbeddings.memoryId],
 references: [memories.id],
 }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
 user: one(users, {
 fields: [tasks.userId],
 references: [users.id],
 }),
 reminders: many(reminders),
}));

export const remindersRelations = relations(reminders, ({ one }) => ({
 user: one(users, {
 fields: [reminders.userId],
 references: [users.id],
 }),
}));

export const avatarAssetsRelations = relations(avatarAssets, ({ one }) => ({
 avatar: one(avatars, {
 fields: [avatarAssets.id],
 references: [avatars.assetId],
 }),
}));

export const translationsRelations = relations(translations, ({ one }) => ({
 user: one(users, {
 fields: [translations.userId],
 references: [users.id],
 }),
}));

// ─── Lead Management ──────────────────────────────────────────

export const leads = pgTable('leads', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 name: varchar('name', { length: 100 }).notNull(),
 phone: varchar('phone', { length: 15 }).notNull(),
 alternatePhone: varchar('alternate_phone', { length: 15 }),
 email: varchar('email', { length: 255 }),
 service: varchar('service', { length: 50 }).notNull(),
 location: varchar('location', { length: 100 }).notNull(),
 notes: text('notes'),
 source: varchar('source', { length: 50 }).notNull(),
 status: varchar('status', { length: 50 }).default('new').notNull(),
 priority: varchar('priority', { length: 50 }).default('medium').notNull(),
 budget: varchar('budget', { length: 50 }),
 timeline: varchar('timeline', { length: 50 }),
 isQualified: boolean('is_qualified').default(false).notNull(),
 followUpDate: timestamp('follow_up_date'),
 tags: text('tags').array(),
 assignedTo: uuid('assigned_to').references(() => users.id),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
 index('leads_user_idx').on(table.userId),
 index('leads_status_idx').on(table.status),
 index('leads_source_idx').on(table.source),
]);

export const leadsRelations = relations(leads, ({ one }) => ({
 user: one(users, {
 fields: [leads.userId],
 references: [users.id],
 }),
}));

// ─── Lead Pipeline ────────────────────────────────────────────

export const leadPipelineStages = pgTable('lead_pipeline_stages', {
 id: uuid('id').defaultRandom().primaryKey(),
 leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }).notNull().unique(),
 stage: varchar('stage', { length: 50 }).notNull(),
 description: text('description'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 index('lead_pipeline_stages_lead_idx').on(table.leadId),
]);

export const leadPipelineStagesRelations = relations(leadPipelineStages, ({ one }) => ({
 lead: one(leads, {
 fields: [leadPipelineStages.leadId],
 references: [leads.id],
 }),
}));

// ─── Follow-ups ───────────────────────────────────────────────

export const leadFollowUps = pgTable('lead_follow_ups', {
 id: uuid('id').defaultRandom().primaryKey(),
 leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'cascade' }).notNull(),
 assignedTo: uuid('assigned_to').references(() => users.id),
 followUpDate: timestamp('follow_up_date').notNull(),
 notes: text('notes'),
 completed: boolean('completed').default(false).notNull(),
 createdAt: timestamp('created_at').defaultNow().notNull(),
 updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
 index('lead_follow_ups_lead_idx').on(table.leadId),
 index('lead_follow_ups_date_idx').on(table.followUpDate),
]);

export const leadFollowUpsRelations = relations(leadFollowUps, ({ one }) => ({
 lead: one(leads, {
 fields: [leadFollowUps.leadId],
 references: [leads.id],
 }),
}));

// ─── Analytics ────────────────────────────────────────────────

export const leadAnalytics = pgTable('lead_analytics', {
 id: uuid('id').defaultRandom().primaryKey(),
 userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
 date: date('date').notNull(),
 newLeads: integer('new_leads').default(0).notNull(),
 qualifiedLeads: integer('qualified_leads').default(0).notNull(),
 convertedLeads: integer('converted_leads').default(0).notNull(),
 revenueGenerated: numeric('revenue_generated', { precision: 12, scale: 2 }).default('0.00'),
 createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
 // `uniqueIndex`, not `index(...).unique()` — `IndexBuilder` has no `unique()`
 // method in any drizzle version this repo has used, so this declaration never
 // compiled. The intent was clearly uniqueness on (user_id, date).
 uniqueIndex('lead_analytics_user_date_idx').on(table.userId, table.date),
]);

export const leadAnalyticsRelations = relations(leadAnalytics, ({ one }) => ({
 user: one(users, {
 fields: [leadAnalytics.userId],
 references: [users.id],
 }),
}));
