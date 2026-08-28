# Disaster Recovery Runbook — NOVA Platform

## Document Control
| Field | Value |
|-------|-------|
| Project | Nova Leadup |
| Version | 0.1.0 |
| Date | 2026-08-28 |
| Status | Draft |
| Owner | DevOps Engineer |

---

## 1. Recovery Objectives

| Metric | Target |
|--------|--------|
| RPO (Recovery Point Objective) | 1 hour (WAL archiving) |
| RTO (Recovery Time Objective) | 4 hours for full service |
| RTO (Database) | 2 hours |
| Data retention | 30 days of backups |

---

## 2. Failure Scenarios & Recovery

### 2.1 Single Container Failure
**RTO: 5 minutes**
```bash
docker compose -f docker-compose.prod.yml restart <service>
docker compose -f docker-compose.prod.yml ps # Verify
curl https://nova.leadup.in/health/ready # Verify health
```

### 2.2 PostgreSQL Failure
**RTO: 30 minutes**
```bash
# Check if data volume is intact
docker compose -f docker-compose.prod.yml ps postgres
docker logs nova-postgres 2>&1 | tail -50

# If volume intact, just restart
docker compose -f docker-compose.prod.yml restart postgres

# If data corrupted, restore from backup (see backup-restore.md)
./scripts/restore-db.sh ./infrastructure/backups/postgres/nova_latest.sql.gz
```

### 2.3 Redis Failure
**RTO: 10 minutes**
```bash
# Redis with AOF persistence — restart recovers data
docker compose -f docker-compose.prod.yml restart redis

# If AOF corrupted, start fresh (sessions will be invalidated, users re-login)
docker compose -f docker-compose.prod.yml exec redis redis-cli DEBUG RELOAD
```

### 2.4 Complete Infrastructure Loss
**RTO: 4 hours**
1. Provision fresh infrastructure on cloud provider
2. Clone repository: `git clone https://github.com/leadupofficial/nova-leadup.git`
3. Configure environment variables (see secrets-rotation.md)
4. Run `docker compose -f docker-compose.prod.yml up -d`
5. Restore database from latest backup
6. Verify all services healthy
7. Update DNS if IP changed

### 2.5 Data Breach
**RTO: Immediate**
1. Isolate affected systems (disable network access)
2. Preserve evidence (snapshot all containers, export logs)
3. Notify security team and legal counsel
4. Rotate ALL credentials (see secrets-rotation.md)
5. Review audit logs for scope of breach
6. Engage incident response process (see incident-response.md)

---

## 3. Infrastructure Recovery Checklist

- [ ] Provision compute resources (EC2/GCP VM / Kubernetes)
- [ ] Clone repository at stable tag
- [ ] Configure environment variables from secrets manager
- [ ] Pull Docker images or build from source
- [ ] Start infrastructure services (PostgreSQL, Redis, MinIO)
- [ ] Restore database from latest verified backup
- [ ] Start application services (api, auth, workers, admin)
- [ ] Verify health endpoints: `/health/ready`, `/health/live`
- [ ] Verify database connectivity
- [ ] Verify Redis connectivity
- [ ] Verify S3/MinIO connectivity
- [ ] Test authentication flow
- [ ] Test core user journeys
- [ ] Update DNS / load balancer
- [ ] Monitor error rates for 1 hour
- [ ] Notify stakeholders of recovery

---

## 4. Backup Verification Schedule

| Frequency | Action |
|-----------|--------|
| Weekly | Test restore from backup to verify integrity |
| Monthly | Full DR drill — restore to separate environment |
| Quarterly | Review and update this runbook |

---

## 5. Contact Information

| Role | Contact |
|------|---------|
| DevOps Engineer | Via Paperclip (current agent) |
| Chief of Staff | Via Paperclip escalation |
| Cloud Provider Support | Provider-specific support channels |
| Database Admin | Via team escalation |
