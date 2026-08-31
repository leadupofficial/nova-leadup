#!/bin/sh
# NOVA service entrypoint — waits for dependencies, runs migrations, starts service
set -e

SERVICE="${NOVA_SERVICE:-api}"
echo "[entrypoint] Starting $SERVICE service..."

# Wait for database if DATABASE_URL is set
if [ -n "$DATABASE_URL" ]; then
 echo "[entrypoint] Waiting for database..."
 for i in $(seq 1 30); do
 if pg_isready -h "$(echo $DATABASE_URL | sed -n 's|.*://[^:]*:[^@]*@\([^:]*\):.*|\1|p')" \
 -p "$(echo $DATABASE_URL | sed -n 's|.*://[^:]*:[^@]*@[^:]*:\([0-9]*\).*|\1|p')" > /dev/null 2>&1; then
 echo "[entrypoint] Database is ready"
 break
 fi
 echo "[entrypoint] Database not ready yet... ($i/30)"
 sleep 2
 done
fi

# Wait for Redis if REDIS_URL is set
if [ -n "$REDIS_URL" ]; then
 echo "[entrypoint] Waiting for Redis..."
 for i in $(seq 1 30); do
 if redis-cli -h "$(echo $REDIS_URL | sed -n 's|.*://\([^:]*\):.*|\1|p')" \
 -p "$(echo $REDIS_URL | sed -n 's|.*://[^:]*:\([0-9]*\).*|\1|p')" \
 ping 2>/dev/null | grep -q PONG; then
 echo "[entrypoint] Redis is ready"
 break
 fi
 echo "[entrypoint] Redis not ready yet... ($i/30)"
 sleep 1
 done
fi

# Run migrations if the command exists (only for API service)
if [ "$SERVICE" = "api" ] && [ -f "services/api/dist/migrate.js" ]; then
 echo "[entrypoint] Running database migrations..."
 node services/api/dist/migrate.js || echo "[entrypoint] Migrations skipped or failed"
fi

echo "[entrypoint] Starting $SERVICE..."
exec "$@"
