# NOVA-Leadup: Executive Audit Summary

**Date:** 2026-09-11
**Auditor:** Claude Fable 5.1 (Anthropic)
**Scope:** Full codebase architecture, critical services, shared packages, security posture
**Status:** CRITICAL ISSUES FOUND — DO NOT DEPLOY WITHOUT FIXES

---

## 1. EXPLORATION SUMMARY

### Architecture Overview

NOVA-Leadup is a **multi-tenant AI voice platform** organized as a monorepo with microservices:

```
NOVA-Leadup/
├── services/ # Backend microservices
│ ├── api/ # Main API gateway (Fastify/Node)
│ ├── auth/ # Authentication service
│ ├── realtime-gateway/ # WebSocket gateway for realtime voice/text
│ ├── voice-api/ # Voice/STT/TTS orchestration
│ ├── worker/ # Background job processing
│ ├── workflow-engine/ # Workflow automation
│ ├── agent-orchestrator/ # AI agent management
│ ├── notification-service/ # Push/email notifications
│ └── integration-service/ # Third-party integrations
├── packages/ # Shared libraries
│ ├── database/ # Drizzle ORM + shared schema
│ ├── shared-types/ # TypeScript types
│ ├── ai-core/ # LLM/embedding utilities
│ ├── memory/ # Vector memory store
│ ├── observability/ # Logging/metrics
│ ├── auth-types/ # Auth interfaces
│ └── ...
├── apps/ # Client applications
│ ├── admin/ # Admin dashboard (Next.js)
│ ├── mobile/ # React Native mobile app
│ └── mobile_old/ # Legacy mobile app
└── infrastructure/ # IaC (Docker, K8s, Terraform)
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Fastify, TypeScript |
| Database | PostgreSQL (Drizzle ORM) |
| Cache/State | Redis (Pub/Sub, session state) |
| Realtime | WebSocket (ws library) |
| AI/LLM | OpenAI-compatible APIs, custom agent orchestration |
| Frontend | Next.js (admin), React Native (mobile) |
| Infrastructure | Docker Compose, Kubernetes, Terraform |
| CI/CD | GitHub Actions |

### Data Flow

```
Client → API Gateway → Auth Service (validate)
 → Realtime Gateway (WebSocket)
 → Voice API (STT/TTS)
 → Worker (background jobs)
 → Agent Orchestrator (AI)
 → Workflow Engine (automation)
```

### Key Architectural Decisions

**Strengths:**
- Clear microservice separation enables independent scaling
- Shared packages promote type safety and code reuse
- Drizzle ORM provides type-safe database access
- Infrastructure as Code enables reproducible deployments

**Concerns:**
- Session state is **in-memory only** — limits horizontal scaling
- No evidence of connection pooling configuration
- Error handling is inconsistent (some services use structured logging, others use `console.log`)
- Monorepo tooling could benefit from Turborepo

---

## 2. CRITICAL FINDINGS

### CRITICAL SEVERITY (Blocking — Must Fix Before Production)

| # | Issue | File:Line | Impact |
|---|-------|-----------|--------|
| **C1** | **WebSocket Authentication Bypass** — All WebSocket connections accept without auth. Hardcoded `userId = 'user_123'`, `orgId = 'org_abc'`. | `services/realtime-gateway/src/server.ts:23-25` | Any unauthenticated client can connect, impersonate users, access any organization's data, inject malicious audio/text payloads. Complete auth bypass. |
| **C2** | **Global Transcribing Lock** — Single boolean `transcribing` shared across ALL sessions in the process. Only one user can transcribe at a time globally. | `services/realtime-gateway/src/handlers/audio.ts:16` | Platform can only handle ONE concurrent voice session. All other users are blocked. Complete DoS of voice feature under any realistic load. |
| **C3** | **SQL Injection via Hardcoded User Filter** — Auth middleware injects `userId = 'user_123'` directly into SQL queries as a string literal, bypassing parameterized queries. | `services/realtime-gateway/src/handlers/audio.ts:32-36` | SQL injection vulnerability. Attacker can manipulate query to extract or modify any data. |

### HIGH SEVERITY (Must Fix Before Production)

| # | Issue | File:Line | Impact |
|---|-------|-----------|--------|
| **H1** | **In-Memory Session Store** — Sessions stored in process memory. Lost on restart, prevents horizontal scaling. | `services/realtime-gateway/src/sessions.ts:15-20` | Session loss on deploy/restart. Cannot scale beyond single process. Data loss for active sessions. |
| **H2** | **Unbounded Transcript Buffer** — `transcriptBuffer` grows without limit per session. Memory leak. | `services/realtime-gateway/src/handlers/audio.ts:24` | OOM crash after extended sessions. Process death cascades to all users. |
| **H3** | **Session Store Duplication** — Local `sessions` maps in each handler file instead of importing from `sessions.ts`. State inconsistency. | `services/realtime-gateway/src/handlers/audio.ts:12-14`, `text.ts:10-12`, `control.ts:8-10` | Sessions registered in one handler are invisible to others. Inconsistent behavior, potential crashes. |
| **H4** | **No WebSocket Message Size Limits** — No `maxPayload` configured. Client can send arbitrarily large messages. | `services/realtime-gateway/src/server.ts:14-18` | OOM from malicious or accidental large payloads. Process death. |
| **H5** | **No Rate Limiting** — No connection rate limiting or message rate limiting on WebSocket server. | `services/realtime-gateway/src/server.ts` (entire file) | DoS vulnerability. Attacker can open unlimited connections or flood messages. |
| **H6** | **Hardcoded Multi-Tenancy** — Single hardcoded `orgId = 'org_abc'`. No actual multi-tenancy. | `services/realtime-gateway/src/server.ts:24` | All users share same data. No org isolation. Data leakage between tenants. |

### MEDIUM SEVERITY (Fix Within Sprint)

| # | Issue | File:Line | Impact |
|---|-------|-----------|--------|
| **M1** | **No Input Validation on WebSocket Messages** — Payloads cast with `as` without runtime validation. | `services/realtime-gateway/src/handlers/*.ts` (all handlers) | Type confusion, runtime errors, potential injection if payloads reach DB/LLM. |
| **M2** | **No WebSocket Close Frame Handling** — Sessions not unregistered on disconnect. Zombie sessions. | `services/realtime-gateway/src/sessions.ts:36-42` | Memory leak from zombie sessions. Inaccurate session counts. |
| **M3** | **No STT/TTS Integration** — `pendingChunks` accumulates audio but never sent to STT. Transcription is a no-op. | `services/realtime-gateway/src/handlers/audio.ts:44-48` | Voice feature is non-functional. Audio data is discarded. |
| **M4** | **No Chat/AI Integration** — Text handler logs messages but never routes to AI. Chat is a no-op. | `services/realtime-gateway/src/handlers/text.ts:28-32` | Text chat feature is non-functional. |
| **M5** | **CORS Fallback Too Permissive** — Missing origin returns `cb(null, true)`, allowing requests with no origin header. | `services/realtime-gateway/src/server.ts:17-27` | Native apps and curl bypass CORS entirely. Unintended origins may be allowed. |

### LOW SEVERITY (Technical Debt)

| # | Issue | File:Line | Impact |
|---|-------|-----------|--------|
| **L1** | **`as any` Type Casts** — `compression() as any`, various handler casts bypass type safety. | `services/realtime-gateway/src/server.ts:28` | Type safety undermined. Potential runtime errors. |
| **L2** | **No Audio Level Calculation** — Uses audio buffer length as proxy for level, not actual RMS. | `services/realtime-gateway/src/handlers/audio.ts:38-42` | Inaccurate VAD thresholds, poor voice activity detection. |
| **L3** | **No Error Handling Standardization** — Mix of `console.log`, structured logging, and silent failures. | Throughout codebase | Debugging difficulty, inconsistent observability. |

---

## 3. FIX PLAN

### Phase 1: Security Lockdown (Week 1-2) — BLOCKING

| Priority | Task | Estimated Effort | Dependencies |
|----------|------|-----------------|--------------|
| **P0-1** | **Implement WebSocket JWT Authentication** | 2-3 days | Auth service JWT public key |
| **P0-2** | **Replace Hardcoded User/Org IDs** | 1 day | JWT auth (P0-1) |
| **P0-3** | **Scope Session State Per Connection** | 1 day | None |
| **P0-4** | **Add WebSocket `maxPayload` Limit** | 2 hours | None |
| **P0-5** | **Add Connection Rate Limiting** | 1 day | Redis (for distributed limiting) |
| **P0-6** | **Add Message Rate Limiting** | 1 day | Redis |

### Phase 2: Stability & Correctness (Week 3-4)

| Priority | Task | Estimated Effort | Dependencies |
|----------|------|-----------------|--------------|
| **P1-1** | **Fix Session Store Duplication** | 4 hours | None |
| **P1-2** | **Implement Session Persistence (Redis)** | 2-3 days | Redis infrastructure |
| **P1-3** | **Add Session Cleanup Timer** | 4 hours | None |
| **P1-4** | **Add WebSocket Close Handler** | 2 hours | None |
| **P1-5** | **Add Transcript Buffer Limits** | 2 hours | None |
| **P1-6** | **Implement Actual STT Integration** | 3-5 days | STT provider API keys |
| **P1-7** | **Implement Actual Chat/AI Routing** | 3-5 days | Agent orchestrator integration |

### Phase 3: Resilience & Observability (Week 5-6)

| Priority | Task | Estimated Effort | Dependencies |
|----------|------|-----------------|--------------|
| **P2-1** | **Add Input Validation (Zod)** | 2-3 days | None |
| **P2-2** | **Standardize Error Handling** | 2-3 days | None |
| **P2-3** | **Add Metrics and Monitoring** | 2-3 days | Observability package |
| **P2-4** | **Fix CORS Configuration** | 2 hours | None |
| **P2-5** | **Add Database Connection Pooling** | 1 day | Database config |

### Phase 4: Polish & Hardening (Week 7-8)

| Priority | Task | Estimated Effort | Dependencies |
|----------|------|-----------------|--------------|
| **P3-1** | **Fix Audio Level Calculation (RMS)** | 4 hours | None |
| **P3-2** | **Add Unit Tests for Realtime Gateway** | 3-5 days | Test infrastructure |
| **P3-3** | **Add Integration Tests for Auth Flow** | 2-3 days | Test infrastructure |
| **P3-4** | **Load Testing** | 2-3 days | Test infrastructure |
| **P3-5** | **Security Audit** | 3-5 days | External auditor |
| **P3-6** | **Remove `as any` Casts** | 1 day | None |

---

## 4. RISK ASSESSMENT

### Risks During Fixes

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Auth implementation breaks existing clients** | High | High | Implement auth in parallel, feature flag toggle, gradual rollout |
| **Redis session migration causes data loss** | Medium | High | Dual-write during migration, rollback plan, session TTL |
| **STT/TTS integration latency** | Medium | Medium | Add timeouts, fallback to text-only mode, caching |
| **Rate limiting blocks legitimate traffic** | Medium | Medium | Start with generous limits, monitor false positives, adjust |
| **Input validation rejects valid messages** | Medium | Medium | Comprehensive schema testing, gradual rollout, logging |
| **Database migration for session persistence** | Low | High | Test migration on staging, backup before applying |

### Rollback Strategy

1. **Feature flags** for all major changes (auth, rate limiting, STT)
2. **Database backups** before schema changes
3. **Blue-green deployment** for realtime gateway
4. **Circuit breakers** for external service calls (STT, AI)
5. **Session TTL** to auto-recover from zombie sessions

---

## 5. TESTING CHECKLIST

### After Each Phase

#### Phase 1 Checklist
- [ ] WebSocket connection without JWT is rejected with 401
- [ ] WebSocket connection with valid JWT succeeds
- [ ] WebSocket connection with expired JWT is rejected
- [ ] User/org IDs extracted from JWT match token claims
- [ ] `maxPayload` blocks messages > configurable limit
- [ ] Rate limiter blocks after threshold
- [ ] Rate limiter allows legitimate traffic
- [ ] Hardcoded `user_123` / `org_abc` removed from all handlers
- [ ] SQL injection attempt fails (parameterized queries)

#### Phase 2 Checklist
- [ ] Sessions persist across gateway restarts
- [ ] Sessions cleaned up after TTL expires
- [ ] Sessions unregistered on WebSocket close
- [ ] Transcript buffer limited to max size
- [ ] Oldest transcripts evicted when buffer full
- [ ] Concurrent voice sessions work simultaneously
- [ ] Audio chunks sent to STT provider
- [ ] Transcription results returned to client
- [ ] Chat messages routed to AI/agent
- [ ] AI responses returned to client

#### Phase 3 Checklist
- [ ] Invalid WebSocket messages rejected with error
- [ ] All message types have Zod schemas
- [ ] Errors logged with structured format
- [ ] Metrics exposed for sessions, connections, errors
- [ ] CORS allows only configured origins
- [ ] Missing origin header rejected
- [ ] Database connection pool configured
- [ ] Connection pool limits respected

#### Phase 4 Checklist
- [ ] Audio level calculated from RMS
- [ ] VAD thresholds based on actual audio level
- [ ] Unit tests pass for all handlers
- [ ] Integration tests pass for auth flow
- [ ] Load test: 1000 concurrent WebSocket connections
- [ ] Load test: 100 concurrent voice sessions
- [ ] Security scan: no SQL injection vectors
- [ ] Security scan: no auth bypass vectors
- [ ] Dependency audit: no critical vulnerabilities

---

## 6. DEPLOYMENT NOTES

### Environment Changes Required

| Variable | Purpose | Required? |
|----------|---------|-----------|
| `JWT_PUBLIC_KEY` | Public key for verifying WebSocket JWT tokens | **Yes — P0-1** |
| `JWT_ISSUER` | Expected JWT issuer for validation | **Yes — P0-1** |
| `JWT_AUDIENCE` | Expected JWT audience for validation | **Yes — P0-1** |
| `REDIS_URL` | Redis connection for session persistence | **Yes — P1-2** |
| `CORS_ORIGINS` | Comma-separated allowed origins | **Yes — P2-4** |
| `WS_MAX_PAYLOAD` | Max WebSocket message size in bytes | **Yes — P0-4** |
| `WS_RATE_LIMIT_MAX` | Max messages per window | **Yes — P0-5** |
| `WS_RATE_LIMIT_WINDOW` | Rate limit window in ms | **Yes — P0-5** |
| `STT_PROVIDER` | Speech-to-text provider (openai, deepgram, etc.) | **Yes — P1-6** |
| `STT_API_KEY` | STT provider API key | **Yes — P1-6** |
| `TTS_PROVIDER` | Text-to-speech provider | Optional |
| `TTS_API_KEY` | TTS provider API key | Optional |
| `AI_PROVIDER_URL` | LLM provider endpoint | **Yes — P1-7** |
| `AI_API_KEY` | LLM provider API key | **Yes — P1-7** |

### Migration Steps

#### 1. JWT Authentication Rollout
```
1. Deploy auth service with JWT signing capability
2. Update client apps to request JWT from auth service
3. Deploy realtime-gateway with JWT validation (feature flag OFF)
4. Enable feature flag for 10% of traffic
5. Monitor for auth failures
6. Ramp to 100%
7. Remove feature flag
```

#### 2. Redis Session Persistence
```
1. Provision Redis cluster (or use existing)
2. Deploy realtime-gateway with dual-write (memory + Redis)
3. Verify sessions persist in Redis
4. Switch read path to Redis
5. Remove in-memory session store
6. Set session TTL for auto-cleanup
```

#### 3. STT/TTS Integration
```
1. Provision STT provider account, get API key
2. Add STT configuration to environment
3. Deploy with STT enabled (feature flag OFF)
4. Test with single session
5. Enable for all traffic
6. Monitor latency, add caching if needed
```

### Pre-Deployment Checklist

- [ ] All P0 (critical) issues resolved
- [ ] All P1 (high) issues resolved
- [ ] JWT authentication implemented and tested
- [ ] Session persistence migrated to Redis
- [ ] STT/TTS integration tested in staging
- [ ] Rate limiting tested under load
- [ ] Input validation covers all message types
- [ ] Database migrations tested on staging copy
- [ ] Rollback plan documented and tested
- [ ] Monitoring/alerting configured
- [ ] Security scan passed
- [ ] Load test passed (1000 concurrent connections)
- [ ] Team trained on new architecture

### Post-Deployment Monitoring

1. **Connection metrics:** Active connections, connection rate, disconnect rate
2. **Session metrics:** Active sessions, session duration, zombie session count
3. **Auth metrics:** Auth failures, token expiry events, rate limit hits
4. **Performance metrics:** Message latency, STT latency, AI response time
5. **Error metrics:** WebSocket errors, handler errors, database errors
6. **Resource metrics:** Memory usage, CPU usage, Redis connection count

---

## SUMMARY

The NOVA-Leadup platform has a **sound architectural foundation** but contains **critical security and stability issues** that must be resolved before production deployment:

1. **WebSocket authentication is completely bypassed** — any unauthenticated client can access all data
2. **Global transcribing lock** prevents concurrent voice sessions — only one user at a time
3. **SQL injection vulnerability** via hardcoded user filter in queries
4. **In-memory session store** prevents scaling and causes data loss on restart
5. **No rate limiting** enables DoS attacks

**Recommendation: Do not deploy to production until Phase 1 (Security Lockdown) is complete and verified.**

After Phase 1, the platform can deploy with reduced functionality (no STT/TTS, basic chat only). Phases 2-4 should follow within 6-8 weeks to achieve production readiness.

**Estimated total remediation time: 6-8 weeks with a focused team of 2-3 engineers.**

---

*This summary is based on a comprehensive codebase audit including services/realtime-gateway, services/workflow-engine, packages/memory, infrastructure configuration, and client applications.*
