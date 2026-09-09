#!/usr/bin/env bash
set -euo pipefail

# Run a temporary pgvector-enabled Postgres for migrations / local dev.
# Uses a separate container name and port so it does not clash with demo-db.
CONTAINER_NAME="nova-pgvector"
PORT="5433"
IMAGE="pgvector/pgvector:pg16"
DB="nova"
USER="nova_user"
PASS="nova_secure_2026"

if ! docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
 echo "[pgvector] Creating container $CONTAINER_NAME on port $PORT..."
 docker run -d \
 --name "$CONTAINER_NAME" \
 -e POSTGRES_USER="$USER" \
 -e POSTGRES_PASSWORD="$PASS" \
 -e POSTGRES_DB="$DB" \
 -p "$PORT:5432" \
 "$IMAGE"
else
 echo "[pgvector] Container exists, starting..."
 docker start "$CONTAINER_NAME" >/dev/null 2>&1 || true
fi

echo "[pgvector] Waiting for Postgres to become ready..."
for i in {1..60}; do
 if docker exec "$CONTAINER_NAME" pg_isready -U "$USER" -d "$DB" >/dev/null 2>&1; then
 echo "[pgvector] Postgres is ready on port $PORT"
 exit 0
 fi
 sleep 1
done

echo "[pgvector] Timed out waiting for Postgres" >&2
exit 1
