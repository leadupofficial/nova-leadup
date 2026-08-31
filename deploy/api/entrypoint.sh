#!/bin/sh
# NOVA API entrypoint — run DB migrations, then start server
set -e

echo "[entrypoint] Starting NOVA API..."

# Wait for database
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

# Run migrations if the command exists
if [ -f "services/api/dist/migrate.js" ]; then
 echo "[entrypoint] Running database migrations..."
 node services/api/dist/migrate.js || echo "[entrypoint] Migrations skipped or failed"
fi

echo "[entrypoint] Starting server..."
exec "$@"
