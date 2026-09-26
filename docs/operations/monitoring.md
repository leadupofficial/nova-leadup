# NOVA Monitoring Configuration
# Metrics, logging, and alerting setup for production.

## 1. Prometheus Metrics

### Available Endpoints

| Service | Endpoint | Port | Status |
|---------|----------|------|--------|
| API | `/metrics` | 3001 | **Implemented** (Prometheus text format; see "What is actually exported" below) |
| Auth | — | 3003 | **Not implemented** — no exporter in `services/auth` |
| Admin | — | 3004 | **Not implemented** — the admin console has JSON endpoints under `/api/v1/admin/*`, not a Prometheus scrape target |

The API endpoint is reachable only from a private address, or with
`METRICS_TOKEN` set (then `Authorization: Bearer <token>`). In production the
container publishes `127.0.0.1:3001` only, so an on-host Prometheus scrapes
`http://127.0.0.1:3001/metrics`.

### What is actually exported

Served by `services/api/src/metrics/registry.ts`:

```
# HTTP — recorded for every request, labelled by route pattern (never by raw URL)
http_requests_total{method,path,status}
http_request_duration_seconds{method,path}          # histogram, buckets 5ms … 10s

# Database connection pool — read at scrape time from the live pg Pool
db_connection_pool_active
db_connection_pool_idle
db_connection_pool_waiting

# Build identity — answers "is the deploy actually live?" without grepping a container
nova_build_info{version,commit}

# Process/runtime defaults from prom-client
process_cpu_seconds_total, process_resident_memory_bytes, nodejs_heap_size_used_bytes,
nodejs_eventloop_lag_seconds, nodejs_gc_duration_seconds, …
```

`path` is the Express route pattern (`/api/v1/recordings/:id`), and requests that
never match a route are normalised the same way. Labelling by raw URL would
create one time series per recording id.

### Documented but NOT instrumented

These appear in earlier versions of this file and in the alerting rules below.
They do **not** exist yet — a scrape of `/api/v1/admin/*` JSON is the closest
substitute, and the admin metrics endpoint reports an explicit
`unavailableReason` where a signal is missing rather than a `0`:

| Metric | Missing instrumentation |
|--------|------------------------|
| `db_query_duration_seconds` | no query-level timing; only pool state |
| `redis_operations_total`, `redis_hits_total`, `redis_misses_total` | no Redis instrumentation anywhere |
| `auth_login_attempts_total`, `auth_token_refreshes_total` | auth routes increment no counters |
| `voice_transcriptions_total`, `ai_requests_total{model,status}` | provider calls are logged, not counted |
| Cost metrics | `services/api/src/admin/pricing.ts` computes cost on demand; not exported |

Alerting rules written against the missing series will never fire. Either
instrument them or delete the rules — a rule over a non-existent metric is a
silent hole in monitoring, not coverage.

## 2. Alerting Rules (Prometheus)

```yaml
groups:
 - name: nova.alerts
 rules:
 - alert: HighErrorRate
 expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
 for: 5m
 annotations:
 summary: "High error rate on {{ $labels.path }}"
 description: "Error rate is {{ $value }} errors/sec"

 - alert: HighLatency
 expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 1
 for: 5m
 annotations:
 summary: "High latency on {{ $labels.path }}"

 - alert: DatabaseDown
 expr: up{job="postgres"} == 0
 for: 1m
 annotations:
 summary: "PostgreSQL is down"

 - alert: RedisDown
 expr: up{job="redis"} == 0
 for: 1m
 annotations:
 summary: "Redis is down"

 - alert: AuthServiceDown
 expr: up{job="auth"} == 0
 for: 1m
 annotations:
 summary: "Auth service is down"

 - alert: DiskSpaceLow
 expr: (node_filesystem_avail_bytes / node_filesystem_size_bytes) < 0.1
 for: 5m
 annotations:
 summary: "Disk space below 10% on {{ $labels.device }}"

 - alert: ContainerRestartLoop
 expr: rate(container_restart_count[5m]) > 3
 for: 5m
 annotations:
 summary: "Container {{ $labels.name }} is restarting frequently"
```

## 3. Logging Strategy

### Structured JSON Logging
All services use `pino` for structured logging:

```typescript
// Example log entry
{
 "level": 30,
 "time": 1709452800000,
 "pid": 12345,
 "hostname": "nova-api-abc123",
 "requestId": "uuid-here",
 "method": "POST",
 "path": "/auth/login",
 "statusCode": 200,
 "durationMs": 45,
 "userId": "user-uuid",
 "traceId": "trace-id"
}
```

### Log Fields
- `requestId` — trace ID for request correlation
- `userId` — authenticated user (when available)
- `method/path/statusCode` — HTTP details
- `durationMs` — request processing time
- `traceId` — distributed tracing ID

### Log Retention
- Hot storage (Elasticsearch/CloudWatch): 7 days
- Cold storage (S3): 90 days
- Audit logs: 1 year (compliance)

## 4. Dashboards

### Admin Dashboard Panels
1. **Service Health**: Container status, uptime, health check results
2. **Request Rate**: Requests/sec by service and endpoint
3. **Error Rate**: 4xx/5xx breakdown over time
4. **Latency**: p50, p95, p99 response times
5. **Database**: Connection pool, query latency, table sizes
6. **Redis**: Hit rate, memory usage, connected clients
7. **Auth**: Login success/failure rate, active sessions
8. **Cost**: Compute, storage, API usage costs over time

---

## 5. Access
- Monitoring dashboard: `/admin/monitoring` (authenticated)
- Metrics endpoint: `/metrics` — private addresses only, or `Authorization: Bearer $METRICS_TOKEN` when that variable is set
- Log access: Admin console audit log
