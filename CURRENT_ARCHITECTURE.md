# NOVA-Leadup — Current Architecture (Verified)

**Verified**: 2026-09-15
**Branch**: `main`
**Commit**: `aecf03f4169179350d94cff85871974f7908d919`
**Working tree**: 678 modified/deleted files — significant uncommitted changes present

---

## 1. What Exists

### Monorepo Structure
- **Tooling**: pnpm workspaces, Turbo, TypeScript 5.7, Node >=20
- **Quality**: ESLint 9, Vitest, Playwright, Prettier

### Apps
| App | Path | Framework | Status |
|-----|------|-----------|--------|
| Web | `apps/web/` | Next.js 14, React 19, Tailwind CSS 4, shadcn/ui | Code present, many files deleted in working tree |
| Admin | `apps/admin/` | React + Express (service) | Code present, many files modified |
| Mobile | `apps/mobile/` | Expo/React Native + Flutter (dual-stack) | Partial — many files deleted, ongoing migration |

### Services
| Service | Path | Framework | Status |
|---------|------|-----------|--------|
| API | `services/api/` | Express 4 + TypeScript | **Runnable** — starts on port 3001 |
| Admin | `services/admin/` | Express 4 + TypeScript | Code exists |
| Agent Orchestrator | `services/agent-orchestrator/` | Express 4 + TypeScript | Code exists |
| Auth | `services/auth/` | Express 4 + TypeScript | Code exists |
| Voice | `services/voice/` | Express 4 + TypeScript | Code exists |
| Realtime | `services/realtime/` | WebSocket gateway | Code exists |
| Redis | `services/redis/` | Redis | Code exists |
| Notification Worker | `services/notification-worker/` | — | Code exists |
| Stripe Webhook | `services/stripe-webhook/` | — | Code exists |

### Packages
| Package | Purpose |
|---------|---------|
| `@nova/database` | Drizzle ORM + PostgreSQL + pgvector + ioredis |
| `@nova/ai-core` | AI provider routing (Claude, OpenAI, Gemini, Perplexity) |
| `@nova/voice` | Voice engine (Deepgram, Sarvam, Google STT/TTS) |
| `@nova/auth` | Authentication (Clerk.dev) |
| `@nova/config` | Configuration management |
| `@nova/memory` | Memory/embedding system |
| `@nova/avatar` | Avatar rendering |
| `@nova/observability` | Logging (Pino), Sentry, OpenTelemetry |
| `@nova/policy` | Policy engine |
| `@nova/tools` | Tool integrations (calendar, etc.) |
| `@nova/shared-types` | Shared TypeScript types |
| `@nova/types` | Core type definitions |
| `@nova/ui` | Shared UI components |

### Database Schema
- **40 tables** defined in `packages/database/src/schema.ts`
- Key tables: organizations, workspaces, users, user_profiles, roles, role_bindings, sessions, devices, personas, avatars, avatar_assets, conversations, conversation_messages, audio_recordings, transcripts, transcript_segments, recording_summaries, memories, memory_embeddings, tasks, reminders, notifications, integrations, integration_connections, tool_definitions, tool_executions, tool_approvals, consent_records, privacy_preferences, retention_policies, deletion_requests, data_exports, audit_logs, usage_records, subscriptions, feature_flags, provider_configs, incident_events, translations, companion_configs
- **pgvector** support for memory embeddings
- Migrations exist in `packages/database/drizzle/`
- Drizzle relations fully defined

### API Routes (services/api/src/server.ts)
- `/healthz` — health (no auth)
- `/api/auth` — login/register (rate-limited, no JWT)
- `/api/conversations`, `/api/ai`, `/api/chat`, `/api/memories`, `/api/settings`, `/api/voice`, `/api/biometric`, `/api/streaming`, `/api/notifications`, `/api/upload`, `/api/subscriptions`, `/api/webhooks` — JWT + rate-limited
- `/api/admin` — JWT + admin role
- `/api/tasks` — JWT-protected
- WebSocket: express-ws + socket.io

### AI Providers
- Claude (Anthropic SDK), OpenAI, Gemini, Perplexity
- Routing logic in `packages/ai-core/src/orchestrator.ts`

### Voice Providers
- Deepgram (STT), Sarvam (STT), Google Cloud (STT/TTS)
- Routing logic in `packages/voice/src/engine.ts`

### Deployment
- **Terraform** in `infrastructure/terraform/` (AWS: compute, database, load balancer, storage)
- **Docker Compose** for local (`docker-compose.yml`) and production (`docker-compose.prod.yml`)
- **Dockerfiles** for API, admin, and other services in `deploy/`

### Observability
- **Pino** structured logging (replaced morgan/console)
- **Sentry** integration in `packages/observability`
- **OpenTelemetry** support

### CI/CD
- GitHub Actions (`.github/workflows/ci.yml`) — **PASSING**

---

## 2. What Works

| Component | Verification Method | Result |
|-----------|---------------------|--------|
| **CI/CD** | GitHub Actions | PASS |
| **Build** | `pnpm run build` (turbo) | PASS |
| **TypeScript** | Build includes type-checking | PASS |
| **Dev server** | `pnpm --filter @nova/api dev` | PASS — starts on port 3001 |
| **Health endpoint** | HTTP GET /healthz | PASS |
| **API route structure** | Code inspection | All routes mount correctly |
| **Database schema** | Code inspection | 40 tables, complete relations |
| **AI routing** | Code inspection | Multi-provider orchestration logic present |
| **Voice routing** | Code inspection | Multi-provider STT/TTS routing present |
| **WebSocket support** | Code inspection | express-ws + socket.io wired in server |

### Quality Gates (verified)
| Gate | Result |
|------|--------|
| `pnpm install` | PASS |
| `pnpm run build` | PASS |
| `pnpm run typecheck` | PASS |
| `pnpm run lint` | PASS |
| `pnpm test` | PASS |

---

## 3. What Fails / Not Tested

| Component | Result | Reason |
|-----------|--------|--------|
| **PostgreSQL** | BLOCKED | No local PostgreSQL available |
| **Redis** | BLOCKED | No local Redis available |
| **Database migrations** | BLOCKED | Requires PostgreSQL |
| **Database queries** | BLOCKED | Requires PostgreSQL |
| **Redis integration** | BLOCKED | Requires Redis |
| **WebSocket gateway** | BLOCKED | Requires Redis |
| **AI live** | BLOCKED | No provider API keys |
| **Voice live** | BLOCKED | No provider API keys |
| **Stripe webhook** | BLOCKED | No Stripe credentials |
| **Clerk auth** | BLOCKED | No Clerk API keys |
| **Mobile** | UNVERIFIED | Partial codebase, many deleted files |
| **Admin service** | NOT_TESTED | Not independently started |
| **Agent orchestrator** | NOT_TESTED | Not independently started |

---

## 4. Exact Blockers

### Infrastructure Blockers
1. **No PostgreSQL** — `docker compose ps` shows no running database. Cannot verify Drizzle schema, migrations, or any database-dependent route.
2. **No Redis** — Cannot verify Redis-dependent features (WebSocket gateway, caching, sessions).
3. **No third-party API keys** — Clerk, Anthropic, OpenAI, Google, Deepgram, Sarvam, Stripe credentials unavailable in this environment.

### Codebase Blockers
4. **Massive working tree changes** — 678 modified/deleted files. The working tree diverges significantly from HEAD. This does not affect runtime but indicates active development.
5. **Mobile app partially deleted** — Many `apps/mobile/` files show as deleted in working tree. Mobile status is unclear.
6. **`api_disabled` service deleted** — Entire `services/api_disabled/` directory removed in working tree.

### Environment Blockers
7. **No `.env` file** — Only `.env.example` exists. No runtime configuration available.
8. **Cannot independently start services** — Admin, agent-orchestrator, auth, voice, realtime services exist but were not independently started.

---

## 5. Unknowns

| Unknown | Why |
|---------|-----|
| Is PostgreSQL reachable remotely? | Only local Docker was checked |
| Is Redis reachable remotely? | Only local Docker was checked |
| Do AI provider keys exist in production? | No `.env` available |
| Does Clerk production config exist? | No `.env` available |
| Does Stripe webhook signing work end-to-end? | No Stripe keys |
| Can mobile app build/launch? | Too many deleted files to verify |
| Does the WebSocket gateway actually connect clients? | Requires Redis |
| Are database migrations up to date? | Cannot run without PostgreSQL |
| Do admin/agent-orchestrator services start independently? | Not tested |
| What is the intended deployment topology? | Terraform exists but not deployed |

---

## Verified Commands

```bash
# Baseline
git rev-parse HEAD # aecf03f4169179350d94cff85871974f7908d919
git branch --show-current # main
git status --porcelain # 678 lines

# Quality gates
pnpm install # PASS
pnpm run build # PASS
pnpm run typecheck # PASS
pnpm run lint # PASS
pnpm test # PASS

# Dev server
pnpm --filter @nova/api dev # PASS — starts on http://0.0.0.0:3001
curl http://localhost:3001/healthz # PASS

# Infrastructure
docker ps # No PostgreSQL, no Redis
docker compose ps # No services running
```
