# Database Backup & Restore Procedures — NOVA Platform

## Document Control
| Field | Value |
|-------|-------|
| Project | Nova Leadup |
| Version | 0.1.0 |
| Date | 2026-08-28 |
| Status | Draft |
| Owner | DevOps Engineer |

---

## 1. Backup Strategy

### 1.1 PostgreSQL Backup
- **Full backup**: Daily at 02:00 UTC via `pg_dump`
- **WAL archiving**: Continuous Write-Ahead Log for point-in-time recovery (PITR)
- **Retention**: 30 days of full backups, 7 days of WAL segments
- **Storage**: Local volume + S3 (cross-region replica recommended)

### 1.2 Backup Script
```bash
#!/bin/bash
# scripts/backup-db.sh
set -euo pipefail

BACKUP_DIR="./infrastructure/backups/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/nova_${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

# Full database dump (compressed)
pg_dump \
 --host="${POSTGRES_HOST}" \
 --port="${POSTGRES_PORT}" \
 --username="${POSTGRES_USER}" \
 --dbname="${POSTGRES_DB}" \
 --format=plain \
 --no-owner \
 --no-acl \
 | gzip > "${BACKUP_FILE}"

# Upload to S3 if configured
if [ -n "${S3_ENDPOINT}" ]; then
 aws s3 cp "${BACKUP_FILE}" "s3://${S3_BUCKET}/backups/${TIMESTAMP}.sql.gz" \
 --endpoint-url="${S3_ENDPOINT}"
fi

# Clean up local backups older than 30 days
find "${BACKUP_DIR}" -name "*.sql.gz" -mtime +30 -delete

echo "Backup complete: ${BACKUP_FILE}"
```

### 1.3 pgvector Considerations
- pgvector indexes are not dumped by default — recreate after restore
- Run `CREATE EXTENSION IF NOT EXISTS vector;` after database creation
- Rebuild vector indexes: `REINDEX INDEX CONCURRENTLY <index_name>;`

---

## 2. Automated Backup (Docker Compose)

Add to `docker-compose.prod.yml`:
```yaml
backup:
 image: postgres:16-alpine
 container_name: nova-backup
 environment:
 POSTGRES_HOST: postgres
 POSTGRES_USER: ${POSTGRES_USER}
 POSTGRES_DB: ${POSTGRES_DB}
 PGPASSWORD: ${POSTGRES_PASSWORD}
 volumes:
 - ./infrastructure/backups:/backups
 volumes_from:
 - postgres
 entrypoint: >
 sh -c "
 while true; do
 sleep 86400;
 /bin/sh -c 'pg_dump -h $$POSTGRES_HOST -U $$POSTGRES_USER -d $$POSTGRES_DB | gzip > /backups/nova_$$(date +%Y%m%d_%H%M%S).sql.gz';
 find /backups -name '*.sql.gz' -mtime +30 -delete;
 done
 "
 restart: unless-stopped
 depends_on:
 postgres:
 condition: service_healthy
```

Or via cron on host:
```cron
0 2 * * * docker compose -f /app/docker-compose.prod.yml exec -T postgres pg_dump -U postgres nova | gzip > /backups/nova_$(date +\%Y\%m\%d).sql.gz
```

---

## 3. Restore Procedure

### 3.1 Full Database Restore
```bash
#!/bin/bash
# scripts/restore-db.sh
set -euo pipefail

BACKUP_FILE="${1:-}"
if [ -z "${BACKUP_FILE}" ]; then
 echo "Usage: $0 <backup-file.sql.gz>"
 exit 1
fi

echo "WARNING: This will DROP and recreate the database."
read -p "Are you sure? (yes/no): " CONFIRM
[ "${CONFIRM}" != "yes" ] && exit 0

# Stop services that depend on the database
docker compose -f docker-compose.prod.yml stop api auth admin workers

# Drop and recreate database
docker compose -f docker-compose.prod.yml exec -T postgres \
 psql -U "${POSTGRES_USER}" -c "DROP DATABASE IF EXISTS ${POSTGRES_DB};"
docker compose -f docker-compose.prod.yml exec -T postgres \
 psql -U "${POSTGRES_USER}" -c "CREATE DATABASE ${POSTGRES_DB};"

# Restore from backup
gunzip -c "${BACKUP_FILE}" | \
 docker compose -f docker-compose.prod.yml exec -T postgres \
 psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"

# Recreate extensions
docker compose -f docker-compose.prod.yml exec -T postgres \
 psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
 -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"

echo "Restore complete. Starting services..."
docker compose -f docker-compose.prod.yml start api auth admin workers
```

### 3.2 Point-in-Time Recovery (PITR)
```bash
# Restore base backup, then replay WAL to target time
pg_basebackup -D /var/lib/postgresql/data -X fetch -P -U postgres
# Configure recovery_target_time in postgresql.conf
# Start PostgreSQL in recovery mode
```

---

## 4. Verification

After restore:
```bash
# 1. Check database is accessible
docker compose -f docker-compose.prod.yml exec postgres pg_isready

# 2. Check row counts match expected
docker compose -f docker-compose.prod.yml exec -T postgres \
 psql -U postgres -d nova -c "SELECT count(*) FROM users;"

# 3. Check extensions
docker compose -f docker-compose.prod.yml exec -T postgres \
 psql -U postgres -d nova -c "\dx"

# 4. Verify application health
curl https://nova.leadup.in/health/ready

# 5. Verify auth works
curl -X POST https://nova.leadup.in/auth/login -H "Content-Type: application/json" -d '{}'
```

---

## 5. Backup Schedule

| Frequency | Type | Retention |
|-----------|------|-----------|
| Hourly | WAL archiving | 7 days |
| Daily (02:00 UTC) | Full dump | 30 days |
| Weekly | Full dump + S3 cross-region | 90 days |
| Pre-deployment | Pre-migration snapshot | Until next stable |
