# Incident Response Runbook — NOVA Platform

## Document Control
| Field | Value |
|-------|-------|
| Project | Nova Leadup |
| Version | 0.1.0 |
| Date | 2026-08-28 |
| Status | Draft |
| Owner | DevOps Engineer |

---

## 1. Incident Severity Levels

| Severity | Definition | Response Time | Examples |
|----------|-----------|---------------|---------|
| P0 — Critical | Complete service outage, data breach, or security compromise | 15 min | Database down, credential exposure, full outage |
| P1 — High | Major functionality impaired, significant user impact | 30 min | Auth down, AI service failure, data loss risk |
| P2 — Medium | Degraded performance, partial feature failure | 2 hours | Slow API responses, minor error rate increase |
| P3 — Low | Cosmetic issues, minor bugs, maintenance | 24 hours | UI glitches, non-critical warnings |

---

## 2. Response Procedure

### 2.1 Detection
1. Monitoring alert fires in admin dashboard (`/admin/incidents`)
2. Alert routes to on-call engineer via configured notification channel
3. On-call acknowledges alert within SLA

### 2.2 Triage
1. Assess severity level (P0–P3)
2. Assign incident commander
3. Create incident ticket in admin console (LEA-57/LEA-56)
4. Tag with severity and affected services

### 2.3 Containment
1. **P0/P1**: Immediate mitigation — scale up healthy instances, enable circuit breakers, rollback recent deployments
2. **P2**: Monitor, apply workarounds if needed
3. **P3**: Document, schedule for next maintenance window

### 2.4 Investigation
1. Pull logs from affected services (structured JSON logs)
2. Check admin dashboard metrics (`/metrics` endpoint)
3. Review recent deployments and config changes
4. Correlate with audit log (`/admin/audit-log`)

### 2.5 Resolution
1. Implement fix
2. Verify in staging environment
3. Deploy to production
4. Confirm recovery via health checks (`/health/ready`)

### 2.6 Post-Incident
1. Write post-mortem within 48 hours
2. Update runbooks if gaps found
3. Schedule preventive measures
4. Conduct blameless retrospective

---

## 3. Common Incident Scenarios

### 3.1 Database Unavailable
**Symptoms**: Health check fails, API returns 500, workers stuck
**Steps**:
1. Check PostgreSQL container: `docker compose -f docker-compose.prod.yml ps postgres`
2. Check disk space: `df -h`
3. Check connections: `SELECT count(*) FROM pg_stat_activity;`
4. If disk full: `pg_dump` critical data, then clean WAL files
5. If crashed: restore from latest backup (see disaster-recovery.md)
6. Restart: `docker compose -f docker-compose.prod.yml restart postgres`

### 3.2 Redis Unavailable
**Symptoms**: Rate limiting broken, sessions lost, workers not processing
**Steps**:
1. Check Redis: `docker compose -f docker-compose.prod.yml ps redis`
2. Redis supports persistence — restart and data recovers from AOF
3. Verify: `redis-cli -a $REDIS_PASSWORD ping`

### 3.3 Auth Service Down
**Symptoms**: Login failures, JWT validation errors across all services
**Steps**:
1. Check auth service: `docker compose -f docker-compose.prod.yml ps auth`
2. View logs: `docker compose -f docker-compose.prod.yml logs auth`
3. Restart: `docker compose -f docker-compose.prod.yml restart auth`
4. If persistent, check JWT_SECRET matches across services

### 3.4 Elevated Error Rate
**Symptoms**: 5xx errors increasing, response latency spike
**Steps**:
1. Check `/metrics` for error rate breakdown
2. Check database query performance: `SELECT * FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;`
3. Check Redis hit rate for cache warming issues
4. Rollback last deployment if correlation found
5. Enable rate limiting if upstream traffic spike

### 3.5 Credential/Security Incident
**Symptoms**: Unusual API key usage, leaked secrets, unauthorized access
**Steps**:
1. **IMMEDIATE**: Revoke the affected credential
2. Review audit log for affected scope
3. Rotate all related secrets (see secrets-rotation.md)
4. Notify security team
5. Force re-authentication for affected sessions
6. Review access logs for evidence of exfiltration

---

## 4. Escalation Matrix

| Situation | Escalation |
|-----------|-----------|
| P0 not resolved in 30 min | Chief of Staff |
| Data breach suspected | Chief of Staff + Legal |
| Infrastructure cost spike | Chief of Staff |
| Cannot restore from backup | Cloud provider support |

---

## 5. Communication Templates

### Internal Notification
```
[INCIDENT: P{X}] {Service} — {Brief description}
Status: {Investigating/Mitigating/Resolved}
Impact: {User-facing description}
Next update: {Time}
Incident commander: {Name}
```

### Customer Notification (if applicable)
```
We are currently experiencing issues with {service}. Our team is actively investigating and working to resolve this. We will provide updates every 30 minutes until resolved. Last updated: {timestamp}.
```
