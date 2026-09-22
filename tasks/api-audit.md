# NOVA-Leadup API Server Audit

**Date:** 2026-09-15
**Auditor:** Claude Code (automated)
**Scope:** `/services/api/` — the primary Express.js backend for the NOVA-Leadup monorepo

---

## 1. Project Structure & Entry Points

| Item | Detail |
|---|---|
| **Framework** | Express.js (TypeScript) |
| **Root** | `/services/api/` |
| **Entry point** | `src/server.ts` |
| **Package manager** | pnpm workspaces (monorepo) |
| **Docker** | Multi-stage Dockerfile, deployed via `docker-compose.yml` |
| **Port** | 3001 (production: `127.0.0.1:3001:3001`) |
| **Node target** | ESM modules (`.js` extensions in imports) |

### Key files
- `/services/api/src/server.ts` — App bootstrap, middleware registration, route mounting
- `/services/api/src/routes/` — Route definitions (20+ route files)
- `/services/api/src/middleware/` — Auth, validation, error handling, security
- `/services/api/src/services/` — Business logic (AI, memory, STT, TTS, notifications, tools)
- `/services/api/src/utils/` — Logger, pagination, env validation, health checks
- `/services/api/src/schemas/` — Zod validation schemas for all endpoints

---

## 2. Route Handlers & Controllers

### Implemented Routes (from `server.ts`)

| Prefix | Description | Auth Required |
|---|---|---|
| `/health` | Health check (uses `health.ts` utility) | No |
| `/api/auth/*` | Register, login, logout, refresh, forgot/reset password, verify email | Mixed |
| `/api/conversations/*` | CRUD for conversations, message sending, summary | Yes |
| `/api/memories/*` | CRUD, search, filter, confidence updates, merge | Yes |
| `/api/call-logs/*` | CRUD for call logs, search, summary generation | Yes |
| `/api/leads/*` | CRUD, status transitions, search, export | Yes |
| `/api/tasks/*` | CRUD, status updates, assignee changes, filtering | Yes |
| `/api/notifications/*` | List, mark read, mark all read, delete | Yes |
| `/api/profile/*` | Get/update profile, avatar upload | Yes |
| `/api/persona/*` | Get/update AI persona config | Yes |
| `/api/companion/*` | Companion mode, wake word, notification filters | Yes |
| `/api/privacy/*` | Privacy preferences (recordings, transcripts, local processing) | Yes |
| `/api/ai/*` | Summarize, embed, available models, usage stats | Yes |
| `/api/admin/*` | Audit logs, users, incidents, feature flags, usage stats | Admin |
| `/api/settings/*` | Get/update app settings | Admin |
| `/api/tools/*` | Tool calling, validation, availability | Yes |
| `/api/organizations/*` | Organization CRUD, members, invites | Yes |
| `/api/webhooks/*` | Webhook handlers (deepgram, twilio, sarvam, etc.) | No (signature-verified) |

### Route Registration Pattern
Routes are registered via a chainable `RouteGroup` API in `server.ts`:
```typescript
const api = new RouteGroup(app, '/api');
api.group(authRoutes);
api.group(conversationRoutes);
// ... etc
```
Auth middleware is applied per-group, not globally.

---

## 3. Authentication & Authorization

### Auth Stack
- **Primary:** Auth0 integration (`AUTH0_ISSUER`, `AUTH0_AUDIENCE`, `AUTH0_JWKS_URI`)
- **Gateway auth:** ED25519 keypair (`NOVA_PRIVATE_KEY_PATH`, `NOVA_PUBLIC_KEY_PATH`)
- **Gateway shared secret:** `NOVA_GATEWAY_SHARED_SECRET` (for internal service-to-service)
- **JWT refresh tokens:** Separate `JWT_REFRESH_SECRET` from access token secret

### Middleware Stack
1. `authMiddleware()` — Validates Auth0 JWT tokens, attaches user to `req`
2. `requireAuth()` — Rejects unauthenticated requests
3. `requireAdmin()` — Role-based access control for admin routes
4. `optionalAuth()` — Allows anonymous access but attaches user if present

### JWT Configuration
- Access tokens: `JWT_SECRET` (min 32 chars required)
- Refresh tokens: `JWT_REFRESH_SECRET` (separate secret)
- Both validated in `validateEnv.ts` (length check, fallback secret detection)

### Current Auth Issues (from existing memory)
- **CRITICAL:** Unsigned JWT in `workflow-engine` service (separate service, not in `services/api/`)
- **HIGH:** No token revocation mechanism
- **HIGH:** Race condition in token refresh
- **MEDIUM:** Rate limiting applied AFTER auth in some routes

---

## 4. Database & ORM

### Stack
- **ORM:** Prisma (type-safe queries)
- **Database:** PostgreSQL 16 (with pgvector extension for AI embeddings)
- **Redis:** Redis 7 (caching, sessions, rate limiting)
- **Migrations:** Prisma migrations (`schema.prisma`)

### Connection
- Primary: `DATABASE_URL` (required)
- Dev pgvector: `NOVA_DB_PASSWORD` on port 5433
- Redis: `REDIS_URL`

### Docker Compose
- PostgreSQL with healthcheck (`pg_isready`)
- Redis 7 Alpine
- API depends on both being healthy before starting
- Data persisted in Docker volumes (`postgres_data`, `redis_data`)

---

## 5. Third-Party Service Integrations

### AI Providers (`services/ai.ts`)
| Provider | Purpose | Config |
|---|---|---|
| **Anthropic (Claude)** | Primary chat completions | `ANTHROPIC_API_KEY` or `BROCODE_API_KEY` + `ANTHROPIC_BASE_URL` |
| **OpenAI** | Fallback chat + embeddings | `OPENAI_API_KEY` (lazy-loaded) |
| **Deepgram** | Speech-to-text (English default) | `DEEPGRAM_API_KEY` |
| **ElevenLabs** | Text-to-speech (English default) | `ELEVENLABS_API_KEY` |
| **Google** | TTS/STT fallback | Via Google Cloud SDK |
| **Sarvam** | TTS/STT for Tamil/Tanglish | `SARVAM_API_KEY` |

**Circuit Breaker Pattern:** Implemented for ElevenLabs and Google providers with configurable thresholds.

### Other Integrations
| Service | Purpose | Config |
|---|---|---|
| **S3-compatible storage** | Voice recordings, avatars, media | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` |
| **Auth0** | Identity provider | `AUTH0_ISSUER`, `AUTH0_AUDIENCE`, `AUTH0_JWKS_URI` |
| **Twilio** | Phone calls, SMS | Webhook handler at `/api/webhooks/twilio` |
| **Sarvam** | Indian language TTS/STT | Webhook handler at `/api/webhooks/sarvam` |
| **Deepgram** | Voice transcription webhooks | Webhook handler at `/api/webhooks/deepgram` |

### AI Safety Guardrails
- patterns blocked in `ai.ts` (regex-based)
- PII extraction prevention (emails, phone numbers, passwords, SSNs, addresses, credit cards)
- Content filtering for sensitive topics (banking, OTP, explicit content)

---

## 6. Security Headers & CORS

### Helmet Configuration (`middleware/security.ts`)
- **CSP:** Strict policy — `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'nonce-*'`
- **HSTS:** Enabled in production (1 year, includeSubDomains, preload)
- **Cross-origin policies:** `same-origin` for CORP, `same-origin-allow-popups` for COOP
- **Other:** XSS filter, no sniff, referrer policy, permitted cross-domain policies none

### CORS Configuration
- Production origins: `https://nova.leadup.in,https://admin.nova.leadup.in`
- Development: Permissive (all origins allowed)
- Credentials: Enabled
- Max age: 600s
- Exposed headers: `X-RateLimit-*`, `X-Request-ID`

### XSS Sanitization
- Body sanitization middleware for POST/PUT/PATCH
- Uses `xss` library with whitelist of safe HTML tags
- Strips scripts and dangerous tags

---

## 7. Input Validation

### Zod Schemas (`schemas/index.ts`)
Comprehensive validation for all endpoints:
- **Auth:** Register, login, refresh, forgot/reset password, verify email
- **Conversations:** Create, update, list (cursor-based pagination), send message
- **Memories:** Create, update, search (with filters), list (cursor-based)
- **Call Logs:** Create, update, list, search
- **Leads:** Create, update, list, search, status transitions
- **Notifications:** Create, list, mark read
- **Tasks:** Create, update, list, status changes
- **Admin:** Audit queries, user queries, incident queries, flag queries, usage queries
- **Settings:** Profile update, persona config, companion config, privacy prefs, notification prefs
- **AI:** Summarize, embed
- **Biometric:** Enroll, auth

### Manual Validation (`utils/validation.ts`)
Legacy validation utilities for registration, login, and leads with:
- Email format validation
- Password complexity (uppercase, lowercase, number)
- Phone number format (international)
- XSS sanitization (HTML entity encoding)

---

## 8. Rate Limiting

- **Redis-backed** rate limiter (imported from shared utils)
- **Exposed headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- Applied via middleware chain

**Issue:** Rate limiting currently applied AFTER auth in some routes (medium severity per existing audit).

---

## 9. Error Handling & Logging

### Logger (`utils/logger.ts`)
- Structured logging with configurable log level
- Production vs development formatting

### Error Handling
- Global error handler middleware
- Request ID tracking (`X-Request-ID` header)

### Health Checks (`utils/health.ts`)
- Dedicated health check utility
- Docker healthcheck: `curl -f http://localhost:3001/health`

---

## 10. Webhook Handlers

| Webhook | Provider | Path |
|---|---|---|
| Deepgram transcription | Deepgram | `/api/webhooks/deepgram` |
| Twilio voice/SMS | Twilio | `/api/webhooks/twilio` |
| Sarvam voice | Sarvam | `/api/webhooks/sarvam` |

Webhooks use signature verification (provider-specific).

---

## 11. Background Jobs

- **Queue:** Bull/BullMQ with Redis (imported in route files)
- **Job types:** AI summarization, call log processing, notification delivery
- **Processing:** Async via `Queue` class from shared utilities

---

## 12. API Documentation

- **Status:** No OpenAPI/Swagger documentation found
- **Validation:** Zod schemas serve as implicit API contracts
- **Recommendation:** Add `swagger-jsdoc` + `swagger-ui-express` or generate OpenAPI spec from Zod schemas

---

## 13. Testing Setup

### Configuration
- **Framework:** Vitest
- **HTTP testing:** Supertest
- **Scripts:**
 - `pnpm test` — `vitest run`
 - `pnpm test:watch` — `vitest`
 - `pnpm test:coverage` — `vitest run --coverage`

### E2E Tests
- Separate `.env.e2e` file (gitignored)
- Separate PostgreSQL instance on port 5433
- Auth0 test credentials required

### Test Coverage
- **Status:** Unknown — no test files observed in the route directories
- **Recommendation:** Add unit tests for middleware, route handlers, and service integrations

---

## 14. Environment Variables

### Required
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Access token signing (min 32 chars) |
| `JWT_REFRESH_SECRET` | Refresh token signing |
| `POSTGRES_PASSWORD` | Docker Compose PostgreSQL password |

### Optional (with fallbacks)
| Variable | Purpose | Fallback |
|---|---|---|
| `REDIS_URL` | Redis connection | None (optional) |
| `ANTHROPIC_API_KEY` | Claude AI | `BROCODE_API_KEY` via proxy |
| `OPENAI_API_KEY` | OpenAI fallback | None (lazy-loaded) |
| `DEEPGRAM_API_KEY` | Speech-to-text | None |
| `ELEVENLABS_API_KEY` | Text-to-speech | Falls back to Google/Deepgram |
| `SARVAM_API_KEY` | Indian language TTS/STT | None |
| `S3_*` | Object storage | None |

### Security Notes
- `JWT_SECRET` validated for minimum length (32 chars)
- Fallback secret detection warns if `fallback-secret-change-me` is used
- All API keys loaded from environment (no hardcoded credentials)
- `.env.e2e` is gitignored
- Docker Compose uses `${VAR:?error}` syntax for required secrets

---

## 15. Security Issues & Concerns

### CRITICAL
1. **Unsigned JWT in workflow-engine** — Separate service uses unsigned JWTs (from existing audit)
2. **No token revocation** — JWTs remain valid until expiry, no blacklist mechanism

### HIGH
3. **Unauthenticated notification endpoint** — From existing audit
4. **Race condition in token refresh** — From existing audit
5. **No API rate limiting on public routes** — `/health` and webhooks are unauthenticated

### MEDIUM
6. **Rate limiting after auth** — Some routes apply rate limiting post-authentication
7. **Public `/health` endpoint** — Exposes service status without auth (consider IP whitelist)
8. **Shared JWT secret pattern** — From existing audit (workflow-engine)
9. **CORS permissive in development** — Allows all origins when `NODE_ENV !== 'production'`
10. **No request size limits** — Missing `express.json({ limit: '1mb' })` or similar

### LOW
11. **No OpenAPI documentation** — API contracts only in code
12. **No automated security scanning** — No `npm audit` or Snyk in CI
13. **XSS sanitization on body only** — Query params and URL segments not sanitized
14. **Circuit breaker state in-memory** — Not persisted across restarts
15. **No request timeout middleware** — Long-running AI calls could hang connections

---

## 16. Missing Features & Recommendations

### High Priority
1. **Add request timeout middleware** — Prevent hanging connections (AI calls can take 120s+)
2. **Implement token revocation** — Add Redis-backed JWT blacklist
3. **Add request size limits** — `express.json({ limit: '1mb' })`, `express.urlencoded({ limit: '100kb' })`
4. **Add API documentation** — OpenAPI/Swagger for external consumers
5. **Add automated tests** — Currently no observable test coverage for routes

### Medium Priority
6. **Persist circuit breaker state** — Store in Redis for recovery after restarts
7. **Add request/response logging middleware** — Structured logging with correlation IDs
8. **Implement idempotency keys** — For payment and webhook endpoints
9. **Add metrics endpoint** — Prometheus or OpenTelemetry metrics
10. **Sanitize query parameters** — Extend XSS sanitization beyond request body

### Low Priority
11. **Add GraphQL option** — Consider for complex nested data (memories, conversations)
12. **Implement graceful shutdown** — Handle SIGTERM for in-flight requests
13. **Add API versioning** — `/api/v1/` prefix for future breaking changes
14. **Add request signing** — For internal service-to-service communication

---

## 17. Docker & Deployment

### Dockerfile
- Multi-stage build (deps → builder → runner)
- Non-root user (`nodejs:1001`)
- Health check with curl
- Alpine-based for smaller image

### Docker Compose
- API service depends on PostgreSQL and Redis health checks
- Secrets passed via environment variables (not baked into image)
- Restart policy: `unless-stopped`
- Health check: `curl -f http://localhost:3001/health`

### CI/CD
- GitHub Actions workflow at `.github/workflows/ci.yml`
- Runs lint, typecheck, build, test

---

## 18. Summary

The NOVA-Leadup API server is a well-structured Express.js application with:
- **Strengths:** Comprehensive Zod validation, strong security headers (Helmet + CSP), circuit breakers for AI providers, Redis-backed rate limiting, ED25519 gateway auth, multi-provider AI fallbacks
- **Gaps:** No OpenAPI docs, no observable test coverage, missing request timeouts/size limits, token revocation not implemented, circuit breaker state not persisted
- **Critical action items:** Fix unsigned JWT in workflow-engine, implement token revocation, add request timeouts

---

## Correction, verified 2026-09-19

Two of the three critical action items have landed, and the third is no longer accurate
as written:

- **Unsigned JWT in workflow-engine — fixed.**
  `services/workflow-engine/src/middleware/auth.ts` calls
  `jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })` and rejects the request when
  `JWT_SECRET` is unset. A signature algorithm is pinned, so `alg: none` cannot pass.
- **Token revocation — implemented.** `services/workflow-engine/src/middleware/token-denylist.ts`
  is consulted on every authenticated request (`jti` check), and both
  `services/auth/src/tokenDenylist.ts` and
  `services/realtime-gateway/src/auth/token-denylist.ts` exist. `verify-auth.py` exercises
  it end to end: a logged-out access token is rejected with *"Token has been revoked"*.
- **Request size limits — present.** `services/api/src/server.ts` sets
  `express.json({ limit: '5mb' })`; request timeouts remain a fair gap.

This audit predates the work that made `pnpm run build` 27/27 and `pnpm run typecheck`
31/31. Treat the gap list above as findings from that date, not as current state.

