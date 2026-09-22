# NOVA-Leadup Monorepo — Comprehensive Audit Report

**Report Date:** 2026-09-11
**Repository:** NOVA-Leadup
**Audit Scope:** Security, Authentication/Authorization, Data Handling, Infrastructure, Mobile, Frontend, Backend, Architecture
**Auditors:** Security Auditor, Backend Analyzer, Android Wakeword Fix, Notifications Creator, Admin Analyzer
**Report Compiled By:** Audit Report Compiler

---

## Executive Summary

This comprehensive audit of the NOVA-Leadup monorepo identified **96 findings** across five audit domains. The findings reveal critical security vulnerabilities, missing service implementations, infrastructure gaps, and frontend/backend weaknesses that require immediate attention.

### Severity Breakdown

| Severity | Count | Description |
|----------|-------|-------------|
| **P0 - Critical** | 17 | Immediate exploitation risk, data breach, service unavailability |
| **P1 - High** | 45 | Significant security/operational impact, should fix within 1 sprint |
| **P2 - Medium** | 34 | Best practice gaps, moderate risk, address within 1-2 quarters |
| **P3 - Low** | 0 | Minor improvements, no immediate risk |

### Domain Breakdown

| Domain | Findings | P0 | P1 | P2 |
|--------|----------|----|----|----|
| Security Auditor | 29 | 8 | 10 | 11 |
| Backend Analyzer-2 | 21 | 4 | 11 | 6 |
| Analyze-Admin | 22 | 2 | 8 | 12 |
| Fix-Android-Wakeword | 11 | 2 | 6 | 3 |
| Create-Notifications | 13 | 1 | 10 | 2 |
| **TOTAL** | **96** | **17** | **45** | **34** |

### Key Risk Areas

1. **Authentication & Authorization**: 17 findings including JWT algorithm bypass, hardcoded secrets, missing refresh token rotation, IDOR vulnerabilities, and no MFA support.
2. **Service Availability**: 13 findings including missing notification service, missing Dockerfiles, and no health check endpoints.
3. **Infrastructure**: 21 findings including no CI/CD, no secrets management, no monitoring, and container security gaps.
4. **Data Protection**: 5 findings including unencrypted PII, leaked stack traces, and database credentials in logs.

---

## Systemic Issues

These patterns appear across multiple subsystems and indicate architectural weaknesses:

### 1. Authentication & Authorization Weaknesses
**Pattern:** Incomplete or missing authentication/authorization checks across services.
**Impact:** Unauthorized access to resources, data breaches, privilege escalation.
**Affected Services:** auth-service, api, workflow-engine, voice-api, realtime-gateway, admin app
**Findings:** FIND-001, FIND-003, FIND-005, FIND-006, FIND-007, FIND-016, FIND-021, FIND-027, ADM-004, ADM-005, ADM-019, ADM-023

### 2. Missing Input Validation & Sanitization
**Pattern:** User-controlled input not validated or sanitized before processing.
**Impact:** SQL injection, XSS, NoSQL injection, data corruption.
**Affected Services:** api, auth-service, admin app, notification-service
**Findings:** FIND-017, FIND-022, ADM-006, ADM-013

### 3. No Rate Limiting or Abuse Protection
**Pattern:** Authentication and critical endpoints lack rate limiting.
**Impact:** Brute force attacks, DoS attacks, credential stuffing.
**Affected Services:** api, realtime-gateway, workflow-engine
**Findings:** FIND-012, FIND-024, FIND-026

### 4. Missing Observability & Monitoring
**Pattern:** No centralized logging, metrics, tracing, or alerting.
**Impact:** Cannot debug production issues, slow incident response, blind to failures.
**Affected Services:** All services
**Findings:** FIND-025, B-010, B-011, B-012, B-013, F-012, F-013

### 5. Infrastructure as Code & Deployment Gaps
**Pattern:** Manual infrastructure setup, no CI/CD, no secrets management.
**Impact:** Configuration drift, slow deployments, credential exposure, human error.
**Affected Services:** All services
**Findings:** B-001, B-002, B-003, B-004, B-006, B-007, B-017, B-018

### 6. Missing Service Implementations
**Pattern:** Core services (notification, wake word) incomplete or missing.
**Impact:** Feature unavailability, broken user experience.
**Affected Services:** notification-service, mobile/android
**Findings:** F-001, F-002, F-003, F-004, CREATE-NOTIFICATIONS F-001 through F-013

### 7. Error Handling & Information Leakage
**Pattern:** Stack traces, internal paths, and sensitive data exposed to clients.
**Impact:** Information disclosure aiding attackers, debugging difficulties.
**Affected Services:** api, auth-service, database
**Findings:** FIND-013, FIND-020, ADM-001

---

## Detailed Findings

### Security

#### FIND-001: JWT "none" Algorithm Bypass
- **File:** `services/auth-service/src/middleware/auth.ts:120-145`
- **Severity:** P0
- **Category:** Authentication
- **Description:** The authentication middleware accepts JWT tokens with the "none" algorithm, allowing attackers to bypass signature verification entirely.
- **Root Cause:** Missing algorithm validation in JWT verification logic.
- **Concrete Fix:**
```typescript
// services/auth-service/src/middleware/auth.ts
if (header.alg === 'none') {
 return res.status(401).json({ error: 'Algorithm not allowed' });
}
// Only accept RS256 or HS256
if (!['RS256', 'HS256'].includes(header.alg)) {
 return res.status(401).json({ error: 'Invalid algorithm' });
}
```

#### FIND-002: Hardcoded JWT Secret
- **File:** `services/api/src/middleware/auth.ts:37-41`
- **Severity:** P0
- **Category:** Authentication
- **Description:** JWT signing secret is hardcoded in source code and committed to version control.
- **Root Cause:** Secret management not implemented; developer convenience over security.
- **Concrete Fix:**
```typescript
// services/api/src/middleware/auth.ts
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
 throw new Error('JWT_SECRET not configured');
}
// Use JWT_SECRET for signing/verification
```

#### FIND-003: No Refresh Token Rotation
- **File:** `services/auth-service/src/routes/auth.routes.ts`
- **Severity:** P0
- **Category:** Authentication
- **Description:** Refresh tokens are never invalidated, allowing stolen tokens to be used indefinitely.
- **Root Cause:** No token revocation mechanism or rotation strategy implemented.
- **Concrete Fix:**
```typescript
// services/auth-service/src/routes/auth.routes.ts
// Store refreshTokenId in DB, generate new one on each refresh, invalidate old one
const refreshTokenId = crypto.randomUUID();
await db.refreshToken.create({
 data: { id: refreshTokenId, userId: user.id, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }
});
// On refresh: invalidate old token, issue new one
await db.refreshToken.update({ where: { id: oldTokenId }, data: { revoked: true } });
```

#### FIND-004: Password Reset Token in URL
- **File:** `services/api/src/routes/auth.routes.ts:96-113`
- **Severity:** P0
- **Category:** Authentication
- **Description:** Password reset tokens are passed as URL query parameters, leaking via Referer headers and server logs.
- **Root Cause:** Token passed in query string instead of POST body.
- **Concrete Fix:**
```typescript
// services/api/src/routes/auth.routes.ts
// Use POST body for token, not URL parameter
router.post('/auth/reset-password', async (req, res) => {
 const { token, newPassword } = req.body;
 // Validate token and update password
});
```

#### FIND-005: IDOR - Workflow Instance Access
- **File:** `services/workflow-engine/src/routes/instances.ts:21-33`
- **Severity:** P0
- **Category:** Authorization
- **Description:** Users can access other users' workflow instances due to missing ownership check.
- **Root Cause:** Query does not filter by `userId`.
- **Concrete Fix:**
```typescript
// services/workflow-engine/src/routes/instances.ts
const instance = await db.workflowInstance.findFirst({
 where: { id: instanceId, userId: req.user.id }
});
if (!instance) {
 return res.status(404).json({ error: 'Not found' });
}
```

#### FIND-006: IDOR - Voice Agent Access
- **File:** `services/voice-api/src/routes/agents.ts:17-30`
- **Severity:** P0
- **Category:** Authorization
- **Description:** Users can access other tenants' voice agents due to missing tenant isolation.
- **Root Cause:** Query does not filter by `tenantId`.
- **Concrete Fix:**
```typescript
// services/voice-api/src/routes/agents.ts
const agent = await db.agent.findFirst({
 where: { id: agentId, tenantId: req.user.tenantId }
});
if (!agent) {
 return res.status(404).json({ error: 'Not found' });
}
```

#### FIND-007: WebSocket Auth Race Condition
- **File:** `services/realtime-gateway/src/middleware/auth-guard.ts:65-73`
- **Severity:** P0
- **Category:** Authentication
- **Description:** WebSocket connection is established before authentication is verified, allowing unauthorized connections.
- **Root Cause:** Async auth check performed after HTTP upgrade to WebSocket.
- **Concrete Fix:**
```typescript
// services/realtime-gateway/src/middleware/auth-guard.ts
// Verify JWT in HTTP handshake before upgrading to WebSocket
wss.on('connection', (ws, req) => {
 const token = parseQueryString(req.url).token;
 if (!verifyJWT(token)) {
 ws.close(4001, 'Unauthorized');
 return;
 }
 // Proceed with authenticated connection
});
```

#### FIND-008: Weak bcrypt Rounds
- **File:** `services/auth-service/src/services/password.service.ts:27`
- **Severity:** P1
- **Category:** Authentication
- **Description:** bcrypt is configured with only 8 rounds, which is too fast for modern hardware.
- **Root Cause:** Default/slow migration from old hash configuration.
- **Concrete Fix:**
```typescript
// services/auth-service/src/services/password.service.ts
const hash = await bcrypt.hash(password, 12); // Increase to 12 rounds
```

#### FIND-009: PII Stored Unencrypted
- **File:** `packages/database/src/schema.ts:31-40`
- **Severity:** P0
- **Category:** Data Protection
- **Description:** PII fields (email, phone, name) are stored unencrypted in the database.
- **Root Cause:** No column-level encryption configured.
- **Concrete Fix:**
```sql
-- packages/database/src/schema.ts (migration)
ALTER TABLE users
 ALTER COLUMN email TYPE VARCHAR ENCRYPTED USING 'aes' WITH (key_name = 'pii_key'),
 ALTER COLUMN phone TYPE VARCHAR ENCRYPTED USING 'aes' WITH (key_name = 'pii_key'),
 ALTER COLUMN name TYPE VARCHAR ENCRYPTED USING 'aes' WITH (key_name = 'pii_key');
```

#### FIND-010: CSRF Vulnerability
- **File:** `services/api/src/middleware/cors.ts`
- **Severity:** P1
- **Category:** Security
- **Description:** CORS is configured to allow all origins with credentials, enabling CSRF attacks.
- **Root Cause:** Misconfigured CORS headers with wildcard origin and credentials enabled.
- **Concrete Fix:**
```typescript
// services/api/src/middleware/cors.ts
origin: (origin) => whitelist.includes(origin),
credentials: true,
```

#### FIND-011: CORS Allows Any Origin
- **File:** `services/api/src/middleware/cors.ts`
- **Severity:** P1
- **Category:** Security
- **Description:** CORS allows any origin with credentials, enabling cross-origin attacks.
- **Root Cause:** Wildcard origin (`*`) used with `credentials: true`.
- **Concrete Fix:**
```typescript
// services/api/src/middleware/cors.ts
// Remove Access-Control-Allow-Origin: * when credentials: true
origin: (origin) => whitelist.includes(origin) ? origin : false,
credentials: true,
```

#### FIND-012: No Rate Limiting on Auth Endpoints
- **File:** `services/api/src/middleware/rate-limit.ts`
- **Severity:** P1
- **Category:** Security
- **Description:** Authentication endpoints lack rate limiting, enabling brute force attacks.
- **Root Cause:** Rate limiter middleware not applied to `/auth/*` routes.
- **Concrete Fix:**
```typescript
// services/api/src/middleware/rate-limit.ts
// Apply rate-limit to /auth/*: 5 attempts per 15 minutes
app.use('/auth/*', rateLimit({
 windowMs: 15 * 60 * 1000,
 max: 5,
 message: 'Too many login attempts, please try again later'
}));
```

#### FIND-013: Error Handler Leaks Stack Traces
- **File:** `services/api/src/middleware/error-handler.ts`
- **Severity:** P2
- **Category:** Security
- **Description:** Error handler exposes stack traces and internal paths to clients.
- **Root Cause:** Stack trace included in error response.
- **Concrete Fix:**
```typescript
// services/api/src/middleware/error-handler.ts
const response = { error: message, code: error.code || 'INTERNAL_ERROR' };
delete response.stack; // Remove stack trace from response
return res.status(500).json(response);
```

#### FIND-014: Missing Security Headers
- **File:** `services/api/src/middleware/helmet.ts`
- **Severity:** P2
- **Category:** Security
- **Description:** Missing security headers (X-Frame-Options, CSP, HSTS).
- **Root Cause:** Helmet not configured or incomplete.
- **Concrete Fix:**
```typescript
// services/api/src/middleware/helmet.ts
helmet({
 contentSecurityPolicy: {
 directives: { defaultSrc: ["'self'"] }
 },
 xFrameOptions: 'DENY'
});
```

#### FIND-015: No HTTPS Enforcement
- **File:** `services/api/src/server.ts`
- **Severity:** P2
- **Category:** Security
- **Description:** API accepts HTTP connections without redirecting to HTTPS.
- **Root Cause:** Missing HTTPS redirect middleware.
- **Concrete Fix:**
```typescript
// services/api/src/server.ts
app.use((req, res, next) => {
 if (req.headers['x-forwarded-proto'] !== 'https') {
 return res.redirect('https://' + req.headers.host + req.url);
 }
 next();
});
```

#### FIND-016: JWT Tokens Never Revoked
- **File:** `services/auth-service/src/middleware/auth.ts`
- **Severity:** P1
- **Category:** Authentication
- **Description:** JWT tokens are never revoked, allowing compromised tokens to remain valid.
- **Root Cause:** No token blacklist or short expiry mechanism.
- **Concrete Fix:**
```typescript
// services/auth-service/src/middleware/auth.ts
// Add token version field to user table; reject tokens issued before password change
const tokenVersion = await db.user.findUnique({ where: { id: payload.sub } }).then(u => u.tokenVersion);
if (payload.version < tokenVersion) {
 return res.status(401).json({ error: 'Token revoked' });
}
```

#### FIND-017: Missing Input Sanitization
- **File:** `services/api/src/middleware/auth.ts`
- **Severity:** P1
- **Category:** Security
- **Description:** User-controlled fields are not sanitized before database queries.
- **Root Cause:** No validation/sanitization layer before DB access.
- **Concrete Fix:**
```typescript
// services/api/src/middleware/auth.ts
import { z } from 'zod';
const schema = z.object({ name: z.string().max(100).regex(/^[a-zA-Z\s]+$/) });
const validated = schema.parse(req.body);
```

#### FIND-018: No Webhook Signature Verification
- **File:** `services/notification-service/src/routes/webhooks.ts`
- **Severity:** P1
- **Category:** Security
- **Description:** Webhooks accept any payload without verifying HMAC signature.
- **Root Cause:** No signature verification implemented.
- **Concrete Fix:**
```typescript
// services/notification-service/src/routes/webhooks.ts
const crypto = require('crypto');
const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
if (signature !== expected) {
 return res.status(401).json({ error: 'Invalid signature' });
}
```

#### FIND-019: Workflow Execution Without Timeout
- **File:** `services/workflow-engine/src/services/engine.ts`
- **Severity:** P2
- **Category:** Security
- **Description:** Workflow execution has no timeout, allowing hung processes to block the queue.
- **Root Cause:** No execution timeout implemented.
- **Concrete Fix:**
```typescript
// services/workflow-engine/src/services/engine.ts
const timeout = new Promise((_, reject) =>
 setTimeout(() => reject(new Error('Workflow timeout')), 30000)
);
Promise.race([executeWorkflow(), timeout]);
```

#### FIND-020: Database Connection String in Logs
- **File:** `packages/database/src/index.ts`
- **Severity:** P2
- **Category:** Data Protection
- **Description:** Database connection string is logged at startup, exposing credentials.
- **Root Cause:** Logger includes full connection string.
- **Concrete Fix:**
```typescript
// packages/database/src/index.ts
// Remove from logger: delete process.env.DATABASE_URL after connection
const connectionUrl = process.env.DATABASE_URL;
await connect(connectionUrl);
delete process.env.DATABASE_URL; // Prevent accidental logging
```

#### FIND-021: No MFA Support
- **File:** `services/api/src/middleware/auth.ts`
- **Severity:** P2
- **Category:** Authentication
- **Description:** Only single-factor authentication is supported.
- **Root Cause:** MFA implementation missing.
- **Concrete Fix:**
```typescript
// services/api/src/middleware/auth.ts
// Implement TOTP with speakeasy
import * as speakeasy from 'speakeasy';
const secret = speakeasy.generateSecret({ name: 'NOVA' });
// Verify TOTP during login
const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token: req.body.mfaToken });
```

#### FIND-022: File Upload Without Validation
- **File:** `services/api/src/routes/upload.ts`
- **Severity:** P1
- **Category:** Security
- **Description:** File upload accepts any file type and size without validation.
- **Root Cause:** No file type/size validation middleware.
- **Concrete Fix:**
```typescript
// services/api/src/routes/upload.ts
const upload = multer({
 limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
 fileFilter: (req, file, cb) => {
 if (!file.mimetype.startsWith('image/')) {
 return cb(new Error('Only images allowed'));
 }
 cb(null, true);
 }
});
```

#### FIND-023: Admin Endpoints Not Restricted
- **File:** `services/api/src/routes/admin.ts`
- **Severity:** P1
- **Category:** Authorization
- **Description:** Admin endpoints are accessible without admin role verification.
- **Root Cause:** Missing role check middleware.
- **Concrete Fix:**
```typescript
// services/api/src/routes/admin.ts
if (req.user.role !== 'admin') {
 return res.status(403).json({ error: 'Forbidden' });
}
```

#### FIND-024: No Message Rate Limiting on WebSocket
- **File:** `services/realtime-gateway/src/index.ts`
- **Severity:** P2
- **Category:** Security
- **Description:** WebSocket connections can be flooded with messages without rate limiting.
- **Root Cause:** No per-connection rate limiting.
- **Concrete Fix:**
```typescript
// services/realtime-gateway/src/index.ts
// Implement per-connection rate limit: max 100 messages/minute
const messageCount = new Map();
ws.on('message', (data) => {
 const count = messageCount.get(ws) || 0;
 if (count > 100) {
 ws.close(4008, 'Rate limit exceeded');
 return;
 }
 messageCount.set(ws, count + 1);
});
```

#### FIND-025: No Request ID for Tracing
- **File:** `packages/shared/src/types/index.ts`
- **Severity:** P2
- **Category:** Security
- **Description:** No request ID for tracing, making audit and debugging difficult.
- **Root Cause:** Missing correlation ID generation.
- **Concrete Fix:**
```typescript
// packages/shared/src/types/index.ts
import { randomUUID } from 'crypto';
const requestId = randomUUID();
logger.info({ requestId, ... });
```

#### FIND-026: Rate Limiter Uses Memory Store
- **File:** `services/api/src/middleware/rate-limit.ts`
- **Severity:** P2
- **Category:** Infrastructure
- **Description:** Rate limiter uses in-memory store, which doesn't work across multiple instances.
- **Root Cause:** In-memory store used instead of distributed store.
- **Concrete Fix:**
```typescript
// services/api/src/middleware/rate-limit.ts
import RedisStore from 'rate-limit-redis';
const store = new RedisStore({ client: redisClient });
```

#### FIND-027: Token Expiry Too Long
- **File:** `services/api/src/middleware/auth.ts`
- **Severity:** P2
- **Category:** Authentication
- **Description:** JWT tokens have 7-day expiry, allowing stale tokens to remain valid.
- **Root Cause:** Long token expiry without refresh token rotation.
- **Concrete Fix:**
```typescript
// services/api/src/middleware/auth.ts
// Reduce to 1 hour with refresh token rotation
const token = jwt.sign({ sub: user.id, version: user.tokenVersion }, JWT_SECRET, {
 expiresIn: '1h'
});
```

#### FIND-028: No Dead Letter Queue
- **File:** `services/notification-service/src/queues/processor.ts`
- **Severity:** P1
- **Category:** Architecture
- **Description:** Failed notifications are silently dropped without a dead letter queue.
- **Root Cause:** No DLQ configuration.
- **Concrete Fix:**
```typescript
// services/notification-service/src/queues/processor.ts
const dlq = await queue.add('notifications-dlq', msg, {
 attempts: 3,
 backoff: 'exponential'
});
```

#### FIND-029: Queue Worker Without Concurrency Limit
- **File:** `services/workflow-engine/src/queues/worker.ts`
- **Severity:** P2
- **Category:** Architecture
- **Description:** Queue worker processes jobs without concurrency limit, potentially overwhelming downstream services.
- **Root Cause:** No concurrency limit configured.
- **Concrete Fix:**
```typescript
// services/workflow-engine/src/queues/worker.ts
await queue.process('workflows', 5, async (job) => {
 // Process with max 5 concurrent jobs
});
```

---

### Authentication/Authorization

#### FIND-030: No MFA Support (Duplicate of FIND-021)
- **File:** `services/api/src/middleware/auth.ts`
- **Severity:** P2
- **Category:** Authentication
- **Description:** Single-factor authentication only.
- **Root Cause:** MFA implementation missing.
- **Concrete Fix:** Implement TOTP with speakeasy.

#### FIND-031: JWT Tokens Never Revoked (Duplicate of FIND-016)
- **File:** `services/auth-service/src/middleware/auth.ts`
- **Severity:** P1
- **Category:** Authentication
- **Description:** No token revocation mechanism.
- **Root Cause:** No token version field or blacklist.
- **Concrete Fix:** Add token version field to user table.

#### FIND-032: Admin Endpoints Not Restricted (Duplicate of FIND-023)
- **File:** `services/api/src/routes/admin.ts`
- **Severity:** P1
- **Category:** Authorization
- **Description:** Admin endpoints lack role verification.
- **Root Cause:** Missing role check middleware.
- **Concrete Fix:** Add `if (req.user.role !== 'admin')` check.

---

### Data Handling

#### FIND-033: PII Stored Unencrypted (Duplicate of FIND-009)
- **File:** `packages/database/src/schema.ts:31-40`
- **Severity:** P0
- **Category:** Data Protection
- **Description:** PII fields stored without encryption.
- **Root Cause:** No column-level encryption.
- **Concrete Fix:** Use pgcrypto for column-level encryption.

#### FIND-034: Error Handler Leaks Stack Traces (Duplicate of FIND-013)
- **File:** `services/api/src/middleware/error-handler.ts`
- **Severity:** P2
- **Category:** Data Handling
- **Description:** Stack traces exposed to clients.
- **Root Cause:** Stack trace included in error response.
- **Concrete Fix:** Remove stack trace from response.

#### FIND-035: Database Connection String in Logs (Duplicate of FIND-020)
- **File:** `packages/database/src/index.ts`
- **Severity:** P2
- **Category:** Data Handling
- **Description:** Connection string logged at startup.
- **Root Cause:** Logger includes full connection string.
- **Concrete Fix:** Delete `DATABASE_URL` after connection.

---

### Infrastructure

#### FIND-036: No Dockerfile for Notification Service
- **File:** `services/notification-service/`
- **Severity:** P0
- **Category:** Infrastructure
- **Description:** Notification service cannot be containerized.
- **Root Cause:** Missing Dockerfile.
- **Concrete Fix:**
```dockerfile
# services/notification-service/Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

#### FIND-037: No Health Check Endpoints
- **File:** `services/notification-service/src/index.ts`
- **Severity:** P0
- **Category:** Infrastructure
- **Description:** No health check endpoints in any service.
- **Root Cause:** Health check routes not implemented.
- **Concrete Fix:**
```typescript
// services/notification-service/src/index.ts
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/ready', (req, res) => res.json({ status: 'ready' }));
```

#### FIND-038: docker-compose.prod.yml Missing Resource Limits
- **File:** `docker-compose.prod.yml`
- **Severity:** P0
- **Category:** Infrastructure
- **Description:** No resource limits in production compose file, risking OOM kills.
- **Root Cause:** Missing `deploy.resources.limits` configuration.
- **Concrete Fix:**
```yaml
# docker-compose.prod.yml
services:
 api:
 deploy:
 resources:
 limits:
 cpus: '0.5'
 memory: 512M
 reservations:
 cpus: '0.25'
 memory: 256M
```

#### FIND-039: No Secrets Management
- **File:** `.env` files in repository
- **Severity:** P0
- **Category:** Infrastructure
- **Description:** Environment files with credentials committed to version control.
- **Root Cause:** No secrets management solution.
- **Concrete Fix:** Use Docker secrets or HashiCorp Vault.

#### FIND-040: Redis Not Configured with Password
- **File:** `redis.conf`
- **Severity:** P1
- **Category:** Infrastructure
- **Description:** Redis has no password, allowing unauthenticated access.
- **Root Cause:** Missing `requirepass` configuration.
- **Concrete Fix:**
```conf
# redis.conf
requirepass your_secure_password_here
```

#### FIND-041: No CI/CD Pipeline
- **File:** `.github/workflows/`
- **Severity:** P1
- **Category:** Infrastructure
- **Description:** No CI/CD pipeline for automated builds and deployments.
- **Root Cause:** No GitHub Actions workflow.
- **Concrete Fix:** Create `.github/workflows/ci.yml` with build, test, and deploy stages.

#### FIND-042: No Automated Security Scanning
- **File:** CI/CD configuration
- **Severity:** P1
- **Category:** Infrastructure
- **Description:** No automated vulnerability scanning in CI/CD.
- **Root Cause:** No security scanning tools configured.
- **Concrete Fix:** Add Snyk or Trivy to CI pipeline.

#### FIND-043: No Centralized Logging
- **File:** Infrastructure configuration
- **Severity:** P1
- **Category:** Infrastructure
- **Description:** No centralized logging solution.
- **Root Cause:** No ELK or Loki stack configured.
- **Concrete Fix:** Deploy ELK stack or Loki for log aggregation.

#### FIND-044: No Metrics Collection
- **File:** Infrastructure configuration
- **Severity:** P1
- **Category:** Infrastructure
- **Description:** No metrics collection or monitoring.
- **Root Cause:** No Prometheus + Grafana setup.
- **Concrete Fix:** Deploy Prometheus + Grafana with service exporters.

#### FIND-045: No Alerting Configured
- **File:** Infrastructure configuration
- **Severity:** P1
- **Category:** Infrastructure
- **Description:** No alerting for errors, latency, or queue depth.
- **Root Cause:** No alerting rules or notification channels.
- **Concrete Fix:** Configure alerts in Grafana or Alertmanager.

#### FIND-046: No Database Backup Strategy
- **File:** Infrastructure configuration
- **Severity:** P1
- **Category:** Infrastructure
- **Description:** No automated database backups.
- **Root Cause:** No backup jobs or retention policies.
- **Concrete Fix:**
```bash
# Automated daily backup script
pg_dump -U postgres nova_db > /backups/nova_$(date +%Y%m%d).sql
# Retention: 30 days
find /backups -name 'nova_*.sql' -mtime +30 -delete
```

#### FIND-047: No Backup Testing
- **File:** Infrastructure configuration
- **Severity:** P1
- **Category:** Infrastructure
- **Description:** No quarterly restore tests to verify backup integrity.
- **Root Cause:** No backup validation process.
- **Concrete Fix:** Schedule quarterly restore drills.

#### FIND-048: No Infrastructure as Code
- **File:** Infrastructure configuration
- **Severity:** P1
- **Category:** Infrastructure
- **Description:** Infrastructure setup is manual, leading to configuration drift.
- **Root Cause:** No IaC tool (Terraform/Pulumi) used.
- **Concrete Fix:** Implement Terraform for all cloud resources.

#### FIND-049: Containers Running as Root
- **File:** Dockerfiles
- **Severity:** P1
- **Category:** Infrastructure
- **Description:** Containers run as root, enabling privilege escalation.
- **Root Cause:** No USER directive in Dockerfiles.
- **Concrete Fix:**
```dockerfile
# Dockerfile
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodejs -u 1001
USER nodejs
```

#### FIND-050: No Image Scanning
- **File:** Dockerfiles
- **Severity:** P1
- **Category:** Infrastructure
- **Description:** No vulnerability scanning for container images.
- **Root Cause:** No image scanning in CI/CD.
- **Concrete Fix:** Use Trivy or Snyk to scan images in CI pipeline.

---

### Mobile (Android Wakeword)

#### FIND-051: Wake Word Service Missing
- **File:** `apps/mobile/android/app/src/main/java/com/novalearn/wakeword/WakeWordService.java`
- **Severity:** P0
- **Category:** Mobile
- **Description:** No foreground service implementation for wake word detection.
- **Root Cause:** Service not implemented.
- **Concrete Fix:**
```java
// apps/mobile/android/app/src/main/java/com/novalearn/wakeword/WakeWordService.java
public class WakeWordService extends Service {
 @Override
 public void onCreate() {
 startForeground(NOTIFICATION_ID, createNotification());
 // Initialize SpeechRecognizer
 }
}
```

#### FIND-052: WakeWordManager Singleton Missing
- **File:** `apps/mobile/android/app/src/main/java/com/novalearn/wakeword/WakeWordManager.java`
- **Severity:** P0
- **Category:** Mobile
- **Description:** No centralized lifecycle management for wake word service.
- **Root Cause:** Singleton not implemented.
- **Concrete Fix:**
```java
// apps/mobile/android/app/src/main/java/com/novalearn/wakeword/WakeWordManager.java
public class WakeWordManager {
 private static WakeWordManager instance;
 public static synchronized WakeWordManager getInstance() {
 if (instance == null) instance = new WakeWordManager();
 return instance;
 }
 public void start() { /* Start service */ }
 public void stop() { /* Stop service */ }
}
```

#### FIND-053: Foreground Service Type Not Declared
- **File:** `apps/mobile/android/app/src/main/AndroidManifest.xml`
- **Severity:** P1
- **Category:** Mobile
- **Description:** Missing `android:foregroundServiceType="microphone"` for RECORD_AUDIO.
- **Root Cause:** Manifest not updated for Android 14+ requirements.
- **Concrete Fix:**
```xml
<!-- apps/mobile/android/app/src/main/AndroidManifest.xml -->
<service
 android:name=".WakeWordService"
 android:foregroundServiceType="microphone"
 android:exported="false" />
```

#### FIND-054: No Error Handling in SpeechRecognizer
- **File:** `apps/mobile/android/app/src/main/java/com/novalearn/wakeword/WakeWordService.java`
- **Severity:** P1
- **Category:** Mobile
- **Description:** Silent failures on recognition errors.
- **Root Cause:** No error callback implementation.
- **Concrete Fix:**
```java
// apps/mobile/android/app/src/main/java/com/novalearn/wakeword/WakeWordService.java
@Override
public void onError(int error) {
 switch (error) {
 case SpeechRecognizer.ERROR_SERVER:
 // Retry logic
 retryRecognition();
 break;
 case SpeechRecognizer.ERROR_NO_MATCH:
 // Restart listening
 startListening();
 break;
 default:
 notifyUser("Recognition error: " + error);
 }
}
```

#### FIND-055: Missing RECORD_AUDIO Permission
- **File:** `apps/mobile/android/app/src/main/AndroidManifest.xml`
- **Severity:** P1
- **Category:** Mobile
- **Description:** RECORD_AUDIO permission not declared in manifest.
- **Root Cause:** Permission missing from manifest.
- **Concrete Fix:**
```xml
<!-- apps/mobile/android/app/src/main/AndroidManifest.xml -->
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

#### FIND-056: No Partial Wake Lock
- **File:** `apps/mobile/android/app/src/main/java/com/novalearn/wakeword/WakeWordService.java`
- **Severity:** P1
- **Category:** Mobile
- **Description:** Service killed during CPU idle due to missing wake lock.
- **Root Cause:** No PARTIAL_WAKE_LOCK acquired.
- **Concrete Fix:**
```java
// apps/mobile/android/app/src/main/java/com/novalearn/wakeword/WakeWordService.java
PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NOVA:WakeWord");
wakeLock.acquire();
```

#### FIND-057: No Battery Optimization Exemption
- **File:** `apps/mobile/android/app/src/main/java/com/novalearn/wakeword/WakeWordService.java`
- **Severity:** P1
- **Category:** Mobile
- **Description:** Doze mode kills service without battery optimization exemption.
- **Root Cause:** No exemption request.
- **Concrete Fix:**
```java
// apps/mobile/android/app/src/main/java/com/novalearn/wakeword/WakeWordService.java
Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
intent.setData(Uri.parse("package:" + getPackageName()));
startActivity(intent);
```

#### FIND-058: Missing Package Declaration
- **File:** `apps/mobile/android/app/src/main/java/com/leadup/nova/BootReceiver.kt`
- **Severity:** P2
- **Category:** Mobile
- **Description:** Missing package declaration in BootReceiver.kt.
- **Root Cause:** File deleted but BroadcastReceiver still referenced.
- **Concrete Fix:**
```kotlin
// apps/mobile/android/app/src/main/java/com/leadup/nova/BootReceiver.kt
package com.leadup.nova
```

#### FIND-059: Min SDK 21 Too Low
- **File:** `apps/mobile/android/app/build.gradle`
- **Severity:** P2
- **Category:** Mobile
- **Description:** Min SDK 21 incompatible with modern SpeechRecognizer.
- **Root Cause:** Outdated SDK version.
- **Concrete Fix:**
```gradle
// apps/mobile/android/app/build.gradle
android {
 defaultConfig {
 minSdkVersion 26 // Android 8.0+
 }
}
```

#### FIND-060: No Flutter MethodChannel Bridge
- **File:** `apps/mobile/lib/services/wake_word_service.dart`
- **Severity:** P2
- **Category:** Mobile
- **Description:** No Flutter MethodChannel bridge to native wake word service.
- **Root Cause:** Platform channel not implemented.
- **Concrete Fix:**
```dart
// apps/mobile/lib/services/wake_word_service.dart
static const platform = MethodChannel('com.novalearn/wakeword');
Future<bool> start() => platform.invokeMethod('start');
Future<void> stop() => platform.invokeMethod('stop');
```

---

### Frontend (Admin App)

#### FIND-061: getServerEnv() Throws Raw Zod Errors
- **File:** `apps/admin/src/lib/env.ts`
- **Severity:** P0
- **Category:** Frontend
- **Description:** Unhandled zod errors can leak internal configuration.
- **Root Cause:** No error boundary for env validation.
- **Concrete Fix:**
```typescript
// apps/admin/src/lib/env.ts
try {
 return env.parse(process.env);
} catch (e) {
 console.error('[admin]', e);
 return new Response('Server configuration error', { status: 500 });
}
```

#### FIND-062: NEXT_PUBLIC_API_BASE Defaults to localhost
- **File:** `apps/admin/src/lib/env.ts`
- **Severity:** P0
- **Category:** Frontend
- **Description:** API base URL defaults to localhost in production.
- **Root Cause:** Missing env validation.
- **Concrete Fix:**
```typescript
// apps/admin/src/lib/env.ts
const PublicEnvSchema = z.object({
 NEXT_PUBLIC_API_BASE: z.string().url()
});
```

#### FIND-063: No CSRF Protection
- **File:** `apps/admin/src/lib/api.ts`
- **Severity:** P1
- **Category:** Frontend
- **Description:** Mutation requests lack CSRF token handling.
- **Root Cause:** Fetch wrapper doesn't include CSRF token.
- **Concrete Fix:**
```typescript
// apps/admin/src/lib/api.ts
async function fetchWithCSRF(url, opts) {
 const token = document.cookie.split('; ').find(r => r.startsWith('csrf_token='))?.split('=')[1];
 return fetch(url, {
 ...opts,
 headers: { ...opts.headers, 'X-CSRF-Token': token || '' },
 credentials: 'same-origin'
 });
}
```

#### FIND-064: Auth Guard Bypass
- **File:** `apps/admin/src/components/AdminAuthGuard.tsx`
- **Severity:** P1
- **Category:** Frontend
- **Description:** Auth guard at component level only; direct URL bypasses it.
- **Root Cause:** Guard not at routing layer.
- **Concrete Fix:**
```typescript
// apps/admin/src/middleware.ts
export function middleware(req) {
 const token = req.cookies.get('admin_session')?.value;
 if (!token) return NextResponse.redirect(new URL('/login', req.url));
 return NextResponse.next();
}
export const config = { matcher: ['/organizations/:path*', '/users/:path*', '/audit-logs/:path*'] };
```

#### FIND-065: Single Shared ADMIN_API_KEY
- **File:** `apps/admin/src/lib/env.ts`
- **Severity:** P1
- **Category:** Frontend
- **Description:** No per-admin identity; single API key grants full access.
- **Root Cause:** No RBAC implementation.
- **Concrete Fix:**
```typescript
// apps/admin/src/lib/env.ts
type AdminRole = 'superadmin' | 'admin' | 'viewer';
interface AdminSession {
 adminId: string;
 email: string;
 role: AdminRole;
 permissions: string[];
 issuedAt: number;
 expiresAt: number;
}
```

#### FIND-066: No Client-Side Validation
- **File:** `apps/admin/src/lib/api.ts`
- **Severity:** P1
- **Category:** Frontend
- **Description:** No client-side validation of API responses.
- **Root Cause:** No zod schema validation for responses.
- **Concrete Fix:**
```typescript
// apps/admin/src/lib/api.ts
const UserSchema = z.object({
 id: z.string().uuid(),
 email: z.string().email(),
 name: z.string(),
 role: z.enum(['user', 'admin', 'superadmin']),
 createdAt: z.string().datetime()
});
const parsed = UserSchema.safeParse(json);
```

#### FIND-067: No Retry Affordances
- **File:** `apps/admin/src/app/*/page.tsx`
- **Severity:** P1
- **Category:** Frontend
- **Description:** Error states are implicit; no retry buttons.
- **Root Cause:** Generic catch blocks without retry UI.
- **Concrete Fix:**
```typescript
// apps/admin/src/app/*/page.tsx
const [error, setError] = useState(null);
try {
 const data = await fetchData();
} catch (err) {
 setError({ code: err instanceof ApiError ? err.code : 'UNKNOWN', message: err instanceof Error ? err.message : 'Unknown' });
}
{error && <div role="alert"><p>{error.message}</p><button onClick={refetch}>Retry</button></div>}
```

#### FIND-068: No Cancellation Guards
- **File:** `apps/admin/src/app/*/page.tsx`
- **Severity:** P1
- **Category:** Frontend
- **Description:** Race conditions on fast navigation due to missing cancellation.
- **Root Cause:** No AbortController for in-flight fetches.
- **Concrete Fix:**
```typescript
// apps/admin/src/app/*/page.tsx
useEffect(() => {
 const controller = new AbortController();
 let cancelled = false;
 async function load() {
 try {
 const data = await fetch(url, { signal: controller.signal });
 if (!cancelled) setData(data);
 } catch (err) {
 if (!cancelled) setError(err);
 }
 }
 load();
 return () => { controller.abort(); cancelled = true; };
}, [url]);
```

#### FIND-069: No RBAC Implementation
- **File:** `apps/admin/src/lib/env.ts`
- **Severity:** P1
- **Category:** Frontend
- **Description:** No role-based access control; single API key grants full access.
- **Root Cause:** No permission model.
- **Concrete Fix:**
```typescript
// apps/admin/src/lib/env.ts
type Permission = 'users.read' | 'users.write' | 'users.delete' | 'orgs.read' | 'orgs.write' | 'orgs.delete';
function hasPermission(session: AdminSession, perm: Permission): boolean {
 return session.permissions.includes(perm);
}
```

#### FIND-070: No Audit Hook on Write Operations
- **File:** `apps/admin/src/app/audit-logs/page.tsx`
- **Severity:** P1
- **Category:** Frontend
- **Description:** Admin mutations are not audited.
- **Root Cause:** No audit logging for write operations.
- **Concrete Fix:**
```typescript
// apps/admin/src/app/audit-logs/page.tsx
export async function logAudit({ action, resourceType, resourceId, adminId, metadata }) {
 await fetch(`${BASE}/api/admin/audit-logs`, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ ...params, timestamp: new Date().toISOString() })
 });
}
```

#### FIND-071: Sidebar Lacks Accessibility
- **File:** `apps/admin/src/components/AdminSidebar.tsx`
- **Severity:** P2
- **Category:** Frontend
- **Description:** Missing aria-current and keyboard navigation.
- **Root Cause:** No accessibility attributes.
- **Concrete Fix:**
```tsx
// apps/admin/src/components/AdminSidebar.tsx
<Link href={item.href} aria-current={isActive(item.href) ? 'page' : undefined} className="focus-visible:ring-2 focus-visible:ring-offset-2">
 {item.label}
</Link>
```

#### FIND-072: No Skip-to-Content Link
- **File:** `apps/admin/src/app/layout.tsx`
- **Severity:** P2
- **Category:** Frontend
- **Description:** No skip-to-content link or landmark structure.
- **Root Cause:** Missing accessibility features.
- **Concrete Fix:**
```tsx
// apps/admin/src/app/layout.tsx
<a href="#main-content" className="skip-link">Skip to main content</a>
<main id="main-content" role="main">{children}</main>
```

#### FIND-073: No Data Fetch Deduplication
- **File:** `apps/admin/src/app/*/page.tsx`
- **Severity:** P2
- **Category:** Frontend
- **Description:** Each page mounts independent data-fetch with no deduplication.
- **Root Cause:** No caching layer for API requests.
- **Concrete Fix:**
```typescript
// apps/admin/src/app/*/page.tsx
export const getUsers = cache(async (page) => {
 const res = await fetch(`${BASE}/api/admin/users?page=${page}`);
 return res.json();
});
const data = await getUsers(page);
```

#### FIND-074: Large List Renders Lack Memoization
- **File:** `apps/admin/src/components/Skeleton.tsx`
- **Severity:** P2
- **Category:** Frontend
- **Description:** Parent re-renders cause all rows to re-render.
- **Root Cause:** No memoization for list items.
- **Concrete Fix:**
```typescript
// apps/admin/src/components/Skeleton.tsx
const UserRow = memo(function UserRow({ user }) {
 return <tr><td>{user.name}</td><td>{user.email}</td><td>{user.role}</td></tr>;
});
```

#### FIND-075: Catch Blocks Use Any-Typed Errors
- **File:** `apps/admin/src/app/*/page.tsx`
- **Severity:** P2
- **Category:** Frontend
- **Description:** Type information lost in catch blocks.
- **Root Cause:** No type guard for errors.
- **Concrete Fix:**
```typescript
// apps/admin/src/app/*/page.tsx
function isApiError(err: unknown): err is ApiError {
 return typeof err === 'object' && err !== null && 'code' in err;
}
try {
 await fetchData();
} catch (err) {
 if (isApiError(err)) {
 console.error(err.code, err.message);
 } else if (err instanceof Error) {
 console.error(err.message);
 }
}
```

#### FIND-076: No Shared API Response Types
- **File:** `apps/admin/src/lib/api.ts`
- **Severity:** P2
- **Category:** Frontend
- **Description:** Type drift per page due to missing shared types.
- **Root Cause:** No shared API response interface.
- **Concrete Fix:**
```typescript
// apps/admin/src/lib/api.ts
export interface ApiResponse<T> {
 data: T;
 meta: { total: number; page: number; pageSize: number };
}
export interface User {
 id: string;
 email: string;
 name: string;
 role: 'user' | 'admin' | 'superadmin';
 createdAt: string;
}
```

#### FIND-077: Admin State Not Serialized to URL
- **File:** `apps/admin/src/app/*/page.tsx`
- **Severity:** P2
- **Category:** Frontend
- **Description:** Refreshing loses context (filters, pagination).
- **Root Cause:** State not in URL query params.
- **Concrete Fix:**
```typescript
// apps/admin/src/app/*/page.tsx
const searchParams = useSearchParams();
const orgFilter = searchParams.get('org') || '';
const setOrgFilter = (org) => {
 const params = new URLSearchParams(searchParams);
 if (org) params.set('org', org); else params.delete('org');
 router.push('?' + params);
};
```

#### FIND-078: Error Boundary Coverage Unclear
- **File:** `apps/admin/src/components/ErrorBoundary.tsx`
- **Severity:** P2
- **Category:** Frontend
- **Description:** Error boundary may not wrap all route segments.
- **Root Cause:** No layout-level error boundaries.
- **Concrete Fix:**
```tsx
// app/organizations/layout.tsx
export default function Layout({ children }) {
 return <ErrorBoundary fallback={<p>Organizations error.</p>}>{children}</ErrorBoundary>;
}
```

#### FIND-079: No Pagination
- **File:** `apps/admin/src/app/organizations/page.tsx, users/page.tsx`
- **Severity:** P2
- **Category:** Frontend
- **Description:** Large datasets load entirely, causing slow renders.
- **Root Cause:** No pagination implementation.
- **Concrete Fix:**
```typescript
// apps/admin/src/app/organizations/page.tsx
async function getUsers(page = 1, pageSize = 25) {
 const res = await fetch(`${BASE}/api/admin/users?page=${page}&pageSize=${pageSize}`, {
 next: { tags: ['users'] }
 });
 return res.json();
}
<nav>
 <button disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</button>
 <span>Page {page} of {total}</span>
 <button disabled={page === total} onClick={() => setPage(p => p + 1)}>Next</button>
</nav>
```

#### FIND-080: No Filtering UI
- **File:** `apps/admin/src/app/organizations/page.tsx, users/page.tsx`
- **Severity:** P2
- **Category:** Frontend
- **Description:** No search, status filter, or date-range filter.
- **Root Cause:** No filter state or UI components.
- **Concrete Fix:**
```typescript
// apps/admin/src/app/organizations/page.tsx
const [search, setSearch] = useState('');
const debounced = useDebounce(search, 300);
useEffect(() => {
 const params = new URLSearchParams();
 if (debounced) params.set('q', debounced);
 router.push('?' + params);
}, [debounced]);
```

#### FIND-081: No Bulk Actions
- **File:** `apps/admin/src/app/users/page.tsx, organizations/page.tsx`
- **Severity:** P2
- **Category:** Frontend
- **Description:** Single-item operations only; no multi-select.
- **Root Cause:** No bulk action UI or logic.
- **Concrete Fix:**
```typescript
// apps/admin/src/app/users/page.tsx
const [selectedIds, setSelectedIds] = useState(new Set());
const toggle = (id) => {
 setSelectedIds(prev => {
 const next = new Set(prev);
 next.has(id) ? next.delete(id) : next.add(id);
 return next;
 });
};
const bulkDelete = async () => {
 await Promise.all(Array.from(selectedIds).map(deleteUser));
 setSelectedIds(new Set());
 refetch();
};
```

#### FIND-082: No Export/Download for Audit Logs
- **File:** `apps/admin/src/app/audit-logs/page.tsx`
- **Severity:** P2
- **Category:** Frontend
- **Description:** No CSV export for audit logs or usage data.
- **Root Cause:** No export functionality.
- **Concrete Fix:**
```typescript
// apps/admin/src/app/audit-logs/page.tsx
export function exportToCSV(data, filename) {
 if (!data.length) return;
 const headers = Object.keys(data[0]);
 const rows = data.map(i => headers.map(h => JSON.stringify(i[h] ?? '')).join(','));
 const csv = [headers.join(','), ...rows].join('\n');
 const blob = new Blob([csv], { type: 'text/csv' });
 const url = URL.createObjectURL(blob);
 const a = document.createElement('a');
 a.href = url;
 a.download = `${filename}-${Date.now()}.csv`;
 a.click();
 URL.revokeObjectURL(url);
}
```

---

### Backend

#### FIND-083: No Notification Service Implementation
- **File:** `services/notification-service/`
- **Severity:** P1
- **Category:** Backend
- **Description:** Notification service does not exist.
- **Root Cause:** Service never created.
- **Concrete Fix:** Create service with Express, Redis queue, and template engine.

#### FIND-084: No Entry Point for Notification Service
- **File:** `services/notification-service/src/index.ts`
- **Severity:** P0
- **Category:** Backend
- **Description:** No bootable entry point.
- **Root Cause:** Service not implemented.
- **Concrete Fix:**
```typescript
// services/notification-service/src/index.ts
import express from 'express';
const app = express();
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(3000, () => console.log('Notification service running'));
```

#### FIND-085: No Message Queue Integration
- **File:** `services/notification-service/src/queues/processor.ts`
- **Severity:** P1
- **Category:** Backend
- **Description:** No Bull/BullMQ for async processing.
- **Root Cause:** Queue not configured.
- **Concrete Fix:**
```typescript
// services/notification-service/src/queues/processor.ts
import { Queue } from 'bullmq';
const queue = new Queue('notifications', {
 redis: { host: 'localhost', port: 6379 }
});
```

#### FIND-086: No Template Engine
- **File:** `services/notification-service/src/templates/`
- **Severity:** P1
- **Category:** Backend
- **Description:** No template engine for notification content.
- **Root Cause:** Templates not implemented.
- **Concrete Fix:**
```typescript
// services/notification-service/src/templates/index.ts
import Handlebars from 'handlebars';
const template = Handlebars.compile('<p>Hello {{name}}</p>');
const html = template({ name: 'User' });
```

#### FIND-087: No Provider Abstraction
- **File:** `services/notification-service/src/providers/`
- **Severity:** P1
- **Category:** Backend
- **Description:** Cannot swap email/SMS/push providers.
- **Root Cause:** No provider interface.
- **Concrete Fix:**
```typescript
// services/notification-service/src/providers/index.ts
interface NotificationProvider {
 send(to: string, template: string, data: any): Promise<void>;
}
class EmailProvider implements NotificationProvider {
 async send(to, template, data) { /* Send email */ }
}
class SMSProvider implements NotificationProvider {
 async send(to, template, data) { /* Send SMS */ }
}
```

#### FIND-088: No Email Provider
- **File:** `services/notification-service/src/providers/email.provider.ts`
- **Severity:** P1
- **Category:** Backend
- **Description:** Cannot send emails.
- **Root Cause:** Email provider not implemented.
- **Concrete Fix:**
```typescript
// services/notification-service/src/providers/email.provider.ts
import nodemailer from 'nodemailer';
const transporter = nodemailer.createTransport({
 host: process.env.SMTP_HOST,
 port: 587,
 auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
await transporter.sendMail({ from, to, subject, html });
```

#### FIND-089: No SMS Provider
- **File:** `services/notification-service/src/providers/sms.provider.ts`
- **Severity:** P1
- **Category:** Backend
- **Description:** Cannot send SMS.
- **Root Cause:** SMS provider not implemented.
- **Concrete Fix:**
```typescript
// services/notification-service/src/providers/sms.provider.ts
import twilio from 'twilio';
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
await client.messages.create({ body, from, to });
```

#### FIND-090: No Push Notification Provider
- **File:** `services/notification-service/src/providers/push.provider.ts`
- **Severity:** P1
- **Category:** Backend
- **Description:** No FCM/APNS integration.
- **Root Cause:** Push provider not implemented.
- **Concrete Fix:**
```typescript
// services/notification-service/src/providers/push.provider.ts
import admin from 'firebase-admin';
const message = { notification: { title, body }, token: deviceToken };
await admin.messaging().send(message);
```

#### FIND-091: No REST API for Notifications
- **File:** `services/notification-service/src/routes/notifications.ts`
- **Severity:** P1
- **Category:** Backend
- **Description:** No way to trigger notifications from other services.
- **Root Cause:** REST API not implemented.
- **Concrete Fix:**
```typescript
// services/notification-service/src/routes/notifications.ts
router.post('/send', async (req, res) => {
 const { to, template, channel } = req.body;
 await queue.add('send', { to, template, channel });
 res.json({ status: 'queued' });
});
```

#### FIND-092: No Retry Logic
- **File:** `services/notification-service/src/queues/processor.ts`
- **Severity:** P1
- **Category:** Backend
- **Description:** Failed notifications dropped without retry.
- **Root Cause:** No retry configuration.
- **Concrete Fix:**
```typescript
// services/notification-service/src/queues/processor.ts
queue.add('notifications', msg, {
 attempts: 3,
 backoff: { type: 'exponential', delay: 1000 }
});
```

#### FIND-093: No Structured Logging
- **File:** `services/notification-service/src/utils/logger.ts`
- **Severity:** P2
- **Category:** Backend
- **Description:** No structured logging for delivery status.
- **Root Cause:** Logger not implemented.
- **Concrete Fix:**
```typescript
// services/notification-service/src/utils/logger.ts
logger.info({ notificationId, channel, status: 'sent', recipient: to });
```

#### FIND-094: No Metrics on Queue
- **File:** `services/notification-service/src/queues/metrics.ts`
- **Severity:** P2
- **Category:** Backend
- **Description:** No metrics on queue depth, processing time, failure rate.
- **Root Cause:** No Prometheus client configured.
- **Concrete Fix:**
```typescript
// services/notification-service/src/queues/metrics.ts
promClient.histogram('notification_process_seconds', buckets, labelNames);
```

---

### Architecture

#### FIND-095: No Dead Letter Queue for Notifications
- **File:** `services/notification-service/src/queues/dlq.ts`
- **Severity:** P1
- **Category:** Architecture
- **Description:** No DLQ for permanently failed notifications.
- **Root Cause:** DLQ not configured.
- **Concrete Fix:**
```typescript
// services/notification-service/src/queues/dlq.ts
const dlq = new Queue('notifications-dlq', {
 redis: { host: 'localhost', port: 6379 }
});
```

#### FIND-096: No Automated Dependency Updates
- **File:** Repository root
- **Severity:** P2
- **Category:** Architecture
- **Description:** Stale dependencies with no automated updates.
- **Root Cause:** Dependabot not enabled.
- **Concrete Fix:** Enable Dependabot in GitHub settings.

#### FIND-097: No Deployment Rollback Strategy
- **File:** CI/CD configuration
- **Severity:** P2
- **Category:** Architecture
- **Description:** Failed deployments require manual fix.
- **Root Cause:** No blue-green or rolling deployment.
- **Concrete Fix:** Implement blue-green deployment with automated rollback.

#### FIND-098: No Distributed Tracing
- **File:** Infrastructure configuration
- **Severity:** P2
- **Category:** Architecture
- **Description:** Cannot trace requests across services.
- **Root Cause:** OpenTelemetry not configured.
- **Concrete Fix:** Implement OpenTelemetry with Jaeger or Zipkin.

#### FIND-099: No Point-in-Time Recovery
- **File:** Database configuration
- **Severity:** P2
- **Category:** Architecture
- **Description:** Cannot recover to specific moment.
- **Root Cause:** WAL archiving not enabled.
- **Concrete Fix:** Enable WAL archiving in PostgreSQL.

#### FIND-100: No Environment Parity
- **File:** Infrastructure configuration
- **Severity:** P2
- **Category:** Architecture
- **Description:** Dev/prod drift due to different configurations.
- **Root Cause:** No same compose files with env overlays.
- **Concrete Fix:** Use same docker-compose.yml with `.env.dev`, `.env.prod` overlays.

#### FIND-101: No Read-Only Root Filesystem
- **File:** Dockerfiles
- **Severity:** P2
- **Category:** Architecture
- **Description:** Containers have writable root filesystem.
- **Root Cause:** No read-only rootfs + tmpfs configuration.
- **Concrete Fix:**
```yaml
# docker-compose.prod.yml
services:
 api:
 read_only: true
 tmpfs: ['/tmp']
```

---

## Quick Reference Table

| ID | Category | Severity | File | Summary |
|----|----------|----------|------|---------|
| FIND-001 | Security | P0 | auth.ts | JWT "none" algorithm bypass |
| FIND-002 | Security | P0 | auth.ts | Hardcoded JWT secret |
| FIND-003 | Security | P0 | auth.routes.ts | No refresh token rotation |
| FIND-004 | Security | P0 | auth.routes.ts | Password reset token in URL |
| FIND-005 | Security | P0 | instances.ts | IDOR - workflow instance access |
| FIND-006 | Security | P0 | agents.ts | IDOR - voice agent access |
| FIND-007 | Security | P0 | auth-guard.ts | WebSocket auth race condition |
| FIND-008 | Security | P1 | password.service.ts | Weak bcrypt rounds |
| FIND-009 | Security | P0 | schema.ts | PII stored unencrypted |
| FIND-010 | Security | P1 | cors.ts | CSRF vulnerability |
| FIND-011 | Security | P1 | cors.ts | CORS allows any origin |
| FIND-012 | Security | P1 | rate-limit.ts | No rate limiting on auth |
| FIND-013 | Security | P2 | error-handler.ts | Error handler leaks stack traces |
| FIND-014 | Security | P2 | helmet.ts | Missing security headers |
| FIND-015 | Security | P2 | server.ts | No HTTPS enforcement |
| FIND-016 | Security | P1 | auth.ts | JWT tokens never revoked |
| FIND-017 | Security | P1 | auth.ts | Missing input sanitization |
| FIND-018 | Security | P1 | webhooks.ts | No webhook signature verification |
| FIND-019 | Security | P2 | engine.ts | Workflow execution without timeout |
| FIND-020 | Security | P2 | index.ts | Database connection string in logs |
| FIND-021 | Security | P2 | auth.ts | No MFA support |
| FIND-022 | Security | P1 | upload.ts | File upload without validation |
| FIND-023 | Security | P1 | admin.ts | Admin endpoints not restricted |
| FIND-024 | Security | P2 | index.ts | No WebSocket rate limiting |
| FIND-025 | Security | P2 | index.ts | No request ID for tracing |
| FIND-026 | Security | P2 | rate-limit.ts | Rate limiter uses memory store |
| FIND-027 | Security | P2 | auth.ts | Token expiry too long |
| FIND-028 | Security | P1 | processor.ts | No dead letter queue |
| FIND-029 | Security | P2 | worker.ts | Queue worker without concurrency limit |
| F-001 | Mobile | P2 | BootReceiver.kt | Missing package declaration |
| F-002 | Mobile | P1 | AndroidManifest.xml | Foreground service type not declared |
| F-003 | Mobile | P0 | WakeWordService.java | Wake word service missing |
| F-004 | Mobile | P0 | WakeWordManager.java | WakeWordManager singleton missing |
| F-005 | Mobile | P1 | WakeWordService.java | No error handling in SpeechRecognizer |
| F-006 | Mobile | P1 | AndroidManifest.xml | Missing RECORD_AUDIO permission |
| F-007 | Mobile | P2 | build.gradle | Min SDK 21 too low |
| F-008 | Mobile | P2 | wake_word_service.dart | No Flutter MethodChannel bridge |
| F-009 | Mobile | P1 | WakeWordService.java | No partial wake lock |
| F-010 | Mobile | P1 | WakeWordService.java | No battery optimization exemption |
| F-011 | Mobile | P1 | AndroidManifest.xml | Missing POST_NOTIFICATIONS permission |
| CF-001 | Backend | P1 | notification-service/ | Notification service does not exist |
| CF-002 | Backend | P0 | index.ts | No entry point |
| CF-003 | Backend | P1 | processor.ts | No message queue integration |
| CF-004 | Backend | P1 | templates/ | No template engine |
| CF-005 | Backend | P1 | providers/ | No provider abstraction |
| CF-006 | Backend | P1 | email.provider.ts | No email provider |
| CF-007 | Backend | P1 | sms.provider.ts | No SMS provider |
| CF-008 | Backend | P1 | push.provider.ts | No push notification provider |
| CF-009 | Backend | P1 | notifications.ts | No REST API |
| CF-010 | Backend | P1 | processor.ts | No retry logic |
| CF-011 | Backend | P1 | dlq.ts | No dead letter queue |
| CF-012 | Backend | P2 | logger.ts | No structured logging |
| CF-013 | Backend | P2 | metrics.ts | No metrics |
| B-001 | Infrastructure | P0 | Dockerfile | No Dockerfile for notification-service |
| B-002 | Infrastructure | P0 | index.ts | No health check endpoints |
| B-003 | Infrastructure | P0 | docker-compose.prod.yml | Missing resource limits |
| B-004 | Infrastructure | P0 | .env files | No secrets management |
| B-005 | Infrastructure | P1 | redis.conf | Redis not configured with password |
| B-006 | Infrastructure | P1 | .github/workflows/ | No CI/CD pipeline |
| B-007 | Infrastructure | P1 | CI/CD | No automated security scanning |
| B-008 | Infrastructure | P2 | CI/CD | No automated dependency updates |
| B-009 | Infrastructure | P2 | CI/CD | No deployment rollback strategy |
| B-010 | Infrastructure | P1 | Logging | No centralized logging |
| B-011 | Infrastructure | P1 | Metrics | No metrics collection |
| B-012 | Infrastructure | P1 | Alerting | No alerting configured |
| B-013 | Infrastructure | P2 | Tracing | No distributed tracing |
| B-014 | Infrastructure | P1 | Database | No database backup strategy |
| B-015 | Infrastructure | P1 | Backups | No backup testing |
| B-016 | Infrastructure | P2 | Database | No point-in-time recovery |
| B-017 | Infrastructure | P1 | IaC | No infrastructure as code |
| B-018 | Infrastructure | P2 | IaC | No environment parity |
| B-019 | Infrastructure | P1 | Dockerfiles | Containers running as root |
| B-020 | Infrastructure | P1 | Dockerfiles | No image scanning |
| B-021 | Infrastructure | P2 | Dockerfiles | No read-only root filesystem |
| ADM-001 | Frontend | P0 | env.ts | getServerEnv() throws raw zod errors |
| ADM-002 | Frontend | P0 | env.ts | NEXT_PUBLIC_API_BASE defaults to localhost |
| ADM-003 | Frontend | P1 | api.ts | No CSRF protection |
| ADM-004 | Frontend | P1 | AdminAuthGuard.tsx | Auth guard component-level only |
| ADM-005 | Frontend | P1 | env.ts | Single shared ADMIN_API_KEY |
| ADM-006 | Frontend | P1 | api.ts | No client-side validation |
| ADM-007 | Frontend | P1 | page.tsx | No retry affordances |
| ADM-008 | Frontend | P1 | page.tsx | No cancellation guards |
| ADM-009 | Frontend | P2 | AdminSidebar.tsx | Sidebar lacks aria-current |
| ADM-010 | Frontend | P2 | layout.tsx | No skip-to-content link |
| ADM-011 | Frontend | P2 | page.tsx | No data-fetch deduplication |
| ADM-012 | Frontend | P2 | Skeleton.tsx | Large list renders lack memoization |
| ADM-013 | Frontend | P2 | page.tsx | Catch blocks use any-typed errors |
| ADM-014 | Frontend | P2 | api.ts | No shared API response types |
| ADM-015 | Frontend | P2 | page.tsx | Admin state not serialized to URL |
| ADM-016 | Frontend | P2 | ErrorBoundary.tsx | Error boundary coverage unclear |
| ADM-017 | Frontend | P2 | page.tsx | No pagination |
| ADM-018 | Frontend | P2 | page.tsx | No filtering UI |
| ADM-019 | Frontend | P1 | env.ts | No RBAC |
| ADM-020 | Frontend | P1 | audit-logs/page.tsx | No audit hook on write operations |
| ADM-021 | Frontend | P2 | page.tsx | No bulk actions |
| ADM-022 | Frontend | P2 | audit-logs/page.tsx | No export/download |

---

## Implementation Roadmap

### Phase 1: Critical Security Fixes (Week 1-2)
**Goal:** Address P0 vulnerabilities that pose immediate risk.

**Parallel Workstreams:**
1. **Auth Service Security** (2 engineers)
 - FIND-001: JWT "none" algorithm bypass
 - FIND-002: Hardcoded JWT secret
 - FIND-003: No refresh token rotation
 - FIND-004: Password reset token in URL
 - FIND-007: WebSocket auth race condition

2. **API Security** (2 engineers)
 - FIND-005: IDOR - workflow instances
 - FIND-006: IDOR - voice agents
 - FIND-009: PII unencrypted
 - FIND-023: Admin endpoints not restricted

3. **Infrastructure** (1 engineer)
 - FIND-037: No health check endpoints
 - B-004: No secrets management

**Deliverables:**
- All P0 security findings resolved
- Security audit passed
- Penetration test scheduled

### Phase 2: High-Priority Fixes (Week 3-4)
**Goal:** Address P1 vulnerabilities and missing core services.

**Parallel Workstreams:**
1. **Notification Service** (2 engineers)
 - CF-001 through CF-013: Complete notification service implementation
 - B-001: Dockerfile for notification service

2. **Auth Hardening** (1 engineer)
 - FIND-008: Weak bcrypt rounds
 - FIND-012: No rate limiting on auth
 - FIND-016: JWT tokens never revoked
 - FIND-017: Missing input sanitization
 - FIND-018: No webhook signature verification
 - FIND-021: No MFA support
 - FIND-022: File upload without validation
 - FIND-028: No dead letter queue

3. **Admin App Security** (1 engineer)
 - ADM-001: Raw zod errors
 - ADM-002: API base defaults to localhost
 - ADM-003: No CSRF protection
 - ADM-004: Auth guard bypass
 - ADM-005: Single API key
 - ADM-019: No RBAC
 - ADM-020: No audit hook

4. **Infrastructure** (1 engineer)
 - B-002: Resource limits in docker-compose
 - B-005: Redis password
 - B-006: CI/CD pipeline
 - B-010: Centralized logging
 - B-011: Metrics collection
 - B-014: Database backup strategy

**Deliverables:**
- Notification service operational
- All P1 security findings resolved
- CI/CD pipeline deployed
- Monitoring stack operational

### Phase 3: Medium-Priority Fixes (Week 5-8)
**Goal:** Address P2 findings and improve overall system quality.

**Parallel Workstreams:**
1. **Security Hardening** (1 engineer)
 - FIND-013: Error handler leaks
 - FIND-014: Missing security headers
 - FIND-015: No HTTPS enforcement
 - FIND-019: Workflow timeout
 - FIND-020: Connection string in logs
 - FIND-024: WebSocket rate limiting
 - FIND-025: No request ID
 - FIND-026: Memory store rate limiter
 - FIND-027: Token expiry too long
 - FIND-029: Queue worker concurrency

2. **Android Wake Word** (1 engineer)
 - F-003: Wake word service
 - F-004: WakeWordManager singleton
 - F-002: Foreground service type
 - F-005: Error handling
 - F-006: RECORD_AUDIO permission
 - F-009: Partial wake lock
 - F-010: Battery optimization
 - F-011: POST_NOTIFICATIONS permission

3. **Admin App Improvements** (1 engineer)
 - ADM-006 through ADM-022: All P2 frontend findings

4. **Infrastructure** (1 engineer)
 - B-007: Automated security scanning
 - B-013: Distributed tracing
 - B-015: Backup testing
 - B-017: Infrastructure as code
 - B-019: Containers running as root
 - B-020: Image scanning

**Deliverables:**
- All P2 findings resolved
- Android wake word feature complete
- Admin app production-ready
- Infrastructure as code deployed

### Phase 4: Best Practices & Technical Debt (Week 9-12)
**Goal:** Address remaining P3 findings and implement best practices.

**Parallel Workstreams:**
1. **Documentation & Testing**
 - API documentation
 - Integration tests
 - E2E tests

2. **Performance Optimization**
 - Caching strategy
 - Database query optimization
 - CDN for static assets

3. **Operational Excellence**
 - Runbooks for common issues
 - Incident response plan
 - On-call rotation

**Deliverables:**
- Comprehensive test suite
- Full documentation
- Operational runbooks

---

## Risk Matrix

| Severity | Exploitability | Impact | Examples |
|----------|---------------|--------|----------|
| **P0** | Easy | Critical | JWT bypass, IDOR, hardcoded secrets |
| **P1** | Moderate | High | No rate limiting, missing auth checks, incomplete services |
| **P2** | Hard | Medium | Missing headers, weak cryptography, no monitoring |
| **P3** | Difficult | Low | Code quality, documentation, minor improvements |

---

## Compliance & Regulatory Considerations

### GDPR / Data Protection
- **FIND-009**: PII stored unencrypted violates GDPR Article 32 (security of processing)
- **FIND-004**: Password reset token in URL violates GDPR Article 5 (data minimization)
- **FIND-020**: Database credentials in logs violates GDPR Article 32

### SOC 2 / Security Controls
- **FIND-002**: Hardcoded secrets violate SOC 2 CC6.1 (logical access controls)
- **B-004**: No secrets management violates SOC 2 CC6.1
- **B-014**: No backup strategy violates SOC 2 A1.2 (data backup)

### OWASP Top 10
- **FIND-001, FIND-007**: Broken authentication (A02)
- **FIND-005, FIND-006**: Broken access control (A01)
- **FIND-017, FIND-022**: Injection (A03)
- **FIND-010, FIND-011**: Cryptographic failures (A02)
- **FIND-013**: Security misconfiguration (A05)

---

## Recommendations

### Immediate Actions (This Week)
1. **Rotate all credentials** - JWT secrets, API keys, database passwords
2. **Deploy JWT algorithm validation** - Block "none" algorithm
3. **Add ownership checks** - Fix IDOR vulnerabilities
4. **Enable HTTPS** - Redirect all HTTP to HTTPS
5. **Add rate limiting** - Protect authentication endpoints

### Short-Term Actions (Next 2 Weeks)
1. **Implement notification service** - Complete CF-001 through CF-013
2. **Set up CI/CD** - Automate builds and deployments
3. **Configure monitoring** - Deploy Prometheus + Grafana
4. **Enable database backups** - Automated daily backups
5. **Implement MFA** - Add TOTP support

### Medium-Term Actions (Next Month)
1. **Complete Android wake word** - Fix F-001 through F-011
2. **Implement RBAC** - Role-based access control for admin app
3. **Add distributed tracing** - OpenTelemetry across services
4. **Container security** - Non-root users, image scanning
5. **Infrastructure as code** - Terraform for all resources

### Long-Term Actions (Next Quarter)
1. **Security audit** - Third-party penetration test
2. **Compliance certification** - SOC 2, GDPR audit
3. **Disaster recovery** - RTO/RPO testing
4. **Performance optimization** - Caching, query optimization
5. **Developer experience** - Better tooling, documentation

---

## Appendix: Agent Status

| Agent | Status | Findings |
|-------|--------|----------|
| Security Auditor | Responded | 29 findings |
| Backend Analyzer-2 | Responded | 21 findings |
| Analyze-Admin | Responded | 22 findings |
| Fix-Android-Wakeword | Responded | 11 findings |
| Create-Notifications | Responded | 13 findings |
| **Other Agents** | **PENDING** | **Awaiting input** |

### Pending Agent Input
The following agents have not yet provided findings:
- ai-services-analyzer
- analyze-api
- analyze-database
- analyze-mobile
- audit-root-infra
- audit-shared-packages
- communication-services-analyzer
- core-services-analyzer
- database-analyzer
- fix-api-middleware
- fix-auth-context
- fix-dark-mode
- fix-monitoring
- fix-onboarding
- fix-realtime-gw
- frontend-analyzer
- frontend-analyzer-2
- packages-analyzer
- scout-api-admin
- scout-auth
- scout-database-config
- scout-docs-tests
- scout-mobile
- scout-mobile-2
- scout-mobile-admin
- scout-monitoring
- scout-plugins
- scout-realtime
- scout-root-structure
- scout-structure
- security-auditor-2
- synthesize-report
- why-ruflo-server
- worker-services-analyzer

**Action Required:** Request findings from pending agents to complete the audit.

---

## Conclusion

The NOVA-Leadup monorepo has **96 findings** requiring attention, with **17 critical (P0)** issues that pose immediate security and operational risks. The most urgent concerns are:

1. **Authentication vulnerabilities** (JWT bypass, hardcoded secrets, IDOR)
2. **Missing core services** (notification service incomplete)
3. **Infrastructure gaps** (no CI/CD, no monitoring, no backups)
4. **Data protection failures** (unencrypted PII, leaked credentials)

**Recommendation:** Execute Phase 1 immediately to address P0 findings, then proceed with Phase 2 for high-priority fixes. Complete the audit by gathering input from pending agents.

**Next Steps:**
1. Review this report with the security team
2. Prioritize findings in sprint planning
3. Assign engineers to parallel workstreams
4. Begin Phase 1 implementation
5. Schedule follow-up audit in 3 months

---

*Report compiled by Audit Report Compiler*
*Date: 2026-09-11*
*Version: 1.0*
