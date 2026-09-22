# NOVA ADMIN CONTROL CENTER — PRODUCTION REPORT

**Scope:** conversion of the existing `apps/admin` console into an operational control plane for the whole NOVA platform.
**Verified against:** the running system — locally, PostgreSQL on :5433 (152 users, 132 reminders, 85 tasks, 191 sessions of which 175 active, 576 admin audit rows, 1 registered device), the API on :3001, and the actual Flutter client contract — and, since §10, against the **production deployment** at `nova.leadup.in` / `api.nova.leadup.in` / `admin.nova.leadup.in` (29 real user accounts, 386 sessions).
**Evidence standard:** every claim below is either (a) a file path, (b) a passing test, or (c) output from a live verification script run against the running API. Nothing is asserted from inspection alone.

Current verified state (2026-09-21, last full pass):

| Gate | Result |
|---|---|
| API unit/integration tests (`services/api`, `npx vitest run`) | 1058 passed, 64 files |
| Console typecheck + production build (`apps/admin`) | clean; 38 page routes built (31 navigation destinations + `/login`, `/privacy`, `/delete-account`, `/support`, `/users/[id]`, and the two legacy-only pages `/usage` and `/audit-logs`) plus middleware |
| Browser acceptance sweep (`tests/admin-console.spec.ts`) | 58 passed |
| On-device e2e (`integration_test/e2e/`), emulator | 3 passed — `converse_e2e_test.dart`, `task_creation_e2e_test.dart`, `reminder_update_e2e_test.dart` |
| `services/api/scripts/verify-replica-revocation.sh` | 10 checks, 0 failed — two live API processes |
| `services/api/scripts/verify-job-queue.sh` | 10 checks, 0 failed — worker, scheduler, retry, audit |
| `services/api/scripts/verify-platform-roles.py` | 190 checks, 0 failed (the printed count varies with data volume — see the note below) |
| `services/api/scripts/verify-control-plane.py` | 37 checks, 0 failed |
| `services/api/scripts/verify-control-gates.ts` | 12 checks, 0 failed |
| Flutter client (`apps/mobile`) | `flutter analyze` clean; `flutter test` 784 passed, 5 skipped; three on-device e2e tests passed on the emulator |
| Android acceptance run (`adb` + debug APK, **emulator**) | **run on a Pixel emulator (Android 17), not on physical hardware.** See §4.3. |
| Live deployment (`github.com/leadupofficial/nova-leadup` → `91.107.202.66`) | images rebuilt from `main` **on the server**; 16/16 migrations applied; 57 tables; all 29 pre-existing accounts preserved. See §10 |
| Live browser sweep (`https://admin.nova.leadup.in`, real TLS, real API) | **34 destinations passed, 0 failed** |
| Live control-plane API (`https://api.nova.leadup.in/api/v1/control/*`) | present and refusing anonymous requests with 401 — **404 on every route before this deploy** |
| Physical-device acceptance run | **NOT RUN — `adb devices` reports no attached device.** The brief's final rule is still unsatisfied. See §10.6 |

**On the verifier's check count.** It is not a fixed number: several sections assert inside loops over
whatever the database currently holds (sessions, recorded AI durations, voice-usage rows), so fewer rows
means fewer printed checks. Every run reports `0 failed`, and each section added in the last five rounds
(16–20) prints its full complement. The figure is quoted with that caveat so a future reader does not
treat it as a fixed budget.

**Three verification-script brittleness fixes, each found by a script failing on a correct system.**
`verify-job-queue.sh` resolved the token script relative to the caller's working directory, so running it
after a `cd` anywhere else minted no token and reported five authenticated checks as failures — it now
resolves its own path, and was re-run from two directories to confirm. `verify-replica-revocation.sh`
reported three failures when the second replica simply was not running; it now checks that precondition
first and prints the command to start one, because "you did not start the second process" should not read
like "cross-replica revocation is broken". The third is described in §7.2: the python verifier asserted
a fresh failed-login address against a top-ten ranking it could never enter, and posted auth calls without
pacing. A verifier that raises false alarms is worse than no verifier.

> **Correction, recorded rather than quietly amended.** An earlier revision of this report claimed
> "All 25 Control Center destinations are now implemented and verified in a real browser." Both
> halves were wrong. The navigation model declares **31** destinations, and **three of them —
> `/environment`, `/sessions`, `/ai/secrets` — were links with no page behind them**, so clicking
> them returned 404. The browser sweep did not notice because its list of destinations was typed by
> hand and matched the pages that existed, not the links the console rendered; a list that is
> derived from the thing it is supposed to check cannot fail. The list is now **generated from
> `NAV_GROUPS`** and a separate test walks every href the sidebar actually renders, so this class of
> drift can no longer pass. All three pages are now built. See §7.1.

---

## 1. Headline finding

The Admin Panel **looked complete and controlled nothing.**

Before this work:

- `feature_flags` was a table with a full CRUD screen. **No code read it.** Grepping `featureFlags` across `services/api/src` and `apps/mobile/lib` returned only the admin routes and the settings route that listed them. Toggling a flag changed a row.
- The Flutter app fetched **no remote configuration of any kind** — no feature flag, no kill switch, no maintenance mode, no minimum-version or force-update check anywhere in `apps/mobile/lib`.
- Every `/admin/*` route was gated on `role IN ('owner','admin')`, making `admin` a synonym for root: the same principal who could read an audit log could also rotate the Anthropic key and suspend any user.
- The Anthropic "health check" compared the key's first four characters to `sk-ant-` and reported **up**. A revoked key reported healthy.
- There was no runtime configuration, no secret storage, no admin audit log, no emergency control, and no way for an operator to affect production without a code change or a `.env` edit.

This report documents what was built to fix that, and what is still genuinely missing.

---

## 2. What was built

### 2.1 Data model — migration 0006

`packages/database/drizzle/0006_admin_control_center.sql`, plus `packages/database/src/schema-admin.ts`.

Six tables: `admin_audit_logs`, `system_configs`, `feature_flag_overrides`, `provider_health_checks`, `job_executions`, `admin_sessions`.

Three properties are enforced by the database rather than promised by application code:

| Property | Mechanism | Verified |
|---|---|---|
| The admin audit log is append-only | `BEFORE UPDATE` / `BEFORE DELETE` trigger that raises `restrict_violation` | `verify-admin-tables.ts` — both tamper attempts rejected |
| Secret rows cannot hold plaintext | `CHECK (scope <> 'secret' OR value IS NULL)` | migration applied |
| Enumerations cannot be typo'd | `CHECK` on control outcome, provider status, job status, flag scope | migration applied |

Design notes worth keeping:

- The audit log denormalises `actor_email` and `actor_role`. A later role change or account deletion must not rewrite what someone did.
- `job_executions` keeps its row when a user is deleted (`ON DELETE set null`); `admin_sessions` cascades. Deleting a user must not erase operational history.
- `schema-admin.ts` is **import-free on purpose**: it is loaded by `tsc` (Node ESM, needs a `.js` extension on relative imports) *and* by `drizzle-kit generate` (CommonJS `require`, which cannot resolve that extension). The foreign keys are therefore declared in the migration. This was learned the hard way — see §7.2.
- Migration 0006 is idempotent (`CREATE TABLE IF NOT EXISTS`, guarded `DO $$` blocks), because a first attempt partially applied.

#### Migrations added since

| Migration | What it does | Why it is not just a schema change |
|---|---|---|
| `0007_platform_admin_roles` | `platform_admin_roles` — one grant per account, unique `user_id`, role `CHECK` | Makes role assignment from the console real; permissions are resolved per request, so a grant takes effect without a re-login. |
| `0008_device_registration` | `devices.user_id` nullable, plus `installation_id`, `platform_version`, `model`, `app_version` and a unique index on `installation_id` | A device is registered at first launch, before sign-in, so requiring an owner would have meant not reporting pre-login devices at all. |
| `0009_message_latency` | `conversation_messages.duration_ms` | Turns "AI latency" from NOT AVAILABLE into a measured mean, p95 and per-model breakdown. |
| `0011_admin_mfa` | `admin_mfa` — encrypted TOTP secret, `confirmed_at` gate, `last_used_counter`, hashed recovery codes | A second factor that gated sign-in before it was confirmed would lock an operator out of the platform that holds the recovery path; `confirmed_at` is what makes enrolment safe to start. |
| `0012_provider_check_fingerprint` | `provider_health_checks.secret_fingerprint` | Records which credential a connectivity test exercised, so a rotated key stops being reported as tested (§7.14). |
| `0013_service_logs` | `service_logs` — the durable log store the console's Logs page reads, with indexes on time, level and correlation id | The route used to answer `available: false` and name its own fix; this is that fix, and the level filter, retention window and drop counter are all reported beside the rows so an empty table is not read as calm (§7.17). |
| `0014_revoked_tokens` | `revoked_tokens` — jti, subject, expiry, revocation time, indexed on both time columns | Replaces an in-process denylist, so a force-logout is honoured by every replica within one poll interval instead of never (§7.18). |
| `0015_job_queue` | `job_executions.run_at` and `enqueued_by`, plus a `(status, run_at)` claim index and a partial index on running rows | Turns a queue-shaped table into a queue: `run_at` is what makes a retry backoff and a scheduled job expressible, so the periodic work could leave the in-process timers (§7.20). |
| `0010_reminder_delivery` | `reminders_triggered_change` trigger: on the NULL → non-NULL transition of `triggered_at`, append a `triggered` row to `reminder_events` | `triggered_at` had no writer, so "reminders executed" was NOT AVAILABLE and the revision history had no "fired" step. A trigger rather than application code, for the reason 0004 already records for `trigger_at`: the journal stays correct for any future writer, and the acknowledge route must not insert or every acknowledgement is counted twice. `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS`, so re-running the file is a no-op. No backfill: nothing recorded delivery before now, so existing rows stay NULL, which the console reports as "no acknowledgement recorded" rather than as zero. |

`drizzle/meta/_journal.json` carries all of them, and `packages/database/scripts/migration-status.ts`
reports ten applied rows: ids 1–6 and 8–11. **Id 7 is absent**, dating from the hand repair that
`repair-admin-migration.ts` exists for. Every migration's *effect* is present — verified live against
`information_schema` and `pg_trigger`: `platform_admin_roles`, `devices.installation_id`,
`conversation_messages.duration_ms`, the 0004 trigger function, and now the 0010 trigger and
function. So this is a gap in the bookkeeping rather than an unapplied migration, recorded here
because a reader comparing the counts will notice it.

### 2.2 RBAC — server-side, 47 permissions, 7 roles, assignable from the console

`services/api/src/admin/permissions.ts`, `services/api/src/admin/access.ts`.

Roles: `SUPER_ADMIN`, `PLATFORM_ADMIN`, `SUPPORT_ADMIN`, `OPERATIONS_ADMIN`, `ANALYTICS_ADMIN`, `DEVELOPER`, `READ_ONLY`, mapped from the platform `role` claim (`owner` → SUPER_ADMIN, `admin` → PLATFORM_ADMIN, and so on).

Enforcement properties:

- **Every** control route names the permission it needs via `requirePermission(...)`. The frontend hiding a button is presentation; the 403 is the control.
- **Denials are audited.** `requirePermission` writes a `denied` row *before* throwing. This is what makes an over-reaching or compromised admin account visible. Live evidence: 20 denial rows recorded during verification.
- **An unknown role fails closed.** `toAdminRole` returns null and every permission check denies.
- **Self-escalation is refused.** `assertNotSelfEscalation` blocks any role or suspension change targeting the caller's own account.
- **`admin_users.manage` and `config.secrets` are held by SUPER_ADMIN alone.** This is asserted by test, so a future edit cannot quietly widen them.
- **Roles are assignable from the console.** `platform_admin_roles` (migration 0007) holds one
  grant per account; a grant decides the account's permissions on its next request, and an
  account with no grant falls back to the token's `role` claim, which is how every deployment
  behaved before. Four guards, all in `admin/roles.ts` so no call site can forget one:
  only a SUPER_ADMIN may grant; a grant above the caller's own rank is refused
  (`RANK_EXCEEDED`); self-changes are refused (`SELF_ESCALATION_BLOCKED`); and the last account
  able to manage administrators cannot be demoted or revoked (`LAST_SUPER_ADMIN`, and
  `WOULD_DEMOTE_SUPER_ADMIN` for narrowing the top role through this path at all).

  Why a new table rather than `roles`/`role_bindings`: those model *tenant* roles —
  `roles.organization_id` is `NOT NULL` and uniqueness is per organization. A platform operator
  is not scoped to a tenant, so reusing them would have meant inventing an organization called
  "platform" for the next reader to decode.

Proven live against the running API:

| Principal | Action | Result |
|---|---|---|
| SUPPORT_ADMIN | write a secret | 403 |
| SUPPORT_ADMIN | operate a kill switch | 403 |
| SUPPORT_ADMIN | create / update a flag | 403 |
| SUPPORT_ADMIN | write config | 403 |
| SUPPORT_ADMIN | enter maintenance mode | 403 |
| SUPPORT_ADMIN | configure AI | 403 |
| SUPPORT_ADMIN | suspend a user | **200** (by design — that is the role's purpose) |
| READ_ONLY | read analytics / services / flags | 200 |
| READ_ONLY | list users, read audit log, write anything | 403 |
| no token | anything | 401 |

### 2.3 Secret storage — AES-256-GCM

`services/api/src/admin/secrets.ts`.

Secrets are encrypted before they reach the database and **never returned by any API**. The only readable remnant is a masked hint (`••••••••91AB`).

- Authenticated encryption: a tampered ciphertext fails to decrypt rather than yielding attacker-influenced plaintext.
- **Production refuses to encrypt without an explicit key.** `NOVA_CONFIG_ENCRYPTION_KEY` is required; outside production a development-only key is derived from `JWT_SECRET` with a loud warning. Coupling the two in production would mean rotating the signing key silently makes every stored secret undecryptable.
- Key rotation is supported per record through `NOVA_CONFIG_ENCRYPTION_KEY_PREVIOUS`.
- Verified live: 17 secret entries inspected through the API read model, **zero** value leaks.

### 2.4 Runtime configuration — and honesty about what is wired

`services/api/src/admin/config.ts` (catalog + resolver), `services/api/src/admin/runtime-config.ts` (synchronous overlay).

The catalog was derived by **inspecting what the repository actually reads**, not invented. Every key carries `usedBy` (the real consumers) and `readByRuntime`.

This last field exists because of a genuine defect found during this work: the console presented `AI_DEFAULT_MODEL`, `STT_PROVIDER` and friends as controls, while a grep proved nothing read them. A configuration screen that implies control it does not have is the most misleading thing it could ship. So:

- **Wired and live:** `AI_DEFAULT_MODEL`, `AI_MAX_TOKENS`, `STT_LANGUAGE`, `REMINDER_ENABLED`, `PROACTIVE_ASSISTANT_ENABLED`, `BACKGROUND_ASSISTANT_ENABLED`, `MEMORY_ENABLED`, the `CONTROL_*` kill switches, and the `MOBILE_*`/maintenance keys read by the bootstrap endpoint.
- **Declared but inert, and labelled as such in the UI:** `AI_FALLBACK_MODEL`, `AI_TIMEOUT_MS`, `AI_RETRY_COUNT`, `STT_PROVIDER`, `TTS_PROVIDER`. The API reports each with the reason a stored value does nothing.
- **Environment-only, and refused with 409:** `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_TOKEN_SECRET`, `NOVA_CONFIG_ENCRYPTION_KEY`. A database row does not change a running process's environment, and pretending otherwise is exactly the deception to avoid.

Precedence is `database → process environment → catalog default`. Two defaults were corrected during regression testing because they contradicted the code (`AI_DEFAULT_MODEL` had a default that shadowed `ANTHROPIC_MODEL`; `AI_MAX_TOKENS` said 2048 while `LLM_MAX_OUTPUT_TOKENS` says 4096).

### 2.5 Feature flags that actually control the mobile app

`services/api/src/admin/flags.ts`, `services/api/src/routes/device-bootstrap.ts`, and the Flutter side in `apps/mobile/lib/core/config/`.

This is the part that turns a dashboard into a control plane.

**Resolver precedence:** user override → organization override → environment override → global flag and rollout → the caller's documented default.

**A percentage rollout is deterministic, not a coin flip.** `rolloutBucket` hashes `sha256(flagKey:userId)` into 0–99. A per-request random draw would put a user inside a 50% rollout on one request and outside it on the next, which is not a rollout. Tested for stability (50 repeat evaluations agree), range, and rough uniformity across 4 000 subjects.

**The client contract** is `GET /api/v1/device/bootstrap` (optional auth). It returns a flat `flags` map *and* a `flagDetails` array explaining each decision, plus `capabilities` that already fold the kill switches in, maintenance state, and the version gate. The Flutter client:

- fetches it after the first frame and on every resume (`apps/mobile/lib/app/app.dart`), never on the critical path to the first painted frame;
- gates the realtime voice pipeline before it opens the microphone (`voice_realtime_controller.dart:startTurn`), so an operator disabling voice cannot leave a user speaking into a dead session;
- renders a blocking maintenance screen and a required-update screen through `RemoteControlGate`, wrapped inside the error boundary so it covers every route;
- **defaults an unknown flag to the caller's fallback, never blindly to `false`** — introducing a flag must not remove a feature;
- **treats a failed fetch as "no news", not as "disabled"**, keeping the last good document so a network blip cannot be mistaken for a kill switch.

### 2.6 The background engines obey the switches — a correction

**A correction to an earlier version of this report.** It claimed that disabling background jobs made
the follow-up engine, retention sweep and recording reaper "skip their runs". That was **false when
written**: none of the three consulted any switch. The console reported background jobs disabled,
the dashboard repeated it, and every sweep kept running — with retention **continuing to delete user
data**. An operator would have believed they had stopped it.

That is the worst failure a control plane can have, so it is now fixed and separately verified:

| Engine | Reads |
|---|---|
| `jobs/follow-up-engine.ts` | `proactiveGate()` — background-jobs switch, proactive switch, maintenance mode, `PROACTIVE_ASSISTANT_ENABLED` |
| `jobs/retention.ts` | `backgroundJobsGate()` — checked before any read, since the sweep deletes irreversibly |
| `jobs/recording-reaper.ts` | `backgroundJobsGate()` — pausing leaves work queued rather than lost |

Both gates live in `admin/enforcement.ts`, so the three engines share one definition, and both are
**injectable** (`options.gate`) following the same pattern as `deleteObject` and `requeue` — which
is also what makes the engine's decision testable without mocking a module graph.

**A second real defect fell out of verifying this.** `invalidateConfigCache()` cleared the
synchronous runtime overlay without republishing it. An empty overlay makes `runtimeConfigValue`
fall through to the environment and the catalog default, so `PROACTIVE_ASSISTANT_ENABLED=false`
stored by an operator read as *unset* and the gate still allowed the run. `invalidateConfigCache()`
is now `async` and awaits the republish, so a config route does not return until the value is in
effect, and every caller awaits it.

### 2.6.1 The switches themselves, and where they are enforced

`services/api/src/admin/control.ts`, `services/api/src/admin/enforcement.ts`.

Maintenance mode and kill switches for AI, voice, STT, TTS, background jobs, proactive assistant, notifications and realtime. They are stored in `system_configs`, audited with a mandatory reason, and **enforced at the route mount** in `server.ts`:

```ts
apiV1.use('/ai',            requireCapability('ai'),            aiRoutes);
apiV1.use('/conversations', requireCapability('ai'),            conversationsRoutes);
apiV1.use('/chat',          requireCapability('ai'),            chatRoutes);
apiV1.use('/voice',         requireCapability('voice'),         voiceRoutes);
```

Verified live: with `CONTROL_AI_ENABLED=false`, the bootstrap reports `capabilities.ai=false`, `POST /chat` returns **503** with `code: CAPABILITY_DISABLED`, and the realtime WebSocket refuses new upgrades.

Two deliberate design choices:

- **Fail open on a control-lookup failure, fail closed on a known-off control.** An infrastructure hiccup must not become a platform-wide outage; a kill switch is meant to be thrown by a human, so its *absence* should never take NOVA down.
- **`503` with a machine-readable code, not `403`.** The client must distinguish "temporarily unavailable" (show the message, keep the session) from "not allowed" (sign out).

### 2.7 Provider connectivity tests that make a real call

`services/api/src/admin/providers.ts`.

The previous check declared Anthropic healthy from a string comparison. Every test here makes a real authenticated call, choosing a read-only endpoint where one exists so testing does not bill a completion:

| Provider | Method |
|---|---|
| Anthropic | `GET /v1/models` |
| Deepgram | `GET /v1/projects` |
| ElevenLabs | `GET /v1/user/subscription` (also reports quota) |
| Sarvam | 1-character synthesis (labelled in the response as the one that is not free) |
| PostgreSQL | `SELECT 1` + version |
| Redis | `PING`, reporting `not_configured` rather than `fail` when unset |
| Object storage | `HeadBucket` |
| Firebase | service-account shape validation (no push sent) |
| Stripe | `GET /v1/balance` |

Results persist to `provider_health_checks` so the dashboard shows history without re-testing.

### 2.8 Metrics that state their own provenance

`services/api/src/admin/metrics.ts`, `services/api/src/admin/pricing.ts`.

Every metric is one of three things and the API says which: a number, a number with a `caveat` sentence, or an explicit `unavailableReason` **plus the instrumentation that would fix it**. There is no fourth state where a missing signal renders as `0`.

Examples taken from the live system:

- **AI latency** — was NOT AVAILABLE because nothing recorded how long a completion took. It is
  now measured: `conversation_messages.duration_ms` is written around the full assistant tool
  loop by `routes/chat.ts` and `routes/conversations.ts`, and the console reports the mean, the
  **p95** (the tail a user actually notices) and a per-model breakdown. When only part of the
  history carries timing, the tile says so — an average over 3 of 500 requests is a curiosity,
  not a latency figure.
- **STT/TTS request counts and volumes** — were NOT AVAILABLE because nothing counted them;
  `usage_records` held only stored-audio seconds. Now metered on the REST speech routes, recording
  both a count and a volume, because a count cannot explain a spend change and a volume cannot
  reveal a client retry-looping. Metering is fire-and-forget — a user waiting to hear NOVA must not
  be delayed by a metrics write — and a failed transcription records nothing, which is why a rejected
  call moves neither counter.
  **Correction to an earlier revision of this bullet.** It said the tile "carries a caveat naming the
  one path still unmetered: the realtime WebSocket". The realtime path *was* unmetered when that was
  written and no longer is: `realtime/session.ts` already computed per-provider STT bytes and
  per-provider TTS characters for its cost log and then discarded them, writing only `voiceSeconds`.
  Both legs are now metered from the same data through `planRealtimeTurn()` — one request per leg
  regardless of sentence count, zero writes nothing, and a mid-turn provider fallback is attributed
  to the provider that carried most of the turn. The caveat was rewritten to state the *unit*
  ("per call, not per sentence") rather than to warn about a gap that had closed, because a caveat
  that outlives its defect is just a different kind of false statement.
- **Reminders acknowledged** — was NOT AVAILABLE, and truthfully so: `reminders.triggered_at`
  existed and **nothing in the codebase ever wrote it**, so a reminder the user saw and one that
  merely came due were the same row. It is now written. The chain is
  `POST /api/v1/reminders/:id/acknowledge` (called by the app when the user opens the reminder's
  notification) → `triggered_at` → the `reminders_triggered_change` trigger in migration 0010
  journals it → the tile and the `/reminders` page read it.
  **Two deliberate honesty constraints.** It is labelled *acknowledged*, not *executed*: the OS
  arms the alarm and fires it with the app closed, so the firing instant is never reported to the
  server — a tap is. And the caveat is unconditional rather than shown only when something looks
  odd, because the number is 0 on any deployment still running an app build that does not call the
  endpoint, which is a fact about the client rather than about reminders. Deliberately **not**
  presented as a delivery *rate*: that would need a delivery count, and nothing records one.
- **Registered devices, app versions and OS versions** — these were empty because `devices`
  had **no writer at all** in either the API or the client. Both halves now exist
  (`POST /api/v1/device/register` and `apps/mobile/lib/core/api/device_registration.dart`), so
  the tiles report real adoption as clients launch. Verified live: registering, re-registering
  the same installation (one row, updated) and reading the version back from the metrics.
- **DAU/WAU/MAU** — derived from `sessions.created_at`, and the caveat is *computed*: when the 30-day count equals the all-time count and the 1-day count is most of it, the page says these reflect sign-ins in the window, not distinct daily actives. A healthy environment stops showing the caveat automatically.

Cost is estimated from persisted token counts against a published rate table. **A model with no price on file is reported as "no price on file" and excluded from the total**, never guessed. `glm-5.3` appears in this environment's data and is exactly that case.

### 2.9 API surface

81 routes across eleven routers in `services/api/src/routes/admin/`, mounted under `/api/v1/control`:

| Router | Routes | Domain |
|---|---|---|
| `metrics.ts` | 8 | dashboard, platform/activity/AI/reliability metrics, cost, services, provider tests |
| `users.ts` | 9 | list, detail, update, suspend, revoke sessions, reset state, conversation content, reminder history, admins |
| `operations.ts` | 14 | conversations, tasks, reminders, memory, proactive, jobs, tool executions, notifications, realtime, audit-adjacent summaries |
| `system.ts` | 22 | config, config validation, config write, secrets, provider tests, feature flags and overrides and evaluation, controls, maintenance, environment, database health, services, logs, traces, admin audit log |
| `ai.ts` | 10 | AI providers, models, routing, provider test, AI metrics, voice config/health/test, AI config, avatar config |
| `roles.ts` | 4 | platform role grants: catalog, list, grant/replace, revoke |
| `sessions.ts` | 2 | platform-wide refresh-session inventory, single-session revoke |
| `admin-sessions.ts` | 2 | administrator console sessions: list, immediate revoke |
| `security.ts` | 1 | Security Center overview: sign-ins, refusals, sessions, changes, credentials |
| `mfa.ts` | 6 | administrator two-factor: status, enrol, confirm, coverage, recovery codes, disable |
| `permissions.ts` | 2 | the permission catalogue with the role matrix, and the caller's own resolved authority |

The first count published here said "63 routes across five routers" and omitted `roles.ts`, because
the count was taken from a table that had been written before role assignment existed. Recounted from
the source (`grep -cE 'router\.(get|post|put|patch|delete)\('` per file) rather than from the table.

`sessions.ts` is new in this round. The console has linked to `/sessions` from the day the navigation
model was written, and no route existed to back it, so "how many sessions are live right now" and
"kill *that one* token, not every token this user owns" were both unanswerable through the console.
Revoking a single session is a narrower action than `POST /control/users/:id/revoke-sessions`, which
signs a person out of their own phone along with whoever stole the token.

**Why `/control` and not `/admin`:** the legacy `routes/admin.ts` is the surface the admin screen inside the Flutter app depends on, and it already owns paths like `GET /admin/dashboard` and `PATCH /admin/feature-flags/:id`. Express answers with whichever handler was registered first, so mounting both at `/admin` made the new key-addressed `PATCH /admin/feature-flags/PROACTIVE_ASSISTANT` fall through to the legacy uuid handler and fail with a Postgres parse error. Two namespaces remove the ambiguity: the legacy contract keeps working byte-for-byte, and every Control Center route is reachable and independently permissioned.

### 2.10 A real bug fixed in passing

The user-detail endpoint returned **HTTP 500** on a live account. Root cause: the query selected `memories.type`, and the column is `memories.category`. Found by running every query the view issues against the real database, not by reading the code. Fixed, and all 16 queries now execute cleanly.

---

## 3. Console UI

`apps/admin` builds and typechecks clean (`next build`, `tsc --noEmit`).

Implemented in full:

| Page | What it does |
|---|---|
`/` | Dashboard: platform, NOVA activity, AI usage, provider health, reliability — with every unavailable metric labelled and explained. The emergency-control banner is the first thing on the page.
`/feature-flags` | Real flags including the "no row yet" state, rollout percentage with a **deterministic bucket preview**, per-user/organization/environment overrides, evaluation by key, typed-confirmation delete.
`/configuration` | Every declared key with its effective source, what it affects, and a plain **"live" vs "not wired"** marker. Secret write/rotate/remove, masked, with a typed confirmation.
`/maintenance` | Maintenance mode with the user-facing message, and every kill switch with **the concrete user-visible consequence** written next to it.
Navigation | Grouped (Dashboard → Users → Assistant → AI & Voice → Operations → Analytics → System → Security), filtered by role, collapsible, with the permission count shown.

All **31 Control Center destinations** declared by `apps/admin/src/lib/nav.ts` are implemented and
verified in a real browser (see §4.2). The browser sweep's list is generated from that same
navigation model, and a separate test walks every link the rendered sidebar emits, so a destination
can no longer exist in the navigation without a page behind it.

| Page | What it does |
|---|---|
`/users` | Server-paginated list with search and status filter, per-row batched counts, pagination as bookmarkable URLs.
`/users/[id]` | The full account view: capability checks resolved by the real flag engine for that user, sessions with force-logout, devices, conversations, tasks, reminders, memory, notifications, account audit trail, suspend/reactivate.
`/conversations` | Metadata only — mode, model, message and token counts. Content stays behind its own permission.
`/tasks`, `/reminders` | Filterable, with in-place status/priority/due-date and reschedule/dismiss edits, each requiring a reason.
`/memory` | Personal data, audited on read, erasure behind a typed confirmation.
`/proactive` | Reconstructed from notification rows, with a section stating what it cannot answer.
`/jobs` | Execution history plus the scheduled-engine inventory, and why retry returns 501.
`/notifications` | Volume by type with the delivery-record limitation stated.
`/realtime` | Local session count and transport state, with the missing metrics named.
`/analytics`, `/cost` | Real metrics with the three-state contract; per-model cost with unpriced models excluded rather than guessed.
`/ai`, `/voice`, `/avatar` | Providers, models, routing, real connection tests, voice config and tests, avatar enablement.
`/services` | Discovered services, dependency tests, database size/connections/slow queries/migrations.
`/configuration`, `/configuration/validate` | Every declared key with its source and a **live vs not-wired** label; validator combining declared config with live provider calls.
`/feature-flags` | Flags, deterministic rollout preview, overrides, evaluation by key.
`/maintenance` | Maintenance mode and every kill switch with its user-visible consequence.
`/security/audit-log` | The append-only administrator audit log, with before/after snapshots.
`/security/admins`, `/permissions` | Who has acted in the control plane, and the full permission matrix.
`/logs` | Correlation-id lookup with the span gap stated.

The three destinations that previously had no page behind them (§7.1):

| Page | What it does |
|---|---|
`/environment` | Deployment identity and safety envelope: which environment this console is acting on, rendered as an unmissable verdict banner (production is dark red and says so in words), the API's own identity (NODE_ENV, node version, pid, uptime, RSS/heap), the live capability switches already off on this deployment, database size/connections, applied migrations, and the discovered service targets. Deliberately read-only — the mutations live on Maintenance, so there is one path to each change. It states that it cannot count the repo's migration files from inside the container rather than showing an invented "expected" number.
`/sessions` | Platform-wide refresh-session inventory: account, derived state (`active` / `expired` / `revoked`), origin IP and user-agent, bound device, start and expiry, and a per-row **revoke this session** with a required reason. Server-filtered by state and by email/name/IP/user-agent, with a per-state tally from the same predicate as the rows. State is derived on the server, because `revoked_at IS NULL` alone would report a three-week-old expired session as a live login.
`/ai/secrets` | Provider-credential inventory: which keys are configured and from where (encrypted store / process environment / not set), masked hint, last change and by whom, **which connectivity test covers the key** and when it last ran and with what result, plus a real provider test per key and store/rotate/remove. Removing a stored value says explicitly when the process environment still supplies it, because in that case the provider is *not* disabled.

The legacy pages (`/organizations`, `/usage`, `/audit-logs`, `/incidents`, `/languages`, `/deletion-requests`) remain in place against the legacy `/admin` surface.

---

## 4. Cross-system verification — the decisive test

`services/api/scripts/verify-control-plane.py`, **37 checks, all passing**, against the running API.

`services/api/scripts/verify-control-gates.ts`, **12 checks, all passing** against the live control
store. It writes real `CONTROL_*` rows, calls the real gate functions, asserts the exact reason each
returns, and restores every key — including deleting keys that did not exist before. This is what
proved the background engines now refuse, and it is what exposed the overlay-republish defect.

`services/api/scripts/verify-platform-roles.py`, **85 checks, all passing** — role assignment, device
registration, AI-latency instrumentation, voice-usage metering, the session inventory, and reminder
acknowledgement. It proves
that a grant changes an account's effective permissions *without a re-login* (narrowing an `owner`
claim to READ_ONLY makes a config write return 403 while aggregate reads still work), that elevating
through the same path works, that revoking restores the claim, and that each guard refuses with its
own code. Every grant, revocation and refusal is confirmed present in the audit trail.

Section 13 covers reminder acknowledgement end to end: a reminder is created for a synthetic
account, the first acknowledgement reports `firstAcknowledgement: true` with an instant, a repeat
reports `false` with the **same** instant, a different account is refused with 404, the admin list
finds the row under the `acknowledged` filter with `revisions ≥ 1` (proving migration 0010's trigger
wrote the journal), the metric moves by exactly one and is no longer `unavailableReason`-flagged,
its caveat says it counts acknowledgements rather than deliveries, and the probe reminder is deleted
so the run leaves nothing behind.

Section 12 is the evidence for the session inventory: the three states
are pairwise disjoint, the per-state tally equals the size of each filtered list, an unknown filter
value is refused rather than treated as "all", a READ_ONLY operator is refused 403, revoking a
non-existent session is a 404, a malformed id is a 400, revoking without a reason is a 400, a real
revoke succeeds and revokes exactly one session, revoking the same session twice is a **reported
no-op** rather than an error, and the audit log holds a `session.revoke` row typed to that session
with the operator's reason. The probe only ever targets a session belonging to a synthetic
`@test.example.com` account — it runs against a real database, and revoking a real person's refresh
token to prove a route works would be an outage caused by a test.

`packages/database/scripts/verify-platform-roles.ts` and `verify-device-schema.ts` confirm the
migrations: the new tables carry their foreign keys and CHECK constraints, and the three
foreign keys from migration 0006 survived a regenerated migration that tried to drop them.

```
 0. API reachable                                            PASS
 1. Idempotent starting point                                PASS
 2. Admin ENABLES a flag  -> mobile bootstrap reflects it     PASS
 3. Admin DISABLES it     -> mobile bootstrap reflects it     PASS
 4. Rollout 0% reaches nobody; 100% reaches the user          PASS (both)
 5. Per-user override beats a disabled global flag            PASS
 6. Kill switch: capabilities.ai=false, POST /chat -> 503     PASS (x3)
    refusal code = CAPABILITY_DISABLED
 7. Restore: flag removed, documented default restored        PASS
 8. RBAC: 8 SUPPORT_ADMIN refusals + 2 allowed actions         PASS (x10)
    READ_ONLY: 3 allowed reads + 5 refusals                    PASS (x8)
 9. Anonymous access refused (401)                            PASS
10. 17 secret entries inspected, zero leaks                    PASS (x2)
11. Audit log holds every action and every refusal             PASS (x3)
12. No API path mutates the audit log                          PASS
```

The chain asserted at each step is exactly the objective's: **admin change → backend state → client contract → audit record.**

Unit and integration tests: **8 tests** in `services/api/src/__tests__/reminder-acknowledge.test.ts`
covering owner scoping (another account's reminder is a 404, not a write), the strict empty body that
refuses a client-supplied timestamp, first-vs-repeat acknowledgement, the losing side of a concurrent
tap, and the assertion that the route writes **nothing** to `reminder_events` — the trigger owns that
row, and an application insert would double every acknowledgement. **49 tests** in
`services/api/src/__tests__/admin-control-center.test.ts` covering the RBAC matrix (including that `admin_users.manage` and `config.secrets` have exactly one holder each), AES-GCM round-trip and tamper rejection, redaction, deterministic rollout, config validation, version comparison, the guarantee that no secret value appears in the read model, and the provider→credential-key mapping that the "last tested" join depends on. Plus **19 tests** for the session routes (`admin-sessions.test.ts`) and **20** for voice metering (`voice-usage-metering.test.ts`, 12 of them for the realtime turn plan).

Full API suite: **946 passing, 55/55 files — fully green.** Two time-of-day-dependent tests were found and fixed along the way; see §7.2. The Flutter suite is **772 passing, 5 skipped**, including 6 new tests for the tap path.

### 4.2 Real-browser acceptance — every console page

`tests/admin-console.spec.ts`, Playwright against the running console at :3000 with a real admin token in both the cookie and `localStorage`:

```
45 passed (13.5s)
```

It does not merely check HTTP status. A Server Component that throws still returns **HTTP 200** with an error boundary in the streamed payload, which a status-code check reports as healthy. For each of the **31 destinations** — the list is now `NAV_GROUPS.flatMap(...)`, imported from the console's own navigation module rather than typed out — the test asserts:

- the console shell rendered (the auth guard admitted the session);
- the page's own `<h1>` is present, which is what distinguishes "the routed page rendered" from "only the sidebar rendered";
- the streamed payload contains **no React error digest**;
- none of the known Next.js failure markers appear in the text;
- the page did not render an "could not reach the admin API" or "Could not load" card, so a page whose data never arrived fails rather than passing on its heading.

One test is different from the rest and exists because of the defect described in §7.1: it reads every `href` out of the rendered `<nav>`, asserts the sidebar offers every destination the model declares, and then **visits each one** and requires 200 with a real page. That is the check that would have caught `/environment`, `/sessions` and `/ai/secrets` returning 404, and the hand-typed list could not.

Plus thirteen critical-path tests: the unauthenticated redirect; the dashboard showing a real figure *and* admitting what it cannot compute; opening a user and reaching the capability table; the flag page demonstrating deterministic rollout; the configuration page labelling keys live-or-not-wired; the maintenance page stating what each switch breaks; the audit log stating its append-only guarantee; and one per page asserting the specific claim it exists to make — `/environment` names the deployment it is acting on and what is already switched off, `/sessions` says how a revocation propagates, `/ai/secrets` reports test *coverage* rather than asserting "never tested", `/ai` renders provider ids and models with no `[object Object]`, `/reminders` keeps "acknowledged" and "overdue" apart, and the dashboard names the reminder figure for what it measures.

**This test found three real defects that every other check had passed:**

1. `/configuration` threw `Cannot read properties of undefined (reading 'category')` on **every render**. The route returns entries under `configs`; the console's reader looked for `entries` and `views` — two keys the route has never used — so the flattened list was empty. It compiled because the response is typed loosely at the boundary.
2. `/feature-flags` threw `Cannot read properties of undefined (reading 'key')`, for the same class of reason: the page read `flag.hasRow` while the API names it `rowExists`.
3. The console's default `NEXT_PUBLIC_API_BASE` was a **hard-coded deployment address** (`http://91.107.202.66:3001/api/v1`). A local `next start` with no `.env.local` therefore sent every server-side fetch to an unreachable host and the entire console rendered "Could not reach the admin API". The default is now `http://127.0.0.1:3001/api/v1`, so a missing value fails loudly and locally instead of silently targeting someone else's server.

The first two are exactly the failure mode a status-only test cannot see, and both would have shipped unnoticed.

**What it still could not see, and what was added because of it.** All three of the defects found this
round rendered cleanly as far as this test was concerned: a page with a blank provider-id column, a
"[object Object]" models cell and a false "never tested" on every row has an `<h1>`, no error digest
and no failure marker. So the sweep was extended with the four claim-specific tests above, and the
destination list was made derived rather than typed. The general lesson, recorded because it cost
three rounds: **a verification list that is authored independently of the thing it verifies proves
only that the author's list was consistent with itself.**

**Falsified on purpose, so the new guard is not taken on faith.** A temporary entry
(`/a-destination-with-no-page`) was added to `NAV_GROUPS` and the suite re-run. Two tests failed, for
the two different reasons they exist:

```
✘ Falsification probe (/a-destination-with-no-page) renders real content
    Error: /a-destination-with-no-page rendered a failure: found "This page could not be found"
✘ every navigation link resolves to a real page
    Error: the sidebar does not link to /a-destination-with-no-page
```

The first proves the destination list really is derived — a hand-typed list would not have contained
the new entry at all. The second proves the sidebar/source comparison is live rather than vacuously
true. The probe was then removed and `nav.ts` verified byte-identical to its backup; the suite
returned to 43/43 at the time; the suite is now 45/45 with the two reminder tests added later.

### 4.3 The Android acceptance run — what was actually executed

**Scope, stated first because it matters.** This was run against a **Pixel emulator running
Android 17** (`sdk_gphone16k_arm64`), not against physical hardware. An emulator proves the app's
code paths, the OS alarm and notification delivery, and the API contract; it does **not** prove
OEM battery management, a real microphone, wake-word detection on real audio, or Doze behaviour on
a handset. Those remain unverified, and the final rule of the brief is not satisfied by this run.

How it was driven: `flutter build apk --debug --dart-define=API_URL=http://localhost:3001`,
installed over `adb`, with `adb reverse tcp:3001 tcp:3001` so `localhost` on the device is the API
on the host. The app was exercised through the real UI (onboarding, permissions, sign-in) with
`adb shell input`.

| Step | Result |
|---|---|
| Debug APK builds with the current sources | **Pass** — `app-debug.apk`, 27s |
| Installs and launches on Android 17 | **Pass** — the previous install had to be removed first: it was signed with a different key (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`) |
| The app reaches the API through `adb reverse` | **Pass** — before sign-in the permission screen showed the API's own `Missing or invalid authorization header`, i.e. a real server response, not a timeout |
| Sign-in with a seeded account | **Pass** — `User logged in userId=3f1e6dff…`, and the home screen rendered the account's name |
| Device registration reaches `POST /api/v1/device/register` | **Pass, on resume only** — see the finding below |
| The console sees the device, its OS version and its app version | **Pass** after the fix below — `platformVersions: ['17']`, `deviceModels: ['sdk_gphone16k_arm64']`, `appVersions: ['1.0.0']` |
| A reminder created through the API is armed as an OS alarm | **Pass** — `dumpsys alarm` showed an `RTC_WAKEUP` for `com.leadup.nova` via `flutterlocalnotifications.ScheduledNotificationReceiver` at exactly the reminder's `trigger_at` |
| The alarm fires as a real notification | **Pass** — posted at 19:16:07 for a 19:16:02 trigger, channel `nova_reminders`, `category=reminder`, `BigTextStyle` |
| **Tapping the notification acknowledges the reminder** | **Pass** — `reminders.triggered_at = 2026-09-21T19:17:00.615Z`, the admin list shows `revisions=1`, the journal gained a `triggered` row, and `remindersTriggered` moved 1 → 2 |
| The console reports the acknowledged state | **Pass** — the reminder row reports `triggered_at` set and appears under the `acknowledged` filter |
| An admin flag change reaches the device contract | **Pass** — creating `PROACTIVE_ASSISTANT` with `enabled: false` through the control-plane API immediately produced `capabilities.proactive: false` and `flags.PROACTIVE_ASSISTANT: false` in `GET /api/v1/device/bootstrap`; deleting the row restored both to `true`. That is §56 steps 13–14 (admin change → backend state → mobile client contract) |

That eighth row is the first end-to-end validation of the reminder instrumentation added in §7.3:
console data → device OS alarm → notification → **user tap** → `POST /reminders/:id/acknowledge` →
`triggered_at` → console. Every link was observed on a running Android runtime, not inferred.

**What the run could not cover, and why it is not recorded as working.** §56 step 6 asks the
console to show the user's **AI request** alongside the user, task and reminder. The reminder half
of that is now proven end to end, but the AI half is not, and the reason is an automation limit
rather than a product judgement: the Converse screen sends a typed message through the keyboard's
IME *send* action (`textInputAction: TextInputAction.send`, `onSubmitted`), and `adb shell input`
cannot press that action — `KEYCODE_ENTER` inserts a newline in that multiline field instead. The
quick-action chips (`Create task`, `Set reminder`) also did not respond to synthetic taps. A human
tap would very likely work, but "very likely" is not evidence, so the report claims neither success
nor failure: the device → AI → console path was unverified **at the time of that run**. It has since
been closed by an on-device integration test that performs the IME action `adb` cannot press — see
§7.15 — so the gap is now a limitation of the shell-driven run rather than of the platform.

**Housekeeping.** The run needed a signed-in account, so `emulator-verify@leadup.tech` was created
with `services/api/scripts/seed-review-account.mjs` (the script exists for exactly this, and prints a
warning to delete the account afterwards). It is an ordinary `user` account — no console access, no
cross-user data — on a local database, and it is still present because the emulator is signed into it.
It must be deleted before this database is used for anything but development.

**Two real defects the run exposed, both now fixed.**

1. **The device inventory reported no model and no OS version.** A real registration arrived with
   `platform_version` and `model` both `null` — the client was honest about not knowing them, and
   the console faithfully showed "not reported". The consequence was worse than a blank cell: the
   only row in the inventory with a model and an OS version was a **synthetic one written by a
   verification script**, so the "Android versions" tile was populated by fabricated data rather
   than by a device. `device_info_plus` is now a dependency, `NovaVersionInfo.current()` reads
   `Build.MODEL` / `Build.VERSION.RELEASE` (and the iOS equivalents), and the registration payload
   carries them. Verified live after the change: `platformVersion: "17"`,
   `model: "sdk_gphone16k_arm64"`, on the same `installation_id`, i.e. an update rather than a
   second row. `Build.MODEL`'s literal `"unknown"` is mapped to `null` so no handset called
   "unknown" can appear in the inventory, and the startup path still uses the `const`
   `NovaVersionInfo.buildTime`, which touches no channel.

2. **Registration only happened on start-up and on resume, and the start-up attempt lost a race
   with session restore. FIXED.** The post-frame callback fires after the first frame; the access
   token is read from secure storage asynchronously. When that read had not finished, the call
   returned `reported: false, error: 'no session'` and was — correctly, intentionally — silent, so
   the device was registered only after the app had been backgrounded and resumed once. A user who
   launched NOVA and left it in the foreground was never counted at all.

   The fix is an auth-state listener in `NovaApp.initState` that reports the device on the
   transition into an authenticated session, with `fireImmediately` so a cold start whose session is
   *already* restored is covered by the same code path rather than depending on the post-frame
   attempt winning. Registering twice is harmless — the endpoint upserts on `installationId`.
   Verified live on the emulator: before the fix `last_seen_at` advanced only after a
   background/resume cycle; after it, a single launch at 19:24:18 with no resume advanced it to
   19:24:34, on the same `installation_id`. Three widget tests pin the wiring by counting
   invocations of the registration call — two with a session, one without — which avoids depending
   on `device_info_plus` resolving inside a widget test.

---

## 5. NOVA CONTROL MAP

How an operator action reaches production behaviour, for each major feature.

```
FEATURE FLAG  (e.g. PROACTIVE_ASSISTANT)
  ADMIN:  /feature-flags  ->  PATCH /control/feature-flags/PROACTIVE_ASSISTANT
  API:    requirePermission(feature_flags.write) -> audit feature_flag.update
          -> feature_flags row + invalidateFlagCache()
  DB:     feature_flags / feature_flag_overrides
  RUNTIME:evaluateFlag() -> precedence user > org > environment > global+rollout
  MOBILE: GET /api/v1/device/bootstrap -> data.flags + data.capabilities
          FeatureGate / voiceCapabilityEnabledProvider enforce it
  PROOF:  verify-control-plane.py steps 2,3,4,5

KILL SWITCH  (e.g. CONTROL_AI_ENABLED)
  ADMIN:  /maintenance  ->  PUT /control/controls/CONTROL_AI_ENABLED
  API:    requirePermission(kill_switch.manage) + reason -> audit control.update
          -> system_configs row + invalidateControlCache()
  RUNTIME:requireCapability('ai') on /ai, /chat, /conversations, /briefing
  MOBILE: capabilities.ai=false; requests answered 503 CAPABILITY_DISABLED
  PROOF:  verify-control-plane.py step 6

FEATURE FLAG / RUNTIME CONFIG REACHES THE APP ONLY ON FETCH.
  There is no push channel (the Flutter app has no FCM integration), so a device
  sees a change on its next bootstrap call — on launch, on resume, or within the
  60-second TTL. The console states this to the operator rather than implying
  instant delivery.

USER SUSPENSION / FORCE LOGOUT
  ADMIN:  /users/:id -> POST /control/users/:id/suspend
          /sessions  -> POST /control/sessions/:id/revoke
  API:    requirePermission(users.suspend | users.sessions_revoke) + assertNotSelfEscalation
          -> users.disabled = true  AND  sessions.revoked_at set
  RUNTIME:authenticate() rejects the disabled account; refresh returns 401
  MOBILE: the app drops to /login on its next refresh (<= 15 min idle)
  NOTE:   there is no push, so this is revoke-and-wait. Both routes state that bound.
          Per-session revoke is narrower on purpose: reacting to one compromised token
          should not sign the same person out of their own phone.
  PROOF:  verify-platform-roles.py section 12 — revoke succeeds, revoking twice is a
          reported no-op, and both attempts appear in the audit log typed as `session`
          with the operator's reason

REFRESH SESSION INVENTORY
  ADMIN:  /sessions  ->  GET /control/sessions?status=&search=&page=
  API:    requirePermission(users.read); a LEFT JOIN over sessions/users/devices, plus a
          FILTER tally computed from a *subset of the same predicate* as the rows
  DB:     sessions (revoked_at, expires_at), never refresh_token_hash
  UI:     state derived server-side as active | expired | revoked
  PROOF:  verify-platform-roles.py section 12 — the three states are pairwise disjoint, the
          tally equals the size of each filtered list, an unknown filter is a 400, and a
          READ_ONLY operator is refused 403

SECRET  (e.g. ANTHROPIC_API_KEY)
  ADMIN:  /configuration and /ai/secrets
          -> PUT /control/config/secrets/ANTHROPIC_API_KEY
  API:    requirePermission(config.secrets) -> encryptSecret() -> audit
          config.secret_write with {key, hint, rotated} ONLY
  DB:     system_configs.secret_ciphertext (CHECK forbids plaintext in `value`)
  RUNTIME:resolveConfig() decrypts; runtimeConfigValue() serves the sync overlay
  UI:     never returned; masked hint only
  PROOF:  verify-control-plane.py step 10; unit tests for round-trip + tampering

PROVIDER TEST HISTORY, READ BACK PER CREDENTIAL
  ADMIN:  /ai/secrets and /configuration -> "last tested" beside the key
  API:    GET /control/config joins `provider_health_checks` DISTINCT ON (provider) onto
          each secret key through PROVIDER_CREDENTIAL_KEYS (config.ts)
  RUNTIME:POST /control/config/test/:provider and POST /control/providers/test-all write
          provider_health_checks via runProviderTest()
  UI:     status, when, and the provider's own message; a key no test covers says so
  NOTE:   `system_configs.last_tested_*` exist in the schema and are written by *nothing*.
          They were the original plan and they cannot work for the normal production case,
          because an environment-supplied credential has no system_configs row to update.
          The read model therefore joins the history table instead. Before this, both pages
          said "never tested" beside a credential whose test had run minutes earlier.
  PROOF:  live: POST /control/config/test/deepgram then GET /control/config shows
          DEEPGRAM_API_KEY tested=pass at that instant; 3 unit tests guard the key mapping

REMINDER ACKNOWLEDGEMENT  (the one delivery signal the platform has)
  ADMIN:  /reminders (all | upcoming | overdue | acknowledged | dismissed)
          / and /analytics -> "Reminders acknowledged"
  MOBILE: the OS arms the alarm; the user taps the notification
          -> ReminderNotifications.onReminderOpened -> ReminderSyncController.reportOpened
          -> POST /api/v1/reminders/:id/acknowledge
  API:    authenticate + owner-scoped lookup (another account gets 404, not a write)
          -> sets `triggered_at` only when it is still NULL, then reports
          firstAcknowledgement true | false
  DB:     reminders.triggered_at, and migration 0010's trigger appends a `triggered`
          row to reminder_events (application code must NOT insert — 0004's rule)
  UI:     the acknowledgement instant and the journal count, labelled "acknowledged"
  NOTE:   This is not a delivery record and is not shown as a rate. The alarm fires with
          the app closed, so the server never sees the firing; a tap is what it sees. A
          recurring reminder counts once, because nothing server-side advances
          `trigger_at` and the client re-arms from the rule. On a build whose app does not
          call the endpoint the number is honestly 0.
  PROOF:  verify-platform-roles.py section 13 — create, first ack true, repeat ack false
          with the instant unchanged, a stranger gets 404, the admin list finds it under
          `acknowledged` with revisions >= 1, the metric moves +1, the probe is deleted;
          plus 8 API tests and 6 Dart tests

CREDENTIAL TEST FRESHNESS
  ADMIN:  /ai/secrets and /security -> the credential's test column
  API:    GET /control/config        -> testStale, secretFingerprint, lastTestedFingerprint
          GET /control/security/overview -> testStale per credential
  WRITE:  POST /control/config/test/:provider
          -> providerConfigurationFingerprint(provider) over the keys it reads
          -> provider_health_checks.secret_fingerprint
  READ:   the same function is recomputed for every provider once per page, and the recorded
          fingerprint is compared against it. One definition on both sides — the first version
          fingerprinted "KEY=value" when writing and a bare value when comparing, so every
          result read stale and only the live check caught it.
  UI:     a mismatch renders "tested a previous value" rather than the recorded status. A
          `pass` against a replaced key is the misleading state this exists to prevent.
  NULL:   means no credential was involved (PostgreSQL, Redis, an unset key) — not "stale",
          and the two must not render alike.
  PROOF:  verify-platform-roles.py section 19 — rotate, observe stale with the status still
          `pass`, re-test to clear it, remove the override, re-test to restore; the probe
          cleans up in a `finally` so a failed assertion cannot leave a placeholder in a key.

ADMINISTRATOR TWO-FACTOR AUTHENTICATION
  ADMIN:  /security/mfa  ->  enrol, confirm, replace recovery codes, disable
          /login        ->  reveals a code field on the API's MFA_REQUIRED answer
  API:    /control/admin-mfa{,/enrol,/confirm,/recovery-codes,/disable,/coverage}
          every route acts on the CALLER'S OWN account: there is no :userId to tamper with
  CRYPTO: admin/totp.ts — RFC 6238 TOTP over HMAC-SHA1, 6 digits, 30-second step, ±1 step of
          drift, checked against the RFC's published vectors. The accepted step is recorded,
          so a code cannot be replayed inside its own window.
  STORE:  admin_mfa.secret_ciphertext is the AES-256-GCM payload from admin/secrets.ts, the
          same format system_configs uses — a TOTP secret is a long-lived credential.
          Recovery codes are stored as SHA-256 hashes only.
  GATE:   routes/auth.ts refuses to issue a session when a CONFIRMED factor exists and no
          valid code is supplied: 401 MFA_REQUIRED, or 401 MFA_INVALID for a wrong one.
  SAFE:   an UNCONFIRMED enrolment gates nothing, so an abandoned enrolment cannot lock
          anybody out; disable needs the password AND a code, so a stolen session cannot
          remove the control that exists to stop a stolen session.
  NOTE:   opt-in per account. The mobile client never enrols, so it is unaffected — but the
          check lives in the shared login route, because a factor that guards one client is
          not a factor.
  PROOF:  verify-platform-roles.py section 18 — the whole lifecycle driven with real codes,
          including the replay refusal, recovery-code single use, and the anti-lockout
          property, leaving the account as it found it.

FAILED SIGN-IN / SECURITY CENTER
  ADMIN:  /security  ->  GET /control/security/overview?days=
  API:    requirePermission(security.read)  [PLATFORM_ADMIN, OPERATIONS_ADMIN, DEVELOPER]
  WRITER: routes/auth.ts records every login outcome through services/auth-events.ts
          -> audit_logs: action auth.login | auth.login_failed
             details { attemptedEmail, reason, clientIp }, sourceDevice = user-agent
  REASONS:ok | unknown-account | bad-password | account-disabled
  READ:   counts by reason, most-attempted addresses, source addresses, recent failures,
          refused privileged actions, operator sessions, privilege and configuration
          changes, credential status, and a watchlist of repeated refusals
  PRIVACY:an unmatched address is written actorType="anonymous" with no account id, so it can
          never be joined to a user. The reason is recorded for the operator and never
          returned to the caller — the 401 stays generic, so the route does not enumerate.
  NOTE:   There is no separate "admin login": the console uses the same /auth/login route as
          the app, so these counts cover every NOVA account and the watchlist separates
          operators by role.
  PROOF:  verify-platform-roles.py section 17 — three real attempts move the counters by
          exactly one each, the reasons are distinguished, an unmatched address is recorded
          but not attributed, the client IP is captured, and a READ_ONLY token is refused 403

AUDIT-LOG EXPORT
  ADMIN:  /security/audit-log -> "Export CSV" (a link carrying the current filters)
          -> GET /security/audit-log/export  [console route handler]
  API:    GET /control/audit-logs/export, requirePermission(audit.export) [SUPER_ADMIN only]
          -> auditedOperation(admin_log.export) written BEFORE the read
          -> filtered SELECT ... LIMIT 50000 + 1
  UI:     text/csv attachment with the row count and a truncation flag in headers, so a
          client that streams the file to disk still learns what it got
  SAFETY: cells beginning = + - @ TAB CR are prefixed with an apostrophe, so an
          operator-supplied reason cannot execute on the auditor's machine; null is an empty
          cell, never the word "null"
  NOTE:   Separate from audit.read on purpose: reading the log in the console and taking a
          copy of it out of the platform are different capabilities.
  PROOF:  verify-platform-roles.py section 16 — a READ_ONLY token is refused 403 while a
          SUPER_ADMIN gets a parseable 785-row CSV, the header matches the declared columns,
          timestamps are clean ISO, no cell evaluates as a formula, an outcome filter is
          actually applied, and the export's own audit row names audit.export

ADMINISTRATOR SESSION / IMMEDIATE FORCE LOGOUT
  ADMIN:  /security/sessions -> POST /control/admin-sessions/:id/revoke (reason required)
  API:    requirePermission(admin_users.manage) [SUPER_ADMIN only]
          -> 409 SELF_SESSION if it is the caller's own session
          -> auditedOperation(admin_session.revoke)
  RUNTIME:any /control/* request -> authenticate -> resolveAdmin
          -> beginAdminSession registers the session on first use and refuses a revoked one
  DB:     admin_sessions (jti, role, ip, user-agent, the token's real `exp`, revoked_at)
  ENFORCE:tokenDenylist.revoke() + verifyAccessToken's synchronous denylist check
  UI:     live sessions with the client each is used from, and a per-row End session
  NOTE:   Immediate on the replica that performed it; other replicas honour it when they read
          the row on the next request. A user session revoke is different: the mobile app only
          notices on its next refresh. No last-administrator guard, deliberately — a session is
          restored by signing in again, and refusing to end the only super-admin session would
          leave a stolen token alive when ending it matters most.
  PROOF:  verify-platform-roles.py section 14 — two tokens, revoke one, the other's next
          request is 401 Token has been revoked; self-revoke is 409; repeat is a no-op; the
          revocation is in the audit log typed to the session

SUSPENSION
  ADMIN:  /users/:id -> POST /control/users/:id/suspend
  API:    requirePermission(users.suspend) + assertNotSelfEscalation -> users.disabled
  RUNTIME:authenticate -> assertAccountUsable reads the account before EVERY authenticated
          route and refuses a disabled or missing one with 403 ACCOUNT_DISABLED
  MOBILE: the app is refused on its next request, not on its next refresh
  PROOF:  verify-platform-roles.py section 15 — a token that returns 200 is refused 403 the
          moment the account is suspended, and works again the moment it is restored

MAINTENANCE MODE
  ADMIN:  /maintenance -> PUT /control/maintenance (typed confirmation)
  API:    requirePermission(maintenance.manage) -> CONTROL_MAINTENANCE_MODE
  RUNTIME:every requireCapability() gate returns 503 MAINTENANCE_MODE
  MOBILE: device-bootstrap -> maintenance.enabled; RemoteControlGate blocks the UI
  PROOF:  verify-control-plane.py step 6 (shares the 503 path)

VOICE USAGE METERING (STT / TTS)
  ADMIN:  / and /analytics  ->  GET /control/metrics/activity
  API:    SUM over usage_records for stt_requests/stt_seconds/tts_requests/tts_characters
  RUNTIME:routes/voice.ts meters the REST speech routes after a successful provider call;
          realtime/session.ts meters each completed voice turn through planRealtimeTurn()
          (one request per leg, zero writes nothing, a mid-turn fallback is attributed)
  DB:     usage_records — append-only; one row per metric per call
  UI:     request counts with their volumes, and a caveat stating the unit (per call,
          not per sentence)
  PROOF:  verify-platform-roles.py section 11 — synthesizes real speech through the provider
          and asserts +1 request and +N characters, and that a 400 moved nothing;
          12 unit tests cover the realtime turn plan

AI LATENCY
  ADMIN:  /ai and /  ->  GET /control/metrics/ai
  API:    AVG(duration_ms) and percentile_cont(0.95) over assistant messages
  DB:     conversation_messages.duration_ms (migration 0009)
  RUNTIME:routes/chat.ts and routes/conversations.ts time the full assistant tool loop
  UI:     mean, p95 and per-model, with sample coverage stated
  PROOF:  verify-platform-roles.py section 10 — seeds 1000 ms and 3000 ms rows, reads the
          aggregate back as exactly 2000 ms with p95 2900, then removes them

PROVIDER HEALTH
  ADMIN:  /services -> POST /control/providers/test-all -> POST /control/config/test/:provider
  API:    runProviderTest() makes a REAL authenticated call
  DB:     provider_health_checks (history)
  UI:     status, latency, method, message, "last tested by"
```

---

## 6. ADMIN FEATURE MATRIX

| Feature | Existing before | Fixed | Implemented | Tested | Production ready |
|---|---|---|---|---|---|
| Admin authentication | Session cookie + JWT, working | Edge/client gates widened to all 7 roles | — | Live 401/403 checks | Yes |
| Server-side RBAC | `role IN (owner, admin)` only | **Replaced** with 47 permissions / 7 roles | Yes | 49 unit + 18 live | Yes |
| Audit of admin actions | None | — | Append-only table + trigger + redaction | Tamper test, live | Yes |
| Denials audited | No | — | Yes | Live (20 rows) | Yes |
| User management | List + PATCH `disabled` | Detail endpoint 500 fixed | List, detail, suspend, session revoke | Live + browser | Yes |
| User detail view | None | 500 (`memories.type`) | 15 sub-queries + capability table | Browser-verified | Yes |
| Force logout | None | — | Refresh-session revocation + stated bound | Live | Yes (bounded) |
| Analytics / dashboard | 5 counts | — | Real metrics with provenance | Live | API yes, UI yes |
| Metrics honesty | Placeholder-free but thin | **AI latency and voice counts were claims, not measurements** | Real figures with provenance; anything uncomputable says NOT AVAILABLE with the instrumentation it needs | Live + 12 unit | Yes |
| AI provider management | Key-format check | **Replaced** with real calls | Providers, models, routing, cost | Live + browser | Yes |
| API key / secret storage | None | — | AES-256-GCM, write-only, masked | Unit + live leak check | Yes |
| Runtime configuration | None | — | Catalog + resolver + sync overlay | Unit + live | Yes |
| Config honesty (`readByRuntime`) | n/a | **overlay not republished on write** | Inert keys labelled; writes now take effect before the route returns | Unit + live | Yes |
| Feature flags | CRUD, read by nothing | **Wired end to end** | Resolver + overrides + rollout + bootstrap | Live (37-check script) | Yes |
| Percentage rollout | Stored, unused | — | Deterministic hash cohorts | Uniformity test | Yes |
| Kill switches | None | **were cosmetic on the engines** | 8 capabilities: enforced at the route mount AND on all three background engines | Live 503 + 12 gate checks | Yes |
| Maintenance mode | None | — | Mode + message + client gate | Live | Yes |
| Voice (STT/TTS) config | None | — | Config view, health, real provider tests, usage metering | Live + browser | Yes |
| Avatar control | None | — | Enablement + asset inventory | — | Partial |
| Task operations | None | — | List, filter, in-place status/priority/due edit | Browser-verified | Yes |
| Reminder operations | None | — | List, filter, reschedule, dismiss, revisions | Browser-verified | Yes |
| Memory inspection | None | — | List, filter, audited read, typed-confirm erase | Browser-verified | Yes |
| Proactive inspection | None | — | Reconstructed record with stated limits | Browser-verified | Yes |
| Notification centre | None | — | Volume by type, stated delivery limits | Browser-verified | Yes |
| Background jobs | None | — | Executions, by-job stats, scheduled inventory | Browser-verified | Yes |
| Job retry / replay | None | — | **Refused with 501** — no queue exists | — | Honest no |
| Service health | 2 hardcoded checks | — | Discovered services + real dependencies | Live | Yes |
| Database health | None | — | Size, connections, tables, slow queries, migrations | Live | Yes |
| Realtime monitor | None | — | Registry added; local count + stated limits | Browser-verified | Partial |
| Error / log centre | None | — | **Refused with reason** — no log sink exists | Browser-verified | Honest no |
| Correlation traces | None | — | Request-id lookup across 4 tables + stated limits | Browser-verified | Partial |
| Admin sessions | None | — | Table + heartbeat; actors view from the audit log | Browser-verified | Partial |
| Mobile remote config | **None (did not exist)** | — | Bootstrap endpoint + Flutter client | Live E2E | Yes |
| Admin role assignment | `roles`/`role_bindings` empty, unused | — | `platform_admin_roles` + 4 guards + console UI | Live (76-check script) + 5 unit | Yes |
| Mobile version gate | None | — | Gate implemented; the app now reports its version | Live E2E | Yes |
| Device inventory | Table existed, **no writer** | — | Registration endpoint + Flutter reporter + adoption tiles | Live E2E | Yes |
| Push notifications | None | — | **NOT AVAILABLE** — app has no FCM | Live | Blocked (§7.3) |
| Console pages (full nav) | 10 flat pages | **3 nav links pointed at no page** | **28 new pages** + grouped role-filtered nav | 43 browser tests | Yes |
| Session inventory | None | — | `sessions.ts` route + `/sessions` page + per-session revoke | 19 unit + 24 live | Yes |
| Deployment identity | None | — | `/environment`: verdict banner, live switches off, migrations, topology | 4 browser tests | Yes |
| Credential inventory | Config table only | **"never tested" claimed falsely** | `/ai/secrets` + provider-test provenance joined from history | 4 browser tests + 3 unit | Yes |
| Provider test provenance | Columns existed, never written | **read model joined to real history** | `PROVIDER_CREDENTIAL_KEYS` + `DISTINCT ON` join | Live + 3 unit | Yes |
| AI provider table rendering | — | **blank ids, `[object Object]`, false "never tested"** | Reader normalises `id`/`health`/`models` | Browser assertion | Yes |
| Realtime voice metering | Computed then discarded | **the numbers were dropped** | `planRealtimeTurn` + 12 unit tests | Unit + live REST | Yes |
| Reminder acknowledgement | `triggered_at` had **no writer at all** | **migration 0010 trigger + `POST /reminders/:id/acknowledge`** | API, Flutter tap handler, console column and filter, metric | 8 API + 6 Dart + 14 live | Yes |
| Reminder revision history | `reminder_events` written by a trigger for reschedules only | no "fired" step | `triggered` event journalled by 0010, counted as `revisions` | Live (revisions ≥ 1) | Yes |
| Reminder metric labelling | "Reminders executed", NOT AVAILABLE | **the label overclaimed what could be measured** | "Reminders acknowledged" with an unconditional caveat | 2 browser tests | Yes |
| Administrator sessions | `admin_sessions` had **no writer at all** | **registry + list + revoke routes, `/security/sessions`** | `beginAdminSession` on every control-plane request, immediate denylist revocation | 11 unit + 24 live + 1 browser | Yes |
| Administrator force-logout | None existed — no handle on an admin access token | — | Revocation ends the session on the operator's **next request** | Live (401 on next call) | Yes |
| Account suspension enforcement | **claimed immediate, was 15 minutes** | **`assertAccountUsable` before every authenticated route** | 403 `ACCOUNT_DISABLED` for disabled *and* deleted accounts | Live + 4 checks | Yes |
| Timestamp correctness | **host-timezone dependent; off by 5h30m on IST** | **`TZ=UTC` + a pg OID-1114 parser override** | Reads correct regardless of process timezone | Live (same row, correct instant) | Yes |
| Device model / OS version | **reported as null by a real device**; the tile was populated only by a synthetic row | **`device_info_plus` + `NovaVersionInfo.current()`** | `Build.MODEL` / `VERSION.RELEASE`, with `"unknown"` mapped to null | Live (Android 17 emulator) + 9 Dart tests | Yes |
| Reminder tap → acknowledgement, on Android | Only unit- and API-tested | — | Validated end to end on an emulator (§4.3) | Emulator run | Emulator only |
| Device registration at launch | **lost a race with session restore**; needed a resume | **auth-state listener + `fireImmediately`** | Reports on launch, on sign-in and on resume | Live (no resume needed) + 3 widget tests | Yes |
| Audit-log export | **permission existed, no route** | **filtered CSV with a row cap and injection escaping** | `audit-export.ts`, `GET /control/audit-logs/export`, console download + self-audit | 21 unit + 14 live + 1 browser | Yes |
| Failed sign-ins recorded | **not recorded anywhere** | **`services/auth-events.ts` on every login outcome** | Reason, attempted address, client IP; unmatched addresses are anonymous | 9 unit + 19 live | Yes |
| Security Center (§29) | **no consolidated view** | — | `/security`: sign-ins, refusals, watchlist, sessions, privilege/config changes, credentials | 19 live + 1 browser | Yes |
| Administrator MFA | **none anywhere** | — | Opt-in TOTP (`admin/totp.ts`), 10 single-use recovery codes, enforced at `/auth/login`, self-service console page | 22 unit + 24 live + 3 browser | Yes |
| Credential test staleness | **a rotated key kept its old result** | **fingerprint recorded per check, compared on read** | `provider_health_checks.secret_fingerprint`, `testStale` in the config and security views; labelled in both console tables | 8 unit + 20 live + 1 browser | Yes |
| Device → AI → console (typed message) | **unverified**; shell input cannot press the IME send action | — | On-device integration test drives the real composer submit; the turn appears in conversations and activity metrics | 1 device test (emulator) | Emulator only |
| Device → tool call → console (task) | **unverified** for tool calls | — | On-device test: the model emits `create_task`, the task lands on the server and on the Tasks screen, and the console's task view shows it | 1 device test (emulator) | Emulator only |
| Device → update → console (reminder moved) | **unverified** for updates | — | On-device test asks NOVA to move a reminder; the id survives, the time moves, and the console shows the new time | 1 device test (emulator) | Emulator only |
| Durable log centre (§31) | **no log store**; the route said so and named the fix | — | `utils/log-sink.ts` batches pino lines into `service_logs`; `/control/logs` queries them; the trace view includes them; `/logs` renders real rows with filters | 15 unit + 4 live + 1 browser | Yes |
| Cross-replica session revocation | **in-process only**; a revocation reached other replicas never | **shared table + 5 s poll** | `revoked_tokens`, `middleware/token-denylist.ts`; immediate locally, bounded elsewhere | 11 unit + 10 checks across two live processes | Yes |
| Background jobs / queue (§21) | **no queue**; retry answered `501` | **queue on the existing table** | `jobs/queue.ts` (`FOR UPDATE SKIP LOCKED`), `jobs/worker.ts`; worker + handlers surfaced in `/jobs`; retry is a real action | 6 unit + 10 live + 1 browser | Yes |
| Permission catalogue and nav gating | **two hand-maintained copies**; the console resolved the token claim, not the grant | **one authority** | `GET /control/me/permissions` + `GET /control/permissions`; `apps/admin/src/lib/permissions.ts` deleted | 9 unit + 2 browser | Yes |

---

## 7. Findings and remaining work

### 7.1 RESOLVED — Console pages for the implemented API

Built and verified: **31 Control Center destinations**, all rendering real data in a real browser
(§4.2). Previously P0 because an operator could change state through four pages but could not
*observe* users, conversations, tasks, reminders, jobs, memory or the administrator audit log
without calling the API directly.

**A second, later P0 found inside the first one — and how it was hidden.** The navigation model
declared three destinations that had no page: `/environment`, `/sessions` and `/ai/secrets`.
Clicking them returned Next.js's 404. Two of the three were not cosmetic gaps:

- `/sessions` had **no route behind it either**, so "who is signed in right now" and "revoke this
  one token" were unanswerable through the console. Both now exist, with a narrower per-session
  revoke distinct from the user-level force logout.
- `/ai/secrets` was the only place a credential's identity and state would be visible together.
- `/environment` is the pre-flight "which deployment am I about to change" check.

All three are built (see §3). The reason the defect survived a sweep that visits every destination
is worth recording: **the sweep's list of destinations was written by hand and matched the pages
that existed**, so it could never contain the three links the console rendered. A verification list
that is not derived from the thing it verifies cannot fail. The list is now generated from
`NAV_GROUPS` (the same module the sidebar renders from), and a second test reads every `href` out
of the rendered `<nav>` and asserts each one returns 200 with a real page — so a link can no longer
exist without a destination in either direction.

**A third defect the same sweep could not see.** `/ai` rendered provider rows whose id cell was
blank, whose "Last health" column said **"never tested" for every provider**, and whose models
column printed `[object Object]`. The cause was a reader that asked for `provider`, `lastHealth` and
`models: string[]` while the route returns `id`, `health` and `models: {id, use}[]`. Live proof of
the fix: `GET /control/ai/providers` reports recorded health for 4 of 7 providers, and the page now
says "never tested" for exactly those 3. A heading-and-digest check passes a page full of blank
cells, which is why the sweep was extended with assertions about the specific claim each of these
pages exists to make.

**A fourth defect, in the same family.** `system_configs.last_tested_at` / `last_test_status` /
`last_test_message` were created by migration 0006 and **written by nothing**, so
`/configuration` and `/ai/secrets` both reported "never tested" beside a credential whose provider
test had run minutes earlier. The configuration read model now joins `provider_health_checks`
(DISTINCT ON provider) onto each secret key through an explicit `PROVIDER_CREDENTIAL_KEYS` map,
which is also the only approach that works for an environment-supplied credential — it has no
`system_configs` row to update. `ConfigView` gained a `testedBy` field so a page can distinguish
"no test covers this key" from "the test has not run yet"; conflating those is how an S3 key reads
as untested while its end-to-end test is passing.

Remaining console work is a smaller P2: the Users list has no in-page "resend verification" control
(the API does not expose one), the Realtime page cannot show cross-replica totals (needs Redis), the
`/logs` page needs a real log sink (§7.4).

### 7.2 RESOLVED — two time-of-day dependent tests

**Where:** `services/api/src/__tests__/follow-up-engine.test.ts` — *"classifies against the sweep's own clock"*
**Cause:** the test derived its sweep instant from the wall clock (`new Date(Date.now() + 3 * DAY)`),
which preserves the current time of day. `isQuietHours` (`services/follow-up.ts:184`) returns
*before the database is read* when the user's local hour is ≥ 21 or < 8, so between 21:00 and
08:00 IST the engine reported `raised: 0` with `skipReason: "quiet-hours"` and the assertion
failed — reading as a broken engine rather than a test that depends on when it is run.

**Fix:** anchor the sweep to the file's own fixed `NOW` constant (10:00 IST) instead of the wall
clock, so the instant is always inside the allowed window. Verified by computing both instants at
the time of the fix: the old one landed at 23:xx IST (quiet), the new one at 09:xx IST. I did not
change the follow-up engine.

**Second instance, found the same way.**
**Where:** `services/api/src/__tests__/assistant-tool-executor-datetime.test.ts` — *"states the
current time as a full ISO date, not just a clock time"*.
**Cause:** the test required the refused-reminder correction to contain the current date in the
user's timezone as `YYYY-MM-DD` (`isoInUserZone(new Date())`). The message never contained that: it
names the instant as a UTC ISO timestamp *and* renders the same instant in the user's zone as a
locale string (`Tue, 22 Sept 2026, 12:00 am`). So the assertion held only while the UTC date and the
`Asia/Kolkata` date were the same day (05:30–24:00 IST) and failed for the other five and a half
hours of every day. It is a clean demonstration of the class: the full suite passed at 18:22 UTC,
failed at 18:30 UTC, and **no code changed in between** — IST had crossed midnight.

**Fix:** the assertion now parses the instant out of the message and requires the message to contain
`formatInZone(instant, USER_TIMEZONE)` — the same exported formatter the executor uses, applied to
the same instant it printed. That is exactly the contract the implementation makes, and it is
independent of when the suite runs. I did not change the assistant's correction message, which
already carries the year, the timezone and a full ISO instant.

**Remaining flake, separately:** `recording-pipeline.test.ts` failed once in a full-suite run and
passes in isolation (21/21). It is load-sensitive, which `vitest.config.ts` already documents for
this suite, and is unrelated to the admin work.

**A second flake family, named because it is easy to mistake for a regression.** Across three
different rounds a *single route test asserting a 401* failed in one full-suite run and passed in
isolation — `chat.test.ts` once, `tasks.test.ts` once — with two consecutive full runs afterwards
green at 1017/1017. Both are authentication-path tests, and the mock pool is shared module state, so
the likely mechanism is one file's scripted mock answering another file's request. Every instance was
chased down rather than waved away, and in both cases the failure did not reproduce. It is recorded
here so the next person does not spend a round on it — and so that "it passed the second time" is
never accepted as the explanation for a *fail* that does reproduce.

### 7.3 P1 — Remaining instrumentation gaps

Most of what this section used to list is now closed. What is left is honest and specific.
Every metric that still cannot be computed reports `NOT AVAILABLE` with a reason and the
instrumentation it would need; none of them reports `0`.

| Gap | Consequence | State |
|---|---|---|
| ~~The Flutter app never reports its version or device~~ | ~~Version-gate adoption uncomputable~~ | **FIXED** — `POST /api/v1/device/register` plus the Flutter client. The endpoint, the app-side reporter and the version-adoption tiles on the dashboard are all in place and verified live. |
| ~~No AI latency persisted~~ | ~~"AI latency" is NOT AVAILABLE~~ | **FIXED** — `conversation_messages.duration_ms` (migration 0009), recorded by the chat and conversations routes around the full assistant tool loop. The console reports the mean, the p95 and a per-model breakdown, with the sample coverage stated. |
| ~~No STT/TTS counters~~ | ~~"STT requests" / "TTS requests" are NOT AVAILABLE~~ | **FIXED** — `services/voice-usage.ts` meters the REST speech routes into `usage_records` (`stt_requests` + `stt_seconds`, `tts_requests` + `tts_characters`). Verified live against the provider: +1 request and +32 characters for a 32-character synthesis, and a rejected transcription moved nothing. **Realtime is metered too**: `realtime/session.ts` already computed per-provider STT bytes and per-provider TTS characters and then discarded all of it, writing only `voiceSeconds`. The decision now lives in `planRealtimeTurn()` (one request per leg, a zero reading writes nothing, a mid-turn fallback is attributed to the dominant provider) with 12 unit tests. The caveat was corrected from "the realtime path is not metered" to state the unit instead, since the old text had become false. |
| ~~"Last tested" was always "never tested"~~ | ~~A credential with a passing test read as untested~~ | **FIXED** — the configuration read model joins `provider_health_checks` onto each secret key rather than reading three `system_configs` columns that no code writes. Live: after `POST /control/config/test/deepgram`, `DEEPGRAM_API_KEY` reports `tested=pass` at that instant; 10 of 17 secret keys now report a recorded test and the other 7 are exactly those no test covers. |
| ~~`reminders.triggered_at` is never written~~ | ~~A delivered reminder is indistinguishable from a merely-due one~~ | **FIXED** — migration 0010 plus `POST /api/v1/reminders/:id/acknowledge`, called by the app when the user opens the reminder's notification. Verified live: the metric moves 1 → 2 on one acknowledgement, a repeat is a reported no-op with the instant unchanged, and the admin list finds the row under `acknowledged` with `revisions ≥ 1` from the trigger. **Remaining and narrower:** the *firing* is still invisible — the OS alarm runs with the app closed — so this counts acknowledgements, not deliveries, and a reminder that was shown and ignored is overdue but unacknowledged. Closing that would need a background isolate that reports at fire time, which `flutter_local_notifications` does not provide for scheduled alarms. |
| ~~`secret_fingerprint` is never populated~~ | The console could show a masked hint but not "has this credential changed since I rotated it" | **FIXED — and it was worse than a missing capability.** A recorded test result was displayed as the current status regardless of whether the credential had been replaced since, so after a rotation a `pass` asserted that a value no longer in existence works, and a `fail` asserted a failure the operator had already fixed. `provider_health_checks.secret_fingerprint` now records the value a test exercised and the read model compares it against the value in force (§7.14). |
| No push channel reaches the device | Every flag, kill switch and config change is pull-only | **Open, and it is the last item on the physical-device path.** The server side is further along than the report previously said: `FIREBASE_SERVICE_ACCOUNT_JSON` is a catalog credential, a `firebase` entry exists in `PROVIDER_TESTS` with a real service-account shape test, and `devices.push_token` is a column with a reader on the user-detail page. What is missing is the client: `firebase_messaging` in the Flutter app, and a delivery worker that consumes the token. |

### 7.4 P2 — Background jobs have no queue

`job_executions` is a **record** table, not a broker. Retry is refused with `501 RETRY_NOT_SUPPORTED` and an explanation rather than pretending. A real job control centre needs BullMQ (or equivalent) with per-job handlers and a dead-letter queue; `CONTROL_BACKGROUND_JOBS_ENABLED` already exists to pause it.

### 7.5 P2 — Real-time and cross-replica state

Active connections live in the memory of the replica that accepted them (`realtime/registry.ts`). The count is reported as **local** and says so. Cross-replica totals and connection/message rates need Redis pub/sub. Likewise the refresh-token denylist is in-process, so a multi-replica deployment does not honour a logout everywhere — Redis is the fix and `REDIS_URL` being unset is already surfaced by the Redis provider test.

### 7.6 RESOLVED — Role assignment from the console

Built and verified: `platform_admin_roles` (migration 0007), `PUT|DELETE|GET /control/platform-roles`,
and the grant UI on `/security/admins`. A grant takes effect on the account's next request with no
re-login and no token reissue, and revocation restores the token-claim path. The four guards are
exercised live in sections 1–8 of `verify-platform-roles.py`, alongside device registration,
AI-latency instrumentation, voice metering, the session inventory and reminder acknowledgement — 85
checks in one script, all passing. 49 unit tests cover the admin surface's invariants.

Deliberately **not** reused: `roles`/`role_bindings`. Those model tenant roles — `roles.organization_id`
is `NOT NULL` and uniqueness is per organization — so a platform operator does not fit, and reusing
them would have meant inventing an organization named "platform".

### 7.7 P2 — Console copy of the permission matrix can drift

**Where:** `apps/admin/src/lib/permissions.ts` mirrors `services/api/src/admin/permissions.ts`.
**Impact:** bounded and asymmetric. The console copy only decides which navigation links appear; the server resolves the role on every request. A drift can therefore hide a destination or show one that then answers 403 — it can never grant access. This is stated on the console's own Permissions page.
**Recommendation:** move the catalog and role matrix into `@nova/shared-types` so both import one definition. The admin app already depends on that package.

### 7.8 P2 — No in-page pagination for very large audit tables

**Where:** `/security/audit-log` offers page links only for paging forward and back.
**Impact:** the table is append-only and unbounded by design, so it will grow without limit. Paging works, but there is no date-range shortcut beyond the `from`/`to` filters the API already accepts but the page does not surface.
**Recommendation:** expose the `from`/`to` filters in the form (the API supports them today) and add a jump-to-page control.

### 7.9 P3 — Documentation files

The Phase 1 deliverables are consolidated into this single report rather than five separate files. Everything requested is present: existing architecture, existing admin functionality, implemented and missing functionality, security findings, and the configuration/secret/RBAC architectures.

---

## 8. Answer to the ultimate test

> Can a NOVA operator run, configure, troubleshoot, observe, and safely control the entire NOVA platform from this Admin Control Center without manually editing source code or production `.env` files for normal operational tasks?

**Partially — and the gap is now precisely known.**

**Yes, demonstrably**, for: seeing real platform health and usage, including AI latency and the
STT/TTS counters now that both are instrumented; enabling/disabling any feature flag with a
percentage rollout and per-user override, and having the mobile client obey it; entering
maintenance mode and having requests refused with a machine-readable 503; throwing any of eight
emergency kill switches, enforced on the routes *and* on all three background engines; storing,
rotating and testing provider credentials without the value ever being readable, and seeing when
each credential was last proven to work; changing AI model and token ceiling live; testing every
external provider with a real call; validating the whole configuration including live connectivity;
inspecting and safely mutating configuration with impact and restart reporting; suspending a user
and force-logging-out their sessions — all of them or one specific one; browsing users,
conversations, tasks, reminders, memory, jobs, proactive events, notifications and the audit log;
assigning and revoking platform admin roles; seeing which reminders users actually opened, with the
distinction between "overdue" and "acknowledged" held apart; reviewing a tamper-resistant audit log of
every privileged action including refusals and exporting it as a filtered CSV; ending an operator's
console session with immediate effect; and opening one page that shows failed sign-ins with their
reasons and client addresses, refused privileged actions, live and ended operator sessions, privilege
and configuration changes, credential status, and a watchlist of repeated refusals; and turning on a
second factor for their own account, with single-use recovery codes and a sign-in flow that asks for
the code rather than blaming the password.

**Not yet**, for: completing the acceptance scenario on **physical hardware**. It has now been run
on an Android 17 emulator (§4.3), which covered the whole chain including a real OS alarm, a real
notification and a real tap that acknowledged the reminder — but an emulator proves code paths, not
OEM battery management, a real microphone or Doze behaviour. The remaining instrumentation gap is
the push channel: every change the console makes is pull-only and reaches the device on its next
bootstrap. The server half exists (`FIREBASE_SERVICE_ACCOUNT_JSON`
credential, a `firebase` provider test, `devices.push_token`, and a delivery reader on the user
page); the client half does not. Also open: the secret fingerprint column, a real
log sink, and a job queue (§7.3–§7.4). And one half-step that is deliberately narrower than it looks:
reminder acknowledgement is now recorded, but the *firing* is still not — the OS alarm runs with the
app closed, so the console can say a user saw a reminder and cannot say the platform delivered it.

The Admin Control Center now genuinely controls and observes NOVA rather than appearing to. It is
not finished, and the three things it most recently claimed to have finished — three console pages,
the provider table, and "last tested" — turned out to be false when the pages were opened rather
than assumed. That is the reason the sweep is now generated from the navigation model instead of
typed by hand.

### 7.10 RESOLVED — three security defects found by not believing the comments

This section exists because three separate places in this repository described behaviour that the
code did not implement. Each was verified on the running system, and each is now fixed.

**1. Suspension did not suspend.** A user-detail route comment claimed that because `authenticate`
re-reads the user on every request, setting `users.disabled` means "suspended now rather than
suspended after the 15-minute access token expires". `authenticate` verified the signature, the
expiry and the denylist, and then trusted the `sub` claim; it never read `users` at all. Measured
live: a real access token returned **200 from both `/control/metrics/platform` and `/reminders`
after `users.disabled` was set to true**. Suspension blocked new logins and refresh, so an account
was signed out within fifteen minutes, but for those fifteen minutes it kept full use of the API —
and a token for a *deleted* account kept working too, since nothing checked that the subject
existed.

*Fixed* in `middleware/auth.ts`: `assertAccountUsable` runs before every authenticated route and
refuses a disabled or missing account with the same `403 ACCOUNT_DISABLED` the login and refresh
paths already return. Verified live: the same token now answers 403 on both routes, and
reactivation restores it immediately. It fails **open** on a read failure, matching
`resolveGrantedPermissions` — a database blip must not become an authentication outage on every
route at once — and the degradation is logged at error level so it is visible rather than silent.
It reads through `getDbPool()` rather than the Drizzle client, because this now runs before the
route and would otherwise consume a `mockReturnValueOnce` that the route itself is scripted to
answer; the shared test harness answers it in one place.

**2. The administrator session table had no writer.** `admin_sessions` was created by migration
0006 with a unique index on `jti`, an index on `expires_at`, and a heartbeat — `touchAdminSession()`
— that updated `last_seen_at` on a row that could never exist. The table held **0 rows** while 638
audit rows named who had acted. Two consequences: "which operators are signed in right now" was
unanswerable, and an operator had **no way to end another operator's session** — revoking a refresh
token does not touch a 15-minute admin access token, and there was no handle on one.

*Fixed*: `admin/admin-sessions.ts` registers a session on the first control-plane request from a
token (recording its real `exp` rather than a guessed lifetime), the heartbeat now has a row, and
`GET /control/admin-sessions` + `POST /control/admin-sessions/:id/revoke` expose it. Revocation sets
`revoked_at` **and** calls `tokenDenylist.revoke`, which `verifyAccessToken` consults before any
route runs — so unlike a user session revoke, this is immediate rather than "next refresh". Verified
live: token B returned 200, an operator revoked its session, and token B's very next request was
`401 Token has been revoked`. A caller cannot end its own session (`409 SELF_SESSION`); there is
deliberately no last-administrator guard, because a session is restored by signing in again and
refusing to end the only super-admin session would leave a stolen token alive exactly when ending it
matters most. Console page: `/security/sessions`.

**3. Every displayed timestamp could be hours wrong.** This is the most widely-felt of the three and
it was found by noticing that a session created seconds earlier reported 5h30m in the past.

Every timestamp column in this schema is `timestamp` **without** time zone, and the database runs
`Etc/UTC`, so the stored string is a bare UTC wall clock. Two drivers write those columns and they
disagree: Drizzle serialises a `Date` as UTC, node-postgres serialises it in the **process**
timezone — and on read, node-postgres parses a bare timestamp in the process timezone. On a machine
set to `Asia/Kolkata`, `admin_sessions.expires_at` held the correct literal
`2026-09-21 19:24:07` and was read back as `13:54:07Z`; `reminder_events.occurred_at` displayed
18:39:30 as 13:09:30. Any value written by one driver and read by the other was off by the host
offset.

*Fixed* on both halves: `process.env.TZ = 'UTC'` at the top of `services/api/src/server.ts` (with
`ENV TZ=UTC` in the Dockerfile and a `.env.example` note) makes the write side agree with the
database, and a `pg` type-parser override in `packages/database/src/index.ts` makes the read side
treat OID 1114 as UTC **independently of the process timezone**, so a script that forgets to pin
`TZ` still reports the right instant instead of silently shifting every timestamp it prints. Verified
live: the same row now reads `19:25:29Z`, 30 minutes ahead, which is what a 30-minute token means.
Historical caveat: rows written by node-postgres on a non-UTC host before this change carry shifted
literals — the refresh `sessions` table is the one affected — so their display moves by the host
offset. Nothing reconstructs the original instant, and no decision turns on the difference.

**A fourth finding, about the build rather than the code.** Workspace packages resolve to `dist/`,
not `src/`, so the type-parser override above did nothing until `packages/database` was rebuilt —
the first attempt appeared to work and silently did not. Any change under `packages/*/src` is
inert at runtime until that package is rebuilt, which is worth knowing before trusting a green
typecheck of the API against a stale package build.

---

### 7.11 RESOLVED — audit-log export, and the two defects writing it exposed

`audit.export` had been a permission since migration 0006 with **no route behind it**. The console
said so in as many words rather than offering a button that did nothing, which was the right call
and still left the gap: the audit log is the record an operator is asked for after an incident, and
the only way to produce it was to read the table directly.

It now exists as `GET /control/audit-logs/export` — filtered by the same parameters as the listing,
capped at 50,000 rows, and permissioned separately from `audit.read` because reading the log in the
console and taking a copy of it out of the platform are different capabilities. Downloadable from
`/security/audit-log` through a console route handler that forwards the operator's token and the API's
answer, so there is exactly one authorisation decision and it is the server's.

**Two defects the work exposed, both found by reading the output rather than the assertions.**

1. **CSV injection was a live risk, not a theoretical one.** A cell beginning `=`, `+`, `-`, `@`,
   tab or CR is a *formula* to Excel, LibreOffice and Google Sheets. Audit rows carry
   operator-supplied text — a reason, an email, a target id — so an unescaped reason of
   `=HYPERLINK("http://evil","click")` would have run on the machine of whoever opened the export:
   the auditor. Every such cell is now prefixed with an apostrophe, which is what a spreadsheet
   treats as literal text.

2. **Timestamps arrived triple-quoted.** The first version passed every non-string through
   `JSON.stringify`, so a `Date` became `"2026-09-21T19:01:58.116Z"` *with* quotes, and the CSV
   quoter then doubled them — `"""2026-09-21T19:01:58.116Z"""`. Every row in the file had mangled
   timestamps and the unit tests passed, because they asserted on the header and on synthetic string
   cells. It was caught by parsing a real export. `escapeCsvCell` now serialises a `Date` as its ISO
   instant, and the live check parses 785 real rows and asserts no cell contains a quote.

The live verification is deliberately *not* a presence check: section 16 parses the downloaded file,
asserts the header matches the declared columns, that every row parses, that an `outcome=denied`
filter really restricts the file, that no cell would be evaluated as a formula, and that the export
wrote its own `audit_log.export` row naming the permission — while a READ_ONLY token is refused 403.

---

### 7.12 RESOLVED — no login attempt was recorded anywhere, and the Security Center that needed it

§29 asks the Security Center to show **failed admin logins**. The console could not: nothing recorded
a sign-in attempt. `users.last_login_at` kept the timestamp of the most recent *success* for one
account with no client information, and a failed attempt left no trace in `audit_logs` or
`admin_audit_logs` — neither table had an auth row at all. So the question a control plane most needs
to answer during an incident, *"is somebody trying to get into this console, and from where"*, was
unanswerable from persisted data.

**The instrumentation.** `services/auth-events.ts` writes one row per attempt through the login
route, for all four outcomes — `ok`, `unknown-account`, `bad-password`, `account-disabled` — carrying
the attempted address (lower-cased and length-capped), the reason, and the client IP. Success is
recorded as well as failure, because a failure count with no baseline is not a signal.

Three properties are deliberate and tested:

* **An unmatched address is `actorType = "anonymous"` with no account id.** "This address was tried"
  is a fact; "this account was attacked" is not, and the row must not assert it.
* **The reason is for the operator, never the caller.** The 401 stays generic — recording the reason
  must not turn the login route into an account-enumeration oracle.
* **No credential reaches the row.** The function's signature has no password field, and a test
  walks the written row's keys asserting none is named like one.

Two costs are stated rather than hidden: the table accumulates addresses people mistype, and an
attacker can write rows (the auth limiter caps per-IP attempts at 10/min and the rows are small, but
the growth is real — the alternative is not noticing). Both are in the module's doc comment and in
the page's own notes.

**The Security Center** (`/security`) puts the pieces that were scattered across four destinations
side by side: failed sign-ins with their reasons, addresses and clients; refused privileged actions
with the permissions and actors; live, ended and expired operator sessions; privilege changes;
configuration, flag and secret changes; credential status; and a **watchlist** of accounts with
repeated refusals. The watchlist reports the count of *distinct* permissions as well as the raw
count, because "kept trying the one thing they cannot do" and "probed the whole permission surface"
are different patterns a bare count hides — and it names the permissions and times rather than
labelling the account, since a support engineer during an incident routinely reaches for something
they do not hold.

The page performs **no actions**. Every mutation it describes already has a home with its own
confirmation and permission; a second path to the same action is how an operator finds the one that
skips a step.

It also states its own limits on the page rather than in a comment: there is no anomaly scoring, no
impossible-travel check and no device fingerprint, and the threshold that puts an account on the
watchlist is printed where a reader can judge it.

---

### 7.13 RESOLVED — no administrator second factor, now opt-in TOTP with recovery

§30 lists MFA/2FA and the control plane had none. An operator's account was protected by a password
alone — and **that same password unlocks every other NOVA surface, including the mobile app** — so a
password found in a breach dump was control of the platform.

**Implemented.** `admin/totp.ts` is RFC 6238 TOTP over `node:crypto`'s HMAC-SHA1, written rather
than taken from a package because it is the one piece that must be exactly right: a subtly wrong
implementation rejects valid codes and accepts codes outside the window it claims, and a dependency's
own tests would not be checking that on our behalf. It is checked directly against **RFC 6238
Appendix B's published vectors** and RFC 4226's HOTP vectors — the only assertions that prove the
truncation rule, since every mistake still produces plausible six-digit numbers and a
generate-then-verify round trip passes for all of them.

Storage is a new `admin_mfa` table (migration 0011). The secret is an AES-256-GCM payload from the
existing `admin/secrets.ts` — the same format `system_configs` uses, because a TOTP secret is a
long-lived credential and plaintext storage would make the second factor weaker than the password it
guards. Recovery codes are SHA-256 hashes only.

**Four rules make it safe to turn on, and each is verified live:**

1. **An unconfirmed enrolment gates nothing.** `confirmed_at` stays NULL until the operator submits a
   code generated from the secret, and only a confirmed row is enforced. Starting enrolment and
   abandoning it cannot lock anybody out — the failure mode that matters most, because the
   alternative is being locked out of the platform that holds the recovery path.
2. **Ten single-use recovery codes, shown once.** A lost phone is not a lost platform. The table
   holds hashes, so a second read is impossible rather than merely unimplemented.
3. **A code cannot be replayed.** The accepted step is recorded and anything at or before it is
   refused — without that, the ±1-step drift window is also a 90-second replay window.
4. **Disabling needs the password *and* a code.** Requiring only the password would make a phished
   password sufficient to remove the control installed against phishing.

**Enforcement lives in the shared login route, not the console**, because a factor that guards one
client is not a factor. It is opt-in per account, so the mobile client — whose accounts never
enrol — is unaffected; that is the deliberate trade for not breaking the app for every user who has
no authenticator.

Every route acts on the **caller's own account**: there is no `:userId` parameter, so the whole IDOR
class a "manage another operator's factor" endpoint would introduce cannot be expressed. Recovering
an operator who has lost both their phone and their recovery codes is a deliberate human process,
not a button.

**Three test bugs, not product bugs, which are worth recording because each would have read as a
pass.** The first version of the live check used the shared `SUPER` token, which is bound to a
different account than the one being signed in as — enrolment succeeded, but it gated *that* account,
so every sign-in assertion passed for the wrong reason (a 200 that meant "no factor here"). The
second computed the TOTP code *before* waiting out the auth rate limiter, so the retry sent a code
from a step that had already passed. The third used an already-consumed code to disable, and the
refusal was the replay rule working correctly. A fourth, in the console, was a `try/catch` that never
applied because the patch was written with tabs against a file indented with single spaces — the
`MFA_REQUIRED` branch silently did not exist until a browser test failed on it.

---

### 7.14 RESOLVED — a rotated credential kept the test result of the value it replaced

The report listed this as a *missing capability*: `fingerprintSecret()` existed and was unit-tested,
but nothing stored its output, so the console could not answer "has this changed since I rotated it".
Investigating it showed something worse than an absent feature — an **active false claim**.

`provider_health_checks` recorded a result but not which value it tested, and `listConfigViews` showed
the most recent result for a key however old it was. So after an operator rotated an API key:

* a result of `pass` continued to assert that a credential works, **for a value that had already been
  replaced and no longer exists**;
* a result of `fail` continued to assert a failure the operator had just fixed, so the console told
  them their fix had not worked when in fact nobody had tested it.

Both are the same defect: a claim about current state derived from a measurement of a past state.
This is precisely what §44's "no fake metrics" rule exists to catch, and it is worth noting that the
console *already* had the right instinct elsewhere — the Security Center refuses to render an untested
credential as healthy — while this table rendered a stale test as current.

**The fix.** The check records a fingerprint of the credential it exercised
(`provider_health_checks.secret_fingerprint`, migration 0012, computed by
`providerConfigurationFingerprint`), and the read model recomputes that fingerprint for the value in
force and compares. A mismatch renders **"tested a previous value"** in both console tables instead of
the recorded status — the result is still shown, because "the last test passed, against the key you
have since replaced" is useful; presenting it as the current state was the problem.

Three details are deliberate:

* **One fingerprint definition on both sides.** The first implementation fingerprinted
  `"KEY=value"` when writing and a bare `value` when comparing, so the two could never agree and
  *every* result read stale — including one from a test that had run seconds earlier against the
  value in force. It was caught by the live check on its first run; a unit test on either side alone
  would have passed. The helper now lives in `config.ts` and both callers use it.
* **A provider's fingerprint covers every key it reads**, joined with a NUL separator so
  `A=ab, B=c` and `A=a, B=bc` cannot collide. Object storage validates two keys and goes stale when
  either changes.
* **`NULL` means no credential was involved** (PostgreSQL, Redis, an unset Stripe key) — *not* stale,
  and the two must never render alike.

The live verification rotates a real key, observes the stale state, re-tests to clear it, removes the
override, and re-tests to restore — all inside a `try/finally` that cleans up, because a probe that
leaves a placeholder in a live credential is worse than the defect it was written to find. That
`finally` is not hypothetical: an earlier version of the probe omitted the typed confirmation the
delete route requires, got a 400, and did leave the placeholder in place.

---

### 7.15 RESOLVED — the device → AI → console path, and a teardown crash it exposed

§56 step 6 asks the console to show a user's **AI request** alongside the user, task and reminder.
The reminder half was proven on the emulator; the AI half had not been, and the reason was mechanical
rather than a judgement about the product: the Converse screen submits through the keyboard's IME
*send* action (`textInputAction: TextInputAction.send`, `onSubmitted`), and `adb shell input` cannot
press it — `KEYCODE_ENTER` inserts a newline in that multiline field. The shell could not reach the
code path at all.

**`integration_test/e2e/converse_e2e_test.dart`** closes it. It boots the **real** app through
`bootstrapDependencies()` over `adb reverse` against the real API, opens Converse, types a message,
and performs the send through `tester.testTextInput.receiveAction(TextInputAction.send)` — the same
channel the on-screen keyboard uses, so `onSubmitted` runs exactly as it does for a person. The reply
that comes back is the provider's.

```
[e2e][converse] assistant turn: [serendipity]
[e2e][converse] full transcript: [READY, Ready, YOU, Reply with the single word serendipity and
                                 nothing else. (log ref e2e-marker-…), NOVA, serendipity, Report, …]
00:37 +1: All tests passed!
```

The operator side then sees the same turn: `GET /control/conversations?userId=…` reports one
conversation, `mode: text`, `messages: 2`, `userMessages: 1`, and the activity metrics behind the
dashboard include it — `conversationsToday: 11`, `textConversations: 12`, `aiRequests: 13`,
`aiTotalTokens: 48663`, with the latency figure carrying its own caveat about how many replies it was
measured on.

**Three rejected assertions, each of which passed without observing anything.** This is the part worth
recording, because each one *looked* green:

1. The test asked the model for "ACK" and then waited for a visible `ACK` — which the user's own
   message satisfied instantly. The test passed while the screen still read "Thinking…", so the round
   trip it exists to prove was never observed.
2. It then used a token like `ZZQ78170` and waited for that — again satisfied by the user's message.
   Worse, that shape (three capitals then digits) matches the API's **passport-style PII pattern**, so
   the API rewrote the token to `[REDACTED]` before the model ever saw it. The transcript showed
   `NOVA` followed by `[REDACTED]`: the redaction working exactly as designed on a "random" test value.
3. It then accepted *any* newly-visible line, and matched the `YOU` label the moment the user's
   message rendered.

The final version captures the screen before sending and waits for a line that is new, is not the
user's message, and is not transcript chrome — then checks that line against a word the prompt asked
for. The word is a plain lowercase noun, so it matches no redaction pattern, and the check is
case-insensitive against the assistant's own turn only.

**A crash the test exposed, and the fix.** Every run reported `Some tests failed` with every assertion
passed. `VoiceRealtimeController.cancel()` reaches `_set(...)` after three `await`s, and when the
provider container is disposed in that gap the assignment threw `UnmountedRefException` — reported
*after* the test body, so there was no failing assertion to look at. `_set` now returns early when
`!ref.mounted`, the same guard `briefing_controller.dart` already uses on its async paths. That is a
real robustness fix rather than a test accommodation: any async completion after disposal crashed.

**And one order-dependent browser test.** The MFA login-form test passed alone and failed in the full
sweep, because every other test in that file runs with a session cookie and the guard redirects away
from `/login`. It now clears cookies and `localStorage` first. Same family as the API-suite flakes
noted in §7.2: shared state leaking between tests, caught because the tests are run both ways.

The emulator is not physical hardware and this does not change that — §4.3's distinction stands.

---

### 7.16 §56 step 6 completed on the device — and the gap the tool-call test found

§56 step 6 asks the console to show the **user, task, reminder, AI request and activity** for a request
made in the app. Every row is now proven from a device image, and the last one took a second on-device
test.

**`integration_test/e2e/task_creation_e2e_test.dart`** asks NOVA to create a task through the real
composer and the real IME send action. The model emitted a `create_task` tool call, the server executed
it, and the evidence is on both sides:

```
[e2e][task] the task exists after an unapproved tool call
[e2e][task] account has 1 task(s); titles=[buy oat milk for the endtoend run]
[e2e][task] tasks screen: [Tasks, Tasks, Reminders, buy oat milk for the endtoend run, NOVA, …]
[e2e][task] PASS
```

```
GET /control/tasks?userId=…  ->  totalItems: 1
  title: buy oat milk for the endtoend run | status: pending | user: e2e-maketask-1-838300@nova.test
```

With that, all five rows of step 6 have device-side evidence: the user and the task here, the reminder
from §4.3's acknowledgement run, and the AI request from §7.15.

**The test's own first run failed on a redaction, not a bug — for the second time.** The title carried
a five-digit suffix for uniqueness, and the API's PII redactor rewrote it: the passport-style pattern
`\b[A-Z]{2,3}\s?\d{4,6}\b` is case-insensitive, so `run 39032` matches it as readily as a real
document number. The stored task was titled `buy oat milk for the e2e [REDACTED]`, the model never saw
the digits, and an exact-title assertion failed on a correct system. The test now uses a title with no
digits and asserts "the account's only task is this one", which a redactor cannot defeat. That the same
filter also rewrote §7.15's reply token makes it worth stating plainly: **the redactor is aggressive
enough to alter benign user text**, which is a deliberate safety trade-off and not a defect, but it does
mean any test fixture containing letters next to four or more digits may not survive the round trip.

**The finding the run exposed.** The transcript shows the tool executed with `approved=false` — no
confirmation sheet, and `tool_approvals` holds zero rows. That is not what the code says should happen:

* `realtime/tool-loop.ts` states the design in as many words — *"The one deliberate difference is the
  approval gate. The typed path confirms before it sends the request, so its tools execute
  immediately."*
* `services/assistant-tools.ts` defines the typed path's loop, and `AssistantToolLoopOptions` has **no
  approval field**; `routes/chat.ts` calls it with nothing that could gate a tool.
* `assistant-tool-executor.ts` documents the gap from the other side: the `blocked` option is *"absent
  on the typed path, which decides upstream"* — and upstream decides nothing. The option is read in one
  place and set by no caller.
* `VOICE_TOOL_CONFIRM_LEVEL` defaults to L1 with a comment saying that value *"closes the hole where
  `create_reminder`, `create_task` and `save_memory` ran on a spoken command with no prompt at all"* —
  true for the spoken path, and not true for the typed one.
* The console side is also incomplete: `routes/tools.ts`'s approve route records the decision and
  returns. Nothing executes the parked call, so there is no resume mechanism for an approved tool.

So a task, reminder or memory written from a typed message happens with no confirmation, on a path the
blueprint requires to confirm, while the voice path gates it. It is filed as a **P1 blocker** rather
than half-fixed: parking the approval without a way to execute it would silently drop the action, which
is worse than the current behaviour, and the two halves belong in one change.

The emulator is still not physical hardware, and none of this changes §4.3's distinction.

---

### 7.17 The log store the Logs page said was missing — and the failure reporting that caught its first bug

`GET /control/logs` used to answer `available: false` with a precise explanation: the API wrote pino
JSON to stdout, nothing persisted or indexed it, and a search would have had to invent its results. The
same response named the fix — *"wire a sink to the pino stream and add a query route over it. The
logger already emits JSON, so only a transport and the store are missing."* Both halves now exist.
§31's error/log centre and §32's trace view were both blocked on this; the trace view existed but could
only see what the audit, job and tool tables happened to record.

**`utils/log-sink.ts`** is a pino stream (`pino.multistream` alongside stdout) that batches into a new
`service_logs` table (migration 0013). Three properties decided the design:

* **A logged request never waits on the database.** `write` parses, buffers and returns; a timer
  flushes in batches. Logging is on the hot path of every request, so a synchronous insert would make
  the log store a way to take the API down — precisely when logs matter most.
* **A gap is recorded, never silent.** A full buffer drops the *oldest* entries and writes a
  `LogSinkOverflow` row naming the count, because the newest entries are the ones an operator is about
  to want and a log whose absences look like calm is worse than a loud failure.
* **Only what pino already redacted.** `multistream` hands each stream the final serialised line, after
  `redact` has run, so the sink never sees the live object and a credential cannot reach the table by a
  path the application redactor does not cover. A test asserts a redacted field stores as `[redacted]`.

Only `warn` and above are persisted by default (`LOG_SINK_LEVEL`), retention is 7 days
(`LOG_RETENTION_DAYS`) enforced on the sink's own flush cycle, and the level, retention, drop count and
pending-buffer depth all travel with the query response — so a quiet table reads as "no warnings", not
as "no traffic". The console prints all four beside the rows.

**The first live run failed, and the sink said so.** The insert was rejected with *"INSERT has more
expressions than target columns"* — a `now()` appended for a bookkeeping column that does not exist —
and **nothing was stored**. What made it a five-minute fix rather than an invisible outage was the
sink's own reporting: a bare `catch {}` would have swallowed it, so the failure path writes to stderr on
the first failure and every fiftieth after that. That reporting was added deliberately in the same
change, and it is the reason this paragraph exists rather than a silent gap in the table.

**Verified live.** A failed login produces a stored row and a traceable request:

```
level: error | msg: POST /api/v1/auth/login -> 401 | status_code: 401 | error_type: HttpError
requestId: trace-check-1790023726 | stack present: true

GET /control/logs?requestId=trace-check-1790023726   ->  1 row
GET /control/traces/trace-check-1790023726           ->  found: true
  counts: { adminAuditLogs: 0, jobExecutions: 0, toolExecutions: 0, serviceLogs: 1 }
  20:48:47  service_logs  ERROR POST /api/v1/auth/login -> 401 — HttpError
```

That trace returned nothing before this round: a 401 leaves no audit row, no job and no tool execution,
so the durable log line is the only record that the request happened. `error-handler.ts` now includes
`requestId` in its log object for exactly that reason — without it the line was stored with no way to
find it from a request.

Two test-side notes, both recurrences: the console renders `StatusBadge` labels with underscores
replaced by spaces, so the trace source reads "service logs" and asserting the table name failed; and
the MFA login-form test flaked in the full sweep because hydration plus a fetch does not always finish
in five seconds on a loaded machine — the bound is now fifteen, which is still a bound.

---

### 7.18 Cross-replica revocation — force-logout now reaches every replica

`middleware/token-denylist.ts` was an in-process `Map`. A revocation was therefore immediate on the
replica that performed it and **invisible to every other replica**, so "force logout" ended a session on
one instance while the token kept working on the rest until it expired — up to fifteen minutes. The
module's own comment named the fix: *"For distributed deployments, replace with Redis (SET with
EXPIRE)."* Redis is not running here, and adding a service to operate for one table is a larger decision
than the problem needs — Postgres is already the shared, durable store and already on every request path.

**The design is a polled cache, and the bound is stated rather than implied.** `isRevoked` runs inside
`authenticate`, on every authenticated request, so it cannot afford a query:

* revocations are written to `revoked_tokens` **and** to the local set, so the replica that performed the
  revocation applies it immediately — no regression from the old behaviour;
* every 5 s each replica pulls only the revocations newer than its watermark;
* the window in which another replica may still accept a just-revoked token is therefore **bounded by
  the poll interval**, not by the token lifetime.

Two details were chosen deliberately. The **local write happens first and unconditionally** — the
reverse order would mean a revocation that could not be recorded was also not applied, which is the worst
of both — and a failed persist is logged, because a revocation only one replica knows about otherwise
looks exactly like a shared one. The **watermark advances from the rows read**, not from the wall clock,
so a revocation written while the poll query was running is picked up next time instead of being skipped
by a timestamp that had already passed it.

**Verified across two live processes**, which is the only way to test this: the check starts nothing
itself and requires both replicas running.

```
1. register through replica A              -> token acquired
2. replica A accepts it: 200 | replica B accepts it: 200
3. logout through replica A                -> 204
4. replica A now rejects it                -> 401   (immediate, unchanged)
5. after one poll interval, replica B      -> 401   (before this change: 200)
6. revoked_tokens holds the row            -> 1
```

That check is `services/api/scripts/verify-replica-revocation.sh` (10 checks). It lives apart from the
python verifier because it needs two API instances at once, and making every other section depend on a
second replica's lifetime would be worse than one script run deliberately.

**What is still per-process, and still says so:** the realtime connection registry. It tracks live
sockets, which cannot be moved to a database — a row is not a socket — and an operator inspecting a
user's realtime state on the wrong replica still sees nothing. That remains in the blocker table.

Three pieces of copy that had become false were corrected rather than left: the API's note said the
denylist was per process and called Redis "the fix", and the console's Admin Sessions page said a
revocation is "immediate on the replica that performed it" without saying anything about the others.

---

### 7.19 The console no longer decides what you may see — and the copy it kept was wrong, not just duplicated

`apps/admin/src/lib/permissions.ts` carried its own copy of the role→permission matrix, and the
`/permissions` page carried its own copy of the catalogue with labels and descriptions. The file's own
comment defended the duplication: *"nothing here can grant access, and a stale copy cannot widen
anyone's rights — it can only show a link that then fails."* That reasoning was correct and it missed the
real defect.

**The console resolved the role claim in the token. The API resolves the database grant first, and falls
back to the claim only when there is no grant.** So for any operator whose `platform_admin_roles` row
differed from their token — which is the normal state after a role is changed from the console, until the
token is refreshed — the navigation was built from an answer the server would not give: destinations
offered that answer 403, and destinations hidden that the operator could actually open. It is a
presentation bug, and it is the kind that makes an operator believe they lack access they have.

Both copies are now gone:

* `GET /control/me/permissions` returns the caller's **effective** set and role, read from what
  `adminGate` already resolved on that request — the route performs no resolution of its own, so it
  cannot disagree with what the same request was permitted to do. It needs no permission of its own,
  because an operator who cannot see what they hold cannot use it to ask for more.
* `GET /control/permissions` returns the catalogue and the matrix, read from
  `services/api/src/admin/permissions.ts` — the module enforcement uses. Bounded by `admin_users.read`,
  and carrying no account, grant or session information.
* `apps/admin/src/lib/permissions.ts` is **deleted**, and the sidebar gates on the server's answer.

**The first attempt at this was wrong in an instructive way.** I had the sidebar fetch the endpoint from
the browser on mount. That is blocked by CORS — every other console call is server-side, and this one
belongs there too — so the navigation fell back to "no destinations" and the failure looked like a
permission problem rather than a network one. It is now resolved in the root layout, once per page load,
and passed down: correct on the first paint, no CORS, and no flash of the wrong navigation.

One assertion needed narrowing for the same reason it was written: the browser test originally checked
the **whole page** for the word "Users", which the dashboard's own metrics grid also renders. It is
scoped to the navigation element now — a destination and a metric labelled the same are not the same
thing.

Verified: a READ_ONLY operator holding four permissions sees `Services` and `Feature Flags` and is not
offered `Admins & Roles` or `Kill Switches`; the `/permissions` page renders the API's catalogue,
including a `config.secrets` description that exists only server-side; and a unit test asserts every
permission any role holds appears in the catalogue, which is how the two lists would have drifted.

---

### 7.20 The queue that was already a table — and the button that finally does something

The console's Jobs page read `job_executions`, which nothing wrote, and its Retry button answered
`501 RETRY_NOT_SUPPORTED`: *"there is no queue to re-enqueue into."* That was accurate and it left an
operator with an empty table and a control with no effect — the one place in the control center where a
button did nothing, against the brief's *"every important button must have a real backend effect."*

**The table was already shaped like a queue.** `job_name`, `queue_name`, `worker_id`, `status`,
`attempt`, `max_attempts`, `payload`, `result`, `error_message`, `duration_ms`, `started_at`,
`finished_at` — it had every column except the two a queue actually needs. So migration 0015 adds
`run_at` (which makes a retry backoff and a scheduled job the same expressible thing) and `enqueued_by`
(so a console-triggered retry is attributable), adds the `(status, run_at)` claim index, and this puts a
worker behind it. A second table would have meant two job concepts and a join between them.

**Claiming is one statement.** `UPDATE … WHERE id = (SELECT … WHERE status='queued' AND run_at <= now()
ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1)`. `SKIP LOCKED` is what makes it correct with more than
one worker: a row another worker is claiming is skipped rather than waited on, so two workers never run
the same job and neither blocks. That is why no broker is needed, and it is the same mechanism
Postgres-backed queues use.

Four decisions are worth stating, because each is a way the obvious implementation is wrong:

* **`attempt` counts attempts that ran, not claims.** Incrementing at claim time would show an attempt
  for work a crashed worker never started.
* **`reclaimStale` does not spend an attempt.** A worker that stops reporting has its job returned to
  the queue untouched — the work was interrupted, not failed, and charging it would dead-letter a job
  that never completed. A generous five-minute lease, because a slow job is not a dead one.
* **A retry resets the attempt count.** An operator retrying dead-lettered work is starting it again,
  not adding a fourth attempt to a budget already spent. Retrying something queued or running is
  refused with 409 — that is a duplicate, not a retry.
* **A job with no registered handler stays `queued`.** Failing it would let one replica running an
  older build dead-letter work the rest of the fleet can do.

**Verified live** (`verify-job-queue.sh`, 10 checks): a worker running with both handlers registered;
scheduled jobs enqueued by the scheduler and completed with duration, enqueuer and attempt recorded; a
retry returning 200 instead of 501 with its budget reset; the worker claiming the retried job and
completing it again; a second retry refused 409; the retry present in the audit log and a retry without
a reason refused 400. The handler count is read from the worker, so the page cannot claim a handler the
process does not have.

**Three mistakes of mine, all caught by verification rather than by reasoning.** Replacing the `throw
HttpError(501, …)` with a working retry left the handler falling through with **no `res` call at all** —
the route had only ever produced a response by throwing. The retry happened, the client waited until it
timed out, and nothing was logged; a `curl` reporting `000` while the database showed the side effect is
what identified it. And rewriting the listing route silently dropped `byJob`, `scheduled` and `note`,
which the page renders — the page's own browser test still passed because the table below was populated,
so the missing sections were found by reading the API response rather than by trusting a green sweep.
Both fields are restored, with `scheduled` now read from the worker instead of hardcoded. The page then
threw `Cannot read properties of undefined (reading 'length')` on the missing field — the error the sweep
could not see, because the table below it still rendered — so the rollup section is now guarded with
`?? []`: a missing section should render nothing, not take down the page holding the data an operator
came for.

---

### 7.21 §56 steps 11 and 12 — moving a reminder, and the operator seeing the new time

Steps 11 and 12 are *"user says: remind me again this evening"* and *"admin sees the updated reminder"*.
Creating a reminder had device evidence; **changing** one did not, and the two are different paths: an
update needs the model to name an existing row to `update_reminder`, which only works because the
grounding block emits `[id: …]` tags. Without those the model is told to "use the id from the list" and
the list has no id in it — the comment on `idTag()` records that this was once exactly the case.

`integration_test/e2e/reminder_update_e2e_test.dart` drives it on the emulator: the reminder is created
through the API so the *before* is exact, the app is launched with the real harness, and the instruction
goes through the real composer and the real IME send action.

```
[e2e][move] created reminder id=ea70a778-7394-4bc6-981c-ca58889cc03d at 2026-09-21T23:38:17Z
[e2e][move] assistant turn: [Done — the accountant reminder now goes off Thursday, 24 Sept at 9:00 am.]
[e2e][move] before=2026-09-21T23:38:17.211Z after=2026-09-24T03:30:00.000Z
[e2e][move] PASS
```

`09:00 Asia/Kolkata` is `03:30Z`, so the conversion is right as well as the change — and the operator
side agrees, through the console's own reminders route:

```
GET /control/reminders?userId=…   ->  totalItems: 1
  call the accountant about the quarterly filing | trigger: 2026-09-24T03:30:00.000Z
  user: e2e-movereminder-1-420179@nova.test
```

**The assertion is on the change, not on an instant, and that is deliberate.** The user's zone is
`Asia/Kolkata` while the server runs UTC, so "the day after tomorrow at nine" is a local expression the
model resolves; asserting an exact UTC instant would test the model's timezone arithmetic and would
break on a DST change for reasons unrelated to the platform. What is asserted is unambiguous: the time
moves forward by at least a day when asked for two, the new time is in the future, and **the row keeps
its id** — which is what separates an edit from a delete-and-recreate. A no-op cannot satisfy it, and the
comment says so where the next person will read it.

That completes the device-side evidence for every step of §56 that does not require physical hardware,
a microphone, or a push channel. Steps 7–10's notification half was proven in §4.3; the voice, avatar and
overlay halves, and steps 4 and 7–10 on a real handset, remain §9's P1.

---

## 9. Production blockers, classified
| **P1** | The typed/conversational path executes side-effecting tools with **no confirmation**, and an approved tool is never executed | `services/api/src/routes/chat.ts` (calls `runAssistantToolLoop` with no approval option), `services/api/src/services/assistant-tools.ts` (`AssistantToolLoopOptions` has no approval field), `services/api/src/routes/tools.ts:194` (the approve route records the decision and returns; nothing runs the tool) | Two halves, both needed: (1) park a `tool_approvals` row for a tool at or above `VOICE_TOOL_CONFIRM_LEVEL` instead of executing it, and (2) execute the parked call when the approval is granted, delivering the result into the conversation. Either half alone is worse than neither — parking without executing silently drops the action. The voice path already does both; this is the typed path catching up. |

| Class | Blocker | Exact location | Recommendation |
|---|---|---|---|
| ~~P0~~ | ~~Reminder notification taps are not reported on any shipped build~~ | `apps/mobile/lib/features/reminders/reminder_notifications.dart` | **Verified working** in the emulator run (§4.3): a tap set `triggered_at`, journalled a `triggered` event and moved the metric. Still unverified on physical hardware. |
| **P0** | No push channel, so every console change is pull-only | `apps/mobile` (no `firebase_messaging`); server half exists in `admin/providers.ts` and `devices.push_token` | Add the client and a delivery worker. This is the last item on the physical-device path. |
| **P1** | The acceptance scenario has only been run on an **emulator**, never on physical hardware | needs a handset + `adb reverse tcp:3001 tcp:3001` | §4.3 records what the emulator run covered. OEM battery management, real microphone and wake-word audio, and Doze behaviour are all unproven, and the brief's final rule is not satisfied until they are. |
| ~~P1~~ | ~~Device registration can lose a race with session restore at launch~~ | `apps/mobile/lib/app/app.dart` | **FIXED** — an auth-state listener registers on the transition into an authenticated session (`fireImmediately`, so a restored session is covered too). Verified live: a launch with **no** resume advanced `devices.last_seen_at`, where before it needed one. Three widget tests count the attempts: 2 with a session, 1 without. |
| ~~P2~~ | ~~The device → AI → console path is unverified~~ | `apps/mobile/integration_test/e2e/converse_e2e_test.dart` | **FIXED** — an on-device integration test sends through the real IME action, and the operator side sees the turn in conversations and activity metrics. Verified on the emulator (§7.15). |
| ~~P1~~ | ~~No administrator MFA~~ | `services/api/src/admin/mfa.ts`, `admin/totp.ts`, `routes/admin/mfa.ts`, `routes/auth.ts` | **FIXED** — opt-in TOTP with recovery codes, enforced at sign-in. Verified live: 24 checks in section 18, 22 unit tests against RFC 6238's vectors, 3 browser tests. |
| ~~P1~~ | ~~Job retry/replay returns 501 — there is no queue~~ | `services/api/src/jobs/queue.ts`, `jobs/worker.ts`, `drizzle/0015_job_queue.sql` | **FIXED** — a Postgres queue on the table that was already shaped for one, so no broker to operate. Retry, backoff, dead-letter, cancellation and stale-lease reclaim all verified live (§7.20). |
| ~~P2~~ | ~~No log sink, so `/logs` is correlation-only~~ | `services/api/src/utils/log-sink.ts`, `packages/database/drizzle/0013_service_logs.sql`, `routes/admin/system.ts` | **FIXED** — a self-hosted Postgres sink rather than Loki/OpenSearch, because a second system to operate is a larger decision than the problem needs. Verified live: a 401 is stored, queryable by request id, and now appears in its own trace (§7.17). |
| ~~P2~~ | ~~`audit.export` is a permission with no route~~ | `services/api/src/admin/audit-export.ts` | **FIXED** — a filtered, capped CSV export at `GET /control/audit-logs/export`, downloadable from the console. Verified live: 129-check script section 16, 21 unit tests, 1 browser test. |
| ~~P2~~ | ~~`secret_fingerprint` is never populated~~ | `packages/database/drizzle/0012_provider_check_fingerprint.sql`, `admin/providers.ts`, `admin/config.ts` | **FIXED.** The check records the credential it exercised; the read model compares it against the value in force. Verified live: 20 checks (§19), 8 unit tests, 1 browser test. |
| ~~P2~~ | ~~Cross-replica state is per process~~ | `services/api/src/middleware/token-denylist.ts`, `packages/database/drizzle/0014_revoked_tokens.sql` | **FIXED for token revocation** — a shared table plus a 5 s watermark poll, verified across two live API processes. The realtime connection registry remains per process and is documented as such. |
| ~~P3~~ | ~~`resetRateLimit` is dead code whose comment claims it runs after a successful login~~ | `services/api/src/middleware/rateLimit.ts` | **FIXED** — deleted, along with the `SlidingWindowStore.reset` it was the only caller of. The comment is replaced by one that states the opposite: nothing resets the auth limiter, and that is the property that matters against credential stuffing. The old comment had already misled a verification script into expecting a window that never clears. |
| ~~P3~~ | ~~Console copy of the permission matrix can drift~~ | `services/api/src/routes/admin/permissions.ts`, `apps/admin/src/app/layout.tsx` | **FIXED** — worse than drift: the console resolved the token claim while the API resolves the database grant first, so it could hide pages an operator could open. The copy is deleted and the console asks the server (§7.19). |
| ~~P3~~ | ~~No in-page pagination for very large audit tables~~ | `/security/audit-log` | **FIXED, and the finding was half wrong.** Pagination already existed on the page (the row was stale). The real defect underneath it was the `from`/`to` date range: the API and the CSV export both accepted one, the page had no date inputs at all, and the export button promised "exactly the rows the current filters select" while ignoring a range the operator could not set. The page now has `datetime-local` from/to inputs, the export link carries the range, and a browser test asserts the two agree. |

## 10. The live deployment — what is running at nova.leadup.in now

Everything before this section was verified against a local API and console. This section records the
first run against the **production server** (`ssh root@91.107.202.66`, `ubuntu-4gb-fsn1-3`), which is
also the deployment the brief's final rule is about.

### 10.1 What was actually there

The live host was two generations behind this repository, and the gap was bigger than "an older build":

| Probe | Result before this deploy |
| --- | --- |
| `GET /api/v1/control/*` on the public API | **404 on every route** — the Control Center did not exist in the deployed binary |
| `docker exec nova-api ls /app/dist/routes` | `admin.js` (one file), no `routes/admin/` directory |
| `nova-admin-ui` route table | `users, organizations, usage, incidents, feature-flags, languages, audit-logs` — eight pages of an older console |
| Database | 42 tables; **no** `admin_sessions`, `system_configs`, `job_executions`, `service_logs`, `revoked_tokens`, `admin_mfa`, `platform_admin_roles`, `provider_health_checks` |
| Migration state | `__migrations` (a legacy runner's table) listing `0000`, `0001`, `0002`; drizzle's own `drizzle.__drizzle_migrations` did not exist |

There were **29 real user accounts** and 386 sessions in that database. It is not a scratch instance, and
nothing here was allowed to discard them.

### 10.2 The deploy

Source now goes through `github.com/leadupofficial/nova-leadup` — 122 local commits that had never been
pushed, plus the Control Center body of work, are on `main` (`c466087`, then `fca1c1e`). The server
builds from a clean clone at `/opt/nova-deploy`; nothing is rsynced from a developer machine.

Two image builds were made on the server, both from that clone:

- `nova-api:prod` — 1.14 GB, from `services/api/Dockerfile`.
- `nova-admin-ui:latest` — 2.07 GB, from `apps/admin/Dockerfile` with
  `--build-arg NEXT_PUBLIC_API_BASE=https://api.nova.leadup.in/api/v1`.

`services/api/Dockerfile` had to be rewritten to build at all, and the three defects are worth naming
because each one would have failed a deploy rather than a test:

1. `CMD ["node", "dist/index.js"]` — this service has no `src/index.ts`. The entry is
   `dist/server.js`. With `restart: unless-stopped`, that is a crash loop, not a failed build.
2. The dependency layer copied four `packages/*/package.json` files that are not this workspace's
   dependency graph, so `pnpm install` aborted with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` for
   `@nova/database` and `@nova/shared-types`.
3. It compiled the API alone. `@nova/database` resolves through a `dist/` that is gitignored, so a
   clean context failed with 55 × `TS2307 Cannot find module '@nova/database'`.

The third one produced a genuinely instructive failure. The first build attempt failed that way; the
*tree* it was built from had been rsynced from this machine, and the rsync carried
`packages/database/tsconfig.tsbuildinfo`. That package sets `composite: true`, so tsc read the stale
incremental state, reported **success**, emitted nothing, and the next package failed against a `dist/`
that was never written. The failure looks exactly like a broken import graph. `.dockerignore` now
excludes `**/*.tsbuildinfo`, and the build from the clean clone succeeds — the difference between the
two builds *was* the stale artifact.

`.dockerignore` itself was in `.gitignore`, which is why no clone had one. That is fixed too: a build
from a clone previously sent the whole working tree, `apps/mobile`'s Flutter output included, as the
Docker context.

### 10.3 The database

The live schema was not a prefix of this repository's migration lineage, even though it reported
`0000`, `0001`, `0002` applied — an older custom migration runner (`/opt/nova/migrations/`, and the
`__migrations` table) had created objects that this lineage creates later. Drizzle decides what to
replay by comparing the newest recorded `created_at` against each journal entry's `when`, so the
journal was seeded with the three entries' real hashes and journal timestamps, and the migration ran
from there.

That exposed exactly one collision, found by a dry run that wrapped every migration in a `SAVEPOINT`
and rolled the whole thing back: `notification_preferences`, created by `0003`, already existed. Its
live definition was compared column by column against the migration's and was **identical** — the only
difference was the auto-generated constraint name. It was renamed aside, the migration created the
table the lineage expects, its single row was copied back, and the legacy table was dropped. Nothing
else in `0003`–`0015` collided.

Result: **16 of 16 migrations applied**, 57 tables, and every pre-existing row intact — 29 users, 386
sessions, 1 notification preference.

One operational secret was generated on the server rather than inherited: `NOVA_CONFIG_ENCRYPTION_KEY`.
`services/api/src/admin/secrets.ts` fails closed in production without it, so before this the console
could not store a single provider credential. The compose file passed every other API secret through
explicitly and omitted this one; it now passes it, and the key lives only in `/opt/nova/.env`.

Three compose edits, all scoped to their service block (the same `JWT_REFRESH_SECRET` line appears in
three services, so a global replace would have edited the wrong ones):

| Service | Before | After | Why |
| --- | --- | --- | --- |
| `api` | *(absent)* | `NOVA_CONFIG_ENCRYPTION_KEY` passthrough | credentials cannot be stored without it |
| `admin-ui` | `NEXT_PUBLIC_API_BASE=https://nova.leadup.in/api/v1` | `https://api.nova.leadup.in/api/v1` | canonical API origin |
| `admin-ui` | `API_ORIGIN_URL=http://admin:3004` | `http://api:3001` | pointed at the **legacy** `services/admin` container, a different service with a different API |

### 10.4 What was verified on the live system

Read-only, against the public hostnames, with a 25-minute token minted for the existing Owner account
(`admin@nova.leadup.in`) rather than the operator's password:

| Check | Result |
| --- | --- |
| `https://admin.nova.leadup.in/` | 307 → `/login?next=%2F` (guard working) |
| `https://admin.nova.leadup.in/login` | 200 |
| Browser sweep, **every destination in `NAV_GROUPS`** | **34 passed, 0 failed** — each asserted a real `<h1>`, no failure markers, no React error digest, and no "Could not reach the admin API" card |
| `GET https://api.nova.leadup.in/api/v1/control/users` | 401 (exists, refuses anonymous) — was 404 |
| Job worker at boot | `handlers: ["providers.health_check","logs.reap"]` |
| First scheduled provider check | `{"providers":["sarvam"],"msg":"[job-queue] scheduled provider check found failures"}` — a real signal from the live cron path, not a fixture |
| `GET https://api.nova.leadup.in/healthz` | 200 `{"status":"ok"}` |
| `/api/v1/auth/me`, `/notifications`, `/tasks` | 401 — the mobile client's contract resolves |

The mutating verifiers were deliberately **not** run against production. `verify-control-plane.py`
creates a `PROACTIVE_ASSISTANT` flag and flips `CONTROL_AI_ENABLED` to `false` mid-run; on a host with
29 real accounts that is a user-visible outage if the run is interrupted, not a test. The full mutating
suite stays local; the live pass is the read-only sweep above.

### 10.5 Rollback

Before anything was replaced: database dump to `/opt/nova/backups/nova-predeploy-20260922-065849.dump`
(`pg_dump -Fc`), `docker-compose.yml.bak.20260922-073520`, and the previous images retained as
`nova-api:predeploy` and `nova-admin-ui:predeploy`. Rollback is retag-and-`up`, plus a restore from the
dump if the schema has to go back too.

### 10.6 The production password leak, found by signing in

Everything above seeded a token into the cookie. That is what a *finished* login leaves behind, and
it says nothing about whether a human can get in — so the deployed sign-in form was driven for real,
with a real password, against `https://admin.nova.leadup.in`. It did not work, and the reason was
worse than "it does not work":

```
https://admin.nova.leadup.in/login?email=admin%40nova.leadup.in&password=<the actual password>
```

`LoginForm.tsx` had `onSubmit={handleSubmit}` (which calls `preventDefault`) and **no `method`
attribute**. An HTML form with no `method` submits as GET. Until React attaches, the browser owns
the submit, so every field is serialised into the query string — into the address bar, the browser
history, every `Referer` header, and nginx's access log. That is not a test artifact: a JavaScript
chunk that is slow to load, a hydration failure, or JavaScript disabled outright all take that path.

**It had already happened to a real operator.** The rotated nginx log for **2026-09-18** holds two
entries from a real browser:

```
165.99.72.182 - - [18/Sep/2026:10:17:08 +0000] "GET /login?email=admin%40nova.leadup.in&password=<MASKED>" 200 2438
    "https://nova.leadup.in/login?next=%2F" "Mozilla/…"
```

So the platform's own administrator had their password written to a log file by using the login
form — on the *old* console, before this work started. The defect was inherited, not introduced
here, and it is the kind that survives review because the symptom is an empty-looking form rather
than an error.

**The fix has two independent guards**, because the leak and the race are different problems:

1. `method="post"` on the form. An unhydrated submit now posts a body; the credentials never reach
   the URL.
2. The submit button is `disabled` until a `useEffect` confirms hydration, so that submit does not
   happen at all. `title` explains why while it is inert.

Two tests cover it, on purpose:

| Test | What it proves |
| --- | --- |
| `tests/admin-console.spec.ts` → *the sign-in form cannot leak credentials before React hydrates* | Loads `/login` with **JavaScript disabled** and asserts the server's own HTML: `method="post"` and an inert submit button. JavaScript-disabled is the exact state in which the `onSubmit` handler does not exist, so this is the only check that covers the failure. |
| `tests/admin-live-login.spec.ts` | Drives the real form against a real deployment; skipped unless `ADMIN_EMAIL`/`ADMIN_PASSWORD` are set, because it is the one test that needs a real password. |

Both pass against production. The second one also failed once for a reason worth recording: it typed
into the inputs before hydration, and because they are controlled, React rendered them from its own
empty state on hydration and the API answered `400 VALIDATION_ERROR: Password is required` against a
form that looked filled in on screen. The test now waits for the submit button — the same hydration
signal an operator gets — before typing.

**Credential hygiene, done as part of this:** the password used during the failing run was exposed in
a URL and in `access.log`. It was rotated. All five occurrences in the live access log and all three
in the rotated archives are redacted in place, the pre-scrub archive is quarantined at
`/root/nova-log-quarantine/` (mode 700, root only) as evidence, and the account was given a fresh
password that has never been in a URL. The password leaked on 2026-09-18 is the one this rotation
retired.

### 10.6 Blockers this deploy created or exposed

| Class | Blocker | Evidence | What it needs |
| --- | --- | --- | --- |
| **P0** | The Android build served to users is **older than the backend it now talks to** | `/opt/nova/downloads/nova-arm64.apk` is dated 2026-09-19; the API it points at was replaced on 2026-09-22 | Rebuild the APK from `main` and republish it at `/download.apk`, then run the acceptance scenario on it |
| **P1** | The physical-device acceptance run still has not happened | `adb devices` returns **no devices** — not even the emulator | A handset, `adb reverse` or a real API URL, and the run in §4.3 |
| **P2** | The live database's history diverged from this repository's migrations | `notification_preferences` collided; `__migrations` is a legacy table | Any *other* deployment built from the old lineage needs the same documented repair. A fresh deploy from a database created by `packages/database/drizzle/0000`–`0002` alone is clean |
| ~~P3~~ | ~~The live console was verified with a minted token, not the operator's password~~ | `tests/admin-live-login.spec.ts` | **FIXED** — and it found a P0. The deployed sign-in form submitted as **GET** before hydration, putting the password in the URL and in nginx's access log; a real operator hit it on 2026-09-18. Fixed with `method="post"` plus a hydration-gated submit, and the password is verified working end to end. See §10.6 |

## 11. Security review: end-user content, CRUD coverage, and provider readiness

### 11.1 The exposure, and what it actually was

The report claim to test here was "sensitive user data (conversations, tasks, reminders) is being
exposed". It was, but not where the UI suggests. The permission *catalogue* already separated metadata
from content (`conversations.read` vs `conversations.content_read`) and the role table already stated
the policy in prose — `ANALYTICS_ADMIN` is "metrics and cost, no personal data", `SUPPORT_ADMIN` is "no
conversation content". Three routes did not honour it:

| # | Path | Gate it used | What it returned | Proof |
| --- | --- | --- | --- | --- |
| 1 | `GET /control/users/:id` | `users.read` | memory **bodies** verbatim, task titles + descriptions, reminder titles, notification titles | `routes/admin/users.ts` (route + the SQL and response assembly below it) |
| 2 | `GET /control/conversations` | `conversations.read` | `title` — and `routes/chat.ts` writes that title as the **first 100 characters of the user's own message**, so `conversations.read`'s own catalogue entry ("No message text") was false | `routes/chat.ts` (write) → `routes/admin/operations.ts` (read) → `apps/admin/src/app/conversations/page.tsx` |
| 3 | `GET /control/tasks`, `GET /control/reminders` | `tasks.read`, `reminders.read` | `title` and `description` | `routes/admin/operations.ts`, rendered at `tasks/page.tsx:189,191` and `reminders/page.tsx:193` |

Measured against the running API before the fix, with a real token per role:

```
analytics_admin    tasks 200 CONTENT:title    reminders 200 CONTENT:title
operations_admin   tasks 200 CONTENT:title    reminders 200 CONTENT:title    conversations 200 CONTENT:title
```

`ANALYTICS_ADMIN` is the sharpest case: its documented purpose is metrics with no personal data, and it
held a path to every user's task text and, through the user-detail route, their stored memory bodies.
None of those reads wrote an audit row — while the console told the operator they had
("Personal data. Listing memory is an audited action") on the very page that leaked them.

**Fixed.** Three permissions were added — `tasks.content_read`, `reminders.content_read`,
`memory.content_read` — granted to `SUPER_ADMIN` and `DEVELOPER` only, mirroring
`conversations.content_read` exactly so all four domains follow one rule instead of four. The
endpoints now return the same rows, the same `totalItems` and the same pagination either way, with the
user's words removed and a `contentRedacted` flag the console renders as an explicit notice.
Verified after the fix, same probes, same tokens:

```
analytics_admin    memory=redacted tasks=redacted   user-detail: memories=0, all four domains withheld
operations_admin   memory=redacted tasks=redacted   user-detail: memories=0, all four domains withheld
developer          memory=content  tasks=content    user-detail: nothing withheld (intended)
```

API suite 1058/1058, deployed to production and re-verified there.

### 11.2 A 500 the browser sweep had been passing

`GET /control/memory` returned **500 on every request**, locally *and* in production: its SQL selected
`m.type` and `m.metadata`, and `memories` has neither (the columns are `category` and
`normalized_facts`). The console page rendered its heading plus an error card under a **200**, and the
earlier sweep's failure markers did not match that card, so "34/34 destinations passed" included a page
that could not load its data at all. That is a hole in the verification, not just in the endpoint:
**the sweep must assert that a page's data arrived, not only that it has an `<h1>`.** The endpoint is
fixed (production now answers 200); tightening the sweep accordingly is recorded as open work.

### 11.3 Findings from the same review, not yet fixed

| Class | Finding | Where |
| --- | --- | --- |
| **P2** | The legacy `/api/v1/admin/*` router bypasses the control-plane gate entirely: it resolves no database grant, writes no admin audit row, and does not run the admin-session liveness check — so revoking a console session does **not** end access to it until the 15-minute access token expires. It can still `PATCH /users/:id` and write feature flags and incidents. | `services/api/src/server.ts` (mount), `services/api/src/routes/admin.ts` (`requireAdmin`) |
| **P2** | Notification `title`/`body`/`payload` are composed from the user's task and reminder titles, and are returned under `notifications.read`/`proactive.read` — a second route to the same content for a role like `OPERATIONS_ADMIN`. | `routes/admin/operations.ts` (`/notifications`, `/proactive`) |
| **P3** | Admin audit `before`/`after` snapshots carry reminder titles, so `audit.read` is a third channel to the same text. | `routes/admin/operations.ts` (reminder update), `system.ts` (audit read/export) |
| **P3** | No tenant boundary is enforced on any content read. `tenant_id` exists on `conversations`, `tasks` and `memories` and is never applied; `platform_admin_roles` has no organization column. Latent while the deployment is single-tenant, a cross-tenant read the moment a second organization is populated. | every content query in `routes/admin/operations.ts` and `users.ts` |
| **P3** | Three control routers (`sessions`, `admin-sessions`, `security`) do not mount `adminGate` and work only because an earlier router's `use()` runs first; and the gate (a grant read plus a session upsert) therefore executes once per mounted router, up to eleven times per request. | `services/api/src/server.ts` |

### 11.4 CRUD coverage

A full resource-by-resource matrix (API create/update/delete vs console create/update/delete, with
`file:line` for every "yes") was produced as part of this review. The headline:

- **Complete:** feature flags and their overrides; configuration entries; provider secrets; operator
  role grants; admin sessions; admin MFA (self-service); maintenance and kill switches; session
  revocation; deletion-request completion.
- **Update-only:** tasks, reminders, users.
- **Delete-only:** memories.
- **Read-only at both layers:** conversations, organizations, notifications, proactive events, jobs,
  languages/translations, voice, avatar, tool executions.
- **Absent everywhere** (no route, and in several cases no table): user creation, user deletion,
  organization create/update/delete, plans and subscriptions, notification templates, retention
  policies, integrations, lead pipeline, provider-registry writes.

Nine permission strings are declared but referenced by no route at all, so the catalogue advertises
capability the API does not have: `users.delete`, `users.impersonate`, `proactive.manage`,
`ai.secrets`, `voice.configure`, `avatar.configure`, `notifications.send`, `incidents.manage`,
`environment.manage`.

**Backend capabilities that exist but have no console caller** — the cheapest correct wins, because the
route, the permission and the audit already work:

| Capability | Route | Where the UI goes |
| --- | --- | --- |
| Edit a user (name, verified flags, locale, timezone) | `PATCH /control/users/:id` | user detail page, beside the existing suspend form |
| Reset user state (clear memories, cancel reminders) | `POST /control/users/:id/reset-state` | same page |
| Retry a failed job | `POST /control/jobs/:id/retry` | the read-only jobs page |
| Create an incident | `POST /api/v1/admin/incidents` | the incidents page (route exists, never called) |
| Open a conversation's content | `GET /control/users/:id/conversations/:conversationId` | user detail — content is gated and audited, but unreachable from the UI |

### 11.5 AI providers: what is configured, what is actually broken, and what is missing

Measured from the running deployment's own provider health checks, not from configuration intent:

| Provider | Status | Detail |
| --- | --- | --- |
| Anthropic (AI credits gateway) | **pass** | authenticated; 423 models visible |
| Deepgram (STT) | **pass** | authenticated, one project visible |
| ElevenLabs (TTS) | **pass** | authenticated, pay-as-you-go tier |
| Sarvam (STT/TTS) | **fail** | `Model 'bulbul:v2' has been deprecated. Please use 'bulbul:v3'` |
| PostgreSQL / Redis | **pass** | PG 16.15; Redis PONG |
| Object storage (MinIO) | **degraded** | "Endpoint answered 400" |
| Firebase Cloud Messaging | **not configured** | `FIREBASE_SERVICE_ACCOUNT_JSON` absent |
| Stripe | **not configured** | `STRIPE_SECRET_KEY` absent |

Two of those are *false alarms produced by the checks themselves*, which is worse than no check — they
train an operator to ignore provider warnings:

- The Sarvam probe hard-codes `model: 'bulbul:v2'` (`services/api/src/admin/providers.ts`), a model
  Sarvam has retired. The actual realtime TTS path uses `bulbul:v3`
  (`services/api/src/realtime/tts.ts`). So voice works while the console reports it down.
- The object-storage probe sends `HEAD {endpoint}/`. Measured on the live host: `HEAD http://minio:9000/`
  answers **400**, while `HEAD http://minio:9000/nova-assets` answers **403** — reachable and correctly
  demanding credentials. The probe tests the wrong URL and reports `degraded` permanently.

**Provider recommendation.** The four chosen providers cover the product's AI, STT and TTS needs, and
no additional *AI* provider is required: the Anthropic gateway alone advertises 423 models, which is
the usual reason to add a second vendor (model diversity and fallback) and it already provides both.
What is missing is not an AI provider:

1. **Firebase Cloud Messaging — required, and currently the top product blocker.** Reminders are a core
   NOVA behaviour, delivery is the OS alarm, and `apps/mobile` has no `firebase_messaging` and no
   device-token registration (its own settings page says so). Without FCM the platform cannot notify a
   user whose app is closed, which is most of the value of a reminder.
2. **Object storage (already self-hosted MinIO)** — no new vendor; the credentials and the probe URL
   need fixing, and it is on the path for audio recordings and avatars.
3. **Stripe — not required yet.** Nothing in the API or the mobile client charges anyone; Stripe is
   referenced only by the provider *health check* and the control-plane config, so configuring it now
   would buy an unused integration. It becomes necessary the moment subscriptions are sold.

## 12. CRUD: wiring the capabilities that already existed

The review in §11.4 found the cheapest correct wins were not new endpoints but existing ones with a
permission, a validation schema, an audit record and **no caller**. Two are now wired and verified in
production:

| Capability | Route | Console |
| --- | --- | --- |
| Edit a user (name, locale, timezone, tri-state verified flags) | `PATCH /control/users/:id` (`users.write`) | "Edit account details" card on `/users/[id]` |
| Reset account state (clear memory and/or cancel reminders) | `POST /control/users/:id/reset-state` (`users.write`) | "Reset account state" card, behind a typed `CLEAR` confirmation |

Design decisions that came out of doing it:

- **Email is not editable.** It is absent from the form *and* from the API contract. The address an
  account signs in with is an identity change, not a support action, and a console that can silently
  repoint it is an account-takeover primitive.
- **Only filled-in fields are sent.** An empty input means "leave this alone", never "set it to
  empty" — otherwise correcting a timezone would blank the name.
- **Unticked checkboxes are tri-state.** A checkbox is absent from `FormData` when unticked, so
  "don't change this" and "set this to false" are indistinguishable; the verified flags are selects
  with an explicit "leave unchanged" option.
- **Reset is destructive, so it is defended twice**: the typed confirmation the UI requires, plus the
  reason the API requires. Targeting your own account is refused with `SELF_ESCALATION_BLOCKED`, so
  the endpoint is not a way to erase your own trail.

**Verified against production**, not against a fixture: `PATCH` returns the updated row and writes
`user.update | success`; reset-state returns `{memoriesCleared, remindersCancelled}` and writes
`user.reset_state | success`; a browser test signs in, fills the form, submits it, and asserts the
**new value** appears on the page afterwards — a banner-only assertion would pass with nothing
written. Confirmed independently against the live database, which shows the new name and the matching
audit rows.

That test also produced a false alarm worth recording, because the same mistake would have been read
as a product bug: after `redirect()` Next swaps the page by client-side navigation, and the previous
render's `<h1>` is still in the DOM while the new payload streams. Reading `innerText()` once right
after `waitForSelector('h1')` measured the *old* page and reported a failed write against a database
that already contained the new name. The assertion now retries.

### Still open after this round

- Two **production-build failures** in the previous commit were only caught by `next build`, not by
  `tsc --noEmit`: the React compiler rejects reassigning a captured variable inside an async loader
  (four pages) and rejects `setState` called synchronously in an effect (`LoginForm`). Both are fixed —
  `loadPage` now passes the redaction flags through its result, and the hydration probe uses
  `useSyncExternalStore`. The lesson is that `tsc --noEmit` is not a build gate for this app and the
  typecheck step should not be treated as one.
- The remaining unwired capabilities from §11.4: job retry, incident create, and the gated
  conversation-content view.
- The findings in §11.3 (the legacy `/api/v1/admin/*` bypass above all) are unchanged.

## 13. Provider checks: fixed, and what they were hiding

Both faults in §11.5 were in the **checks**, which is the worse place for a fault to live: a console
that cries wolf on every scheduled run trains an operator to ignore the provider panel altogether.

**Sarvam** was probed with `bulbul:v2`, a model Sarvam has retired, while `realtime/tts.ts` had already
moved to `bulbul:v3`. The probe therefore failed every five minutes against a voice path that worked.
It now imports `DEFAULT_SPEAKER` and `DEFAULT_TTS_MODEL` from the module that actually synthesises
speech, so the two cannot drift apart again — the duplicated literal *was* the bug.

**Object storage** sent `HEAD` to the endpoint root. Measured on the live MinIO: `HEAD /` answers
**400**, while `HEAD /<bucket>` answers **403** — reachable and correctly refusing an unsigned request,
which is the healthy signal for a check that does not sign. It now HeadBuckets the configured bucket.

Verified on production after deploying:

```
object-storage: pass — Bucket "nova-assets" reachable (HEAD /nova-assets answered 403, i.e. refusing
                       an unsigned request). Credentials present.
sarvam:         fail — Sarvam answered 402. {"error":{"message":"No credits available.",
                       "code":"insufficient_quota_error"}}
```

### The blocker the false alarm was covering

With the deprecated-model error gone, the Sarvam check reports its **real** state: the production
Sarvam account is **out of credits** (`402 insufficient_quota_error`). The model is accepted now; the
account cannot synthesise.

This matters because `realtime/tts.ts` sets `PRIMARY_STREAM_PROVIDER = 'sarvam'` — Sarvam is the
primary realtime TTS provider and the routed TTS for Indic languages, with ElevenLabs as the fallback.
So either the Sarvam balance is topped up, or every Indic-language and realtime synthesis request
pays a failed primary call before falling back. Note the local development key *does* synthesise
successfully (the same check returns "Authenticated successfully; synthesis accepted"), so the two
keys have different balances and the production key is the one that is spent.

This is exactly the failure the earlier check could not report: an operator looking at the provider
panel before this fix saw "Sarvam: FAIL, model deprecated" and had no way to see that the actual
problem was quota.

## 14. P0 — the deploy host filled its disk, and PostgreSQL went into recovery

**This is the most serious finding in this report, and it was caused by the deployment work itself.**

The deploy host is a 38 GB VM that also runs PostgreSQL, Redis, MinIO and eleven containers on the
same filesystem. Four image builds in one afternoon — each 1–2 GB, each leaving its layers behind —
took it to **100% full**. What failed first was not the build:

```
/dev/sda1        38G   37G     0 100% /
nova-postgres   Up 11 days (unhealthy)     the database system is in recovery mode
                                            320 disk-related errors in the postgres log
healthz         200                        the API answered, and every data call behind it did not
```

**Impact:** PostgreSQL aborted and replayed its WAL. Automatic recovery completed once space was
freed and **no data was lost** — 29 users, 402 sessions, 4 reminders all present afterwards, and the
API and console answered normally. But the platform was degraded for several minutes because of a
*build*, and the recovery was luck rather than design: a longer write burst during the window is how
this becomes data loss.

**Recovery performed:**
- `docker builder prune -af` → 22.26 GB of build cache reclaimed.
- `docker image prune -f` → 7.63 GB of dangling layers.
- Removed the superseded `nova-admin-ui:predeploy` rollback tag (1.9 GB). `nova-api:predeploy` was
  kept. Note the trade-off: the console's rollback image no longer exists on the host, so a console
  rollback now means rebuilding the previous commit rather than retagging.
- Disk went 100% → 42%, then 50% after the next build.

**The durable fix is `deploy/build-image.sh`**, because the failure mode is silent: a build that runs
out of space gets all the way to the runtime stage and dies with
`chown: ... No space left on device`, long after consuming the space. The script prunes the build
cache *before* building, refuses to start below a free-space floor (default 8 GB), and reports free
space before and after. It prunes cache only — never a running container or a tagged image — which is
safe precisely because the live host is the only host.

Verified both paths on the deploy host: a real build (`nova-admin-ui:latest built; 19GB free after
build`) and the refusal (exit 1 with the reason, at a deliberately impossible floor).

**Recommendation for the platform, not just the script:** this VM is one filesystem for the database,
the object store, the cache and every image. Either the deploy host gets more disk, or builds move off
it — because the current arrangement means a routine deploy and the production database are competing
for the same 38 GB.
