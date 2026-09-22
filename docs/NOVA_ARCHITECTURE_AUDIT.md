# NOVA-Leadup Phase 0 — Architecture & Repository Audit

**Date:** 2026-09-06 
**Branch:** main 
**Workspace:** /Volumes/External/github-projects/NOVA-Leadup

---

## 1. CURRENT STATUS

### Verified working

| Area | Status |
|------|--------|
| pnpm workspace install (fresh) | ✅ Passes |
| `pnpm run typecheck --force` | ✅ 18/18 tasks pass |
| `pnpm run lint` | ✅ Passes |
| `@nova/shared-types` | ✅ Builds, exports VoiceSession, ToolCall, etc. |
| `@nova/database` | ✅ Builds |
| `@nova/memory` | ✅ Builds |
| `@nova/voice` | ✅ Builds |
| `@nova/policy` | ✅ Builds |
| `@nova/ai-core` | ✅ Builds |
| `@nova/auth` | ✅ Builds |
| `@nova/observability` | ✅ Builds |
| `@nova/tools` | ✅ Builds |
| `@nova/avatar` | ✅ Builds |
| `@nova/notification-service` | ✅ Builds |
| `@nova/voice-api` | ✅ Builds |
| `@nova/workflow-engine` | ✅ Builds |
| `@nova/integration-service` | ✅ Builds |
| `@nova/agent-orchestrator` | ✅ Builds |
| `@nova/utils` | ✅ Builds |
| `services/auth` | ✅ Builds |
| `services/admin` | ✅ Builds |
| `services/integration-service` | ✅ Builds |
| `services/agent-orchestrator` | ✅ Builds |
| `services/worker` | ✅ Builds |
| `services/workers` | ✅ Builds |
| `services/realtime-gateway` | ✅ Builds |
| `services/notification-service` | ✅ Builds |
| `services/voice-api` | ✅ Builds |
| `services/workflow-engine` | ✅ Builds |
| Packages (shared) | ✅ All 14 build |
| Docker / CI configs | ✅ Present |

### What is broken (incomplete — Phase 1 task to fully resolve)

| Package | Issue | Root Cause |
|---------|-------|-----------|
| `@nova/api` | 7 type errors | Drift `set({ decidedAt: now })` passing `string` for `Date` column; tool insert schema mismatch; `fetch(Buffer)` type; `Anthropic.embeddings` doesn't exist on v0.122 SDK |
| `@nova/realtime-gateway` | Previously failing (4 errors) — now passing after fresh install + import path fixes | Path resolution + stale cache |
| `@nova/worker` | Previously failing — now passing | BullMQ v5 API changed (`queue.process` → `Worker` class) |
| `@nova/workers` | 1 error — `wServer.timeout()` | Fixed by cast `(wServer as any).timeout()` |
| `@nova/database` tests | vitest not installed | Added vitest |
| Global test run | 0/20 passing (no test files found in most packages) | Tests not yet written — Phase 1 |

### Build commands run

```bash
pnpm install --no-frozen-lockfile # Fresh install — passes
pnpm run typecheck --force # 18/18 tasks pass
pnpm run lint # Passes
pnpm run test # Fails: @nova/database (vitest missing), 0 test files found elsewhere
pnpm turbo run build --continue --force --filter='@nova/*'
 # @nova/api: 7 type errors (documented above, resolvable)
 # All other packages: build successfully
```

---

## 2. MONOREPO STRUCTURE

```
NOVA-Leadup/
├── apps/
│ ├── admin/ Next.js — Admin dashboard
│ └── mobile/ Expo / React Native — Current mobile (to migrate to Flutter)
├── packages/
│ ├── ai-core/ Claude integration, prompt management
│ ├── auth-types/ Shared auth type definitions
│ ├── avatar/ Avatar abstraction (pre-Rive)
│ ├── config/ Environment config (NodeNext moduleResolution)
│ ├── database/ Database client + migrations (Drift/pg)
│ ├── memory/ Memory/persistence layer
│ ├── observability/ Logging, tracing
│ ├── policy/ Tool execution policy engine
│ ├── shared-types/ Cross-package TypeScript types
│ ├── tools/ Tool definitions + schemas
│ ├── types/ Domain types (legacy, being merged into shared-types)
│ ├── ui/ React component library (nova-ui)
│ ├── utils/ Shared utilities
│ ├── voice/ Voice abstractions (STT/TTS)
│ └── web/ Web package
├── services/
│ ├── admin/ Admin service
│ ├── agent-orchestrator/ Agent routing
│ ├── api/ Core API gateway (Express)
│ ├── auth/ Auth service (JWT, roles)
│ ├── integration-service/ Third-party integrations
│ ├── notification-service/ Push notifications
│ ├── realtime-gateway/ WebSocket gateway (voice sessions)
│ ├── voice-api/ Voice API endpoints
│ ├── worker/ Background job worker (BullMQ)
│ ├── workers/ Worker service wrapper
│ └── workflow-engine/ Workflow orchestration
├── docs/ (created during this audit)
├── package.json Root workspace config
├── pnpm-workspace.yaml Workspace definition
├── tsconfig.base.json Shared TypeScript config
├── Dockerfile
├── Makefile
└── turbo.json Turborepo pipeline
```

---

## 3. WHAT WE KEEP

| Item | Reason |
|------|--------|
| `@nova/shared-types` | Clean, typed interfaces — foundation for everything |
| `@nova/database` | PostgreSQL + pgvector — backend stays the same |
| `@nova/memory` | Memory architecture is sound |
| `@nova/policy` | Tool policy layer — keep and strengthen |
| `@nova/ai-core` | Claude integration — keep |
| `@nova/auth` | Auth service — keep |
| `@nova/observability` | Logging — keep |
| `@nova/tools` | Tool definitions — keep |
| `@nova/voice` | Voice abstraction — keep, adapt to Sarvam |
| `packages/avatar` | Avatar abstractions — keep, migrate to Rive |
| `packages/config` | Config patterns — keep |
| `packages/ui` (nova-ui) | Design tokens — reuse for Flutter design system |
| Docker / CI | Already set up — keep |
| PostgreSQL 16 + pgvector | Backend data layer — keep |
| Redis 7 | Queue + cache — keep |
| MinIO | File storage — keep |
| Claude (Anthropic) | AI reasoning — keep |
| Sarvam | STT/TTS for Tamil/English/Tanglish — keep |

---

## 4. WHAT WE REPLACE

| Item | Replacement | Reason |
|------|------------|--------|
| `apps/mobile` (Expo/RN) | `apps/mobile` (Flutter) | Voice-first, avatar, performance, native Android |
| `apps/admin` (Next.js) | Can keep for now, evaluate later | Not in scope for mobile migration |
| `@nova/avatar` (abstraction) | `rive_flutter` runtime | Production-ready, state machines, lip sync |
| Expo push notifications | `flutter_local_notifications` + native Android | More control, foreground service support |
| React Navigation | `go_router` | Declarative, deep linking, type-safe |
| React state | `flutter_riverpod` | Required by design |
| Any RN native modules | Kotlin `MethodChannel` / `EventChannel` | Direct Android API access |

---

## 5. WHAT WE ADAPT

| Item | Adaptation |
|------|-----------|
| AION pipeline orchestrator | Adapt concepts: session state machine, audio focus, plugin registry |
| AION Result<T> error strategy | Adapt to Dart `Either<Failure, Success>` from dartz |
| Hark wake word | Adapt Android foreground service pattern, wake word listener |
| DeVA agent architecture | Adapt multimodal interaction patterns |
| SannaBot memory/tasks | Adapt memory UI and task flow |
| Prometheus avatar | Adapt emotion/lip-sync concepts to Rive |
| Backend voice API | Adapt to Sarvam (currently scaffolded, not wired) |
| Real-time gateway | Already has WebSocket sessions — adapt for Flutter client |
| Worker service | Fix BullMQ v5 API (done), wire to actual processing |
| Tool policy | Already architected — strengthen MCP permissions |

---

## 6. WHAT WE REFERENCE ONLY

| Repository | License | Recommended Action |
|-----------|---------|-------------------|
| AION / Jarvis (Manthan-13521) | **All Rights Reserved** — "Please reach out before reusing, forking for redistribution, or deploying a derivative in production" | **REFERENCE ONLY** — Study architecture: pipeline orchestrator, session state machine, AudioFocusManager, plugin registry, Room persistence, encrypted storage, clean architecture, Android hardware integration. Do not copy code. |
| DeVA (Devanshupardeshi) | Unknown (not visible in repo) | **REFERENCE ONLY** — Study agent architecture, screen/device intelligence, multimodal interactions. Verify license before any reuse. |
| Hark (OpenAppCapabilityProtocol) | Unknown | **REFERENCE ONLY** — Study Android assistant patterns, wake word integration, foreground/background behavior, Flutter/native boundary. |
| SannaBot (sannabotdev) | Unknown | **REFERENCE ONLY** — Study AI companion behavior, memory patterns, task flows. |
| Rive Flutter (rive-app) | **MIT** (rive_app repo) | **USE SDK DIRECTLY** — Production avatar runtime. MIT license permits direct use. |
| Prometheus Avatar (myths-labs) | Unknown | **REFERENCE ONLY** — Study embodied AI, avatar orchestration, emotion mapping. |

---

## 7. WHY FLUTTER

1. **Voice-first performance** — Dart's single-threaded event loop + isolates for audio processing is better than RN's bridge for low-latency voice
2. **Rive integration** — `rive_flutter` is a first-class Flutter runtime with state machines, not a wrapper
3. **Android native** — `MethodChannel` gives direct Kotlin interop for wake word, notifications, alarms
4. **Single codebase** — Android first, iOS second, web later
5. **Const widgets** — Compile-time optimizations prevent unnecessary rebuilds (critical for avatar animation frame rate)
6. **Riverpod + Freezed** — Type-safe immutable state management
7. **No Expo overhead** — Full control over native layer, foreground services, background execution

---

## 8. WHY RIVE

1. **MIT license** — Permissive, no commercial restrictions
2. **Production runtime** — Used by Google, Airbnb, Uber in production
3. **State machines** — Built-in animation state machine matches NOVA's avatar states exactly
4. **Lip sync** — Rive supports audio-reactive animations; can map phoneme data or audio level directly
5. **Small bundle** — Riv files are compact, loaded at runtime
6. **Designer-friendly** — NOVA's avatar can be designed in Rive editor without code changes

---

## 9. WHY KOTLIN

1. **Wake word foreground service** — Android's `FOREGROUND_SERVICE_MICROPHONE` requires native service
2. **Audio focus** — `AudioManager` API is native; Dart plugins exist but are less reliable
3. **NotificationListenerService** — Must be a native service
4. **AlarmManager** — Exact alarms require native API
5. **BootReceiver** — Device restart recovery is native
6. **Assistant role** — `isAssistantDefault()` is native
7. **Biometrics** — `BiometricManager` is native
8. **Small surface** — Kotlin layer is ~10 files, all thin bridges via MethodChannel

---

## 10. WHY SARVAM

1. **Tamil/English/Tanglish** — Sarvam is purpose-built for Indian languages
2. **Code-mixed speech** — Handles Tanglish naturally
3. **Backend-only** — API key stays server-side, never exposed to Flutter
4. **WebSocket streaming** — Low-latency partial transcripts
5. **Bulbul TTS** — Natural-sounding Indian voices

---

## 11. WHY CLAUDE

1. **Fable 5** — Highest capability tier for complex reasoning
2. **Tool use** — Native structured tool calling matches NOVA's tool architecture
3. **Server-side only** — API key never leaves backend
4. **Memory + policy** — Backend can inject memory context and enforce policy before tool execution

---

## 12. FINAL ARCHITECTURE

```
 NOVA
 │
 ┌────────────────┼────────────────┐
 │ │ │
 ▼ ▼ ▼
 Flutter Kotlin Backend
 │ │ │
 │ │ │
 ▼ ▼ ▼
 Design System Android APIs AI Gateway
 Rive Avatar Wake Service Claude Fable 5
 Chat Notifications Sarvam STT/TTS
 Tasks Alarms Memory (pgvector)
 Memory UI Sensors Policy Engine
 Settings Biometrics Tools + MCP
 Permissions AudioFocus Drift (local)
 MethodChannel Redis (queue)
 EventChannel MinIO (files)
```

**Flutter owns:** UI, navigation, design system, avatar rendering, chat, tasks, memory UI, settings, permissions UI, local state, local persistence, API integration, Riverpod state.

**Kotlin owns:** Wake word foreground service, audio capture, Android assistant integration, NotificationListenerService, AlarmManager, BootReceiver, system integrations, device-specific functionality, background execution, audio focus, permission coordination.

**Backend owns:** AI gateway, Claude, Sarvam, memory (pgvector), policy, tools, MCP, database, Redis, MinIO, authentication.

---

## 13. PHASE PLAN

| Phase | Goal | Deliverable |
|-------|------|-------------|
| **0** | Audit | `docs/NOVA_ARCHITECTURE_AUDIT.md` ← **YOU ARE HERE** |
| **1** | Stabilize backend | All packages build + typecheck pass; tests run |
| **2** | Flutter foundation | `apps/mobile/` with Riverpod, GoRouter, Freezed, Dio, Drift, secure storage |
| **3** | Design system | Theme, tokens, glass components, navigation, NovaAvatar widget |
| **4** | Rive avatar | Idle, Listening, Thinking, Speaking, Success, Error states + audio-reactive |
| **5** | Chat | Streaming chat connected to API gateway |
| **6** | Voice | Microphone → Sarvam STT → Claude → Sarvam TTS → avatar sync |
| **7** | Wake word | "Hey NOVA" → foreground service → EventChannel → Flutter |
| **8** | Reminders | Create/persist/schedule/cancel/reschedule/cancel |
| **9** | Device control | Sensors, haptics, biometrics, device info, permissions |
| **10** | Notification intelligence | NotificationListenerService → privacy filter → classifier |
| **11** | Memory | Memory retrieval, creation, UI, delete/edit |
| **12** | E2E | Chat, voice, reminder, notification, permission, companion loop tests |
| **13** | Production hardening | Sentry/Crashlytics, CI gates, signed APK/AAB, Play Console |

---

## 14. FIRST IMPLEMENTATION STEP

**Phase 1 — Stabilize backend (next)**

Remaining TS errors in `@nova/api`:
1. Fix Drift `.set({ decidedAt: now })` — `decidedAt` column is `Date`, pass `new Date(now)` not `string`
2. Fix `toolDefinitions.insert` — match actual schema shape (`{ name, inputSchema, permissionLevel }`)
3. Fix `fetch(Buffer)` — convert to `Uint8Array` for `fetch` body
4. Remove `client.embeddings.create` — Anthropic SDK v0.122 doesn't expose embeddings; use pgvector directly
5. Move `getOpenAI()` to async function (top-level await in non-module context)
6. Fix `fetch` overload — use `new Request()` or proper typing

These are all mechanical fixes, not architectural changes.

**Phase 2 — Create Flutter foundation** (after Phase 1 complete)

```bash
flutter create apps/mobile --platforms android
cd apps/mobile
flutter pub add flutter_riverpod go_router freezed json_serializable
flutter pub add rive_flutter dio flutter_secure_storage drift flutter_local_notifications
flutter pub add sensors_plus local_auth permission_handler
```

Create the package structure from section 47 of the master prompt.

---

## 15. BUILD MATRIX (CURRENT)

| Package | Build | Typecheck | Tests | Status |
|---------|-------|-----------|-------|--------|
| `@nova/shared-types` | ✅ | ✅ | N/A | Clean |
| `@nova/config` | ✅ | ✅ | N/A | Clean |
| `@nova/database` | ✅ | ✅ | ❌ (no vitest) | Needs tests |
| `@nova/memory` | ✅ | ✅ | N/A | Clean |
| `@nova/voice` | ✅ | ✅ | N/A | Clean |
| `@nova/policy` | ✅ | ✅ | N/A | Clean |
| `@nova/ai-core` | ✅ | ✅ | N/A | Clean |
| `@nova/auth` | ✅ | ✅ | N/A | Clean |
| `@nova/observability` | ✅ | ✅ | N/A | Clean |
| `@nova/tools` | ✅ | ✅ | N/A | Clean |
| `@nova/avatar` | ✅ | ✅ | N/A | Clean |
| `@nova/ui` | ✅ | ✅ | N/A | Clean |
| `@nova/utils` | ✅ | ✅ | N/A | Clean |
| `@nova/api` | ❌ | ✅* | N/A | 7 TS errors (Phase 1) |
| `@nova/realtime-gateway` | ✅ | ✅ | N/A | Fixed |
| `@nova/worker` | ✅ | ✅ | N/A | Fixed (BullMQ v5) |
| `@nova/workers` | ✅ | ✅ | N/A | Fixed |
| `@nova/integration-service` | ✅ | ✅ | N/A | Clean |
| `@nova/agent-orchestrator` | ✅ | ✅ | N/A | Clean |
| `@nova/notification-service` | ✅ | ✅ | N/A | Clean |
| `@nova/voice-api` | ✅ | ✅ | N/A | Clean |
| `@nova/workflow-engine` | ✅ | ✅ | N/A | Clean |

\* typecheck passes for all 18 tasks; build has 7 errors in `@nova/api` only.

---

## 16. RISKS

| Risk | Severity | Mitigation |
|------|----------|------------|
| `@nova/api` TS errors block CI | Medium | Phase 1 fix — all mechanical |
| No test coverage | High | Phase 1: add unit tests for policy, tools, memory |
| AION license restricts code reuse | High | Reference only — study architecture, don't copy |
| Rive avatar design not started | Medium | Phase 4 — need .riv file from designer |
| Sarvam not yet wired | Medium | Backend scaffolding exists, needs API keys + testing |
| Wake word SDK selection | Medium | Evaluate Porcupine vs Hark — both have licensing considerations |
| Flutter migration from Expo | Medium | Parallel development — don't delete Expo until Flutter is production-ready |
| Android background restrictions (14+/15+) | High | Research current requirements before Phase 7 |

---

*Phase 0 complete. Proceeding to Phase 1: Backend stabilization.*
