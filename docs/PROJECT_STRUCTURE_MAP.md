# NOVA-Leadup — Complete Project Structure Map

> **Generated:** 2026-09-11
> **Purpose:** Exhaustive reference of every directory, key file, tech stack component, and architectural role in the NOVA-Leadup monorepo.

---

## Table of Contents

1. [Root Level Overview](#1-root-level-overview)
2. [Package Manager & Workspace Configuration](#2-package-manager--workspace-configuration)
3. [Apps Layer](#3-apps-layer)
4. [Services Layer](#4-services-layer)
5. [Packages Layer (Shared Libraries)](#5-packages-layer-shared-libraries)
6. [Infrastructure Layer](#6-infrastructure-layer)
7. [Documentation Layer](#7-documentation-layer)
8. [Tech Stack Summary](#8-tech-stack-summary)
9. [Service Architecture & Communication](#9-service-architecture--communication)
10. [Database Layer](#10-database-layer)
11. [CI/CD & DevOps](#11-cicd--devops)
12. [Configuration & Environment](#12-configuration--environment)

---

## 1. Root Level Overview

```
NOVA-Leadup/
├── apps/ # Frontend applications (mobile, admin dashboard)
├── services/ # Backend microservices (API, auth, realtime, AI, etc.)
├── packages/ # Shared libraries and internal npm packages
├── infrastructure/ # Deployment configs, docker, nginx, monitoring
├── docs/ # Project documentation
├── .claude/ # Claude Code configuration
├── .github/ # GitHub Actions CI/CD workflows
├── package.json # Root workspace package manifest
├── pnpm-workspace.yaml # pnpm monorepo workspace definition
├── tsconfig.json # Root TypeScript configuration
├── docker-compose.yml # Local development Docker compose
├── docker-compose.prod.yml # Production Docker compose
├── .env.example # Environment variable template
├── .gitignore # Git ignore rules
├── .dockerignore # Docker ignore rules
└── README.md # Project readme
```

### Root `package.json`
- **Type:** npm workspaces root
- **Purpose:** Defines workspace packages and shared scripts
- **Workspaces:** `apps/*`, `services/*`, `packages/*`

---

## 2. Package Manager & Workspace Configuration

### `pnpm-workspace.yaml`
- **Package Manager:** pnpm
- **Workspace Globs:** `apps/*`, `services/*`, `packages/*`
- **Purpose:** Enables monorepo dependency sharing via workspace protocol (`workspace:*`)

### Root `tsconfig.json`
- **Purpose:** Base TypeScript configuration shared across all packages
- **Strategy:** Extends into each sub-package with package-specific overrides

---

## 3. Apps Layer

### `apps/` directory

| Directory | Status | Purpose |
|-----------|--------|---------|
| `apps/admin/` | **Active** | Admin dashboard — management UI for users, organizations, incidents, feature flags, audit logs |
| `apps/mobile_old/` | **Legacy** | Older React Native mobile app (Expo SDK 57, React Native 0.86) |
| `apps/web/` | **Removed** | Was a source directory; currently empty/removed |

---

### `apps/admin/` — Admin Dashboard

```
apps/admin/
├── src/
│ └── app/
│ ├── audit-logs/
│ │ └── page.tsx # Audit log viewer page
│ ├── feature-flags/
│ │ └── page.tsx # Feature flag management page
│ ├── incidents/
│ │ └── page.tsx # Incident management page
│ ├── organizations/
│ │ └── page.tsx # Organization management page
│ ├── usage/
│ │ └── page.tsx # Usage analytics page
│ └── users/
│ └── page.tsx # User management page
├── package.json # @nova/admin — private
└── tsconfig.json
```

**Tech Stack:**
- **Runtime:** Node.js / Express
- **Language:** TypeScript
- **Auth:** JWT (`jsonwebtoken`), ED25519 keypairs
- **Database:** PostgreSQL (`pg`)
- **Monitoring:** Prometheus client (`prom-client`)
- **Logging:** Pino HTTP (`pino-http`)
- **Security:** Helmet, CORS, compression
- **WebSocket:** `express-ws`
- **Serving:** Static admin UI

**Key Dependencies:**
- `@nova/auth` (workspace)
- `express-ws`, `helmet`, `cors`, `compression`, `morgan`
- `jsonwebtoken`, `pg`, `prom-client`, `pino`

---

### `apps/mobile_old/` — Legacy Mobile App

```
apps/mobile_old/
├── src/
│ └── (legacy RN source)
├── android/
│ ├── app/
│ │ ├── src/
│ │ │ ├── main/ # Main Android source (partially deleted)
│ │ │ └── debug/
│ │ │ └── AndroidManifest.xml
│ │ ├── build.gradle # DELETED
│ │ ├── debug.keystore # DELETED
│ │ └── .gitignore
│ └── ...
├── package.json # nova-mobile
└── tsconfig.json
```

**Tech Stack:**
- **Framework:** React Native 0.86.3
- **Navigation:** Expo Router ~57.0.19
- **State:** Zustand 5.x
- **Styling:** Tailwind CSS (nativewind 4.x)
- **Build:** Expo ~57.0.20, EAS Build
- **Platform:** Android (iOS support in package.json but Android native dir present)
- **Key libs:** React Native Skia, Reanimated 4, Gesture Handler, Async Storage, NetInfo, Expo modules (AV, Speech, Secure Store, Notifications, etc.)
- **Icons:** Lucide React Native
- **Primitives:** rn-primitives

**Note:** The Android native directory has been significantly stripped (many files deleted), suggesting migration away from native Android.

---

## 4. Services Layer

### `services/` directory

| Service | Package | Port | Purpose |
|---------|---------|------|---------|
| `api` | `@nova/api` | 3001 | Core REST/GraphQL API |
| `auth` | `@nova/auth` (mounted as a service AND imported as a library) | 3003 | Authentication & authorization |
| `realtime-gateway` | `@nova/realtime-gateway` | 3002 | WebSocket realtime communication hub |
| `voice-api` | `@nova/voice-api` | — | **DEAD CODE — see below** |
| `notification-service` | `@nova/notification-service` | 3006 | Push/in-app notifications — **runs in production** as `nova-notifications` |
| `workflow-engine` | `@nova/workflow-engine` | 3010 | Workflow automation engine |
| `agent-orchestrator` | `@nova/agent-orchestrator` | — | **DEAD CODE — see below** |
| `integration-service` | `@nova/integration-service` | 3011 | Third-party integrations |
| `admin` | `@nova/admin` | 3004 | Admin backend API |
| `worker` | `@nova/worker` | — | **DEAD CODE — see below** |

> ### Five of these services do not run
>
> `agent-orchestrator`, `api_disabled`, `voice-api`, `worker` and `workers` are
> excluded from the build: their `build` and `typecheck` scripts are
> no-ops with a message pointing at their pending deletion. They are listed above only
> because this map is a map of what is in the tree, not of what runs.
>
> Their `test` scripts are untouched and still pass, so their suites are not silently
> broken — but nothing deploys them and no route reaches them. Some were crashed on
> the last recorded smoke run (`BACKEND_SMOKE_REPORT.md`) and nobody noticed, which
> is how dead services usually look from the outside.
>
> `notification-service` is NOT in that list. It was briefly marked dead here because
> a check for the string `notification-service` does not match its container name
> `nova-notifications`; it is running and in use.
>
> Also note `auth`: it is a running service **and** a library. Its `src/index.ts`
> exports the middleware that seventeen files across six services import. It used to
> call `app.listen()` at module scope, so every one of those imports booted a second
> auth server on whatever `PORT` was set. Listening is now guarded behind an
> entry-point check; import the package freely.

| `workers` | `@nova/workers` | — | Additional background workers |

---

### `services/api/` — Core API Service

```
services/api/
├── src/
│ ├── index.ts # Entry point
│ ├── routes/ # API route handlers
│ ├── middleware/ # Express middleware
│ ├── controllers/ # Request handlers
│ ├── services/ # Business logic
│ ├── models/ # Data models
│ ├── utils/ # Utilities
│ └── types/ # Service-specific types
├── Dockerfile # Docker build for production
├── Dockerfile.dev # Docker build for development
├── package.json # @nova/api
├── tsconfig.json
└── .env.example
```

**Tech Stack:**
- **Runtime:** Node.js / Express
- **Language:** TypeScript (strict mode)
- **ORM:** Drizzle ORM
- **Database:** PostgreSQL with pgvector
- **Cache:** Redis (ioredis)
- **Auth:** Auth0 / ED25519 JWT
- **AI:** Anthropic Claude SDK (`@anthropic-ai/sdk`)
- **Storage:** S3-compatible (MinIO in dev, S3 in prod)
- **Queue:** BullMQ
- **Security:** Helmet, CORS, rate limiting
- **Logging:** Pino / Morgan
- **Validation:** Zod

**Key Dependencies:**
- `@nova/auth`, `@nova/database`, `@nova/shared-types`, `@nova/voice`, `@nova/observability`
- `drizzle-orm`, `pg`, `pgvector`, `ioredis`, `bullmq`
- `@anthropic-ai/sdk`, `zod`, `express-ws`, `helmet`, `cors`, `compression`

---

### `services/auth/` — Authentication Service

```
services/auth/
├── src/
│ ├── index.ts
│ ├── routes/
│ ├── middleware/
│ ├── services/
│ └── utils/
├── package.json
└── tsconfig.json
```

**Purpose:** Handles user authentication, JWT issuance, token refresh, ED25519 key management, API key generation, session management.

**Tech Stack:** Node.js, Express, PostgreSQL, Redis, ED25519 cryptography

---

### `services/realtime-gateway/` — WebSocket Gateway

```
services/realtime-gateway/
├── src/
│ ├── server.ts # WebSocket server entry
│ ├── handlers/ # WS message handlers
│ ├── rooms/ # Room/channel management
│ └── middleware/ # WS auth middleware
├── package.json # @nova/realtime-gateway
└── tsconfig.json
```

**Purpose:** Central WebSocket hub for realtime features — live chat, presence, notifications, collaborative editing.

**Tech Stack:** Express + express-ws, ws, Redis pub/sub, JWT auth

**Key Dependencies:**
- `@nova/auth`, `@nova/observability`, `@nova/shared-types`
- `express-ws`, `ws`, `pino`, `zod`

---

### `services/voice-api/` — Voice Processing API

```
services/voice-api/
├── src/
│ ├── index.ts # Entry point
│ ├── routes/
│ └── services/
├── package.json # @nova/voice-api (private)
└── tsconfig.json
```

**Purpose:** Voice input/output processing, speech-to-text, text-to-speech, audio handling.

**Tech Stack:** Express, WebSocket, AWS S3 (audio storage), Zod validation

---

### `services/notification-service/` — Notifications

```
services/notification-service/
├── src/
│ ├── server.ts
│ ├── routes/
│ ├── services/
│ └── queue/ # BullMQ notification queues
├── package.json # @nova/notification-service
└── tsconfig.json
```

**Purpose:** Manages push notifications, in-app alerts, email notifications. Uses BullMQ for async processing.

**Tech Stack:** Express, BullMQ, Redis, PostgreSQL, S3 (media attachments)

**Key Dependencies:**
- `@nova/auth`, `@nova/database`, `@nova/shared-types`
- `bullmq`, `ioredis`, `express-ws`

---

### `services/workflow-engine/` — Workflow Automation

```
services/workflow-engine/
├── src/
│ ├── server.ts
│ ├── routes/
│ ├── engine/ # Workflow execution engine
│ ├── steps/ # Workflow step implementations
│ └── storage/ # Workflow persistence
├── package.json # @nova/workflow-engine
└── tsconfig.json
```

**Purpose:** Defines, executes, and monitors automated workflows. Supports multi-step pipelines with branching.

**Tech Stack:** Express, WebSocket, BullMQ, Redis, PostgreSQL, Zod validation

---

### `services/agent-orchestrator/` — AI Agent Orchestration

```
services/agent-orchestrator/
├── src/
│ ├── server.ts
│ ├── agents/ # Agent definitions
│ ├── tools/ # Tool definitions
│ ├── memory/ # Agent memory management
│ └── policy/ # Policy enforcement
├── package.json # @nova/agent-orchestrator
└── tsconfig.json
```

**Purpose:** Orchestrates AI agent workflows using Anthropic Claude. Manages agent lifecycle, tool calling, memory, and policy compliance.

**Tech Stack:** Anthropic Claude SDK, Express, WebSocket, Redis, Pino logging

**Key Dependencies:**
- `@anthropic-ai/sdk`, `@nova/ai-core`, `@nova/auth`, `@nova/memory`
- `@nova/observability`, `@nova/policy`, `@nova/shared-types`, `@nova/tools`, `@nova/voice`

---

### `services/integration-service/` — Third-Party Integrations

```
services/integration-service/
├── src/
│ ├── server.ts
│ ├── integrations/ # Third-party service adapters
│ └── webhooks/ # Webhook handlers
├── package.json # @nova/integration-service
└── tsconfig.json
```

**Purpose:** Manages external integrations (Slack, Google, etc.), webhook receivers, OAuth flows.

**Tech Stack:** Express, WebSocket, Zod, PostgreSQL, Redis, policy enforcement

---

### `services/admin/` — Admin Backend

```
services/admin/
├── src/
│ ├── index.ts
│ ├── routes/
│ └── middleware/
├── package.json # @nova/admin (private)
└── tsconfig.json
```

**Purpose:** Backend for the admin dashboard — user management, org management, audit logs, feature flags, incident tracking, usage analytics.

**Tech Stack:** Express, JWT, PostgreSQL, Prometheus metrics, Pino logging

---

### `services/worker/` — AI Background Worker

```
services/worker/
├── src/
│ ├── worker.ts # Worker entry
│ ├── jobs/ # Job processors
│ └── queue/ # BullMQ consumers
├── package.json # @nova/worker
└── tsconfig.json
```

**Purpose:** Background job processing for AI tasks — message processing, memory consolidation, report generation. Uses BullMQ + Redis.

**Key Dependencies:**
- `@anthropic-ai/sdk`, `@nova/ai-core`, `@nova/database`, `@nova/memory`
- `@nova/observability`, `@nova/shared-types`, `@nova/voice`
- `bullmq`, `ioredis`, `express-ws`

---

### `services/workers/` — Additional Workers

```
services/workers/
├── src/
│ ├── index.ts
│ └── (worker implementations)
├── package.json # @nova/workers (private)
└── tsconfig.json
```

**Purpose:** Additional background worker processes for NOVA operations.

**Tech Stack:** BullMQ, Redis, PostgreSQL, Pino logging

**Key Dependencies:**
- `@nova/types`, `@nova/utils`, `bullmq`, `ioredis`, `pg`, `pino`

---

## 5. Packages Layer (Shared Libraries)

### `packages/` directory

| Package | Name | Purpose |
|---------|------|---------|
| `database` | `@nova/database` | Drizzle ORM schemas, migrations, DB utilities |
| `ai-core` | `@nova/ai-core` | Core AI primitives, agent interfaces, tool definitions |
| `shared-types` | `@nova/shared-types` | Shared TypeScript types/interfaces across services |
| `auth-types` | `@nova/auth-types` | Auth schemas, constants, shared auth types (private) |
| `voice` | `@nova/voice` | Voice processing types and utilities |
| `ui` | `nova-ui` | Shared React UI components |
| `avatar` | `@nova/avatar` | Avatar generation and management |
| `memory` | `@nova/memory` | Agent memory system (pgvector-backed) |
| `observability` | `@nova/observability` | OpenTelemetry tracing, logging, metrics |
| `policy` | `@nova/policy` | Authorization policy engine (Redis-backed) |
| `config` | `@nova/config` | Shared ESLint, Prettier, TypeScript configs (private) |
| `tools` | `@nova/tools` | Tool definitions for AI agents |
| `types` | `@nova/types` | Legacy shared types (private) |
| `utils` | `@nova/utils` | Legacy shared utilities (private) |

---

### `packages/database/` — Database Package

```
packages/database/
├── src/
│ ├── index.ts # Main exports
│ ├── schema.ts # Drizzle schema definitions
│ ├── migrations/ # SQL migrations
│ ├── queries/ # Reusable query builders
│ └── utils/ # DB utilities
├── drizzle.config.ts # Drizzle Kit configuration
├── package.json # @nova/database
└── tsconfig.json
```

**Purpose:** Centralized database schema, migrations, and query utilities for all services.

**Tech Stack:**
- **ORM:** Drizzle ORM ^0.39.0
- **Database:** PostgreSQL 16 (with pgvector for embeddings)
- **Migration Tool:** Drizzle Kit
- **Client:** `pg`, `postgres`, `ioredis` (Redis for caching)
- **Storage:** AWS S3 SDK (`@aws-sdk/client-s3`)

**Key Scripts:**
- `pnpm generate` — Generate migrations from schema
- `pnpm migrate` — Run migrations
- `pnpm migrate:rollback` — Rollback last migration

---

### `packages/ai-core/` — AI Core Library

```
packages/ai-core/
├── src/
│ ├── index.ts
│ ├── agent.ts # Agent base class/interfaces
│ ├── conversation.ts # Conversation management
│ ├── streaming.ts # Streaming utilities
│ └── types.ts
├── package.json # @nova/ai-core
└── tsconfig.json
```

**Purpose:** Core AI abstractions — agent interfaces, conversation handling, streaming primitives.

**Tech Stack:** Anthropic Claude SDK, Zod validation

---

### `packages/shared-types/` — Shared TypeScript Types

```
packages/shared-types/
├── src/
│ ├── index.ts
│ ├── api.ts # API request/response types
│ ├── auth.ts # Authentication types
│ ├── user.ts # User domain types
│ ├── organization.ts # Organization types
│ ├── voice.ts # Voice types
│ └── (other domain types)
├── package.json # @nova/shared-types
└── tsconfig.json
```

**Purpose:** Canonical TypeScript type definitions shared across all services and apps. Prevents type drift.

---

### `packages/auth-types/` — Auth Types Package

```
packages/auth-types/
├── src/
│ ├── index.ts
│ ├── schemas.ts # Zod schemas for auth
│ ├── constants.ts # Auth constants
│ └── types.ts
├── package.json # @nova/auth-types (private)
└── tsconfig.json
```

**Purpose:** Shared auth validation schemas, constants, and types for the monorepo.

---

### `packages/voice/` — Voice Library

```
packages/voice/
├── src/
│ ├── index.ts
│ ├── stt.ts # Speech-to-text
│ ├── tts.ts # Text-to-speech
│ ├── audio.ts # Audio processing
│ └── types.ts
├── package.json # @nova/voice
└── tsconfig.json
```

**Purpose:** Voice processing utilities — STT/TTS abstractions, audio format handling.

**Tech Stack:** Anthropic Claude SDK (audio), AWS S3 (audio storage), Zod

---

### `packages/ui/` — Shared UI Components

```
packages/ui/
├── src/
│ ├── index.ts
│ ├── components/ # Reusable React components
│ ├── hooks/ # Custom React hooks
│ ├── styles/ # Shared styles
│ └── utils/ # Frontend utilities
├── package.json # nova-ui (private)
└── tsconfig.json
```

**Purpose:** Shared React component library used across admin dashboard and mobile app.

**Tech Stack:** React 18.x, TypeScript

---

### `packages/avatar/` — Avatar Package

```
packages/avatar/
├── src/
│ ├── index.ts
│ └── (avatar logic)
├── package.json # @nova/avatar
└── tsconfig.json
```

**Purpose:** Avatar generation and management utilities.

---

### `packages/memory/` — Agent Memory

```
packages/memory/
├── src/
│ ├── index.ts
│ ├── store.ts # Memory store interface
│ ├── pgvector.ts # pgvector-backed memory
│ └── types.ts
├── package.json # @nova/memory
└── tsconfig.json
```

**Purpose:** Agent memory system — stores conversation history and embeddings using pgvector for semantic search.

**Tech Stack:** Drizzle ORM, pgvector, PostgreSQL, Zod

---

### `packages/observability/` — Observability

```
packages/observability/
├── src/
│ ├── index.ts
│ ├── tracing.ts # OpenTelemetry tracing
│ ├── metrics.ts # Metrics collection
│ ├── logging.ts # Structured logging
│ └── config.ts
├── package.json # @nova/observability
└── tsconfig.json
```

**Purpose:** Centralized observability — OpenTelemetry distributed tracing, metrics, structured logging.

**Tech Stack:** OpenTelemetry SDK for Node, OTLP HTTP exporter, auto-instrumentations

---

### `packages/policy/` — Policy Engine

```
packages/policy/
├── src/
│ ├── index.ts
│ ├── engine.ts # Policy evaluation engine
│ ├── rules/ # Policy rules
│ └── cache.ts # Redis-backed policy cache
├── package.json # @nova/policy
└── tsconfig.json
```

**Purpose:** Authorization policy engine — RBAC/ABAC policy evaluation, rate limiting rules, feature access control.

**Tech Stack:** ioredis (caching), Zod (schema validation)

---

### `packages/config/` — Shared Config

```
packages/config/
├── (config files)
├── package.json # @nova/config (private)
└── tsconfig.json
```

**Purpose:** Shared ESLint, Prettier, and TypeScript configuration across the monorepo.

---

### `packages/tools/` — AI Tool Definitions

```
packages/tools/
├── src/
│ ├── index.ts
│ ├── definitions/ # Tool definitions for Claude
│ └── registry.ts # Tool registry
├── package.json # @nova/tools
└── tsconfig.json
```

**Purpose:** Tool definitions for AI agent function calling with Anthropic Claude.

---

### `packages/types/` — Legacy Shared Types

```
packages/types/
├── src/
│ └── index.ts
├── package.json # @nova/types (private)
└── tsconfig.json
```

**Purpose:** Legacy shared TypeScript types (being migrated to `@nova/shared-types`).

---

### `packages/utils/` — Legacy Utilities

```
packages/utils/
├── src/
│ ├── index.ts
│ └── (utility functions)
├── package.json # @nova/utils (private)
└── tsconfig.json
```

**Purpose:** Legacy shared utility functions (being migrated/consolidated).

---

## 6. Infrastructure Layer

### `infrastructure/` directory

```
infrastructure/
├── docker/
│ ├── Dockerfile # Generic service Dockerfile
│ ├── Dockerfile.dev # Development Dockerfile
│ └── .dockerignore
├── nginx/
│ ├── nginx.conf # Reverse proxy config
│ ├── conf.d/
│ └── ssl/ # TLS certificates
├── prometheus/
│ └── prometheus.yml # Prometheus scrape config
├── grafana/
│ ├── dashboards/ # Pre-built dashboards
│ └── provisioning/
├── postgres/
│ └── init/
│ └── *.sql # DB init scripts
├── backups/ # Database backup scripts
├── scripts/ # Deployment/maintenance scripts
└── kubernetes/ # K8s manifests (if any)
```

### `infrastructure/postgres/init/`
- **Purpose:** SQL initialization scripts for PostgreSQL containers
- **Used by:** `docker-compose.prod.yml` volume mount at `/docker-entrypoint-initdb.d:ro`

### `infrastructure/nginx/`
- **Purpose:** Reverse proxy for routing traffic to microservices
- **Services Proxied:** API, Auth, Realtime, Admin, Notifications, Integration, Workflow
- **TLS:** SSL termination at nginx

### `infrastructure/prometheus/`
- **Purpose:** Metrics collection and alerting
- **Config:** `prometheus.yml` with scrape targets for all services

### `infrastructure/grafana/`
- **Purpose:** Metrics visualization and dashboards
- **Dashboards:** Pre-built for API latency, database performance, agent metrics, system health

### `infrastructure/backups/`
- **Purpose:** Automated database backup scripts
- **Location:** Mounted as volume in PostgreSQL container

---

## 7. Documentation Layer

### `docs/` directory

```
docs/
├── PROJECT_STRUCTURE_MAP.md # This document
├── (additional documentation)
```

---

## 8. Tech Stack Summary

### Languages & Runtimes
| Technology | Version | Usage |
|------------|---------|-------|
| **TypeScript** | ^5.7.0–5.8.3 | Primary language across all services and packages |
| **Node.js** | 20+ | Runtime for all backend services |
| **React** | 19.2.3 | Mobile app UI |
| **React Native** | 0.86.3 | Cross-platform mobile (legacy) |

### Backend Framework
| Technology | Purpose |
|------------|---------|
| **Express 4.x** | HTTP server for all backend services |
| **express-ws** | WebSocket support for realtime services |
| **Zod** | Runtime schema validation across all services |

### Database & Storage
| Technology | Purpose |
|------------|---------|
| **PostgreSQL 16** | Primary relational database |
| **pgvector** | Vector embeddings for AI/semantic search |
| **Drizzle ORM** | Type-safe ORM and migrations |
| **Redis 7** | Caching, pub/sub, BullMQ broker, session store |
| **MinIO** | S3-compatible object storage (dev) |
| **AWS S3** | Object storage (prod) |

### AI & Intelligence
| Technology | Purpose |
|------------|---------|
| **Anthropic Claude SDK** | LLM integration (Claude models) |
| **pgvector** | Vector similarity search for memory |
| **BullMQ** | Background job processing for AI tasks |

### Authentication & Security
| Technology | Purpose |
|------------|---------|
| **Auth0** | Identity provider (or compatible IdP) |
| **ED25519** | Asymmetric JWT signing keypair |
| **JWT** | Access/refresh token authentication |
| **Helmet** | Security headers |
| **CORS** | Cross-origin resource sharing |

### Observability
| Technology | Purpose |
|------------|---------|
| **OpenTelemetry** | Distributed tracing |
| **Pino** | Structured JSON logging |
| **Prometheus** | Metrics collection |
| **Grafana** | Metrics visualization |
| **prom-client** | Prometheus metrics for admin service |

### Frontend
| Technology | Purpose |
|------------|---------|
| **Expo SDK 57** | React Native development framework |
| **Expo Router** | File-based navigation |
| **NativeWind 4** | Tailwind CSS for React Native |
| **Zustand 5** | State management |
| **React Native Skia** | High-performance graphics |
| **React Native Reanimated 4** | Animations |
| **Lucide RN** | Icon library |
| **rn-primitives** | Accessible UI primitives |

### DevOps & Deployment
| Technology | Purpose |
|------------|---------|
| **Docker** | Containerization |
| **Docker Compose** | Local/production orchestration |
| **pnpm** | Package manager with workspaces |
| **ESLint** | Linting |
| **Prettier** | Code formatting |
| **Vitest** | Testing framework |
| **tsx** | TypeScript execution (dev) |
| **tsc-alias** | Path alias resolution in compiled output |

---

## 9. Service Architecture & Communication

### Internal Communication Patterns

```
 ┌─────────────────┐
 │ Nginx (LB) │
 │ :80 / :443 │
 └────────┬────────┘
 │
 ┌────────────────────┼────────────────────┐
 │ │ │
 ▼ ▼ ▼
 ┌──────────┐ ┌──────────────┐ ┌──────────────┐
 │ API │ │ Auth │ │ Realtime GW │
 │ │ │ │ │ │
 └────┬─────┘ └──────┬───────┘ └──────┬───────┘
 │ │ │
 │ ┌──────────────┼──────────────┐ │
 │ │ │ │ │
 ▼ ▼ ▼ ▼ ▼
 ┌─────────────────────────────────────────────────┐
 │ Shared PostgreSQL (16 + pgvector) │
 └─────────────────────────────────────────────────┘
 ┌─────────────────────────────────────────────────┐
 │ Redis (pub/sub + cache + queues) │
 └─────────────────────────────────────────────────┘
```

### Service Dependency Graph

| Service | Depends On |
|---------|-----------|
| API | database, auth, shared-types, voice, observability |
| Auth | database, shared-types, observability |
| Realtime Gateway | auth, observability, shared-types |
| Voice API | auth, shared-types |
| Notification Service | auth, database, shared-types |
| Workflow Engine | database, shared-types |
| Agent Orchestrator | ai-core, auth, memory, observability, policy, shared-types, tools, voice |
| Integration Service | auth, database, policy, shared-types |
| Admin | auth (JWT), database, prom-client |
| Worker | ai-core, database, memory, observability, shared-types, voice |
| Workers | types, utils, bullmq, ioredis, pg |

---

## 10. Database Layer

### PostgreSQL (Primary Database)
- **Image:** `postgres:16-alpine` (dev) / `pgvector/pgvector:pg16` (prod)
- **Port:** 5432 (dev) / internal (prod)
- **Extensions:** pgvector for AI embeddings
- **Init Scripts:** `infrastructure/postgres/init/*.sql`
- **Volume:** `postgres_data`

### Redis
- **Image:** `redis:7-alpine`
- **Port:** 6379
- **Usage:** Caching, session store, BullMQ broker, pub/sub
- **Volume:** `redis_data`
- **Config:** `--maxmemory 256mb --maxmemory-policy allkeys-lru`

### MinIO (S3-Compatible Storage)
- **Image:** `minio/minio:RELEASE.2024-11-01T04-25-39Z`
- **Port:** 9000 (API) / 9001 (Console)
- **Purpose:** Local S3-compatible object storage for development

### Database Schema Packages
- **`@nova/database`** — Centralized Drizzle ORM schemas
- **`drizzle-kit`** — Migration generation and management
- **Migrations:** Managed via `pnpm generate` and `pnpm migrate`

---

## 11. CI/CD & DevOps

### GitHub Actions
```
.github/
└── workflows/
 └── ci.yml # CI pipeline
```

**Triggers:** Push, Pull Request
**Jobs:** Lint, Typecheck, Test, Build

### Docker Build Strategy
- **Development:** `docker-compose.yml` — builds from source with hot reload
- **Production:** `docker-compose.prod.yml` — uses pre-built local images, hardened security (read-only filesystems, no-new-privileges, resource limits)

### Production Services (docker-compose.prod.yml)
| Service | Port | Image | Resources |
|---------|------|-------|-----------|
| postgres | internal | pgvector/pgvector:pg16 | — |
| redis | internal | redis:7-alpine | 1 CPU, 512MB |
| minio | 9000/9001 | minio/minio | — |
| api | 3001 | nova-api:prod | 2 CPU, 1GB |
| auth | 3003 | nova-auth:latest | — |
| realtime-gateway | 3002 | nova-realtime-gateway:latest | — |
| notification-service | 3006 | nova-notification-service:v1.0.0 | 0.5 CPU, 512MB |
| integration-service | 3007 | nova-integration-service:v1.0.0 | 0.5 CPU, 512MB |
| workflow-engine | 3010 | nova-workflow-engine:latest | 0.5 CPU, 512MB |
| admin | 3004 | nova-web:latest | — |

---

## 12. Configuration & Environment

### `.env.example` Template
```
NODE_ENV=development
PORT=3000

# Database
DATABASE_URL=postgres://nova_user:REPLACE_WITH_REAL_PASSWORD@localhost:5432/nova
POSTGRES_USER=nova_user
POSTGRES_PASSWORD=REPLACE_WITH_REAL_PASSWORD
POSTGRES_DB=nova
POSTGRES_HOST=localhost
POSTGRES_PORT=5432

# Auth (ED25519)
NOVA_PRIVATE_KEY_PATH=./keys/nova_private.pem
NOVA_PUBLIC_KEY_PATH=./keys/nova_public.pem

# Redis
REDIS_URL=redis://localhost:6379

# Auth0 / IdP
AUTH0_ISSUER=https://YOUR_TENANT.auth0.com
AUTH0_AUDIENCE=https://api.nova.leadup.io
AUTH0_JWKS_URI=https://YOUR_TENANT.auth0.com/.well-known/jwks.json

# Logging & Observability
LOG_LEVEL=info
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

### Environment Configuration Strategy
- **`.env.example`** — Template (committed to repo)
- **`.env.local`** — Actual values (gitignored)
- **`.env.e2e`** — E2E test credentials (gitignored)
- **Docker secrets** — Production secrets via environment variables

### Key Environment Variables
| Variable | Purpose | Used By |
|----------|---------|---------|
| `DATABASE_URL` | PostgreSQL connection string | API, Auth, Admin, Workers |
| `REDIS_URL` | Redis connection string | All services |
| `JWT_SECRET` | JWT signing secret | API, Auth, Realtime |
| `NOVA_PRIVATE_KEY_PATH` | ED25519 private key path | Auth |
| `NOVA_PUBLIC_KEY_PATH` | ED25519 public key path | Auth |
| `ANTHROPIC_API_KEY` | Claude API key | API, Agent Orchestrator, Worker |
| `S3_ENDPOINT` | S3/MinIO endpoint | API, Notification Service |
| `CORS_ORIGIN` | Allowed CORS origins | API, Auth, Admin |
| `LOG_LEVEL` | Logging verbosity | All services |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry endpoint | All services |

---

## Appendix: Workspace Package Reference

| Package | Location | Version | Description |
|---------|----------|---------|-------------|
| `@nova/database` | `packages/database` | 0.1.0 | Drizzle ORM, schemas, migrations |
| `@nova/ai-core` | `packages/ai-core` | 0.1.0 | AI agent primitives |
| `@nova/shared-types` | `packages/shared-types` | 0.1.0 | Canonical TypeScript types |
| `@nova/auth-types` | `packages/auth-types` | 0.1.0 | Auth schemas (private) |
| `@nova/voice` | `packages/voice` | 0.1.0 | Voice processing |
| `nova-ui` | `packages/ui` | 0.1.0 | React UI components (private) |
| `@nova/avatar` | `packages/avatar` | 0.1.0 | Avatar management |
| `@nova/memory` | `packages/memory` | 0.1.0 | Agent memory (pgvector) |
| `@nova/observability` | `packages/observability` | 0.1.0 | OpenTelemetry tracing |
| `@nova/policy` | `packages/policy` | 0.1.0 | Authorization policies |
| `@nova/config` | `packages/config` | 0.1.0 | Shared configs (private) |
| `@nova/tools` | `packages/tools` | 0.1.0 | AI tool definitions |
| `@nova/types` | `packages/types` | 0.1.0 | Legacy types (private) |
| `@nova/utils` | `packages/utils` | 0.1.0 | Legacy utils (private) |
| `@nova/api` | `services/api` | 0.1.0 | Core API service |
| `@nova/admin` | `services/admin` | 0.1.0 | Admin backend (private) |
| `@nova/realtime-gateway` | `services/realtime-gateway` | 0.1.0 | WebSocket gateway |
| `@nova/voice-api` | `services/voice-api` | 0.1.0 | Voice API (private) |
| `@nova/notification-service` | `services/notification-service` | 0.1.0 | Notification service |
| `@nova/workflow-engine` | `services/workflow-engine` | 0.1.0 | Workflow engine |
| `@nova/agent-orchestrator` | `services/agent-orchestrator` | 0.1.0 | Agent orchestration |
| `@nova/integration-service` | `services/integration-service` | 0.1.0 | Integration service |
| `@nova/worker` | `services/worker` | 0.1.0 | Background worker |
| `@nova/workers` | `services/workers` | 0.1.0 | Additional workers (private) |

---

*End of NOVA-Leadup Project Structure Map.*
