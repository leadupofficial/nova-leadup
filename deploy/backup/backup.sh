#!/usr/bin/env bash
# deploy/backup/backup.sh — NOVA-Leadup database backup script
set -euo pipefail

# ── Config (override via env or .env ──────────────────────────────────────────
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
PGHOST="${PGHOST:-nova-postgres}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-nova_user}"
PGPASSWORD=${PGPASSWORD:?PGPASSWORD is required — set via environment or .env before running backup}
PGDATABASE="${PGDATABASE:-nova}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILENAME="nova_backup_${TIMESTAMP}.sql.gz"
# ─────────────────────────────────────────────────────────────────────────────

mkdir -p "${BACKUP_DIR}"

export PGPASSWORD

echo "[backup] Starting backup at ${TIMESTAMP}"

if command -v pg_dump >/dev/null 2>&1; then
 pg_dump \
 --host="${PGHOST}" \
 --port="${PGPORT}" \
 --username="${PGUSER}" \
 --dbname="${PGDATABASE}" \
 --format=plain \
 --no-owner \
 --no-acl \
 | gzip > "${BACKUP_DIR}/${FILENAME}"
else
 # Fallback: use docker exec if pg_dump is not on the host
 docker exec -e PGPASSWORD="${PGPASSWORD}" nova-postgres \
 pg_dump -U "${PGUSER}" -d "${PGDATABASE}" --no-owner --no-acl \
 | gzip > "${BACKUP_DIR}/${FILENAME}"
fi

SIZE=$(du -h "${BACKUP_DIR}/${FILENAME}" | cut -f1)
echo "[backup] Written: ${FILENAME} (${SIZE})"

# ── Retention ────────────────────────────────────────────────────────────────
echo "[backup] Pruning backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_DIR}" -name "nova_backup_*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete -print || true

echo "[backup] Done. Backups on disk:"
ls -lh "${BACKUP_DIR}/"
