#!/bin/bash
# NOVA Database Backup Script
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./infrastructure/backups/postgres}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/nova_${TIMESTAMP}.sql.gz"

mkdir -p "${BACKUP_DIR}"

echo "[backup] Starting database backup..."

pg_dump \
 --host="${POSTGRES_HOST:-postgres}" \
 --port="${POSTGRES_PORT:-5432}" \
 --username="${POSTGRES_USER:-postgres}" \
 --dbname="${POSTGRES_DB:-nova}" \
 --format=plain \
 --no-owner \
 --no-acl \
 --verbose \
 2>/dev/null \
 | gzip > "${BACKUP_FILE}"

SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
echo "[backup] Complete: ${BACKUP_FILE} (${SIZE})"

# Clean up backups older than 30 days
find "${BACKUP_DIR}" -name "*.sql.gz" -mtime +30 -delete -print 2>/dev/null || true

# S3 upload (if configured)
if [ -n "${S3_ENDPOINT}" ] && [ -n "${S3_BUCKET}" ]; then
 echo "[backup] Uploading to S3..."
 aws s3 cp "${BACKUP_FILE}" "s3://${S3_BUCKET}/backups/${TIMESTAMP}.sql.gz" \
 --endpoint-url="${S3_ENDPOINT}" \
 --sse AES256 \
 2>/dev/null && echo "[backup] S3 upload complete" || echo "[backup] S3 upload skipped (not configured)"
fi

echo "[backup] Done."
