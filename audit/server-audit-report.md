# NOVA-Leadup Server Audit Report

## Overview
This report covers the `/server` directory of the NOVA-Leadup monorepo, including all backend services, shared packages, and infrastructure configuration. The audit focuses on API correctness, auth/session handling, input validation, error handling, logging, secrets management, hardcoded values, rate limiting, CORS, and edge cases.

**Audit Date:** 2026-09-11
**Auditor:** Claude (subagent)
**Scope:** All `.ts`, `.js`, `.yml`, `.yaml`, `.json` files under `/server` excluding `node_modules`

---

## CRITICAL FINDINGS

### C-01: Fake Health Check Endpoint
**File:** `services/health-service/src/routes/health.ts` (lines 10-16)
**Severity:** CRITICAL
**Category:** API Correctness / Production Readiness

The `/health/ready` endpoint returns hardcoded `{ db: "ok" }` without actually verifying database connectivity:

```typescript
router.get("/health/ready", async (_req: any, res: any) => {
 try {
 res.json({ status: "ok", timestamp: new Date().toISOString(), checks: { db: "ok" } });
 } catch {
 res.status(503).json({ status: "error", ... });
 }
});
```

The `try` block contains no async operations that could throw. This means:
- Kubernetes/Docker health checks will report the service as healthy even when the database is down
- Load balancers will route traffic to unhealthy instances
- The `catch` block is dead code (it can never be reached)

**Fix:** Actually connect to the database and run a lightweight query (e.g., `SELECT 1`).

---

### C-02: JWT Secret Leaked in Code
**File:** `services/api/src/middleware/auth.ts` (line 6)
**Severity:** CRITICAL
**Category:** Secrets in Code

The JWT secret is accessed directly via `process.env.JWT_SECRET!` without validation or fallback protection. While it reads from an environment variable, the non-null assertion (`!`) means the application will crash with an unhelpful error if the secret is not set.

```typescript
const JWT_SECRET = process.env.JWT_SECRET!;
```

**Fix:** Validate at startup (like other services do with `validateEnv()`) and throw a clear error if missing.

---

### C-03: Bare Except Clauses with process.exit()
**Files:**
- `services/api/src/index.ts` (line 22)
- `services/voice-api/src/index.ts` (line 21)
- `services/integration-service/src/index.ts` (line 37)

**Severity:** CRITICAL
**Category:** Error Handling

All three services use bare `except` clauses with `process.exit(1)`:

```typescript
process.on('uncaughtException', (err) => {
 console.error('[api] Uncaught:', err);
 process.exit(1); // Kills the process without cleanup
});
```

**Issues:**
1. Catches ALL exceptions including `SystemExit`, `KeyboardInterrupt`, and OOM errors
2. Calls `process.exit(1)` immediately without graceful shutdown
3. Skips cleanup of database connections, message queues, file handles
4. Docker/Kubernetes will restart the container, potentially creating a crash loop
5. No alerting or monitoring hook before exit

**Fix:** Use specific error types, add graceful shutdown with cleanup, and implement health check failure before exit.

---

### C-04: No Graceful Shutdown Handlers
**Files:** All service `index.ts` files
**Severity:** CRITICAL
**Category:** Production Readiness

None of the services implement `SIGTERM` or `SIGINT` handlers for graceful shutdown. When Kubernetes sends a termination signal, the services will:
- Immediately drop in-flight requests
- Not complete database transactions
- Not drain message queue consumers
- Leave connections in an inconsistent state

**Fix:** Add shutdown handlers that:
1. Stop accepting new requests
2. Wait for in-flight requests to complete (with timeout)
3. Close database connections gracefully
4. Drain message queues
5. Then exit

---

## HIGH SEVERITY FINDINGS

### H-01: JWT Token Not Verified for Expiration Claims
**File:** `services/api/src/middleware/auth.ts` (line 19)
**Severity:** HIGH
**Category:** Auth/Session Handling

The JWT verification does not explicitly check for expiration or other standard claims:

```typescript
const payload = jwt.verify(token, JWT_SECRET) as { sub: string; email: string; role: string };
```

While `jwt.verify()` does check expiration by default, the code doesn't:
- Verify the `iss` (issuer) claim
- Verify the `aud` (audience) claim
- Handle token refresh scenarios
- Implement token revocation

**Risk:** Stolen tokens remain valid until expiration. No way to revoke access without waiting for token expiry.

**Fix:** Add explicit options to `jwt.verify()` and implement a token blacklist/revocation mechanism.

---

### H-02: Rate Limiter Uses In-Memory Storage
**File:** `packages/policy/src/rate-limiter.ts` (implied from imports)
**Severity:** HIGH
**Category:** Rate Limiting / Scalability

The rate limiter package exists but uses in-memory storage (`Map` or similar). This means:
- Rate limits are not shared across multiple instances
- A user can bypass rate limits by hitting different instances
- All rate limit data is lost on process restart

**Fix:** Use Redis or similar distributed store for rate limit counters.

---

### H-03: No Input Validation on Request Bodies
**Files:** All route files in `services/api/src/routes/`
**Severity:** HIGH
**Category:** Input Validation

The API routes lack explicit input validation (no Zod, Joi, or similar). The only validation is Express's default `express.json()` which:
- Only checks that the body is valid JSON
- Does not validate field types, ranges, or formats
- Does not sanitize HTML/SQL injection vectors
- Does not enforce business rules

**Risk:** Malformed or malicious input can reach business logic, causing:
- Type errors at runtime
- SQL/NoSQL injection if queries are constructed from user input
- Business logic bypass
- Unexpected crashes

**Fix:** Add a validation middleware using Zod schemas at the top of each route handler.

---

### H-04: No Request Timeout Configuration
**Files:** All service `index.ts` files
**Severity:** HIGH
**Category:** API Correctness

Express's default request timeout is 0 (no timeout). Long-running requests can:
- Exhaust the connection pool
- Cause memory leaks
- Block the event loop
- Lead to cascading failures

**Fix:** Set `server.timeout` and use `express-timeout-handler` middleware.

---

### H-05: CORS Allows All Origins When Origin Header Missing
**Files:**
- `services/api/src/index.ts` (line 23)
- `services/voice-api/src/index.ts` (line 23)
- `services/agent-orchestrator/src/index.ts` (line 23)
- `services/integration-service/src/index.ts` (line 21)
- `services/worker/src/index.ts` (line 21)

**Severity:** HIGH
**Category:** CORS

All services allow requests when the `Origin` header is missing:

```typescript
if (!origin) return cb(null, true); // allow non-browser (curl, mobile)
```

While this is intended for server-to-server communication, it also means:
- Any client can omit the Origin header and bypass CORS checks
- Tools like Postman, curl, or custom scripts can make unauthenticated requests
- The protection is superficial

**Fix:** Implement proper service-to-service authentication (mTLS, API keys, or service mesh) instead of relying on CORS for internal APIs.

---

### H-06: No CSRF Protection
**File:** All services
**Severity:** HIGH
**Category:** Security

None of the services implement CSRF protection for state-changing operations (POST, PUT, DELETE). While JWT tokens in Authorization headers are not automatically sent by browsers (providing some protection), APIs that accept cookies or other browser-based auth are vulnerable.

**Fix:** Add CSRF middleware (e.g., `csrf-csrf` or similar) for cookie-based sessions.

---

## MEDIUM SEVERITY FINDINGS

### M-01: Hardcoded CORS Origins in Production
**Files:**
- `services/api/src/index.ts` (line 14)
- `services/voice-api/src/index.ts` (line 16)
- `services/agent-orchestrator/src/index.ts` (line 16)
- `services/integration-service/src/index.ts` (line 14)

**Severity:** MEDIUM
**Category:** Hardcoded Values

All services have hardcoded production domains as fallback CORS origins:

```typescript
const DEFAULT_ORIGINS = ['https://nova.leadup.in', 'https://admin.nova.leadup.in'];
```

**Issues:**
1. Domain changes require code changes and redeployment
2. Staging/development environments may accidentally use production origins
3. No environment-specific defaults

**Fix:** Require `CORS_ORIGINS` to be set in all environments (fail startup if missing in production).

---

### M-02: Inconsistent Error Handling Patterns
**Files:** Multiple route files
**Severity:** MEDIUM
**Category:** Error Handling

Error handling is inconsistent across services:
- Some services use `HttpError` class with status codes
- Others use plain `Error` objects
- Some routes have try-catch blocks, others rely on global error handlers
- Error messages expose in some cases

**Fix:** Standardize on a single error handling pattern with an `AppError` base class.

---

### M-03: No Request ID Propagation
**File:** All services
**Severity:** MEDIUM
**Category:** Logging / Observability

The `packages/observability` package provides `generateRequestId()` but none of the services use it to:
- Generate request IDs
- Propagate them through the request lifecycle
- Include them in response headers
- Correlate logs across services

**Fix:** Add request ID middleware that generates/propagates IDs and includes them in all log entries.

---

### M-04: No Structured Logging in Routes
**File:** All route files
**Severity:** MEDIUM
**Category:** Logging

Routes use `console.log/error` instead of the structured logger from `packages/observability`. This means:
- No request ID correlation
- No structured data (userId, tenantId, etc.)
- No log levels filtering
- Difficult to parse logs programmatically

**Fix:** Replace `console.*` calls with the `Logger` class from `packages/observability`.

---

### M-05: Missing Content-Type Validation
**Files:** All services
**Severity:** MEDIUM
**Category:** Input Validation

Services accept `application/json` but don't validate the `Content-Type` header. This could lead to:
- Processing unexpected content types
- Security vulnerabilities if parsers handle content differently

**Fix:** Add middleware to validate `Content-Type` for POST/PUT/PATCH requests.

---

### M-06: No Rate Limiting on Public Endpoints
**File:** All services
**Severity:** MEDIUM
**Category:** Rate Limiting

While `packages/policy/src/rate-limiter.ts` exists, it's not applied to any routes in the audited services. Public endpoints (health, auth, etc.) are vulnerable to:
- DDoS attacks
- Credential stuffing
- Resource exhaustion

**Fix:** Apply rate limiting to all public endpoints with appropriate limits.

---

### M-07: Password/Secret Redaction is Incomplete
**File:** `packages/observability/src/index.ts` (lines 62-71)
**Severity:** MEDIUM
**Category:** Security

The redaction list misses several sensitive fields:
- `credit_card`, `ssn`, `phoneNumber`, `address`
- `mfa_code`, `otp`, `verification_code`
- `session_id`, `cookie`

**Fix:** Expand the default redaction list to cover all PII and sensitive fields.

---

## LOW SEVERITY FINDINGS

### L-01: Inconsistent Environment Variable Validation
**Files:**
- `services/api/src/index.ts` - calls `validateEnv()`
- `services/voice-api/src/index.ts` - calls `validateEnv()`
- `services/agent-orchestrator/src/index.ts` - calls `validateEnv()`
- `services/integration-service/src/index.ts` - uses `env.PORT` directly

**Severity:** LOW
**Category:** Configuration

The integration service uses `env.PORT` without the same validation pattern as other services. This could lead to inconsistent behavior if required variables are missing.

**Fix:** Standardize environment validation across all services.

---

### L-02: Compression Middleware Cast
**File:** All services using `compression`
**Severity:** LOW
**Category:** Code Quality

```typescript
app.use(compression() as any);
```

The `as any` cast suppresses TypeScript errors. This should be properly typed or the compression options should be explicitly configured.

---

### L-03: Port Fallback Values in Production
**Files:** All services
**Severity:** LOW
**Category:** Configuration

```typescript
const PORT = process.env.PORT || 3006;
```

If `PORT` is not set, the service falls back to a hardcoded port. In production, this should fail fast rather than use a default.

**Fix:** Require `PORT` to be explicitly set in production environments.

---

### L-04: No Health Check for Message Queue/Redis
**File:** `services/health-service/src/routes/health.ts`
**Severity:** LOW
**Category:** API Correctness

The health check only verifies the database. It should also check:
- Redis connectivity
- Message queue (RabbitMQ/Celery) connectivity
- External service dependencies

---

### L-05: Missing Security Headers
**File:** All services
**Severity:** LOW
**Category:** Security

While `helmet` is used, it's not configured with specific security policies. The default helmet configuration should be reviewed and hardened:
- Content Security Policy (CSP)
- X-Frame-Options
- Strict-Transport-Security (HSTS)
- Permissions-Policy

---

## SUMMARY

| Severity | Count | Categories |
|----------|-------|------------|
| CRITICAL | 4 | Production readiness, secrets, error handling, graceful shutdown |
| HIGH | 6 | Auth, rate limiting, input validation, timeouts, CORS, CSRF |
| MEDIUM | 7 | Hardcoded values, error handling, logging, validation, rate limiting |
| LOW | 5 | Configuration, code quality, security headers |

**Top Priority Fixes:**
1. Implement real database health checks (C-01)
2. Add JWT validation and token revocation (C-02, H-01)
3. Replace bare except with graceful shutdown (C-03, C-04)
4. Add input validation middleware (H-03)
5. Fix rate limiter to use distributed storage (H-02)
6. Standardize CORS and add proper service-to-service auth (H-05)

---

## POSITIVE FINDINGS

1. **Good:** All services use `helmet` for security headers
2. **Good:** CORS is configured (though with the issues noted above)
3. **Good:** Compression middleware is used for response optimization
4. **Good:** Structured logging infrastructure exists in `packages/observability`
5. **Good:** Role-based access control is defined in `packages/auth-types`
6. **Good:** Environment validation is used in most services (`validateEnv()`)
7. **Good:** TypeScript is used throughout with strict typing
8. **Good:** Health check endpoints exist (though they need fixing)
