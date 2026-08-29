#!/usr/bin/env bash
set -euo pipefail

# E2E environment management — starts/stops Docker services for Playwright tests.
# Usage: ./scripts/e2e-env.sh [up|down|wait|test]
# up — start services and wait for health
# down — stop and clean up
# wait — wait for all services to be healthy (idempotent)
# test — run Playwright tests (convenience wrapper)

COMPOSE_FILE="docker-compose.e2e.yml"
WAIT_TIMEOUT=120 # seconds per service

red() { printf '\033[0;31m%s\033[0m\n' "$1"; }
green() { printf '\033[0;32m%s\033[0m\n' "$1"; }

up() {
 green "Starting E2E environment..."
 docker compose -f "$COMPOSE_FILE" up -d --build postgres redis minio
 _wait_for postgres "pg_isready" 5433
 _wait_for redis "redis-cli ping" 6380
 _wait_for minio "curl -sf http://localhost:9000/minio/health/live" 9001

 green "Starting application services..."
 docker compose -f "$COMPOSE_FILE" up -d --build auth api admin web

 # Run DB migrations
 green "Running migrations..."
 sleep 3
 docker compose -f "$COMPOSE_FILE" exec -T auth pnpm run db:migrate 2>/dev/null || true
 docker compose -f "$COMPOSE_FILE" exec -T api pnpm run db:migrate 2>/dev/null || true

 _wait_for auth "curl -sf http://localhost:3003/health/live" 3003
 _wait_for api "curl -sf http://localhost:3001/health/live" 3001
 _wait_for admin "curl -sf http://localhost:3004/health/live" 3004
 _wait_for web "curl -sf http://localhost:3000" 3000

 green "All E2E services healthy."
}

down() {
 green "Stopping E2E environment..."
 docker compose -f "$COMPOSE_FILE" down -v
 green "E2E environment stopped and volumes cleaned."
}

_wait_for() {
 local name="$1"
 local check="$2"
 local host_port="$3"
 local deadline=$((SECONDS + WAIT_TIMEOUT))
 local url="http://localhost:${host_port}"
 # Support port-only checks (pg_isready)
 if [[ "$check" == *":"* ]]; then
 local cmd="$check"
 fi

 printf "Waiting for %s on %s..." "$name" "$url"
 while true; do
 if eval "$check" >/dev/null 2>&1; then
 green " OK"
 return 0
 fi
 if ((SECONDS >= deadline)); then
 red " TIMEOUT after ${WAIT_TIMEOUT}s"
 docker compose -f "$COMPOSE_FILE" logs --tail=20 "$name" 2>/dev/null || true
 return 1
 fi
 sleep 2
 done
}

test() {
 up
 green "Running Playwright E2E tests..."
 pnpm exec playwright test
 local status=$?
 down
 return $status
}

case "${1:-}" in
 up) up ;;
 down) down ;;
 wait) up ;;
 test) test ;;
 *)
 red "Usage: $0 {up|down|wait|test}"
 exit 1
 ;;
esac
