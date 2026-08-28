# NOVA Monitoring Configuration
# Metrics, logging, and alerting setup for production.

## 1. Prometheus Metrics

### Available Endpoints
| Service | Endpoint | Port |
|---------|----------|------|
| API | `/metrics` | 3001 |
| Auth | (via admin) | 3003 |
| Admin | `/metrics` | 3004 |

### Key Metrics
```
# HTTP metrics
http_requests_total{method, path, status}
http_request_duration_seconds{method, path}

# Database metrics
db_query_duration_seconds{query_type}
db_connection_pool_active
db_connection_pool_idle

# Redis metrics
redis_operations_total{operation}
redis_hits_total
redis_misses_total

# Auth metrics
auth_login_attempts_total{status}
auth_token_refreshes_total

# Business metrics
voice_transcriptions_total{status}
ai_requests_total{model, status}
```

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
- Metrics endpoint: `/metrics` (authenticated in production)
- Log access: Admin console audit log
