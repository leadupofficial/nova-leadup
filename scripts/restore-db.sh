#!/bin/bash
# NOVA Database Restore Script
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKUP_FILE="${1:-}"

if [ -z "${BACKUP_FILE}" ]; then
 echo "Usage: $0 <backup-file.sql.gz>"
 echo "Example: $0 ./infrastructure/backups/postgres/nova_20260828_020000.sql.gz"
 exit 1
fi

if [ ! -f "${BACKUP_FILE}" ]; then
 echo "Error: Backup file not found: ${BACKUP_FILE}"
 exit 1
fi

POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-nova}"

echo "=========================================="
echo " WARNING: This will DROP and recreate the database."
echo " All existing data will be LOST."
echo "=========================================="
read -p "Type 'yes' to confirm: " CONFIRM
if [ "${CONFIRM}" != "yes" ]; then
 echo "Restore cancelled."
 exit 0
fi

echo "[restore] Stopping application services..."
docker compose -f "${COMPOSE_FILE}" stop api auth admin workers

echo "[restore] Dropping and recreating database..."
docker compose -f "${COMPOSE_FILE}" exec -T postgres \
 psql -U "${POSTGRES_USER}" -c "DROP DATABASE IF EXISTS ${POSTGRES_DB};"
docker compose -f "${COMPOSE_FILE}" exec -T postgres \
 psql -U "${POSTGRES_USER}" -c "CREATE DATABASE ${POSTGRES_DB};"

echo "[restore] Restoring from ${BACKUP_FILE}..."
gunzip -c "${BACKUP_FILE}" | \
 docker compose -f "${COMPOSE_FILE}" exec -T postgres \
 psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"

echo "[restore] Recreating extensions..."
docker compose -f "${COMPOSE_FILE}" exec -T postgres \
 psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
 -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";"

echo "[restore] Verifying restore..."
TABLE_COUNT=$(docker compose -f "${COMPOSE_FILE}" exec -T postgres \
 psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")
echo "[restore] Tables restored: ${TABLE_COUNT}"

echo "[restore] Starting services..."
docker compose -f "${COMPOSE_FILE}" start api auth admin workers

echo "[restore] Verifying health..."
sleep 5
HEALTH=$(curl -sf https://localhost/health/ready 2>/dev/null || echo "check manually")
echo "[restore] Health: ${HEALTH}"

echo "[restore] Complete."
