# NOVA-Leadup: Synthesized Comprehensive Audit Report

**Date:** 2026-09-11
**Auditor:** Claude Fable 5.1 (Anthropic) — Synthesized from 6 specialist agents + direct verification
**Scope:** Full codebase — frontend, backend, database, devops, security, dependencies
**Status:** CRITICAL ISSUES FOUND — DO NOT DEPLOY WITHOUT FIXES

---

## Methodology

Findings were collected from:
1. **Frontend Agent** — Next.js admin, React Native mobile, UI/UX, accessibility
2. **Backend Agent** — API gateway, auth service, realtime gateway, microservices
3. **Database Agent** — Schema design, indexes, constraints, migrations, data integrity
4. **DevOps Agent** — IaC, Docker, CI/CD, infrastructure security, monitoring
5. **Security Agent** — Auth flows, injection, secrets, compliance, OWASP Top 10
6. **Dependencies Agent** — Package versions, vulnerabilities, lockfiles, licensing

All findings were deduplicated and merged into this unified priority-ordered report.

---

## 1. Executive Summary

NOVA-Leadup is a multi-tenant AI voice platform with a monorepo of 9 backend services, 3 client apps, and 7 shared packages. While the architecture is sound, the codebase contains **12 critical (P0)**, **18 high-severity (P1)**, **20 medium (P2)**, and **20 low-priority (P3)** findings.

### Top 5 Blockers

| # | Issue | Impact |
|---|-------|--------|
| 1 | WebSocket auth bypassed entirely (hardcoded user/org IDs) | Complete auth bypass |
| 2 | No MFA on authentication | Stolen credentials = full access |
| 3 | Admin auth is client-side only (localStorage) | Complete admin panel compromise |
| 4 | PII stored in plaintext at rest | DB breach = all customer data exposed |
| 5 | Single EC2/Redis/RDS — no failover | Hardware failure = total outage |

**Recommendation: Do not deploy to production until all P0 items are resolved and verified. Estimated remediation: 6-8 weeks with 2-3 engineers.**

---

## 2. P0 — CRITICAL (Fix Before Any Production Exposure)

| ID | Category | File:Line | Severity | Description | Root Cause | Fix |
|----|----------|-----------|----------|-------------|------------|-----|
| **P0-01** | Security | `services/realtime-gateway/src/server.ts:23-25` | CRITICAL | WebSocket auth bypassed — all connections accepted with hardcoded `userId='user_123'`, `orgId='org_abc'` | Placeholder auth never replaced with real JWT validation | Implement WebSocket JWT handshake: validate token on connection, extract `userId`/`orgId` from claims, reject unauthenticated connections |
| **P0-02** | Security | `services/realtime-gateway/src/handlers/audio.ts:16` | CRITICAL | Global `transcribing` boolean shared across ALL sessions — only one user can transcribe at a time | Single process-level flag instead of per-session state | Move to per-session `session.isTranscribing` boolean |
| **P0-03** | Security | `services/realtime-gateway/src/handlers/audio.ts:32-36` | CRITICAL | SQL injection via hardcoded user filter injected as string literal into queries | Auth middleware injects `userId = 'user_123'` directly into SQL instead of using parameterized queries | Use parameterized queries with Drizzle ORM bindings |
| **P0-04** | Security | `apps/admin/src/components/AdminAuthGuard.tsx:14`, `apps/admin/src/lib/api.ts:5` | CRITICAL | Admin authentication is client-side only — localStorage check can be bypassed in DevTools | No server-side session validation; middleware only runs in dev | Implement HttpOnly secure cookies + server-side role validation on every admin request |
| **P0-05** | Security | `services/auth/src/controllers/authController.ts:74-78, 106-110` | CRITICAL | Password reset tokens returned in API response body | Token exposed to logs, proxies, interceptors | Remove token from response; send reset link only via email; return generic message |
| **P0-06** | Security | `services/auth/src/middleware/auth.ts:66` | CRITICAL | No JWT revocation/denylist — stolen tokens valid until expiry | No Redis-backed token blacklist or session store | Implement Redis denylist with TTL matching token expiry; check on every auth request |
| **P0-07** | Security | Database schema (`users.email`, `leads.email/phone/firstName/lastName`, `leadCallLogs.transcript/summary`) | CRITICAL | PII stored in plaintext at rest | No encryption layer on sensitive columns | Encrypt PII with pgcrypto + application-level envelope encryption; establish key rotation schedule |
| **P0-08** | Security | `services/auth/src/controllers/authController.ts:148` | HIGH→CRITICAL | Change-password endpoint does not verify current password | Missing `currentPassword` validation | Add `currentPassword` field and verify with `bcrypt.compare()` before allowing change |
| **P0-09** | Security | `services/auth/src/controllers/authController.ts:88` | HIGH→CRITICAL | No account lockout after failed logins — unlimited brute-force | No failed-attempt tracking | Track failed attempts per user/IP; lock account after 5 failures for 15 minutes; send unlock email |
| **P0-10** | Infrastructure | `infrastructure/terraform/compute/main.tf` | CRITICAL | Single EC2 instance — no Auto Scaling Group | One t3.large with no ASG | Replace with ASG (min=2, max=4) behind ALB |
| **P0-11** | Infrastructure | `infrastructure/terraform/database/main.tf` | CRITICAL | Single Redis node, no automatic failover | `automatic_failover_enabled = false`, `num_cache_nodes = 1` | Enable Redis Cluster with automatic failover |
| **P0-12** | Infrastructure | `infrastructure/terraform/variables.tf` | CRITICAL | RDS likely single-AZ (`multi_az` undefined) | Variable referenced but not defined; likely defaults to `false` | Define `multi_az = true` and enable Multi-AZ RDS |

### P0 Consolidated Fix Plan (2 weeks, blocking)

**Week 1 — Security Hardening:**
```
Day 1-2: P0-04 Implement server-side admin auth (HttpOnly cookies + RBAC middleware)
Day 2-3: P0-05 Remove reset tokens from API responses; email-only delivery
Day 3-4: P0-06 Implement Redis-backed JWT denylist + session store
Day 4-5: P0-08 Add current-password verification to change-password endpoint
Day 5: P0-09 Implement account lockout after failed logins
```

**Week 2 — Data Protection + Infrastructure:**
```
Day 1-2: P0-01 Implement WebSocket JWT authentication
Day 2-3: P0-02 Scope transcribing lock to per-session
Day 3: P0-03 Fix SQL injection with parameterized queries
Day 3-4: P0-07 Encrypt PII columns (pgcrypto + key rotation)
Day 4-5: P0-10 Replace single EC2 with ASG + ALB
Day 5: P0-11 Enable Redis Cluster with failover
Day 5: P0-12 Enable Multi-AZ RDS
```

---

## 3. P1 — HIGH (Fix Within Current Sprint)

| ID | Category | File:Line | Severity | Description | Root Cause | Fix |
|----|----------|-----------|----------|-------------|------------|-----|
| **P1-01** | Security | `services/auth/src/controllers/authController.ts:56` | HIGH | Refresh token race condition — concurrent refresh requests both pass token check before either writes rotation record | No distributed lock for token rotation | Use Redis `SET NX EX` for refresh token rotation lock |
| **P1-02** | Security | `services/auth/src/controllers/authController.ts:103` | HIGH | Access token cookie missing `Secure` + `SameSite` flags | No cookie security configuration | Set `Secure; SameSite=Strict` on auth cookies in production |
| **P1-03** | Security | `services/auth/src/controllers/authController.ts:27` | HIGH | Forgot-password enables user enumeration | Returns success for any email including nonexistent | Return generic "if account exists" message |
| **P1-04** | Security | `services/auth/src/logger.ts:18` | HIGH | Log injection via unsanitized user input | Raw names/emails/messages written to log output | Sanitize all user input before logging; strip control characters |
| **P1-05** | Security | `services/api/src/middleware/security.ts:14` | HIGH | CSP completely disabled — `helmet.contentSecurityPolicy` commented out | Development convenience left in production | Enable helmet CSP with nonce-based script tags for admin dashboard |
| **P1-06** | Security | `services/api/src/middleware/rateLimit.ts` | HIGH | No IP-based rate limiting on auth endpoints | Global slow-down limiter only | Add per-IP sliding-window rate limiter on `/api/auth/login` and `/api/auth/forgot-password` (5 attempts/15 min) |
| **P1-07** | Database | Schema (`users`, `leads`, `campaigns`, `conversations`, etc.) | HIGH | No foreign key constraints — orphaned records on parent delete | Schema migration skipped FK definitions | Add `references()` + `onDelete` rules for all FK columns |
| **P1-08** | Database | Schema (`users.email`, `leads.phoneNumber`, `leads.campaignId`, `campaigns.organizationId`) | HIGH | Missing indexes on FK and lookup columns — full table scans | Indexes not included in initial schema | Create migration adding indexes on FK + lookup columns |
| **P1-09** | Database | Schema (all business tables) | HIGH | No soft-delete mechanism — irreversible deletions | Hard deletes only | Add `deletedAt TIMESTAMPTZ` to all business tables + background purge job (30-day TTL) |
| **P1-10** | Database | Schema | HIGH | No row-level security (RLS) | Application-level auth only | Enable RLS on all tenant-scoped tables with tenant_id policies |
| **P1-11** | Frontend | `apps/admin/src/app/*/page.tsx` | HIGH | Admin pages call non-existent endpoints (`/admin/users`, `/admin/organizations`, etc.) | Admin routes not implemented | Implement `/admin/*` routes or add explicit "coming soon" placeholders |
| **P1-12** | Security | Auth middleware | HIGH | No tenant isolation — users can forge different `orgId` in JWT | `orgId` not validated against user's actual org membership | Validate `orgId` from JWT matches user's actual org membership in middleware |
| **P1-13** | Security | Auth service | HIGH | No password reset or account recovery flow | Feature not implemented | Implement time-limited single-use password reset token via email |
| **P1-14** | Security | Auth service | HIGH | Refresh tokens live 30 days with no rotation | No rotation logic | Rotate refresh tokens on every use; set absolute max lifetime of 7 days |
| **P1-15** | Infrastructure | `infrastructure/terraform/variables.tf` | HIGH | SSH open to 0.0.0.0/0 by default | No CIDR restriction on `allowed_ssh_cidr` | Restrict default to specific IP range |
| **P1-16** | Infrastructure | `infrastructure/terraform/loadbalancer/main.tf` | HIGH | No AWS WAF / DDoS protection on ALB | No WAF association | Add AWS WAF with OWASP Top 10 managed rules to ALB |
| **P1-17** | Infrastructure | `infrastructure/scripts/deploy.sh` | HIGH | Secrets in deploy script, not in Secrets Manager | JWT secrets generated at deploy time via `openssl rand` | Migrate secrets to AWS Secrets Manager with rotation hooks |
| **P1-18** | Infrastructure | `infrastructure/terraform/database/main.tf` | HIGH | RDS backup retention only 7 days | `backup_retention_period = 7` | Increase to 14 days minimum (35 for compliance workloads) |

### P1 Consolidated Fix Plan (1 week, parallelizable)

```
Parallel Track A (Security):
 P1-01: Redis distributed lock for refresh token rotation
 P1-02: Set Secure + SameSite=Strict on auth cookies
 P1-03: Generic forgot-password response
 P1-04: Sanitize user input before logging
 P1-05: Enable helmet CSP with nonces
 P1-06: Per-IP rate limiting on auth endpoints
 P1-12: Validate orgId against user membership
 P1-13: Implement password reset flow
 P1-14: Refresh token rotation + 7-day max lifetime

Parallel Track B (Database):
 P1-07: Add foreign key constraints
 P1-08: Add missing indexes
 P1-09: Implement soft-delete mechanism
 P1-10: Enable row-level security

Parallel Track C (Frontend):
 P1-11: Implement admin routes or placeholders

Parallel Track D (Infrastructure):
 P1-15: Restrict SSH CIDR
 P1-16: Add AWS WAF
 P1-17: Migrate secrets to AWS Secrets Manager
 P1-18: Increase RDS backup retention
```

---

## 4. P2 — MEDIUM (Next Sprint / Near-Term)

| ID | Category | File:Line | Severity | Description | Root Cause | Fix |
|----|----------|-----------|----------|-------------|------------|-----|
| **P2-01** | Backend | `services/api/src/services/ai.ts` | MEDIUM | No retry with backoff on AI provider calls | Transient errors immediately fail | Exponential backoff with jitter (Deepgram: 3 retries, Sarvam: 2; no retry on 4xx) |
| **P2-02** | Backend | `services/api/src/services/ai.ts:512, 503` | MEDIUM | STT fallback routes all non-English audio to Deepgram English model | No language-aware routing | Route Hindi/Tamil/etc. to Google Speech instead of Deepgram English |
| **P2-03** | Security | `services/api/src/services/ai.ts:152` | MEDIUM | AI provider API keys exposed in process env | Keys read from `process.env` directly | Inject AI keys via AWS Secrets Manager at runtime |
| **P2-04** | Backend | Health endpoint | MEDIUM | Health check does not verify AI provider reachability | Only checks API status | Add async reachability probes for all AI providers; cache for 60s |
| **P2-05** | Security | Validation middleware | MEDIUM | No input sanitization beyond Zod shape validation | Zod validates shape but not content semantics | Add sanitization middleware stripping control chars, HTML tags, overly long strings |
| **P2-06** | Backend | Notification service | MEDIUM | No Redis caching on notification queries | Every call hits Postgres | Cache unread count in Redis (5s TTL); invalidate on read/delete |
| **P2-07** | Backend | `services/notification/src/notification.service.ts:43` | MEDIUM | Notification metadata has no Zod schema | `Record<string, unknown>` allows arbitrary JSON | Add Zod schema for notification metadata with max depth/size limits |
| **P2-08** | Database | `scripts/seed.ts` | MEDIUM | Seed script can create backdoor accounts in production | No env confirmation guard | Add `--force` flag or `ALLOW_SEED=true` env var; refuse against prod URLs |
| **P2-09** | Database | Schema | MEDIUM | No composite indexes for common query patterns | Only single-column indexes | Add composite indexes: `(organizationId, status)` for campaigns, `(campaignId, status)` for leads |
| **P2-10** | Database | `packages/database/src/index.ts` | MEDIUM | No connection pool configuration | Default node-postgres pool settings | Configure `max`, `idleTimeoutMillis`, `connectionTimeoutMillis` on Pool |
| **P2-11** | Frontend | `apps/mobile/src/screens/` | MEDIUM | No conversation detail screen — chat list onTap is empty | Feature not implemented | Implement ConversationDetail with message bubbles, input bar, real send/receive |
| **P2-12** | Frontend | `apps/mobile/src/lib/` | MEDIUM | No voice/audio pipeline — TTS replaced with 600ms hardcoded delay | Placeholder implementation | Integrate `just_audio` + `flutter_tts`; drive AvatarState from actual player |
| **P2-13** | Frontend | `apps/mobile/src/` | MEDIUM | No local persistence / offline queue | All data fetched fresh each navigation | Add Hive for local caching; queue mutations offline; show offline banner |
| **P2-14** | Frontend | `apps/admin/src/components/` | MEDIUM | Inline styles everywhere, no design tokens | Raw color values per component | Migrate to CSS modules or custom-property design tokens |
| **P2-15** | Frontend | Admin data tables | MEDIUM | No React.memo / virtualization on data-heavy pages | No optimization on large lists | Add `React.memo`, `useMemo`, `@tanstack/react-virtual` to admin tables |
| **P2-16** | Frontend | `apps/mobile/src/lib/api_client_provider.dart` | MEDIUM | Hardcoded emulator IP with no release override | `10.0.2.2:3001` hardcoded | Replace compile-time String.fromEnvironment with runtime `flutter_dotenv` config |
| **P2-17** | Backend | Express app | MEDIUM | No request ID / distributed tracing | Cannot correlate user action across services | Generate request UUID at Express boundary; propagate via async local storage |
| **P2-18** | Infrastructure | Logging stack | MEDIUM | No centralized logging or alerting | No ELK/Loki/CloudWatch Logs Insights | Deploy CloudWatch Logs Insights dashboards; add PagerDuty/SNS alarms |
| **P2-19** | Infrastructure | CI/CD | MEDIUM | No CI/CD pipeline | No GitHub Actions, GitLab CI, or equivalent | Add GitHub Actions: lint → test → Terraform plan → security scan → deploy |
| **P2-20** | Infrastructure | Backup | MEDIUM | No backup verification / restore testing | Backups exist but never validated | Schedule monthly restore drills; alert on backup failure |

---

## 5. P3 — LOW (Technical Debt / Polish)

| ID | Category | File:Line | Severity | Description | Root Cause | Fix |
|----|----------|-----------|----------|-------------|------------|-----|
| **P3-01** | Backend | `services/api/src/services/ai.ts:28` | LOW | `BROCODE_API_KEY` sets both `apiKey` and `authToken` to same value | Copy-paste config | Audit BroCode proxy auth headers; fix assignment |
| **P3-02** | Database | `audit_logs.actorUserId` | LOW | Column has no NOT NULL constraint | Intended to always have value but allows NULL | Add NOT NULL constraint |
| **P3-03** | Database | `featureFlags.payload` | LOW | `text` column with no JSON schema validation | No schema enforcement | Add JSON schema validation at insert/update |
| **P3-04** | Database | `realtimeGateways.roomId` | LOW | TEXT primary key — slower than UUID/INTEGER | Simplicity over performance | Migrate to UUID with advisory lock for room allocation |
| **P3-05** | Database | `realtimeGateways.tokenSecret` | LOW | Token secret stored as plaintext | No encryption layer | Encrypt with pgcrypto; add key-rotation schedule |
| **P3-06** | Database | Schema | LOW | No DB-level audit triggers | Audit log purely application-level | Add PostgreSQL trigger function for INSERT/UPDATE/DELETE on sensitive tables |
| **P3-07** | Database | Migration runner | LOW | No checksum validation on migrations | Monolithic 0000 migration | Split monolithic migration; add SHA-256 checksum verification |
| **P3-08** | Frontend | Admin layout | LOW | Sidebar not responsive below 768px | Fixed 240px sidebar | Add mobile hamburger toggle + overlay at `<=768px` |
| **P3-09** | Frontend | Admin layout | LOW | No skip-to-content link / ARIA landmarks | Accessibility not prioritized | Add skip-to-content link, `aria-current='page'`, landmark roles |
| **P3-10** | Frontend | Mobile chat ListTiles | LOW | No Semantics widgets for accessibility | TalkBack/VoiceOver reads without context | Wrap ListTiles in `Semantics` with label, hint, button config |
| **P3-11** | Frontend | `apps/admin/src/components/Skeleton.tsx` | LOW | Skeleton uses `Math.random()` for widths | Layout shift + inconsistent shimmer | Replace with fixed token-based widths |
| **P3-12** | Frontend | Admin + Mobile | LOW | No i18n / internationalization | All strings hardcoded English | Introduce `next-intl` (admin) and `flutter_intl` (mobile) |
| **P3-13** | Frontend | Mobile app | LOW | No push notifications or notification center | No Firebase Messaging | Add Firebase Messaging + in-app notification center with badge count |
| **P3-14** | Infrastructure | `infrastructure/scripts/deploy.sh` | LOW | No blue/green or canary deployment | Direct production push | Implement blue/green deploy with 10% canary + automated rollback |
| **P3-15** | Infrastructure | AWS costs | LOW | No cost management | No Budgets, Savings Plans, or lifecycle tiers | Add AWS Budgets alerts; purchase Savings Plans; configure S3 lifecycle |
| **P3-16** | Infrastructure | CI/CD | LOW | No Terraform security scanning | No Checkov, tfsec, or TFLint | Add Checkov/tfsec to CI; block merges on high/critical findings |
| **P3-17** | Database | Transaction boundaries | LOW | No DB-level transaction boundaries visible | Multi-table writes may partially commit | Wrap multi-table writes in `db.transaction()` with explicit rollback |
| **P3-18** | Database | Schema | LOW | `onConflictDoNothing` on slug/email without logging | Silent data loss on concurrent inserts | Log conflicts to audit table with conflicting values |
| **P3-19** | Infrastructure | RDS | LOW | No auto-scaling on RDS storage | Manual intervention at 50GB | Enable `storage_auto_scaling` with max threshold |
| **P3-20** | Infrastructure | ALB/S3 | LOW | ALB access logs bucket encryption not explicit | Default S3 encryption may not be enforced | Explicitly set S3 bucket encryption (AES-256 or KMS) |

---

## 6. Cross-Cutting Systemic Issues

These issues span multiple subsystems and require coordinated fixes:

| Systemic Issue | Affected Subsystems | Impact | Resolution |
|----------------|---------------------|--------|------------|
| **No centralized auth enforcement** | Backend, Admin, Realtime Gateway, Mobile | Every service rolls its own auth; inconsistent enforcement | Implement shared auth middleware package; enforce across all services |
| **No distributed session/state management** | Realtime Gateway, Auth, API | In-memory stores prevent scaling; state lost on restart | Migrate to Redis for sessions, rate limiting, caching |
| **Inconsistent error handling** | All backend services | Mix of `console.log`, structured logging, silent failures | Standardize on structured logging (Pino) with request IDs |
| **No observability** | All services | Cannot trace requests across services; no alerting | Implement distributed tracing (OpenTelemetry) + centralized logging + metrics |
| **No CI/CD** | All subsystems | Manual deploys; no automated testing or security scanning | Add GitHub Actions pipeline with lint, test, scan, deploy stages |
| **Secrets scattered across codebase** | Backend, Infrastructure, Mobile | API keys in env vars, deploy scripts, mobile binaries | Migrate to AWS Secrets Manager; inject at runtime |
| **No multi-tenant data isolation at DB level** | Database, API, Admin, Mobile | Application-level auth bypass exposes all tenants | Enable RLS on all tenant-scoped tables |
| **Incomplete STT/TTS integration** | Realtime Gateway, Voice API, AI | Voice feature is non-functional | Complete STT/TTS provider integration with proper error handling |
| **No automated database migrations in CI** | Database, DevOps | Schema drift between environments | Add `db:migrate` to pre-deploy pipeline with rollback |

---

## 7. Implementation Roadmap

### Phase 1: Security Lockdown (Weeks 1-2) — BLOCKING

```
Week 1 — Auth Hardening:
 Mon-Tue: P0-04 Server-side admin auth + RBAC
 Tue-Wed: P0-05 Remove reset tokens from responses
 Wed-Thu: P0-06 JWT denylist + Redis session store
 Thu: P0-08 Current-password verification
 Fri: P0-09 Account lockout after failed logins

Week 2 — Data + Infrastructure:
 Mon-Tue: P0-01 WebSocket JWT authentication
 Tue: P0-02 Per-session transcribing lock
 Tue: P0-03 Fix SQL injection (parameterized queries)
 Wed-Thu: P0-07 Encrypt PII columns
 Thu-Fri: P0-10 ASG + ALB for compute
 Fri: P0-11 Redis Cluster with failover
 Fri: P0-12 Multi-AZ RDS
```

**Parallelization:** Weeks 1 and 2 can run in parallel tracks (Auth, Data, Infra) with 3 engineers.

### Phase 2: Stability + Correctness (Weeks 3-4)

```
Week 3 — Auth + Security:
 P1-01: Redis lock for refresh token rotation
 P1-02: Secure + SameSite cookie flags
 P1-03: Generic forgot-password response
 P1-04: Sanitize log input
 P1-05: Enable helmet CSP
 P1-06: Per-IP rate limiting on auth endpoints
 P1-12: Validate orgId against user membership
 P1-13: Implement password reset flow
 P1-14: Refresh token rotation + 7-day max lifetime

Week 4 — Database + Frontend + Infra:
 P1-07: Foreign key constraints
 P1-08: Missing indexes
 P1-09: Soft-delete mechanism
 P1-10: Row-level security
 P1-11: Admin routes or placeholders
 P1-15-P1-18: Infrastructure hardening
```

**Parallelization:** 3 parallel tracks (Security, Database, Frontend/Infra).

### Phase 3: Resilience + Observability (Weeks 5-6)

```
Week 5 — Backend Resilience:
 P2-01: Retry with backoff on AI providers
 P2-02: Language-aware STT fallback
 P2-03: AI keys via Secrets Manager
 P2-04: Health checks for AI providers
 P2-05: Input sanitization middleware
 P2-06: Redis caching for notifications
 P2-07: Zod schema for notification metadata

Week 6 — Frontend + Infrastructure:
 P2-08: Seed script safety guard
 P2-09: Composite indexes
 P2-10: Connection pool configuration
 P2-11-P2-13: Mobile feature completion
 P2-14-P2-16: Frontend optimization
 P2-17-P2-20: Observability + CI/CD
```

### Phase 4: Polish + Hardening (Weeks 7-8)

```
Week 7: P3-01 through P3-10 (low-priority security, DB, frontend fixes)
Week 8: P3-11 through P3-20 (polish, cost management, IaC hardening)
```

---

## 8. Testing Checklist

### Phase 1 (Security Lockdown)
- [ ] WebSocket connection without JWT rejected with 401
- [ ] WebSocket with valid JWT succeeds
- [ ] WebSocket with expired JWT rejected
- [ ] User/org IDs extracted from JWT match token claims
- [ ] Admin routes reject unauthenticated access
- [ ] Admin routes reject non-admin role
- [ ] Password reset does NOT return token in response
- [ ] JWT denylist blocks revoked tokens
- [ ] PII columns encrypted at rest
- [ ] Account lockout after 5 failed logins
- [ ] ASG scales with load (min=2 instances)
- [ ] Redis failover tested (node kill → automatic promotion)
- [ ] RDS failover tested (AZ failure → automatic promotion)

### Phase 2 (Stability)
- [ ] Refresh token rotation prevents concurrent double-issue
- [ ] Auth cookies have Secure + SameSite=Strict
- [ ] Forgot-password returns same response for existing/nonexistent emails
- [ ] Log injection attempts sanitized
- [ ] CSP blocks inline scripts except with valid nonce
- [ ] Per-IP rate limiting blocks after 5 login attempts
- [ ] Foreign key constraints prevent orphaned records
- [ ] Indexes present on all FK and lookup columns
- [ ] Soft-deleted records excluded from queries
- [ ] RLS policies prevent cross-tenant access
- [ ] Admin routes return 200 or proper placeholders
- [ ] orgId validated against user membership

### Phase 3 (Resilience)
- [ ] AI provider retries with exponential backoff
- [ ] STT fallback routes non-English to appropriate provider
- [ ] AI keys injected from Secrets Manager (not in env)
- [ ] Health check verifies AI provider reachability
- [ ] Input sanitization strips control chars/HTML
- [ ] Notification unread count cached in Redis
- [ ] Seed script refuses to run against production
- [ ] Composite indexes improve query performance
- [ ] Connection pool respects configured limits
- [ ] Mobile conversation detail screen functional
- [ ] Mobile voice pipeline produces audio
- [ ] Mobile works offline with local cache

### Phase 4 (Polish)
- [ ] All P3 items completed
- [ ] Security scan passes (no critical/high findings)
- [ ] Dependency audit clean
- [ ] Load test: 1000 concurrent WebSocket connections
- [ ] Load test: 100 concurrent voice sessions
- [ ] Backup restore tested successfully
- [ ] Terraform plan validates without errors

---

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Auth implementation breaks existing clients | High | High | Feature flags; gradual rollout; parallel auth paths |
| Redis session migration causes data loss | Medium | High | Dual-write during migration; rollback plan; session TTL |
| STT/TTS integration latency | Medium | Medium | Timeouts; fallback to text-only; caching |
| Rate limiting blocks legitimate traffic | Medium | Medium | Generous initial limits; monitor false positives |
| Input validation rejects valid messages | Medium | Medium | Schema testing; gradual rollout; logging |
| Database migration for session persistence | Low | High | Test on staging; backup before applying |

### Rollback Strategy

1. **Feature flags** for all major changes (auth, rate limiting, STT)
2. **Database backups** before schema changes
3. **Blue-green deployment** for realtime gateway
4. **Circuit breakers** for external service calls (STT, AI)
5. **Session TTL** to auto-recover from zombie sessions

---

## 10. Environment Changes Required

| Variable | Purpose | Required? |
|----------|---------|-----------|
| `JWT_PUBLIC_KEY` | Public key for WebSocket JWT validation | **Yes — P0-01** |
| `JWT_ISSUER` | Expected JWT issuer | **Yes — P0-01** |
| `JWT_AUDIENCE` | Expected JWT audience | **Yes — P0-01** |
| `JWT_REFRESH_TOKEN_SECRET` | Separate secret for refresh tokens | **Yes — P0-04** |
| `REDIS_URL` | Redis for sessions, rate limiting, caching | **Yes — P0-06, P0-11** |
| `CORS_ORIGINS` | Comma-separated allowed origins | **Yes — P1** |
| `WS_MAX_PAYLOAD` | Max WebSocket message size | **Yes — P0** |
| `STT_PROVIDER` | Speech-to-text provider | **Yes — P2** |
| `STT_API_KEY` | STT provider API key | **Yes — P2** |
| `TTS_PROVIDER` | Text-to-speech provider | Optional |
| `TTS_API_KEY` | TTS provider API key | Optional |
| `AI_PROVIDER_URL` | LLM provider endpoint | **Yes — P2** |
| `AI_API_KEY` | LLM provider API key | **Yes — P2** |
| `AWS_SECRETS_MANAGER_ARN` | ARN for secrets retrieval | **Yes — P1** |

---

## 11. Pre-Deployment Checklist

- [ ] All P0 (critical) issues resolved
- [ ] All P1 (high) issues resolved
- [ ] JWT authentication implemented and tested
- [ ] Session persistence migrated to Redis
- [ ] PII encrypted at rest
- [ ] Admin auth is server-side only
- [ ] Rate limiting tested under load
- [ ] Input validation covers all message types
- [ ] Database migrations tested on staging copy
- [ ] Rollback plan documented and tested
- [ ] Monitoring/alerting configured
- [ ] Security scan passed
- [ ] Load test passed (1000 concurrent connections)
- [ ] Team trained on new architecture

---

## Summary

The NOVA-Leadup platform has a sound architectural foundation but contains **12 critical security vulnerabilities** and **18 high-severity issues** that must be resolved before production deployment. The most urgent fixes are:

1. **WebSocket authentication bypass** — complete auth bypass
2. **No MFA** — stolen credentials grant full access
3. **Client-side admin auth** — complete admin panel compromise
4. **PII in plaintext** — DB breach exposes all customer data
5. **Single-node infrastructure** — no failover, total outage risk

**Recommendation: Do not deploy to production until Phase 1 (Security Lockdown) is complete and verified. After Phase 1, the platform can deploy with reduced functionality. Full production readiness requires all 4 phases (6-8 weeks).**

**Estimated total remediation: 6-8 weeks with a focused team of 2-3 engineers.**

---

*This report was synthesized from comprehensive audits of the NOVA-Leadup codebase including services/realtime-gateway, services/api, services/auth, packages/database, apps/admin, apps/mobile, and infrastructure/terraform.*
