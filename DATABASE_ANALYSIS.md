# NOVA Database Layer Analysis

## Executive Summary

The NOVA project uses Drizzle ORM with PostgreSQL for an AI companion app. The schema is defined in `packages/database/src/db/schema.ts` using Drizzle's table API, but **the schema has not been executed as migrations** — only the `migrations` tracking table exists. There is no database connection setup file, no seed data, and no drizzle config file in the repository.

---

## 1. Complete Schema Overview

### Tables (6 total)

#### `users`
| Column | Type | Constraints |
|--------|------|-------------|
| id | `text` | PRIMARY KEY |
| email | `text` | UNIQUE, NOT NULL |
| email_verified | `boolean` | DEFAULT false |
| name | `text` | nullable |
| avatar_url | `text` | nullable |
| created_at | `timestamp` | DEFAULT now() |
| updated_at | `timestamp` | DEFAULT now() |

#### `user_profiles`
| Column | Type | Constraints |
|--------|------|-------------|
| user_id | `text` | PRIMARY KEY, FK → users(id) ON DELETE CASCADE |
| bio | `text` | nullable |
| preferences | `jsonb` | DEFAULT '{}' |
| timezone | `text` | DEFAULT 'UTC' |
| created_at | `timestamp` | DEFAULT now() |
| updated_at | `timestamp` | DEFAULT now() |

#### `conversations`
| Column | Type | Constraints |
|--------|------|-------------|
| id | `text` | PRIMARY KEY |
| user_id | `text` | NOT NULL, FK → users(id) ON DELETE CASCADE |
| companion_id | `text` | NOT NULL, FK → companion_profiles(id) ON DELETE CASCADE |
| title | `text` | nullable |
| status | `text` | DEFAULT 'active' |
| last_message_at | `timestamp` | nullable |
| created_at | `timestamp` | DEFAULT now() |
| updated_at | `timestamp` | DEFAULT now() |

#### `messages`
| Column | Type | Constraints |
|--------|------|-------------|
| id | `text` | PRIMARY KEY |
| conversation_id | `text` | NOT NULL, FK → conversations(id) ON DELETE CASCADE |
| role | `text` | NOT NULL |
| content | `text` | NOT NULL |
| metadata | `jsonb` | DEFAULT '{}' |
| created_at | `timestamp` | DEFAULT now() |

#### `companion_profiles`
| Column | Type | Constraints |
|--------|------|-------------|
| id | `text` | PRIMARY KEY |
| name | `text` | NOT NULL |
| description | `text` | nullable |
| avatar_url | `text` | nullable |
| personality | `jsonb` | DEFAULT '{}' |
| system_prompt | `text` | nullable |
| is_active | `boolean` | DEFAULT true |
| created_at | `timestamp` | DEFAULT now() |
| updated_at | `timestamp` | DEFAULT now() |

#### `message_reactions`
| Column | Type | Constraints |
|--------|------|-------------|
| id | `text` | PRIMARY KEY |
| message_id | `text` | NOT NULL, FK → messages(id) ON DELETE CASCADE |
| user_id | `text` | NOT NULL, FK → users(id) ON DELETE CASCADE |
| reactions_user_id | `text` | FK → users(id) ON DELETE CASCADE |
| reaction | `text` | NOT NULL |
| created_at | `timestamp` | DEFAULT now() |

### Relationships
- `users` 1—1 `user_profiles` (user_id is PK in user_profiles)
- `users` 1—N `conversations` (user_id)
- `companion_profiles` 1—N `conversations` (companion_id)
- `conversations` 1—N `messages` (conversation_id)
- `messages` 1—N `message_reactions` (message_id)
- `users` 1—N `message_reactions` (user_id)

---

## 2. Schema Design Issues

### 🔴 Critical

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 1 | **Schema never migrated to DB** | Critical | Only the `migrations` tracking table exists. All 6 tables are defined in code but never created. |
| 2 | **No drizzle config file** | Critical | `drizzle.config.ts` is missing — migrations cannot be generated or run. |

### 🟠 High

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 3 | **Missing indexes on foreign keys** | High | `conversations.user_id`, `conversations.companion_id`, `messages.conversation_id`, `message_reactions.message_id` have no indexes. JOINs and WHERE clauses on these columns will cause seq scans. |
| 4 | **Missing index on `users.email`** | High | Email lookups (login, signup) will be slow without an index on `email`. |
| 5 | **No composite index on conversations(user_id, last_message_at)** | High | Listing a user's conversations sorted by last message will require a seq scan + sort. |
| 6 | **No composite index on messages(conversation_id, created_at)** | High | Fetching a conversation's message history will require a seq scan + sort. |

### 🟡 Medium

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 7 | **`messages.role` has no CHECK constraint** | Medium | Values are unrestricted — any string can be inserted. Should be `CHECK (role IN ('user', 'assistant', 'system'))`. |
| 8 | **`conversations.status` has no CHECK constraint** | Medium | Values are unrestricted. Should be `CHECK (status IN ('active', 'archived', 'deleted'))`. |
| 9 | **`message_reactions.reaction` has no CHECK constraint** | Medium | Any emoji/text can be inserted. Should restrict to known reactions or add validation. |
| 10 | **Redundant `reactions_user_id` FK** | Medium | `message_reactions` has both `user_id` and `reactions_user_id` referencing `users(id)`. It's unclear if both are needed — likely a design error. |

---

## 3. Data Integrity

### 🔴 Critical

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 11 | **No unique constraint on reactions** | High | `message_reactions` allows the same user to react to the same message with the same emoji multiple times. Add `UNIQUE(message_id, user_id, reaction)`. |
| 12 | **`companion_profiles.name` has no uniqueness constraint** | High | Duplicate companion names will cause confusion in the UI. |

### 🟠 High

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 13 | **`messages.content` is nullable** | High | A message without content is meaningless. Should be `NOT NULL`. |
| 14 | **`users.email` lacks length/format check** | Medium | Should add `CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')`. |
| 15 | **`users.name` could be empty string** | Low | Empty string ≠ null. Add `CHECK (name IS NULL OR length(trim(name)) > 0)`. |

---

## 4. Security

### 🔴 Critical

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 16 | **PII stored in plaintext** | Critical | `users.email`, `users.avatar_url`, `user_profiles.bio` are stored unencrypted. Email is especially sensitive under GDPR/CCPA. |
| 17 | **No row-level security (RLS)** | Critical | Any app user with DB access can query/modify any other user's data. No tenant isolation at the database level. |
| 18 | **No data access logging** | High | No audit trail for who accessed or modified sensitive data. |

### 🟠 High

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 19 | **`messages.metadata` is unrestricted JSON** | High | Could store sensitive tokens, API keys, or data without validation. |
| 20 | **`companion_profiles.system_prompt` is unvalidated** | Medium | Could be exploited for if user-editable. |
| 21 | **No encryption at rest** | Medium | PostgreSQL data is stored unencrypted. Should enable `pgcrypto` for sensitive fields. |

---

## 5. Scalability

### 🔴 Critical

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 22 | **N+1 query risk: messages without prefetch** | High | Fetching conversations then messages will cause N+1 queries. Needs composite index `messages(conversation_id, created_at)`. |
| 23 | **N+1 query risk: companion profiles** | High | Fetching conversations then companion profiles will cause N+1. Needs index on `companion_profiles(id)` (already PK) but queries should use JOIN. |

### 🟠 High

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 24 | **No partitioning on `messages`** | High | A single user can generate millions of messages. Without partitioning, queries degrade over time. |
| 25 | **No partitioning on `message_reactions`** | Medium | Reactions scale with messages. Consider same partitioning strategy. |
| 26 | **UUID/text IDs instead of serial/bigserial** | Low | `text` primary keys are larger than integers (12-16 bytes vs 4-8 bytes), causing larger indexes and slower JOINs. Consider `uuid` or `bigserial` for internal tables. |

---

## 6. Missing Features

### 🟠 High

| # | Feature | Severity | Details |
|---|-------|----------|---------|
| 27 | **No soft deletes** | High | Cannot recover accidentally deleted conversations or messages. Add `deleted_at` timestamp columns. |
| 28 | **No audit logging** | High | No record of who created/updated/deleted records. Required for compliance (SOC2, HIPAA). |
| 29 | **No data retention policy** | High | Messages accumulate forever. No TTL or archival strategy. |
| 30 | **No versioning for companion profiles** | Medium | Changes to `personality` or `system_prompt` are overwritten with no history. |

### 🟡 Medium

| # | Feature | Severity | Details |
|---|-------|----------|---------|
| 31 | **No full-text search on messages** | Medium | Users cannot search conversation history. Add `tsvector` column on `messages.content`. |
| 32 | **No read receipts** | Medium | No way to track if messages were read. |
| 33 | **No conversation sharing/permissions** | Medium | No multi-user conversation support. |

---

## 7. Migration Issues

### 🔴 Critical

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 34 | **Migration exists but never applied** | Critical | `20260101000000_001_create_migrations_table.sql` creates the tracking table, but no schema migration exists. |
| 35 | **No drizzle config** | Critical | `drizzle.config.ts` is missing, so `drizzle-kit` cannot generate or run migrations. |

### 🟠 High

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 36 | **DOWN migration drops the entire migrations table** | High | `DROP TABLE IF EXISTS migrations` will erase migration history. Should only remove the last entry. |
| 37 | **No rollback strategy for schema migrations** | High | Even if migrations existed, there's no `down` logic for table drops. |
| 38 | **No transaction wrapping** | Medium | Migration SQL isn't wrapped in `BEGIN; ... COMMIT;` — partial failures could leave DB inconsistent. |

---

## 8. Edge Cases

### 🔴 Critical

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 39 | **`timezone` stored as text** | High | `user_profiles.timezone` stores timezone names as strings (e.g., "America/New_York") with no validation against IANA database. Invalid timezones will break date calculations. |
| 40 | **`timestamp` default `now()` vs `clock_timestamp()`** | Medium | `now()` returns transaction start time. `clock_timestamp()` returns actual current time. For audit trails, `clock_timestamp()` is more accurate. |

### 🟠 High

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 41 | **`created_at`/`updated_at` use `timestamp` not `timestamptz`** | High | `timestamp` without timezone stores values as-is. If the app server is in a different timezone than the DB, dates will be inconsistent. Use `timestamptz`. |
| 42 | **Race condition: `conversations.last_message_at`** | High | Updated in application code, not via DB trigger. Concurrent message inserts could result in stale `last_message_at`. Should use a trigger or update in the same transaction as the message insert. |
| 43 | **No null handling for `last_message_at`** | Medium | Queries sorting conversations by `last_message_at` will put NULLs first or last unpredictably. |

### 🟡 Medium

| # | Issue | Severity | Details |
|---|-------|----------|---------|
| 44 | **`messages.metadata` default is `'{}'`** | Medium | An empty object is indistinguishable from "no metadata set". Consider using NULL for absent metadata. |
| 45 | **No validation on `companion_profiles.personality` JSON schema** | Low | Arbitrary JSON structure could cause runtime errors. |

---

## 9. Additional Observations

### Connection Setup (Missing)
- No `src/db/index.ts` or connection file found
- `package.json` references `DATABASE_URL` but there's no `.env` file
- Uses `drizzle-orm/node-postgres` with `pg` driver, but schema file imports from `@neondatabase/serverless` — driver inconsistency

### Seed Data
- No seed data files found
- No initial companion profiles or test users

---

## Priority Remediation Order

1. **Create `drizzle.config.ts`** and run first migration to create all tables
2. **Add indexes** on all foreign key columns and frequently-queried columns
3. **Change all `timestamp` to `timestamptz`** for timezone safety
4. **Add CHECK constraints** on `role`, `status`, `reaction` columns
5. **Add UNIQUE constraint** on `message_reactions(message_id, user_id, reaction)`
6. **Implement soft deletes** (`deleted_at`) on `conversations` and `messages`
7. **Add RLS policies** or application-level tenant isolation
8. **Encrypt PII fields** (`email`, `avatar_url`, `bio`) using `pgcrypto`
9. **Add composite indexes** for common query patterns
10. **Create audit logging** table and triggers
11. **Add full-text search** on `messages.content`
12. **Add data retention policy** for old messages
