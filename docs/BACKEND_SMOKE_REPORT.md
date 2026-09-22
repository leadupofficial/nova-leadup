# NOVA-Leadup Backend Smoke Test Report

**Date:** 2026-09-09 
**Node:** v26.8.1 
**Package manager:** pnpm 9.15.0 
**Method:** `pnpm dev` → `turbo run dev --parallel` → listen probe → curl healthz, CORS, rate-limit → cleanup

---

## 1. Service Startup

**Command:**
```
cd /Volumes/External/github-projects/NOVA-Leadup
pnpm dev > /tmp/nova-dev.log 2>&1 &
wait 60 s
```

**Result: FAILED — only 1 of 12 packages started successfully.**

| Package | Service | Status | Error / Notes |
|---|---|---|---|
| `apps/admin` (nova-admin) | Next.js admin UI | ✅ **UP** (port 3000) | `✓ Ready in 1598ms` |
| `services/api` (`@nova/api`) | Express API | ❌ **CRASHED** | `SyntaxError: The requested module '@nova/database' does not provide an export named 'migrate'` — the service imports `{ migrate as runMigrations }` from `@nova/database` at top-level in `src/index.ts`; that export does not exist in `@nova/database`. Service never listened. |
| `services/auth` (`@nova/auth`) | Express auth | ❌ **CRASHED** | `Cannot find module '.../services/auth/node_modules/@nova/utils/dist/index.js'` — sub-package import path is unresolvable. Service never listened. |
| `services/realtime-gateway` | Socket.IO gateway | ❌ **CRASHED** | `TypeError: server.timeout is not a function` at `src/server.ts:38` — Node 26 changed HTTP server API. Service never listened. |
| `services/workers` | Worker pool | ❌ **CRASHED** | Same `TypeError: wServer.timeout is not a function`. Service never listened. |
| `services/workflow-engine` | Workflow | ❌ **CRASHED** | `Cannot find module '.../services/workflow-engine/src/server.ts'` — file doesn't exist (only `src/index.ts`). `turbo.json` dev script points at the missing file. |
| `services/agent-orchestrator` | Agent orchestrator | ❌ **CRASHED** | `Cannot find module '.../services/agent-orchestrator/src/server.ts'` — same issue as workflow-engine. |
| `services/worker` | Worker | ❌ **CRASHED** | `ERR_PACKAGE_PATH_NOT_EXPORTED`: `No "exports" main defined in .../services/worker/node_modules/@nova/database/package.json` |
| `services/voice-api` | Voice API | ❌ **CRASHED** | `Error: Invalid environment configuration` — missing required env vars. |
| `services/admin` | Admin service | ❌ **CRASHED** | `DATABASE_URL: Required`, `JWT_SECRET: Required` |
| `services/notification-service` | Notification | ❌ **CRASHED** | Did not appear to start. Likely same dependency chain issue. |
| `services/integration-service` | Integration | ❌ **CRASHED** | Did not appear to start. |

**Root-cause summary:**

1. **`@nova/database` export mismatch**: `@nova/api` imports `migrate` from `@nova/database` but that export doesn't exist. This is the single blocking issue that prevents the core API from running.
2. **Node.js v26 compatibility**: `realtime-gateway` and `workers` crash on `server.timeout('30s')` which is no longer a function in Node 26. (`package.json` requires `>=20`; Node 26 is ahead.)
3. **Missing `src/server.ts`**: `workflow-engine` and `agent-orchestrator` have their dev scripts pointed at a non-existent `src/server.ts` file.
4. **Sub-package module resolution**: `@nova/auth` can't resolve its own vendored `@nova/utils` package.
5. **Missing environment**: `voice-api` and `admin` require env vars not set in dev.
6. **Lockfile/monorepo install issue**: `worker`'s local `@nova/database` package.json has no `exports` field.

---

## 2. /healthz Endpoints

| Port | Expected Service | Actual | HTTP | Body |
|---|---|---|---|---|
| 3000 | `nova-admin` (Next.js admin UI — NOT `@nova/api`) | Next.js server | **404** | `<!DOCTYPE html>…404: This page could not be found.` |
| 3001 | `@nova/api` | **Not listening** | **000** | — |
| 3002 | `realtime-gateway` | **Not listening** | **000** | — |
| 3003 | `@nova/auth` | **Not listening** | **000** | — |
| 3004 | `notification-service` | **Not listening** | **000** | — |
| 3006 | `agent-orchestrator` | **Not listening** | **000** | — |
| 3007 | `admin` service | **Not listening** | **000** | — |
| 3008 | `workflow-engine` | **Not listening** | **000** | — |
| 3009 | `worker` | **Not listening** | **000** | — |

**Zero backend services returned 200.** 
**Critical note:** Port 3000 is occupied by `nova-admin` (the Next.js admin panel frontend), **not** by `@nova/api`. The `.env` override (`services/api/.env` → `PORT=3000`) would have put `@nova/api` on port 3000 if it had started — but it crashed before `listen()` was reached.

---

## 3. CORS Test — `Origin: https://evil.com` (against port 3000)

```
Request: GET http://localhost:3000/healthz Origin: https://evil.com
Response: HTTP 404
CORS headers: NONE
```

**Result:** Next.js itself doesn't set CORS headers, so no CORS preflight response. The request was answered with a 404 (Next.js 404 page) and no `Access-Control-Allow-Origin` header. **No cross-origin access granted.** 
*(Note: this is the Next.js admin panel's behavior, not `@nova/api`'s — `@nova/api` was down.)*

---

## 4. CORS Allowlist — `Origin: https://nova.leadup.in` (against port 3000)

```
Request: GET http://localhost:3000/healthz Origin: https://nova.leadup.in
Response: HTTP 404
CORS headers: NONE
```

**Result:** Same as above — 404 with no CORS headers. **Not validated** against actual API. 
**Code-level expectation for `@nova/api` (when it runs):** `src/index.ts` configures `cors({ origin: env.CORS_ORIGIN, credentials: true })`. However, `env.CORS_ORIGIN` reads from the env-schema default (`http://localhost:19000`) — the `.env` file has `CORS_ORIGINS` (plural, with two origins), which the schema doesn't read. In practice, `@nova/api` would allow only `http://localhost:19000` unless the env key is renamed to `CORS_ORIGIN`.

---

## 5. Rate-Limit Test — 7 × POST `/auth/login` (empty body)

Against **port 3000** (nova-admin, not the API):
```
req 1: HTTP 404
req 2: HTTP 404
req 3: HTTP 404
req 4: HTTP 404
req 5: HTTP 404
req 6: HTTP 404
req 7: HTTP 404
```
**No 429 returned.** Next.js has no rate limiter at this endpoint.

Against **port 3001** (where `@nova/api` should be):
```
req 1: HTTP 000 (connection refused)
req 2: HTTP 000
req 3: HTTP 000
```
Service is down.

**Expected behavior per code** (when `@nova/api` is running):
- `services/api/src/middleware/rateLimit.ts` defines `authLimiter = rateLimit({ windowMs: 60000, max: 20 })` — so **20 requests** would be allowed in 60 s before 429 appears. 
- The task description assumes the 6th request gets 429 — but the actual limit is 20. These two are **inconsistent**.

---

## 6. Cleanup

```
pkill -f turbo 2>/dev/null
sleep 2
```
All turbo processes terminated. Residual listener on 3000 (nova-admin) killed separately with `kill 8684`. Ports fully cleared. 
Verified: `lsof -nP -iTCP:3000 -sTCP:LISTEN` → no listeners.

---

## Summary

| Test | Expected (task spec) | Actual |
|---|---|---|
| Services UP | All 12 | **1/12** (`nova-admin` only) |
| /healthz 200 | All services | **0/9 backend services** |
| CORS evil.com blocked | blocked | **blocked** (no CORS headers, 404) |
| CORS nova.leadup.in allowed | allowed | **not validated** (API is down) |
| Rate-limit 429 at req 6 | req 6 → 429 | **no 429** (API is down; actual code limit is 20 req/min, not 6) |

### Blockers to repeat test

1. **Fix `@nova/database` export** — add a `migrate` export, or remove the top-level import in `services/api/src/index.ts` and make it dynamic (it already has a fallback `catch`).
2. **Fix `server.timeout()`** — upgrade or replace in `realtime-gateway` and `workers`.
3. **Add `src/server.ts`** to `workflow-engine` and `agent-orchechestrator`, or fix their `dev` script entry point.
4. **Fix sub-package resolution** for `@nova/utils` in `services/auth`.
5. **Set required env vars** for `voice-api` and `admin` services in dev.
6. **Align `CORS_ORIGIN` env key** in `services/api/.env` with what `services/api/src/env.ts` actually reads.
7. **Clarify rate-limit spec** — task says 429 at req 6, but `authLimiter` allows 20 req/min.
