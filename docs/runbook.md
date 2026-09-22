/**
 * NOVA-Leadup Operational Runbook
 *
 * This document covers deployment, health checks, troubleshooting, and
 * rollback procedures for production operations.
 */

# Operational Runbook

## Architecture Overview

| Service | Port | Purpose |
|---------|------|---------|
| `@nova/api-gateway` | 3000 | Single entrypoint, rate limiting, routing |
| `@nova/auth` | 3003 | Authentication, RBAC, org management |
| `@nova/admin` | 3007 | Admin panel API (orgs, users, audit, incidents) |
| `@nova/policy-service` | 3006 | RBAC policy evaluation engine |
| `@nova/workflow-engine` | 3004 | Celery-style async task processing |
| `@nova/task-orchestrator` | 3100 | DAG orchestration, approval gates |
| `@nova/memory-service` | 3002 | Long-term memory, vector search |
| `@nova/ai-agents` | 3005 | AI assistant runtime |
| `@nova/voice-service` | 3008 | Voice pipeline, TTS/STT |
| `@nova/billing` | 3009 | Stripe billing, subscriptions |
| `@nova/notification-service` | 3010 | Web push, email, SMS |
| `@nova/scheduler` | 3011 | Cron/scheduled jobs |
| `@nova/leadup-web` | 3000 | Next.js customer-facing web app |
| `@nova/leadup-landing` | 3001 | Marketing landing page |
| `@nova/mobile` | N/A | Expo/React Native mobile app |

---

## Environment Variables

All services require these core env vars:

```bash
# Database
DATABASE_URL=postgres://nova:password@db:5432/nova

# Redis
REDIS_URL=redis://redis:6379

# JWT
JWT_SECRET=<256-bit-secret>

# Object Storage (S3-compatible)
S3_ENDPOINT=https://s3.amazonaws.com
S3_ACCESS_KEY=<key>
S3_SECRET_KEY=<secret>
S3_BUCKET=nova-leadup

# AI Services
ANTHROPIC_API_KEY=<key>
ELEVENLABS_API_KEY=<key>
SARVAM_API_KEY=<key>
```

---

## Health Checks

### Service Health Endpoints

| Service | Endpoint | Description |
|---------|----------|-------------|
| API Gateway | `GET /health` | Overall gateway health |
| Auth | `GET /health/live` | Liveness probe |
| Auth | `GET /health/service` | Service health (requires API key) |
| Admin | `GET /` | Health with DB/Redis/Storage checks |
| Admin | `GET /ready` | Readiness probe |
| Admin | `GET /live` | Liveness probe |

### Kubernetes Probes

```yaml
livenessProbe:
 httpGet:
 path: /health/live
 port: 3003
 initialDelaySeconds: 10
 periodSeconds: 30

readinessProbe:
 httpGet:
 path: /health
 port: 3003
 initialDelaySeconds: 5
 periodSeconds: 10
```

---

## Database Migrations

```bash
# Run pending migrations
pnpm --filter @nova/db run migrate

# Check migration status
pnpm --filter @nova/db run status

# Rollback last migration (Drizzle only supports down for some)
pnpm --filter @nova/db run rollback
```

---

## Troubleshooting

### Service won't start

1. Check DATABASE_URL is set and DB is accessible: `pg_isready -h <host> -p 5432`
2. Check Redis: `redis-cli ping` → should return `PONG`
3. Check S3 credentials: `aws s3 ls <bucket> --endpoint-url <S3_ENDPOINT>`
4. Verify JWT_SECRET is set: `[ -n "$JWT_SECRET" ] && echo "OK"`

### High memory usage in workflow-engine

- Check for stuck tasks: `pnpm --filter @nova/workflow-engine run queue:inspect`
- Clear dead-letter queue: `pnpm --filter @nova/workflow-engine run queue:dlq:purge`

### Auth token errors

- Verify JWT_SECRET matches across all services
- Check token expiry: `jwt decode <token>` (requires `jwt` CLI)
- Clear Redis sessions if needed: `redis-cli DEL "session:<token>"`

### Mobile app crashes on launch

1. Check Expo EAS build status: `eas build:list`
2. Clear Metro bundler cache: `npx expo start --clear`
3. Verify API_URL in `app.config.js` points to production gateway

---

## Rollback Procedures

### Service Rollback

```bash
# Kubernetes
kubectl rollout undo deployment/<service-name> -n nova

# Docker Compose
docker compose up -d --force-recreate <service-name>

# Vercel (web apps)
vercel rollback <deployment-url>
```

### Database Rollback

```bash
# Last resort only — prefer forward migrations
pnpm --filter @nova/db run migrate:down
```

---

## Monitoring Alerts

| Metric | Threshold | Action |
|--------|-----------|--------|
| Error rate | > 1% for 5min | Check Sentry/dashboard |
| Response time (p99) | > 2s | Check DB queries, Redis |
| Queue depth | > 1000 | Scale workflow-engine |
| DB connections | > 80% pool | Increase pool or add read replicas |
| Memory usage | > 85% | Restart service, check for leaks |

---

## Backup & Recovery

### Database

- Automated daily backups via Supabase point-in-time recovery
- Manual backup: `pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql`
- Restore: `psql $DATABASE_URL < backup_YYYYMMDD.sql`

### Redis

- RDB snapshots configured in redis.conf (`save 900 1`)
- Manual: `redis-cli BGSAVE`

### S3 / Object Storage

- Versioning enabled on all buckets
- Cross-region replication for production bucket

---

## Security Incidents

1. **Rotate JWT_SECRET** — invalidates all existing tokens
2. **Revoke API keys** from admin panel
3. **Check audit log** at `GET /api/admin/audit`
4. **Notify** security@leadup.in
5. **Document** in incident report template
