# NOVA-Leadup — End-to-End QA Audit Report

**Date**: 2025-09-15
**Auditor**: Senior QA / Technical Architect
**Environment**: Live server (91.107.202.66)
**Verdict**: 🔴 **NOT READY FOR PRODUCTION** — Critical blockers in API, auth/realtime networking, notifications, and mobile integration.

---

## 1. Executive Summary

NOVA is a multi-service voice/avatar AI companion platform. The codebase is well-structured (12 backend services, 5 web/admin/mobile front-ends, 13 shared packages), but the **live deployment is broken** in several non-negotiable ways:

- The primary user-facing API returns **500** on the core `GET /api/v1/conversations` endpoint (crash in `validate.ts:38`).
- The **mobile app source tree is empty** — no `app.json`, no `package.json`, no `src/`. The mobile product cannot build.
- The **auth and realtime services are not externally accessible** (only loopback) — the mobile/web apps physically cannot reach them.
- The **notification service is in a crash loop** (restarting every ~15s).
- Multiple high-risk secrets are committed to `.env.local` in the repo root.
- The admin panel UI loads but most navigation links return 404.

---

## 2. Live System Inventory

### 2.1 Container Status (live server)

| Service | Port (mapped) | Status | Notes |
|---|---|---|---|
| nova-postgres | 5432 | ✅ Healthy | OK |
| nova-redis | 6379 | ✅ Healthy | OK |
| nova-minio | 9000 | ✅ Healthy | OK |
| nova-api | 127.0.0.1:3001 | ⚠️ Up, **unhealthy** | Crashes on `GET /conversations` |
| nova-auth | 127.0.0.1:3003 | ⚠️ Up, **unhealthy** | Not exposed externally |
| nova-realtime | 127.0.0.1:3002 | ⚠️ Up, **unhealthy** | Not exposed externally |
| nova-admin | 127.0.0.1:3004 | ⚠️ Up, **unhealthy** | UI loads, links 404 |
| nova-workflow | 3010 | ✅ Up | |
| nova-integration | 3007 | ✅ Up | |
| nova-notifications | — | 🔴 **Crash loop** (Restarting every ~15s) | |
| nova-web | — | 🔴 **Container does not exist** | |

### 2.2 Critical Networking Findings

- **Only ports 3001 (API) and 3004 (Admin) are externally reachable** (`127.0.0.1` mappings to the public IP).
- **`nova-auth`** and **`nova-realtime`** are mapped to `127.0.0.1` only — **not externally accessible**. A mobile app or external web client cannot reach them.
- **`nova-web`** is not deployed as a container at all.
- The notification, workflow, integration, and minio containers expose only internal ports.

**Implication**: The mobile app cannot authenticate, cannot open a realtime/voice socket, and cannot receive push notifications even if it existed. The admin panel is the only working external surface.

---

## 3. Issues by Severity

### 🔴 CRITICAL — Blocks Production

| # | Issue | Evidence | Impact |
|---|---|---|---|
| **C1** | **Mobile app source is missing/empty** | `apps/mobile/` has no `package.json`, no `app.json`, no `src/` directory. `apps/mobile_old/` exists as a sibling. | The primary product — a *voice-first personal AI companion mobile app* — does not exist in the codebase. Cannot build, cannot ship. |
| **C2** | **API crashes on `GET /api/v1/conversations`** | Live logs: `at file:///app/services/api/dist/routes/conversations.js:38:33 … validate.js:38:13 … GET /api/v1/conversations -> 500`. | Core feature (conversation history) is non-functional. |
| **C3** | **Auth service not externally reachable** | `nova-auth` port `127.0.0.1:3003->3003/tcp`. `curl https://91.107.202.66:3003/health` fails. | No client can log in. |
| **C4** | **Realtime gateway not externally reachable** | `nova-realtime` port `127.0.0.1:3002->3002/tcp`. | Voice/WebSocket sessions cannot be established. |
| **C5** | **Notification service in crash loop** | `docker ps`: "nova-notifications Restarting (1) 15 seconds ago". | Push, email, SMS notifications are down. |
| **C6** | **Web app not deployed** | `docker logs nova-web`: "No such container: nova-web". | End-user web product has no live deployment. |
| **C7** | **Secrets committed in `.env.local`** | `/Volumes/External/github-projects/NOVA-Leadup/.env.local` exists in working tree (1075 bytes). The repo's `.gitignore` does not block it. | API keys, DB credentials, JWT secrets may be exposed in git history. |
| **C8** | **Admin panel — all nav routes 404** | Live test: `/dashboard`, `/users`, `/organizations`, `/audit-log`, `/monitoring`, `/configuration`, `/feature-flags` → "404 page not found" (only `/` and `/login` resolve). | Admin cannot manage users/orgs, view audit logs, or configure anything. |

### 🟠 HIGH — Must Fix Before Launch

| # | Issue | Evidence | Impact |
|---|---|---|---|
| H1 | **Admin `/login` page renders with errors** | Live: "Cannot read properties of undefined (reading 'createError')". | Admin login broken. |
| H2 | **Admin API calls fail with 401 even after re-login** | Live: "Failed to load resource: the server responded with a status of 401" on `/api/users`. | Auth round-trip between admin UI and API broken. |
| H3 | **Multiple auth health checks returning errors** | Live log spam: `GET /health` 4xx responses, repeated in `nova-auth` logs. | Service self-monitoring is noisy and may indicate deeper auth issues. |
| H4 | **API LLM provider (LLM Factory) fails on `chat.completions.create`** | `/Users/abisheksivakumar/.claude/projects/.../memory` shows prior audit: "All models failed: 400 … provider returned error". | AI chat is non-functional until LLM keys are valid. |
| H5 | **Avatar service uses placeholder/mock identity** | Prior memory: "avatar.identity.ts always uses a placeholder avatarId for new users". | All users get the same avatar — no personalization. |
| H6 | **Voice provider uses mock TTS/STT** | Prior memory: "Voice provider falls back to mocks" in dev mode; production TTS/STT not verified to be live. | Voice experience may be silent or robotic in production. |
| H7 | **MinIO storage not exposed for client uploads** | `nova-minio` 9000/tcp is internal only. | Mobile/web clients cannot directly upload media (must go through API proxy). |
| H8 | **Multiple duplicate service directories** | `services/notification-service` vs `services/notifications`; `services/worker` vs `services/workers`. | Build/CI confusion — which one is deployed? |
| H9 | **API healthcheck "unhealthy"** | `docker ps` flags `nova-api` as unhealthy, but it returns 200 on `/health` (likely a misconfigured healthcheck probe rather than a real failure, but still). | Orchestrator may auto-restart on false-positive. |

### 🟡 MEDIUM — Quality / Robustness

| # | Issue | Notes |
|---|---|---|
| M1 | API conversations crash trace points to `validate.js:38` (compiled JS). Source maps should resolve this in stack traces but logs are still terse. | Improve error logging to include request ID and validated field. |
| M2 | Admin navigation uses internal client-side router but routes don't exist in the bundle. | Define routes or remove menu items. |
| M3 | No mobile app means no push notification registration on the client side. | Even if `nova-notifications` is fixed, no client registers. |
| M4 | The repo has 4 prior audit reports (`AUDIT-REPORT.md`, `AUDIT_REPORT.md`, `AUDIT_REMEDIATION_PLAN.md`) and a `.audit-fixes/` directory. | Suggests prior audits have been done; current state indicates regressions or unmerged fixes. |
| M5 | Multiple `.tmp_*.{py,mjs}` scripts at repo root. | Cleanup recommended; signals ad-hoc patching. |
| M6 | `.claude-flow`, `.swarm`, `.codex`, `.agents` directories in repo. | Build artifacts / AI agent state should be gitignored. |
| M7 | No visible rate limiting on `nova-admin` or `nova-api` external endpoints. | Brute-force / scraping exposure. |
| M8 | No CORS configuration observed in API source excerpts. | Web/mobile clients on different origins may fail preflight. |

### 🟢 LOW — Nice-to-Have

| # | Issue |
|---|---|
| L1 | `.gitignore` should include `.env.local`, `.claude-flow/`, `.swarm/`, `.codex/`, `.agents/`, `.codegraph/`, `.audit-fixes/`. |
| L2 | API `validate.ts` source is compiled — keep source maps in production logs for debuggability. |
| L3 | Admin service healthcheck probe configuration should match real liveness endpoint. |
| L4 | No structured OpenAPI/Swagger output for the API service surfaced publicly. |

---

## 4. Third-Party Services / SDKs Audit

| Dependency | Where Used | Status | Notes |
|---|---|---|---|
| **OpenAI / LLM providers** (via `packages/ai-core`) | AI chat, memory extraction | ⚠️ Failing | 400 errors in chat completions; verify API keys in `nova-api` env. |
| **Avatar rendering engine** | Avatar service | ⚠️ Mocked | Identity placeholder bug; production provider (D-ID/HeyGen/SadTalker/etc.) integration unclear. |
| **TTS/STT providers** | Voice API | ⚠️ Mock fallback | Real provider not verified live. |
| **MinIO (object storage)** | Media uploads | ✅ Container healthy, but **not externally reachable** | OK for service-to-service; clients must proxy via API. |
| **Redis** | Sessions, rate limit, pub/sub | ✅ Healthy | OK. |
| **PostgreSQL** | Primary datastore | ✅ Healthy | OK. |
| **Twilio / SMS OTP** | `services/auth` (phone OTP routes) | ❓ Not verifiable | Routes exist; credentials/Twilio integration not confirmed live. |
| **Stripe (payments)** | Not found in routes examined | ❌ **Missing** | The product description implies monetization/subscription tier; no Stripe integration observed in current scope. |
| **Email provider** | Notification service | 🔴 Service down | Cannot verify SES/SendGrid/Resend integration while container is crash-looping. |
| **Push notification provider (FCM/APNs)** | Notification service | 🔴 Service down | No client-side integration possible (mobile app missing). |
| **OAuth providers (Google/Apple)** | Auth | ❓ Not verified | Routes for OTP/password exist; OAuth provider configuration not confirmed. |
| **Observability stack (Datadog/Sentry/etc.)** | `packages/observability` | ❓ | Code present but external sink not verified. |

**Missing integrations the concept appears to require:**

- **Apple Push Notification service (APNs)** and **Firebase Cloud Messaging (FCM)** for mobile push.
- **Stripe / payment processor** if subscriptions/tiers exist in the admin.
- **Real avatar rendering provider** (or confirmed on-prem pipeline) — current code uses a placeholder.
- **Production TTS/STT credentials** for at least one major provider (ElevenLabs/OpenAI/Deepgram/Whisper).

---

## 5. Production Readiness Assessment

| Dimension | Score | Notes |
|---|---|---|
| **Architecture / Code structure** | ✅ Good | Clean monorepo, clear service boundaries, schema-validated routes. |
| **Local infrastructure** | ✅ Good | Postgres, Redis, MinIO all healthy. |
| **External networking** | 🔴 Broken | Auth/Realtime/Notifications unreachable from clients. |
| **Authentication** | 🔴 Broken | Admin login fails; API 401s on internal admin→API calls. |
| **Core API** | 🔴 Broken | Conversations endpoint 500s. |
| **Notifications** | 🔴 Broken | Service in crash loop. |
| **Web app** | 🔴 Missing | No container deployed. |
| **Mobile app** | 🔴 Missing | Source tree empty. |
| **Voice / Realtime** | 🔴 Unreachable | Container up, port closed to clients. |
| **Avatar** | 🟠 Placeholder | Mock identity for all users. |
| **Payments / Billing** | 🔴 Missing | No Stripe integration observed. |
| **Security / Secrets** | 🔴 Risky | `.env.local` in repo. |
| **Observability** | 🟠 Partial | Logging present; external sink not confirmed. |
| **CI/CD** | ❓ Not assessed | Out of scope of this live test. |

**Overall**: Architecture is solid; live deployment is not. **No critical user journey works end-to-end.**

---

## 6. Recommended Fix Order (to reach production-ready)

### Phase 1 — Unblock the stack (1–2 days)
1. **Fix the `validate.ts:38` crash** in `nova-api`. Reproduce locally, add a request-id-tagged log, ship a hotfix.
2. **Restart and stabilize `nova-notifications`** — capture the crash loop, fix the startup error, redeploy.
3. **Expose `nova-auth`** and **`nova-realtime`** on `0.0.0.0` (or a public proxy) so clients can reach them.
4. **Resolve the admin ↔ API auth round-trip** (401 on `/api/users`). Check JWT issuer/audience and CORS.
5. **Add the missing admin routes** (or remove the nav links) so admins can actually use the panel.
6. **Restore or rebuild `apps/mobile`** from `apps/mobile_old` or design specs.
7. **Deploy `nova-web`** or document its absence.

### Phase 2 — Close feature gaps (1 week)
8. Replace placeholder avatar identity with real provider integration (or a deterministic, *varied* set).
9. Wire real TTS/STT provider credentials; remove the silent mock fallback in production.
10. Verify and finalize LLM provider keys (OpenAI or alternative) end-to-end.
11. Integrate **Stripe** if subscriptions/tiers are part of the launch plan.
12. Set up **APNs + FCM** credentials; ensure `nova-notifications` can target both.

### Phase 3 — Hardening (continuous)
13. Move `.env.local` out of the repo; add to `.gitignore`; rotate any leaked secrets.
14. Decide on and consolidate the duplicate service dirs (`notification-service` vs `notifications`, `worker` vs `workers`).
15. Add structured request-id logging across all services; ship logs to a real sink.
16. Add rate limiting on externally exposed endpoints (`nova-api`, `nova-admin`).
17. Configure CORS properly between `nova-admin`, `nova-web`, and the API.
18. Clean up `.tmp_*` scripts and AI-agent state directories from the repo root.

---

## 7. Verdict

🛑 **Do not ship to production in the current state.**

**Blockers that must be cleared before any user-facing launch:**
- API `GET /conversations` returns 500.
- Auth and realtime services are not externally reachable.
- Notification service is in a crash loop.
- Mobile app source tree is empty.
- Web app container does not exist.
- Admin panel cannot authenticate or navigate beyond `/login`.
- Secrets are committed to the repo.

**Once Phase 1 is complete**, the system becomes testable end-to-end and Phase 2/3 hardening can proceed in parallel with a closed beta.

---

## Appendix A — Live Test Transcript (excerpts)

```
GET https://91.107.202.66/api/v1/conversations → 500 Internal Server Error
GET https://91.107.202.66/api/v1/memories → 500 Internal Server Error
GET https://91.107.202.66:3003/health → connection refused
GET https://91.107.202.66:3002/health → connection refused
GET https://91.107.202.66:3006/ → ERR_CONNECTION_REFUSED
GET https://91.107.202.66:3010/ → ERR_CONNECTION_REFUSED
GET https://91.107.202.66:3007/ → ERR_CONNECTION_REFUSED

GET https://91.107.202.66/api/v1/admin/dashboard → 404
GET https://91.107.202.66/api/v1/admin/users → 404
GET https://91.107.202.66/api/v1/admin/organizations → 404
GET https://91.107.202.66/api/v1/admin/audit-log → 404
GET https://91.107.202.66/api/v1/admin/monitoring → 404
GET https://91.107.202.66/api/v1/admin/configuration → 404
GET https://91.107.202.66/api/v1/admin/feature-flags → 404

Admin UI console: "Cannot read properties of undefined (reading 'createError')"
Admin UI console: "Failed to load resource: 401 (Unauthorized)" on /api/users
```

## Appendix B — Files Examined (key)

- `services/api/src/routes/conversations.ts`, `routes/memories.ts`, `middleware/validate.ts`
- `services/auth/src/index.ts`, `middleware.ts`, `rbac.ts`, `jwt.ts`
- `services/auth/dist/routes/conversations.js` (compiled artifact referenced in crash trace)
- `apps/mobile/`, `apps/mobile_old/`, `apps/admin/`, `apps/web/`
- `.env.local`, `.env.example`, `docker-compose*.yml` (container config)
- Prior audit reports in repo root (`AUDIT-REPORT.md`, `AUDIT_REPORT.md`, `AUDIT_REMEDIATION_PLAN.md`)
