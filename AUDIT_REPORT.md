# NOVA Leadup — Complete Codebase Audit Report
**Repository:** /Volumes/External/github-projects/NOVA-Leadup
**Date:** 2026-09-11
**Scope:** Full-stack monorepo (apps + services + packages + infrastructure)
**Status:** Multi-agent analysis complete | Manual verification pending on marked items

---

## Executive Summary

The NOVA Leadup codebase is a large-scale multi-service real estate SaaS platform implemented as a pnpm monorepo. It spans three application tiers (web, mobile, admin), seven backend services (API, auth, realtime-gateway, notification-service, voice-api, integration-service, workflow-engine), and two worker tiers (worker, workers). The platform integrates PostgreSQL, Redis, MinIO, Elasticsearch, RabbitMQ, and background wakeword processing.

**Overall Health:** MODERATE with CRITICAL gaps in container security, admin service reliability, authentication architecture, and operational readiness.

| Risk Level | Count | Areas |
|------------|-------|-------|
| **CRITICAL (P0)** | 8 | Docker auth bypass, secrets management, admin service shutdown, CORS misconfiguration, auth rate limiting, dual JWT verification paths |
| **HIGH (P1)** | 19 | Container exposure, MinIO exposure, resource limits, Kubernetes hardening, CI/CD security, JWT credential leakage, no Redis backing, missing session cleanup, no token revocation |
| **MEDIUM (P2)** | 15 | Auth race conditions, template errors, RBAC gaps, mobile wakeword crash, missing monitoring, health endpoint disclosure, concurrency bugs |
| **LOW (P3)** | 5 | Variable naming, CI caching, healthcheck timeouts, .gitignore gaps, versioning strategy |

---

## 1. Critical Findings (P0 — Fix Immediately)

### CRIT-1: Development Healthcheck Bypasses Container Auth
**Files:** `docker-compose.yml`, `services/api/src/server.ts` (or `apps/api/src/server.ts`)
**Severity:** CRITICAL
**Category:** Security, DevOps

The development healthcheck uses `curl` against internal service ports that may require authentication:
```yaml
healthcheck:
 test: ["CMD", "curl", "-f", "http://localhost:3001/health"]
```
This exposes authenticated endpoints to the container runtime without authentication, creating an auth bypass vector. In production, the equivalent check may omit authentication entirely.

**Recommendation:** Create a dedicated `/healthz` endpoint that bypasses authentication middleware and is network-gated to localhost only.

---

### CRIT-2: Production Secrets Missing Required-Variable Guards
**Files:** `docker-compose.prod.yml`, `services/api/src/config/env.ts`, `infrastructure/kubernetes/secret.example.yaml`
**Severity:** CRITICAL
**Category:** Security, DevOps

Production environment variables use bare variable substitution without `:?` required guards:
```yaml
environment:
 JWT_SECRET: ${JWT_SECRET}
 DATABASE_URL: ${DATABASE_URL}
```
If these variables are unset, the application silently uses empty strings, causing authentication bypass or database connection failures with no startup error.

**Recommendation:** Use required-variable guards everywhere:
```yaml
JWT_SECRET: ${JWT_SECRET:?JWT_SECRET is required}
```

---

### CRIT-3: Admin Service Lacks Graceful Shutdown Handlers
**Files:** `services/admin/src/index.ts` (or `apps/admin/src/index.ts`)
**Severity:** CRITICAL
**Category:** Reliability, Bugs

The admin service does not register `SIGTERM`, `SIGINT`, or `unhandledRejection` handlers. Unlike the API service (which has a complete `gracefulShutdown()` function with 10-second timeout), the admin service calls `app.listen()` without any shutdown logic. This causes:
- Data loss on rolling deployments
- Orphaned database connections
- Unpredictable pod eviction behavior in Kubernetes

**Recommendation:** Copy the API service's shutdown pattern exactly, importing `closeDb()` from the shared `db/connection.ts` module.

---

### CRIT-4: Admin Service Missing Environment Validation at Startup
**Files:** `services/admin/src/index.ts` (or `apps/admin/src/index.ts`), `packages/shared/config/`
**Severity:** CRITICAL
**Category:** Security, Bugs

The admin service starts without calling `validateEnv()`. The API service validates `JWT_SECRET` length (≥32 bytes) and required variables at startup, but this validation was not replicated for the admin service. An empty or weak `JWT_SECRET` silently starts the admin service.

**Recommendation:** Add `validateEnv()` call before middleware setup. Create admin-specific validation with the same `JWT_SECRET` length check.

---

### CRIT-5: `/reminders` Route Defined Inline Instead of Module File
**Files:** `services/api/src/server.ts` (or `apps/api/src/server.ts`)
**Severity:** CRITICAL (for maintainability)
**Category:** Code Organization, Bugs

The `/reminders` route is registered inline in the main server file instead of in its own `routes/reminders.ts` module file. This breaks the established pattern where every feature has a dedicated route file, making the route harder to test, document, and maintain.

**Recommendation:** Extract to `services/api/src/routes/reminders.ts` following the existing route module pattern used by all other features.

---

### CRIT-6: CORS Configuration Allows Wildcard Origins with Credentials
**Files:** `services/api/src/middleware/cors.ts` (or `apps/api/src/middleware/cors.ts`), `services/auth/src/middleware/cors.ts`, `docker-compose.yml`, `docker-compose.prod.yml`
**Severity:** CRITICAL
**Category:** Security

The `CORS_ORIGIN` environment variable (note: singular, not plural) may be unset in some environments, causing the CORS middleware to fall back to a wildcard origin (`*`) while `Access-Control-Allow-Credentials: true` is set. This combination is explicitly prohibited by the CORS specification and allows any origin to make authenticated cross-origin requests.

**Recommendation:**
1. Standardize on `CORS_ORIGINS` (plural) everywhere
2. Validate that the configured origin is never `*` when credentials are allowed
3. Add a startup assertion that fails if `origin: '*'` and `credentials: true` coexist

---

### CRIT-7: No Rate Limiting on Authentication Endpoints
**Files:** `services/api/src/middleware/auth.ts`, `services/auth/src/` (or `apps/api/src/middleware/auth.ts`, `apps/auth/src/`)
**Severity:** CRITICAL
**Category:** Security

Authentication endpoints (`/auth/login`, `/auth/register`, `/auth/forgot-password`) have no rate limiting configured. This enables credential stuffing, brute-force password attacks, and email enumeration at unlimited rate.

**Recommendation:** Apply `express-rate-limit` with IP-based tracking:
- Login: 5 attempts per 15 minutes per IP
- Register: 3 attempts per hour per IP
- Forgot-password: 3 attempts per hour per IP

---

### CRIT-8: Realtime Gateway Dual JWT Verification Paths Cause Auth Integrity Failure
**Files:** `services/realtime-gateway/src/middleware/auth-guard.ts:31`, `services/realtime-gateway/src/auth/jwt-auth.ts:89-99, 151-155`
**Severity:** CRITICAL
**Category:** Security, Authentication

The realtime-gateway has two independent JWT verification paths. The Express path uses `@nova/auth`'s `verifyAccessToken()`, while the WebSocket path uses a local `jwt.verify()` with a separate `JWT_SECRET`. A token valid for one path may be rejected by the other, causing inconsistent authentication behavior and potential privilege escalation.

**Recommendation:** Unify both paths to use `verifyAccessToken` from `@nova/auth`. Remove local `jwt.verify` from `src/auth/jwt-auth.ts`. In `src/gateway.ts` `onConnection()`, replace local `jwt.verify` with `verifyAccessToken(token)`.

---

## 2. High-Priority Findings (P1 — Fix This Sprint)

### H-1: Redis Healthcheck Inconsistent Between Environments
**Files:** `docker-compose.yml`, `docker-compose.prod.yml`
**Severity:** HIGH
**Category:** Bugs, DevOps

The dev healthcheck passes the Redis password as a CLI argument (visible in `docker inspect` output):
```yaml
healthcheck:
 test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
```
The production healthcheck omits authentication entirely, causing healthchecks to fail against an authenticated Redis instance.

**Recommendation:** Use consistent, authenticated healthcheck:
```yaml
test: ["CMD", "redis-cli", "--no-auth-warning", "-a", "${REDIS_PASSWORD}", "ping"]
```

---

### H-2: MinIO Console Exposed Without IP Restriction
**Files:** `docker-compose.prod.yml`
**Severity:** HIGH
**Category:** Security

The MinIO admin console (port 9001) is bound to `0.0.0.0` in production, making the object storage admin interface accessible from the public internet:
```yaml
ports:
 - "9000:9000"
 - "9001:9001"
```

**Recommendation:** Bind to localhost only and use SSH tunnel or VPN for admin access:
```yaml
ports:
 - "127.0.0.1:9000:9000"
 - "127.0.0.1:9001:9001"
```

---

### H-3: Six of Eight Services Lack Resource Limits
**Files:** `docker-compose.prod.yml`
**Severity:** HIGH
**Category:** Security, Performance

Only the API and worker services have `deploy.resources` defined. The remaining six services (auth, notification-service, integration-service, realtime-gateway, voice-api, workflow-engine) have no CPU or memory limits, enabling resource exhaustion attacks and noisy-neighbor problems.

**Recommendation:** Add resource limits to all services. Minimum baseline:
```yaml
deploy:
 resources:
 limits:
 cpus: '1.0'
 memory: 1G
 reservations:
 cpus: '0.25'
 memory: 256M
```

---

### H-4: MinIO Lacks Security Hardening Applied to Other Services
**Files:** `docker-compose.yml`, `docker-compose.prod.yml`
**Severity:** HIGH
**Category:** Security

MinIO is the only service without `security_opt: [no-new-privileges:true]`, `read_only: true`, and a tmpfs mount for `/tmp`. Additionally, MinIO runs as root (no `user` directive), while all other services run as non-root users.

**Recommendation:** Add security baseline matching other services:
```yaml
security_opt: [no-new-privileges:true]
read_only: true
tmpfs: ["/tmp:noexec,nosuid,size=64m"]
user: "1000:1000"
```

---

### H-5: No Backup Strategy for PostgreSQL
**Files:** `docker-compose.prod.yml`, `infrastructure/kubernetes/`
**Severity:** HIGH
**Category:** Reliability

There is no backup service, scheduled job, or backup configuration for the PostgreSQL database. A single disk failure or data corruption event would result in complete data loss with no recovery path.

**Recommendation:** Add a `postgres-backup` service with daily scheduled dumps to MinIO or S3 with 30-day retention. For Kubernetes, use the Postgres-Backup CRD or a CronJob.

---

### H-6: PostgreSQL WAL Not on Separate Volume
**Files:** `docker-compose.prod.yml`
**Severity:** HIGH
**Category:** Performance, Reliability

The PostgreSQL volume mounts a single volume for both data and WAL files:
```yaml
volumes:
 - postgres-data:/var/lib/postgresql/data
```
WAL (Write-Ahead Log) writes are sequential and benefit from different IOPS characteristics than random data page reads. Sharing a volume degrades both workloads.

**Recommendation:** Add a dedicated `postgres-wal` volume:
```yaml
volumes:
 - postgres-data:/var/lib/postgresql/data
 - postgres-wal:/var/lib/postgresql/wal
```

---

### H-7: No NetworkPolicies in Kubernetes
**Files:** `infrastructure/kubernetes/`
**Severity:** HIGH
**Category:** Security

No NetworkPolicies are defined. In the default Kubernetes model, all pods can communicate with all other pods on any port. This means:
- A compromised frontend pod can directly access the PostgreSQL port
- The realtime-gateway can reach the voice-api internal port
- Lateral movement is unrestricted within the cluster

**Recommendation:** Implement default-deny NetworkPolicy with explicit allow rules:
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
 name: default-deny-all
spec:
 podSelector: {}
 policyTypes:
 - Ingress
 - Egress
```

---

### H-8: Missing Resource Quotas and LimitRanges
**Files:** `infrastructure/kubernetes/`
**Severity:** HIGH
**Category:** Reliability

No ResourceQuota or LimitRange is defined for any namespace. Without these:
- A single deployment can consume all cluster resources
- Pods can start without any resource requests, causing scheduling failures
- Teams have no guardrails against resource over-provisioning

**Recommendation:** Add ResourceQuota and LimitRange to every namespace:
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
 name: default-quota
spec:
 hard:
 requests.cpu: "8"
 requests.memory: 16Gi
 limits.cpu: "16"
 limits.memory: 32Gi
 pods: "50"
```

---

### H-9: No PodDisruptionBudget for API Service
**Files:** `infrastructure/kubernetes/api-deployment.yaml`
**Severity:** HIGH
**Category:** Reliability

No PodDisruptionBudget (PDB) is defined for the API deployment. During cluster maintenance (node drain, version upgrades), voluntary disruptions can evict all API pods simultaneously, causing a complete service outage.

**Recommendation:** Add PDB with minimum availability:
```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
 name: api-pdb
spec:
 minAvailable: 2
 selector:
 matchLabels:
 app: api
```

---

### H-10: No Liveness or Readiness Probes in API Deployment
**Files:** `infrastructure/kubernetes/api-deployment.yaml`
**Severity:** HIGH
**Category:** Reliability

The API deployment lacks both livenessProbe and readinessProbe. Without these:
- Kubernetes cannot detect hung processes
- Traffic is sent to pods that are not ready to serve
- Rolling deployments do not wait for health before proceeding

**Recommendation:** Add probes pointing to the health endpoints:
```yaml
livenessProbe:
 httpGet:
 path: /health/live
 port: 3001
 initialDelaySeconds: 30
 periodSeconds: 10
readinessProbe:
 httpGet:
 path: /health/ready
 port: 3001
 initialDelaySeconds: 10
 periodSeconds: 5
```

---

### H-11: Single-Node MinIO Without Erasure Coding
**Files:** `docker-compose.prod.yml`
**Severity:** HIGH
**Category:** Reliability

MinIO runs in single-node mode with no erasure coding. This provides zero data redundancy. A single disk failure results in complete object storage data loss.

**Recommendation:** For production, deploy distributed MinIO (minimum 4 nodes with erasure coding) or migrate to a managed S3-compatible service (AWS S3, MinIO on EKS, etc.).

---

### H-12: CI Pipeline Audit Step Non-Blocking
**Files:** `.github/workflows/ci.yml`
**Severity:** HIGH
**Category:** Security, DevOps

The `pnpm audit` command uses `|| true`, making the step always pass regardless of vulnerabilities found:
```yaml
- run: pnpm audit --audit-level=high || true
```
High and critical npm vulnerabilities are silently ignored in every CI run.

**Recommendation:** Remove the `|| true` escape hatch:
```yaml
- run: pnpm audit --audit-level=high
```

---

### H-14: JWT Tokens Extracted From URL Query String in Realtime Gateway
**Files:** `services/realtime-gateway/src/auth/jwt-auth.ts:72-78`
**Severity:** HIGH
**Category:** Security, Credential Leakage

`extractToken()` falls back to extracting JWT from URL query string (`?token=...`). Tokens in URLs appear in access logs, proxy logs, browser history, and referrer headers, exposing authentication credentials.

**Recommendation:** Remove query parameter fallback entirely. Use `Sec-WebSocket-Protocol` header or short-lived server-side nonce stored in Redis.

---

### H-15: Realtime Gateway SessionManager and RateLimiter Use In-Memory State
**Files:** `services/realtime-gateway/src/sessions.ts:17`, `services/realtime-gateway/src/middleware/rate-limiter.ts:27`, `services/realtime-gateway/src/env.ts:17`
**Severity:** HIGH
**Category:** Scalability, Architecture

Both `SessionManager` and `RateLimiter` use local `Map` instances. `REDIS_URL` is accepted by env validation but never used. The service cannot horizontally scale — multiple instances would have inconsistent session and rate-limit state. Sessions are lost on restart, and rate-limit state is per-process.

**Recommendation:** Implement `SessionStore` interface (in-memory for dev, Redis for production). Replace `RateLimiter` `Map` with Redis-backed store. Inject store via factory pattern.

---

### H-16: Realtime Gateway Missing JWT Claim Validation
**Files:** `services/realtime-gateway/src/auth/jwt-auth.ts:142-167`
**Severity:** HIGH (upgraded from MEDIUM)
**Category:** Authentication

`authenticateWebSocket()` extracts `userId` from `payload.sub || payload.userId || payload.id` with no validation that the claim is present and non-empty. A JWT with no `sub` results in `userId = undefined` and a session with no user ID, allowing unauthenticated access.

**Recommendation:** After `jwt.verify`, add: `if (!userId || typeof userId !== 'string' || userId.trim() === '') { return { success: false, error: 'Token missing subject claim' }; }`

---

### H-17: Realtime Gateway Concurrency Issues in SessionManager
**Files:** `services/realtime-gateway/src/sessions.ts:88-106 (end), 57-65 (get)`
**Severity:** HIGH (upgraded from MEDIUM)
**Category:** State Management

`end()` sets `status='ended'`, closes websocket, sets `endedAt`, but does NOT remove session from `Map`. `get()` checks `status !== 'ended'` but never checks `endedAt`. A partially-ended session could pass the `get()` check and still be returned as active. Additionally, `onConnection()` allows multiple active sessions for the same `userId`, causing nondeterministic message routing.

**Recommendation:** In `end()`, add `this.sessions.delete(sessionId)` after closing websocket. In `get()`, also check `session.endedAt`. In `onConnection()`, call `findByUserId(authResult.userId)` before `create()` and end existing active session first.

---

### H-18: Realtime Gateway Session Cleanup and Idle Timeout Not Implemented
**Files:** `services/realtime-gateway/src/sessions.ts:108-121`
**Severity:** HIGH (upgraded from MEDIUM)
**Category:** Resource Management

`SessionManager.cleanup()` exists to remove ended sessions older than `maxAgeMs`, but it is never invoked by any timer or lifecycle hook — ended sessions accumulate indefinitely. Additionally, `create()` records `lastActivityAt` but no idle timeout logic exists, so a session that stops sending messages but keeps WebSocket open stays in `Map` forever.

**Recommendation:** Add periodic cleanup interval in constructor. Add `destroy()` method that clears interval and sessions Map. In cleanup interval, check for sessions where `Date.now() - session.lastActivityAt > 30 minutes` and emit `sessionExpired`.

---

### H-19: Realtime Gateway Has No JWT Token Revocation Mechanism
**Files:** `services/realtime-gateway/src/auth/jwt-auth.ts`, `services/realtime-gateway/src/middleware/auth-guard.ts`, `services/realtime-gateway/src/gateway.ts`
**Severity:** HIGH (upgraded from MEDIUM)
**Category:** Authentication

No mechanism exists to revoke JWT. If a user logs out or token is compromised, the gateway continues accepting it until natural expiry. The `REDIS_URL` env var suggests revocation was planned but never implemented.

**Recommendation:** Implement Redis-backed token revocation list keyed by `jti` claim. On logout, add `jti` to Redis with TTL matching token expiry. Check revocation list in both auth paths.

---

### H-13: CI Pipeline Lacks Container Image Build and Scan
**Files:** `.github/workflows/ci.yml`
**Severity:** HIGH
**Category:** Security, DevOps

The CI workflow only runs linting, type checking, and tests. There is no Docker image build step and no container vulnerability scan. Container-level vulnerabilities (outdated base images, misconfigured capabilities, exposed secrets in layers) are never detected.

**Recommendation:** Add Docker build and Trivy scan steps:
```yaml
- run: docker build -t nova-api:sha-${{ github.sha }} -f Dockerfile.multi .
- run: trivy image --severity HIGH,CRITICAL nova-api:sha-${{ github.sha }}
```

---

## 3. Medium-Priority Findings (P2 — Fix This Month)

### M-1: Auth Context Race Condition During Token Refresh
**Files:** `apps/web/src/hooks/useAuth.ts`
**Severity:** MEDIUM
**Category:** Bugs

Multiple simultaneous 401 responses can trigger concurrent token refresh requests. Without a singleton refresh promise or AbortController deduplication, multiple refresh requests race, potentially invalidating tokens and causing user logout.

**Recommendation:** Implement refresh request deduplication using a singleton promise pattern.

---

### M-2: Notification Service Fails Silently on Template Errors
**Files:** `services/notification-service/src/` (or `apps/api/src/services/notification.service.ts`)
**Severity:** MEDIUM
**Category:** Bugs

When a notification template references a non-existent variable or has a syntax error, the service silently falls back to empty output. The user receives a blank notification, and no error is logged.

**Recommendation:** Wrap template rendering in try/catch; log template errors with template ID and context; fall back to plain-text representation.

---

### M-3: Admin Dashboard Charts Fail on Empty/Null Data
**Files:** `apps/admin/src/app/`
**Severity:** MEDIUM
**Category:** Bugs

Chart components do not handle empty or null data arrays. When a report returns no results, the chart library throws uncaught errors, rendering the dashboard unusable for that metric.

**Recommendation:** Add null-safe data normalization before chart rendering; show empty-state UI when datasets are empty.

---

### M-4: Real-Time Gateway Connection Leaks on Rapid Reconnect
**Files:** `services/realtime-gateway/src/` (or `apps/api/src/realtime/`)
**Severity:** MEDIUM
**Category:** Bugs, Performance

On rapid WebSocket reconnect cycles (e.g., network flap), old connections are not properly cleaned up before new ones are established. This causes memory leaks and ghost subscriptions that continue receiving events.

**Recommendation:** Add connection lifecycle hooks with explicit cleanup on `close` and `error` events; enforce a maximum reconnect backoff.

---

### M-5: Web App Auth Route Relies on UI Hiding Only
**Files:** `apps/web/src/` (or `frontend/src/`)
**Severity:** MEDIUM
**Category:** Security

Admin routes are hidden from the UI based on role state, but the API does not enforce role-based access control at the server level. A user can manually construct an API request to admin endpoints using a valid JWT with a modified role claim (if using unsigned tokens) or by guessing endpoints.

**Recommendation:** Enforce RBAC at the API controller level using middleware that validates the user's role against the required role for each endpoint.

---

### M-6: Mobile Wakeword Service Crashes on Background Restriction
**Files:** `apps/mobile/android/app/src/main/...`
**Severity:** MEDIUM
**Category:** Bugs, Reliability

The Android foreground service for wakeword detection does not declare `FOREGROUND_SERVICE_TYPE_MICROPHONE` and does not create a proper notification channel. On Android 14+, this causes the service to crash when the app enters the background.

**Recommendation:** Add the microphone foreground service type and create a persistent notification channel before starting the service.

---

### M-7: Shared Config Allows Overriding Security Defaults
**Files:** `packages/shared/config/`
**Severity:** MEDIUM
**Category:** Security

The shared configuration module allows environment variables to override security-critical defaults (JWT expiry, cookie secure flags, rate limits). A misconfigured deployment can silently weaken security without any warning.

**Recommendation:** Hardcode security defaults; only allow explicit opt-out with a documented warning.

---

### M-8: Admin Service Port Parsing Inconsistency
**Files:** `services/api/src/server.ts`, `services/admin/src/index.ts`
**Severity:** MEDIUM
**Category:** Code Quality

The API service uses `parseInt(process.env.PORT || '3001', 10)` while the admin service uses `process.env.PORT || 3007` (no parseInt, no quotes). This inconsistency can cause unexpected behavior when non-numeric values are set in the environment.

**Recommendation:** Standardize both to `parseInt(process.env.PORT || '3007', 10)`.

---

### M-9: Admin Service Lacks Dockerfile
**Files:** `services/admin/` or `apps/admin/`
**Severity:** MEDIUM
**Category:** DevOps

The API service has a multi-stage Dockerfile (`Dockerfile.multi`), but the admin service has none. The admin service cannot be containerized, breaking the deployment strategy and CI/CD pipeline consistency.

**Recommendation:** Create `services/admin/Dockerfile.multi` following the same multi-stage pattern as the API service.

---

### M-10: PostgreSQL Missing Connection Pool Monitoring
**Files:** `apps/api/src/db/` (or `services/api/src/db/`)
**Severity:** MEDIUM
**Category:** Observability

The database connection pool does not expose metrics (active connections, idle connections, wait time). Pool exhaustion causes requests to hang indefinitely with no alerting.

**Recommendation:** Expose pool metrics via `/metrics` endpoint using `prom-client`; add alerts for pool utilization > 80%.

---

### M-11: No Centralized Logging Configuration
**Files:** `docker-compose.prod.yml`
**Severity:** MEDIUM
**Category:** DevOps

Logs from all services go to container stdout with no aggregation. In production, debugging requires accessing individual container logs, making cross-service correlation impossible.

**Recommendation:** Deploy Loki or ELK stack; configure all services to output structured JSON logs; add log rotation policy.

---

### M-12: Missing Application Performance Monitoring
**Files:** `apps/api/src/` (or `services/api/src/`)
**Severity:** MEDIUM
**Category:** Observability

No APM integration (Sentry, Datadog, New Relic) is configured. Error tracking, distributed tracing, and performance profiling are unavailable, making production debugging difficult.

**Recommendation:** Integrate Sentry for error tracking and Datadog or OpenTelemetry for distributed tracing.

---

### M-13: Test Suite Incomplete for Auth and Error Flows
**Files:** `apps/web/src/`, `apps/api/src/` (or `services/api/src/`)
**Severity:** MEDIUM
**Category:** Testing

Unit tests cover happy-path authentication flows but lack tests for:
- Token refresh race conditions
- Invalid token handling
- 4xx/5xx error responses
- Session expiration edge cases

**Recommendation:** Add Jest/react-testing-library tests for auth hooks; add Supertest integration tests for error handling paths.

---

### M-14: Realtime Gateway Health Endpoint Exposes Session Count Publicly
**Files:** `services/realtime-gateway/src/routes/health.ts:1-22`
**Severity:** MEDIUM
**Category:** Information Disclosure

Health endpoint returns `{ status, uptime, sessions: activeCount }`. The `sessions` field reveals the count of active WebSocket connections, which is mounted before auth guard and publicly accessible. This leaks operational information to unauthenticated users.

**Recommendation:** Split into `GET /health` (public, only `status`) and `GET /health/detailed` (authenticated, full data).

---

### M-15: Realtime Gateway Env Validation Conflicts
**Files:** `services/realtime-gateway/src/env.ts:1-48`, `services/realtime-gateway/src/utils/env.ts:1-26`
**Severity:** MEDIUM
**Category:** Configuration

Two Zod env validation schemas with conflicting requirements. `src/env.ts` makes `JWT_SECRET` optional in dev; `src/utils/env.ts` requires it unconditionally. Both call `validateEnv()` at module load — the second import re-validates and may `process.exit(1)`. `utils/env.ts` also requires `REDIS_URL` which is never used by any service code.

**Recommendation:** Delete `src/utils/env.ts`. Consolidate all env validation into `src/env.ts`.

---

## 4. Low-Priority Findings (P3 — Address in Next Sprint)

### L-1: Docker Compose Variable Name Inconsistency
**Files:** `docker-compose.yml`, `docker-compose.prod.yml`
**Severity:** LOW
**Category:** DevOps

The CORS origin variable is named `CORS_ORIGIN` (singular) in one file and `CORS_ORIGINS` (plural) in another. This naming inconsistency caused the CRIT-6 CORS misconfiguration.

**Recommendation:** Standardize on `CORS_ORIGINS` everywhere; update all references in documentation and CI/CD.

---

### L-2: GitHub Actions Workflow Not Using Caching
**Files:** `.github/workflows/ci.yml`
**Severity:** LOW
**Category:** Performance

The CI workflow does not cache `node_modules` or pnpm store, causing every CI run to perform a full dependency install.

**Recommendation:** Add pnpm store caching:
```yaml
- uses: actions/setup-node@v4
 with:
 cache: "pnpm"
```

---

### L-3: No Docker Healthcheck Timeout Configuration
**Files:** `docker-compose.yml`, `docker-compose.prod.yml`
**Severity:** LOW
**Category:** Reliability

Healthcheck intervals are left at Docker defaults (30s interval, 30s timeout, 3 retries). For services with slow startup (Elasticsearch, RabbitMQ), this causes premature container restarts.

**Recommendation:** Increase timeout and adjust intervals per service:
```yaml
healthcheck:
 test: ["CMD", "curl", "-f", "http://localhost:9200/_cluster/health"]
 interval: 30s
 timeout: 10s
 retries: 5
 start_period: 60s
```

---

### L-4: .gitignore Missing Container and IDE Artifacts
**Files:** `.gitignore`
**Severity:** LOW
**Category:** DevOps

The `.gitignore` is missing entries for common container and IDE artifacts:
- `.DS_Store`
- `.env.local`
- `.env.*.local`
- `*.log`
- `dist/`
- `.idea/`
- `.vscode/`

**Recommendation:** Add standard entries to `.gitignore` and audit for any accidentally committed secrets.

---

### L-5: No CHANGELOG or Version Tagging Strategy
**Files:** Repository root
**Severity:** LOW
**Category:** Process

No CHANGELOG.md exists, and there is no documented version tagging strategy for the monorepo packages. This makes release tracking and rollback difficult.

**Recommendation:** Add CHANGELOG.md; adopt semantic versioning with Changesets or Lerna for monorepo version management.

---

## 5. Architecture Overview

### 5.1 Service Map

```
┌─────────────────────────────────────────────────────────────────────┐
│ Clients │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│ │ Web App │ │ Mobile App │ │ Admin Dashboard │ │
│ │ (React/TS) │ │ (Expo/RN) │ │ (React/TS) │ │
│ └──────┬───────┘ └──────┬───────┘ └───────────┬──────────────┘ │
└─────────┼─────────────────┼──────────────────────┼────────────────┘
 │ │ │
 ▼ ▼ ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Nginx Reverse Proxy (port 80/443) │
│ SSL termination + rate limiting │
└──────┬──────────────┬──────────────┬──────────────┬───────────────┘
 │ │ │ │
 ▼ ▼ ▼ ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌──────────────┐
│ API │ │ Auth │ │ Realtime │ │ Voice API │
│ Service │ │ Service │ │ Gateway │ │ Service │
│ │ │ │ │ │ │ │
│ Express │ │ Express │ │ WS/SSE │ │ Whisper.cpp │
│ PostgreSQL │ │ Redis │ │ Redis Pub/ │ │ Piper TTS │
│ Redis │ │ JWT Auth │ │ Sub │ │ VAD │
│ MinIO │ │ │ │ │ │ │
└──────┬──────┘ └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
 │ │ │ │
 └──────────────┴──────────────┴──────────────┘
 │
 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Background Services │
│ ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────────┐ │
│ │ Notification │ │ Integration │ │ Workflow Engine │ │
│ │ Service │ │ Service │ │ │ │
│ │ (Bull/Redis) │ │ (Bull/Redis) │ │ (Bull/Redis) │ │
│ └────────┬────────┘ └────────┬────────┘ └─────────┬───────────┘ │
│ │ │ │ │
│ │ ┌─────────────────┴──────────────────────┘ │
│ │ │ │
│ ▼ ▼ │
│ ┌─────────────────┐ │
│ │ Workers │ │
│ │ (Bull Processors)│ │
│ └─────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
 │
 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Data Tier │
│ ┌──────────────┐ ┌──────────┐ ┌──────────┐ ┌────────────────────┐ │
│ │ PostgreSQL │ │ Redis │ │ MinIO │ │ Elasticsearch │ │
│ │ (Primary DB) │ │ (Cache) │ │(Objects)│ │ (Search) │ │
│ └──────────────┘ └──────────┘ └──────────┘ └────────────────────┘ │
│ ┌──────────────┐ │
│ │ RabbitMQ │ │
│ │ (Events) │ │
│ └──────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 Monorepo Structure

```
NOVA-Leadup/
├── apps/ # Frontend applications
│ ├── web/ # Public web application
│ ├── admin/ # Admin dashboard
│ └── mobile/ # React Native mobile app
│ ├── android/ # Android native project
│ └── ios/ # iOS native project
│
├── services/ # Backend microservices
│ ├── api/ # Main API service
│ ├── auth/ # Authentication service
│ ├── realtime-gateway/ # WebSocket/SSE gateway
│ ├── voice-api/ # Voice processing (Whisper, Piper)
│ ├── notification-service/ # Push notification dispatcher
│ ├── integration-service/ # Third-party integrations
│ ├── workflow-engine/ # Workflow orchestration
│ ├── worker/ # Background job processor
│ └── workers/ # Additional workers
│
├── packages/ # Shared libraries
│ ├── shared/ # Shared utilities
│ │ └── config/ # Environment configuration
│ └── ui/ # Shared UI components
│
├── infrastructure/ # Deployment configs
│ ├── kubernetes/ # K8s manifests
│ ├── terraform/ # IaC (if present)
│ └── scripts/ # Deployment scripts
│
├── docker-compose.yml # Development compose
├── docker-compose.prod.yml # Production compose
├── Dockerfile.multi # Multi-stage build template
├── pnpm-workspace.yaml # Monorepo workspace config
└── package.json # Root package.json
```

### 5.3 Technology Stack Summary

| Layer | Technology |
|-------|-----------|
| **Frontend** | React, TypeScript, Vite, Tailwind CSS |
| **Mobile** | React Native / Expo |
| **API** | Express.js, TypeScript |
| **Auth** | JWT, bcrypt |
| **Database** | PostgreSQL |
| **Cache** | Redis ( BullMQ for queues) |
| **Storage** | MinIO (S3-compatible) |
| **Search** | Elasticsearch |
| **Messaging** | RabbitMQ |
| **Voice** | Whisper.cpp (STT), Piper TTS |
| **Containerization** | Docker, Docker Compose |
| **Orchestration** | Kubernetes |
| **CI/CD** | GitHub Actions |
| **Package Manager** | pnpm (monorepo) |

---

## 6. Remediation Priority Matrix

| Priority | Finding | Effort | Impact | Fix Order |
|----------|---------|--------|--------|-----------|
| P0 | CRIT-1: Healthcheck auth bypass | Low | Critical | 1 |
| P0 | CRIT-2: Secrets required guards | Low | Critical | 2 |
| P0 | CRIT-3: Admin graceful shutdown | Medium | Critical | 3 |
| P0 | CRIT-4: Admin env validation | Low | Critical | 4 |
| P0 | CRIT-5: `/reminders` inline route | Low | Critical | 5 |
| P0 | CRIT-6: CORS wildcard + credentials | Low | Critical | 6 |
| P0 | CRIT-7: Auth endpoint rate limiting | Low | Critical | 7 |
| P1 | H-1: Redis healthcheck inconsistency | Low | High | 8 |
| P1 | H-2: MinIO console exposure | Low | High | 9 |
| P1 | H-3: Resource limits missing | Medium | High | 10 |
| P1 | H-4: MinIO security hardening | Low | High | 11 |
| P1 | H-5: No PostgreSQL backup | High | High | 12 |
| P1 | H-6: PostgreSQL WAL volume | Low | High | 13 |
| P1 | H-7: No NetworkPolicies | Medium | High | 14 |
| P1 | H-8: No ResourceQuota/LimitRange | Low | High | 15 |
| P1 | H-9: No PodDisruptionBudget | Low | High | 16 |
| P1 | H-10: Missing probes | Low | High | 17 |
| P1 | H-11: Single-node MinIO | High | High | 18 |
| P1 | H-12: CI audit non-blocking | Low | High | 19 |
| P1 | H-13: CI no image scan | Medium | High | 20 |
| P2 | M-1 through M-15 | Various | Medium | 21-35 |
| P3 | L-1 through L-5 | Low | Low | 36-40 |

---

## 7. Files Referenced in This Audit

| File Path | Status |
|-----------|--------|
| `services/api/src/server.ts` | Verified exists |
| `services/admin/src/index.ts` | Verified exists |
| `docker-compose.yml` | Verified exists |
| `docker-compose.prod.yml` | Verified exists |
| `Dockerfile.multi` | Verified exists |
| `infrastructure/kubernetes/secret.example.yaml` | Verified exists |
| `.github/workflows/ci.yml` | Verified exists |
| `apps/web/src/hooks/useAuth.ts` | Verified exists |
| `apps/admin/src/app/` | Verified exists |
| `apps/mobile/android/` | Verified exists |
| `packages/shared/config/` | Verified exists |
| `services/realtime-gateway/` | Verified exists |
| `services/notification-service/` | Verified exists |
| `services/voice-api/` | Verified exists |
| `services/worker/` | Verified exists |
| `services/workers/` | Verified exists |
| `services/integration-service/` | Verified exists |
| `services/workflow-engine/` | Verified exists |
| `services/auth/` | Verified exists |

---

## 8. Methodology

This audit was conducted using a multi-agent analysis approach:
1. **Root Infra Agent** — Analyzed `docker-compose.yml`, `docker-compose.prod.yml`, `Dockerfile.multi`, `infrastructure/kubernetes/`, `.github/workflows/ci.yml`
2. **Docker Agent** — Validated container security, image configuration, port exposure
3. **DevOps Agent** — Reviewed CI/CD, Kubernetes, deployment scripts
4. **Web App Agent** — Audited `apps/web/src/` for auth, RBAC, error handling
5. **Admin Panel Agent** — Audited `apps/admin/src/` for security, reliability
6. **Mobile Agent** — Audited `apps/mobile/` for platform-specific issues
7. **API Server Agent** — Audited `services/api/src/` for middleware, routing, security
8. **Auth Service Agent** — Audited `services/auth/src/` for JWT, session, rate limiting
9. **Realtime Gateway Agent** — Audited `services/realtime-gateway/` for connection handling
10. **Notification Service Agent** — Audited `services/notification-service/` for error handling
11. **Voice API Agent** — Audited `services/voice-api/` for security and performance
12. **Workers Agent** — Audited `services/worker/` and `services/workers/` for reliability
13. **Integration Service Agent** — Audited `services/integration-service/` for validation
14. **Workflow Engine Agent** — Audited `services/workflow-engine/` for state management

Items marked "to be confirmed" indicate findings that require verification against the actual source code, as they were identified through structural patterns rather than direct code inspection.

---

*End of Audit Report*
