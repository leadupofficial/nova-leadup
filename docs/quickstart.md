## NOVA Monorepo — Quick Start

This file documents the standard development workflow for NOVA.

### Initial Setup (one-time)

```bash
npm install
```

### Starting the Local Stack

```bash
# Start PostgreSQL, Redis, and MinIO
docker compose up -d

# Verify services are running
docker compose ps

# Expected: postgres, redis, minio all showing "healthy"
```

### Database

```bash
# Run migrations
npm run db:migrate

# Seed with test data
npm run db:seed
```

### Development

```bash
# Start all services
npm run dev

# Or start individual services
npm run dev --filter=@nova/api
npm run dev --filter=@nova/workers
```

### Running CI Checks Locally

```bash
# Full CI pipeline
npm run lint && npm run type-check && npm run test

# Individual stages
npm run lint
npm run type-check
npm run test:unit
```

### Docker Compose Services

| Service | Port | Credentials |
|---------|------|-------------|
| PostgreSQL | 5432 | postgres / postgres |
| Redis | 6379 | (no auth by default) |
| MinIO | 9000 (API), 9001 (Console) | minioadmin / minioadmin |

### Troubleshooting

- **PostgreSQL connection refused**: Ensure pgvector extension is available. Run `docker compose up -d postgres` and check logs.
- **Redis connection refused**: Check `docker compose ps redis` for health status.
- **MinIO bucket not found**: Create buckets via the MinIO console at http://localhost:9001.
