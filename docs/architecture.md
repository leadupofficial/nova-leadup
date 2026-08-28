# NOVA Architecture

## System Overview

NOVA is a Voice and Visual Companion platform built as a distributed monorepo.

## Services

### API Service (`services/api`)
- Express.js REST API
- Health checks: `/health`, `/health/ready`, `/health/live`
- Handles authentication, tenant management, and request routing

### Workers Service (`services/workers`)
- BullMQ background job processing
- Handles long-running tasks (transcription, TTS, embeddings)
- Consumes from Redis queues

## Data Layer

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Primary Database | PostgreSQL 16 + pgvector | Structured data, embeddings |
| Cache | Redis 7 | Session cache, rate limiting, job queues |
| Object Storage | MinIO (S3-compatible) | Audio files, large assets |

## Shared Packages

| Package | Purpose |
|---------|---------|
| `@nova/config` | Shared ESLint, Prettier, TypeScript configs |
| `@nova/types` | Shared TypeScript types and interfaces |
| `@nova/utils` | Shared utility functions |

## Infrastructure

See the `infrastructure/` directory for IaC definitions.
