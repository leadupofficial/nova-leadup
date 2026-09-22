# NOVA-Leadup — Consolidated Remediation Plan

> Merged from: Backend, Database, Frontend, Infrastructure, and Security audits.
> Severity tiers: **P0-Critical → P1-High → P2-Medium → P3-Low**
> Each item lists all source reports it appears in.

---

## P0 — CRITICAL (fix before any production exposure)

| ID | Title | Source(s) | Description |
|----|-------|-----------|-------------|
| P0-01 | **PII stored in plaintext at rest** | DATABASE (SEC-001), BACKEND (ai.ts:152) | `users.email/phone`, `leads.email/phone/firstName/lastName`, `leadCallLogs.transcript/summary` are stored with no encryption. A single DB breach exposes all customer data. |
| P0-02 | **No MFA on authentication** | SECURITY (AUTH-001) | Password-only login. Stolen credentials grant immediate full access. |
| P0-03 | **No RBAC on admin routes** | SECURITY (AUTH-002) | Admin pages and API routes have no server-side role check. Any authenticated user can access admin surfaces. |
| P0-04 | **JWT access and refresh share the same secret** | SECURITY (SECRETS-001), BACKEND (auth.ts:37) | `JWT_REFRESH_TOKEN_SECRET` falls back to `JWT_SECRET`. Leaking one token type compromises both. |
| P0-05 | **AI chatCompletion has no prompt-injection guardrails** | BACKEND (ai.ts, critical rec) | Raw user content is sent to Claude with no refusing PII extraction, jailbreaks, or unsafe content. Voice pipeline is the highest-risk surface. |
| P0-06 | **No circuit breaker or timeout on AI provider calls** | BACKEND (ai.ts, critical rec) | A hung ElevenLabs or Google connection holds a Socket.IO handler callback indefinitely, blocking that socket slot until process restart. |
| P0-07 | **No token denylist / revocation** | BACKEND (auth.ts, critical rec), SECURITY (implicit) | JWT logout sets an expired cookie but the token remains valid until TTL expiry. Stolen tokens survive logout. |
| P0-08 | **Single EC2 instance — application SPOF** | INFRA (compute/main.tf) | One t3.large with no Auto Scaling Group. Hardware failure or deploy error = total outage. |
| P0-09 | **Single Redis node — cache/queue SPOF** | INFRA (database/main.tf) | `automatic_failover_enabled = false`, `num_cache_nodes = 1`. Redis failure kills session state, rate limiting, and caching simultaneously. |
| P0-10 | **RDS likely single-AZ (multi_az undefined)** | INFRA (variables.tf) | `multi_az` variable referenced but not defined; likely defaults to `false`. Database failure = total outage with no automatic failover. |
| P0-11 | **S3/MinIO storage defaults to HTTP (no TLS)** | SECURITY (DATA-001) | `http://localhost:9000` with no TLS enforcement. Production assets transmitted in cleartext. |
| P0-12 | **No automated DB migration in deploy pipeline** | INFRA (deploy.sh) | Migrations are a manual post-deploy step. A skipped step leaves the app running against a mismatched schema. |

**Recommended P0 sprint scope (2 weeks):**
- P0-01: Encrypt PII columns with pgcrypto + key rotation plan
- P0-02: Add TOTP MFA (enforce for admin role first)
- P0-04: Require distinct `JWT_REFRESH_TOKEN_SECRET`; refuse to start if it equals `JWT_SECRET`
- P0-05: Add system-prompt guardrail to `chatCompletion`; log refusal events
- P0-06: Add AbortSignal timeouts (STT 30s, TTS 60s, chat 120s) + per-provider circuit breaker
- P0-07: Implement Redis-backed JWT denylist checked in `accessToken` middleware
- P0-08: Replace single EC2 with ASG (min=2, max=4) behind ALB
- P0-09: Enable Redis Cluster with automatic failover
- P0-10: Define `multi_az = true` and enable Multi-AZ RDS
- P0-11: Enforce HTTPS for S3/MinIO with certificate validation
- P0-12: Add `pnpm run db:migrate` as a mandatory pre-deploy step with rollback

---

## P1 — HIGH (fix within current sprint)

| ID | Title | Source(s) | Description |
|----|-------|-----------|-------------|
| P1-01 | **Refresh token race condition** | BACKEND (auth.ts:56) | Concurrent refresh requests both pass the token check before either writes the rotation record. Both issue new tokens; the second rotation silently fails to revoke the first. |
| P1-02 | **Access token cookie missing Secure + SameSite flags** | BACKEND (auth.ts:103), SECURITY | No `Secure` flag (token sent over HTTP if LB misconfigured). No `SameSite` attribute (CSRF risk in non-SameSite-aware browsers). |
| P1-03 | **Forgot-password enables user enumeration** | BACKEND (auth.ts:27) | Returns success for any email format including nonexistent addresses. Timing/oracle attacks reveal account existence. |
| P1-04 | **Log injection via unsanitized user input** | BACKEND (logger.ts:18) | Raw names, emails, message bodies written to log output. Terminal/HTML log viewers execute embedded control sequences. |
| P1-05 | **CSP completely disabled** | BACKEND (security.ts:14), SECURITY (XSS-001) | `helmet.contentSecurityPolicy` commented out. Stored XSS from any DB field executes in admin context with full privileges. |
| P1-06 | **No IP-based rate limiting on auth endpoints** | BACKEND (rateLimit.ts), SECURITY (API-001) | Global slow-down limiter only. A single compromised credential can brute-force `/api/auth/login` at full speed. |
| P1-07 | **No foreign key constraints** | DATABASE (SCHEMA-001, SCHEMA-002) | Cross-table integrity enforced only at application level. Orphaned records on parent delete. |
| P1-08 | **Missing indexes on FK and lookup columns** | DATABASE (PERF-001, PERF-002) | No index on `users.email`, `leads.phoneNumber`, `leads.campaignId`, `campaigns.organizationId`, `campaigns.status`. Full table scans on joins and lookups. |
| P1-09 | **No soft-delete mechanism** | DATABASE (SEC-002), BACKEND (notification service) | Hard deletes make compliance audit trails impossible. Soft-deleted notifications grow without bound with no purge job. |
| P1-10 | **No row-level security (RLS)** | DATABASE (SEC-003) | Application-level auth bypass would expose all tenants' data. |
| P1-11 | **Admin pages call non-existent endpoints** | FRONTEND (admin) | `/admin/users`, `/admin/organizations`, `/admin/audit-logs`, `/admin/incidents`, `/admin/usage/*` all return 404. |
| P1-12 | **No tenant isolation / org-boundary enforcement** | SECURITY (AUTH-005) | Users in multiple orgs can switch context by forging a different `orgId` in the JWT. |
| P1-13 | **No password reset or account recovery flow** | SECURITY (AUTH-003) | Locked-out users cannot recover accounts. |
| P1-14 | **Refresh tokens live 30 days with no rotation** | SECURITY (AUTH-004) | Stolen refresh token grants long-lived access. No absolute expiry or rotation limit. |
| P1-15 | **SSH open to 0.0.0.0/0 by default** | INFRA (variables.tf) | Bastion SSH exposed to entire internet if `terraform.tfvars` is not customized. |
| P1-16 | **No AWS WAF / DDoS protection** | INFRA (loadbalancer/main.tf) | ALB has no WAF association for SQL injection, XSS, or bot protection. |
| P1-17 | **Secrets in deploy script, not in Secrets Manager** | INFRA (deploy.sh), DATABASE (SEC-004) | JWT_SECRET, REFRESH_TOKEN_SECRET generated at deploy time via `openssl rand`. No AWS Secrets Manager/SSM integration. |
| P1-18 | **RDS backup retention only 7 days** | INFRA (database/main.tf) | Compliance best practice is 14–35 days depending on regulatory requirements. |

**Recommended P1 sprint scope (1 week):**
- P1-01: Use Redis distributed lock (SET NX EX) for refresh token rotation
- P1-02: Set `Secure; SameSite=Strict` on auth cookies in production
- P1-03: Return generic "if an account exists" message from forgot-password
- P1-05: Enable helmet CSP with nonce-based script tags for admin dashboard
- P1-06: Add per-IP sliding-window rate limiter on `/api/auth/login` and `/api/auth/forgot-password` (5 attempts/15 min)
- P1-07: Add `references()` + `onDelete` rules for all FK columns in schema.ts
- P1-08: Create migration adding indexes on FK + lookup columns
- P1-09: Add `deletedAt TIMESTAMPTZ` to all business tables + background purge job (30-day TTL)
- P1-11: Implement `/admin/*` routes or add explicit "coming soon" placeholders
- P1-12: Validate `orgId` from JWT matches user's actual org membership in middleware
- P1-13: Implement time-limited single-use password reset token via email
- P1-14: Rotate refresh tokens on every use; set absolute max lifetime of 7 days
- P1-15: Restrict `allowed_ssh_cidr` default to a specific IP range
- P1-16: Add AWS WAF with OWASP Top 10 managed rules to ALB
- P1-17: Migrate secrets to AWS Secrets Manager with rotation hooks
- P1-18: Increase RDS `backup_retention_period` to 14 days minimum

---

## P2 — MEDIUM (next sprint / near-term)

| ID | Title | Source(s) | Description |
|----|-------|-----------|-------------|
| P2-01 | **No retry with backoff on AI provider calls** | BACKEND (ai.ts) | Transient 503s from Deepgram/Sarvam immediately fail the voice turn. No recovery attempt. |
| P2-02 | **STT fallback routes all non-English audio to Deepgram English model** | BACKEND (ai.ts:512, 503) | If Sarvam and Google both fail, Hindi audio sent to Deepgram English model returns empty/garbage transcript silently. |
| P2-03 | **AI provider API keys exposed in process env** | BACKEND (ai.ts:152), SECURITY | Keys read from `process.env` directly; may appear in crash dumps or process listings in shared-host environments. |
| P2-04 | **Health check does not verify AI provider reachability** | BACKEND (health check) | Deployment can pass `/health` while Deepgram/ElevenLabs/Sarvam return 401/500. No alerting hook. |
| P2-05 | **No input sanitization beyond Zod shape validation** | BACKEND (validation), SECURITY | Zod validates shape but not content semantics. SQL comment injection, XSS payloads in text fields pass through. |
| P2-06 | **No Redis caching on notification queries** | BACKEND (notification service) | `getUserNotifications` hits Postgres on every call including count subquery. Unread count recalculated on every socket event. |
| P2-07 | **Notification metadata has no Zod schema** | BACKEND (notification.service.ts:43) | `Record<string, unknown>` allows arbitrarily large/nested JSON bloat. |
| P2-08 | **Seed script can create backdoor accounts** | DATABASE (SEC-004) | `seed.ts` inserts a user with dummy password hash without env confirmation. Running against prod = backdoor. |
| P2-09 | **No composite indexes for common query patterns** | DATABASE (PERF-005) | Missing composite indexes like `(organizationId, status)` for campaigns and `(campaignId, status)` for leads. |
| P2-10 | **No connection pool configuration** | DATABASE (PERF-003) | Default node-postgres pool settings may be inappropriate for production load. |
| P2-11 | **Mobile: No conversation detail screen** | FRONTEND (mobile) | Chat list onTap is empty. No message thread, no send/receive lifecycle. |
| P2-12 | **Mobile: No voice/audio pipeline** | FRONTEND (mobile) | TTS replaced with hardcoded 600ms delay. No actual audio playback, streaming, or interruption handling. |
| P2-13 | **Mobile: No local persistence / offline queue** | FRONTEND (mobile) | All data fetched fresh on each navigation. No offline mutation queue. Failed sends show no error UI. |
| P2-14 | **Admin: Inline styles everywhere, no design tokens** | FRONTEND (admin) | Raw color values repeated per component. No dark mode, no theme system, high GC pressure. |
| P2-15 | **Admin: No React.memo / virtualization on data-heavy pages** | FRONTEND (admin) | Audit-logs and usage pages re-render full tables on any state change. No `useMemo`/`useCallback`. |
| P2-16 | **Mobile: Hardcoded emulator IP with no release override** | FRONTEND (mobile, api_client_provider.dart) | `10.0.2.2:3001` hardcoded. Production builds silently hit wrong host unless `NOVA_API_BASE_URL` injected at compile time. |
| P2-17 | **No request ID / distributed tracing** | BACKEND (observability) | Cannot correlate a single user action across Express, Socket.IO, and AI provider calls. |
| P2-18 | **No centralized logging or alerting** | INFRA (logging), BACKEND | No ELK/Loki/CloudWatch Logs Insights. No alerting hooks on health check degradation. |
| P2-19 | **No CI/CD pipeline** | INFRA (CI/CD) | No GitHub Actions, GitLab CI, or equivalent. No automated testing, Terraform plan validation, or security scanning. |
| P2-20 | **No backup verification / restore testing** | INFRA (backup) | Backups exist but are never validated. Restore failure discovered only during an actual incident. |

**Recommended P2 scope:**
- P2-01: Exponential backoff with jitter (Deepgram: 3 retries, Sarvam: 2; no retry on 4xx)
- P2-02: Language-aware STT fallback — route Hindi/Tamil/etc. to Google Speech instead of Deepgram English
- P2-03: Inject AI keys via AWS Secrets Manager at runtime; never read from `process.env` in application code
- P2-04: Add async reachability probes for all AI providers to `/health`; cache for 60s
- P2-05: Add sanitization middleware stripping control chars, HTML tags, and overly long strings
- P2-06: Cache unread count in Redis (5s TTL); invalidate on read/delete events
- P2-07: Add Zod schema for notification metadata with max depth/size limits
- P2-08: Add `--force` flag or `ALLOW_SEED=true` env var guard; refuse to run against URLs containing "prod"
- P2-09: Add composite indexes for common WHERE clauses
- P2-10: Configure `max`, `idleTimeoutMillis`, `connectionTimeoutMillis` on node-postgres Pool
- P2-11: Implement ConversationDetail screen with message bubbles, input bar, real send/receive
- P2-12: Integrate `just_audio` + `flutter_tts`; drive AvatarState from actual player position
- P2-13: Add Hive for local caching; queue mutations when offline; show persistent offline banner
- P2-14: Migrate inline styles to CSS modules or custom-property design tokens
- P2-15: Add `React.memo`, `useMemo`, `@tanstack/react-virtual` to admin data tables
- P2-16: Replace compile-time `String.fromEnvironment` with runtime `flutter_dotenv` config
- P2-17: Generate request UUID at Express boundary; propagate via async local storage to logs, Socket.IO, AI spans
- P2-18: Deploy CloudWatch Logs Insights dashboards; add PagerDuty/SNS alarm hooks
- P2-19: Add GitHub Actions workflow: lint → test → Terraform plan → security scan → deploy
- P2-20: Schedule monthly restore drills; alert on backup failure

---

## P3 — LOW (technical debt / polish)

| ID | Title | Source(s) | Description |
|----|-------|-----------|-------------|
| P3-01 | **BROCODE_API_KEY sets both `apiKey` and `authToken` to same value** | BACKEND (ai.ts:28) | If BroCode proxy expects a different header, auth silently misconfigures. |
| P3-02 | **`auditLogs.actorUserId` has no NOT NULL constraint** | DATABASE (SCHEMA-005) | Column intended to always have a value but allows NULL. |
| P3-03 | **`featureFlags.payload` is `text` with no JSON schema validation** | DATABASE (SCHEMA-004) | Invalid JSON only fails at query time. |
| P3-04 | **`realtimeGateways.roomId` is TEXT primary key** | DATABASE (PERF-004) | TEXT PK slower than UUID/INTEGER for high-throughput routing. |
| P3-05 | **`realtimeGateways.tokenSecret` stored as plaintext** | DATABASE (SEC-006) | Should be encrypted or use secrets manager reference. |
| P3-06 | **No DB-level audit triggers** | DATABASE (SEC-007) | Audit log is purely application-level; a privileged DB user can bypass it. |
| P3-07 | **Migration runner has no checksum validation** | DATABASE (SEC-008, MIG-001) | Tampered migrations applied silently. Monolithic 0000 migration with no incremental history. |
| P3-08 | **Admin sidebar not responsive (no hamburger / breakpoint)** | FRONTEND (admin, ux) | Fixed 240px sidebar overlaps content below 768px. |
| P3-09 | **No skip-to-main-content link / ARIA landmarks** | FRONTEND (admin, a11y) | Keyboard users tab through full sidebar before reaching main content. |
| P3-10 | **Flutter chat ListTiles lack Semantics widgets** | FRONTEND (mobile, a11y) | TalkBack/VoiceOver reads title + subtitle without context; chevron announced as "button" with no label. |
| P3-11 | **Skeleton uses Math.random() for widths** | FRONTEND (admin, Skeleton.tsx) | Layout shift and inconsistent shimmer; minor SSR hydration mismatch risk. |
| P3-12 | **Admin: no i18n / internationalization** | FRONTEND (admin) | All strings hardcoded English; no locale detection or translation layer. |
| P3-13 | **Mobile: no push notifications or notification center** | FRONTEND (mobile) | No Firebase Messaging, no in-app notification center, no badge count. |
| P3-14 | **No blue/green or canary deployment** | INFRA (deploy.sh) | Direct production push with no rollback strategy. |
| P3-15 | **No cost management (Budgets, Savings Plans, lifecycle tiers)** | INFRA (cost) | No AWS Budgets alerts; no Reserved Instances; S3 backups stay in Standard tier. |
| P3-16 | **No Terraform security scanning in CI** | INFRA (IaC testing) | No Checkov, tfsec, or TFLint. Misconfigurations land in prod without review. |
| P3-17 | **No DB-level transaction boundaries visible** | DATABASE (REC-006) | Multi-table writes may partially commit on failure. |
| P3-18 | **`onConflictDoNothing` on slug/email without logging** | DATABASE (SEC-005) | Silent data loss on concurrent inserts with no audit trail. |
| P3-19 | **RDS storage has no auto-scaling** | INFRA (database/main.tf), DATABASE | Manual intervention required if DB exceeds 50GB. |
| P3-20 | **ALB access logs bucket encryption not explicitly configured** | INFRA (loadbalancer/main.tf) | Default S3 encryption may not be enforced. |

**Recommended P3 scope:**
- P3-01: Audit BroCode proxy auth header expectations; fix `apiKey`/`authToken` assignment
- P3-02: Add NOT NULL constraint to `auditLogs.actorUserId`
- P3-03: Add JSON schema validation for `featureFlags.payload` at insert/update
- P3-04: Migrate `realtimeGateways.roomId` to UUID with advisory lock for room allocation
- P3-05: Encrypt `realtimeGateways.tokenSecret` with pgcrypto; add key-rotation schedule
- P3-06: Add PostgreSQL trigger function for INSERT/UPDATE/DELETE on sensitive tables
- P3-07: Split monolithic migration; add SHA-256 checksum verification to migration runner
- P3-08: Add mobile hamburger toggle + overlay sidebar at `<=768px` breakpoint
- P3-09: Add skip-to-content link, `aria-current='page'`, and landmark roles to admin layout
- P3-10: Wrap Flutter ListTiles in `Semantics` with label, hint, and button config
- P3-11: Replace `Math.random()` skeleton widths with fixed token-based widths
- P3-12: Introduce `next-intl` (admin) and `flutter_intl` (mobile); extract all user-facing strings
- P3-13: Add Firebase Messaging + in-app notification center with badge count
- P3-14: Implement blue/green deploy with 10% canary + automated rollback on error rate spike
- P3-15: Add AWS Budgets alerts; purchase 1-year Savings Plans; configure S3 lifecycle (IA at 30d, Glacier at 90d)
- P3-16: Add Checkov/tfsec to CI pipeline; block merges on high/critical findings
- P3-17: Wrap multi-table writes in `db.transaction()` with explicit rollback handlers
- P3-18: Log `onConflictDoNothing` events to audit table with conflicting values
- P3-19: Enable `storage_auto_scaling` on RDS with max threshold
- P3-20: Explicitly set S3 bucket encryption (AES-256 or KMS) on ALB access logs bucket

---

## Cross-Cutting Themes

| Theme | Affected Areas | Key Actions |
|-------|---------------|-------------|
| **Auth hardening** | BACKEND, SECURITY, DATABASE | MFA → RBAC → token rotation → denylist → IP rate limiting. All must ship together; partial implementation creates a false sense of security. |
| **Data protection** | DATABASE, BACKEND, INFRA | PII encryption at rest → soft-delete → RLS → secrets manager → TLS everywhere. Encryption must be in place before any production data is written. |
| **Resilience** | BACKEND, INFRA | Timeouts + circuit breakers + retries on AI calls → ASG + Multi-AZ for infra → backup verification. The voice pipeline is the highest-risk user-facing surface. |
| **Observability** | BACKEND, INFRA | Request ID propagation → AI provider health probes → centralized logging → slow-query alerts. Cannot debug production issues without these. |
| **Infrastructure IaC maturity** | INFRA | Secrets manager → WAF → CI/CD → Terraform scanning → backup verification → DR plan. None of the P0 infra items can be skipped for production. |

---

## Execution Order (Dependency Map)

```
P0-04 (JWT secret separation)
 └─► P0-07 (denylist — needs Redis, which needs P0-09)
 └─► P0-09 (Redis Cluster failover)

P0-05 (AI guardrails) ─┐
P0-06 (AI timeouts) ─┤─► all depend on ASG/Redis being stable
P2-01 (AI retries) ─┘

P0-01 (PII encryption) ─► P0-02 (MFA — needs user table stable)
P1-07 (FK constraints) ─► P1-08 (indexes — needs FK columns defined first)
P1-09 (soft-delete) ─► P2-06 (notification cache — needs deletedAt filter)

P0-08 (ASG) ─► P0-10 (Multi-AZ RDS) ─► P1-17 (Secrets Manager)
 ─► P2-19 (CI/CD — needs stable infra)

Frontend P1-11 (admin endpoints) ─► depends on BACKEND P0-05 + P1-06
Mobile P2-11/P2-12 (chat + voice) ─► depends on BACKEND P0-05 + P0-06
```

---

## Quick Reference: Top 10 by Risk

1. **P0-01** — PII plaintext (compliance breach on any DB leak)
2. **P0-05** — No AI prompt-injection guardrails (data exfiltration, jailbreaks)
3. **P0-02 + P0-03** — No MFA + no RBAC (any credential = full access)
4. **P0-04** — JWT secret reuse (single leak = full auth compromise)
5. **P0-08 + P0-09 + P0-10** — Three single points of failure (EC2, Redis, RDS)
6. **P1-01** — Refresh token race condition (concurrent requests bypass rotation)
7. **P1-05** — CSP disabled (stored XSS in any DB field = admin takeover)
8. **P2-02** — STT language mismatch (silent data loss for non-English users)
9. **P2-13** — No offline queue (every failed mutation = lost user action)
10. **P0-12** — Manual migrations (deploy without migration = schema drift / outage)
