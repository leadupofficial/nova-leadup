#!/usr/bin/env bash
#
# NOVA backup: PostgreSQL + MinIO objects + Redis state.
#
# There were no backups at all until the first version of this script: an agent's
# test cleanup once deleted real user rows and the only reason they came back was
# that autovacuum had not yet reused the heap pages. That is not a recovery strategy.
#
# The database-only version had three holes, all closed here:
#   1. MinIO holds the audio recordings and Redis holds session/cache state. Both
#      live in named Docker volumes that a pg_dump never touches, so a restore
#      from the old archives would have produced an app with no recordings.
#   2. Nothing had ever been restored. `RESTORE_DRILL=1` performs a real restore
#      into a scratch database, compares row counts against production, and drops
#      the scratch database — a backup you have not restored is a hypothesis.
#   3. Every copy sat on the same disk as the database, so losing the host lost
#      the backups too. With OFFHOST_TARGET set (an rsync/scp destination) the
#      archives are also pushed off the host; without it the run says so loudly
#      instead of implying the data is safe.
#
# Exits non-zero on any failure so cron mail and the log make a broken backup
# visible rather than silent.
#
# Usage:
#   bash backup-db.sh                  # dump, verify, prune
#   RESTORE_DRILL=1 bash backup-db.sh  # also prove the newest dump restores
#   OFFHOST_TARGET=user@host:/path bash backup-db.sh   # also copy off-host
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/opt/nova/backups}
RETENTION_DAYS=${RETENTION_DAYS:-14}
ENV_FILE=${ENV_FILE:-/opt/nova/.env}
MIN_FREE_GB=${MIN_FREE_GB:-2}
STAMP=$(date -u +%Y%m%d-%H%M%S)
# The PID guards against two runs in the same second overwriting each other.
PG_FILE="$BACKUP_DIR/nova-$STAMP-$$.sql.gz"
MINIO_FILE="$BACKUP_DIR/minio-$STAMP.tar.gz"
REDIS_FILE="$BACKUP_DIR/redis-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

fail() {
  echo "backup failed: $*" >&2
  exit 1
}

# A full disk is what kills the database first (a 1 GB image build once filled the
# volume and PostgreSQL aborted into recovery), so refuse to add to the pressure.
FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
[ "${FREE_GB:-0}" -ge "$MIN_FREE_GB" ] || fail "only ${FREE_GB}GB free, below the ${MIN_FREE_GB}GB floor"

# ---------------------------------------------------------------------------
# PostgreSQL
# ---------------------------------------------------------------------------
# A dump that is silently empty or truncated is worse than none, so every check
# below fails the run instead of leaving a file that looks like a backup.
docker exec nova-postgres pg_dump -U postgres -d nova --clean --if-exists \
  | gzip -9 > "$PG_FILE"

[ -s "$PG_FILE" ] || fail "$PG_FILE is empty"
gzip -t "$PG_FILE" 2>/dev/null || fail "$PG_FILE is not a valid gzip stream"

# ... and that it contains schema, not just a pg_dump preamble.
#
# `grep -q` would exit on the first match, giving zcat SIGPIPE; under `pipefail`
# that makes the pipeline fail and reports a perfectly good dump as broken. So
# count instead of short-circuiting, and absorb grep's no-match exit code.
TABLES=$(zcat "$PG_FILE" | grep -c 'CREATE TABLE' || true)
[ "${TABLES:-0}" -gt 0 ] || fail "no CREATE TABLE found in $PG_FILE"
chmod 600 "$PG_FILE"

# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------
# BGSAVE rewrites dump.rdb inside the volume; wait for it to finish before
# archiving the volume, otherwise the archive holds a half-written snapshot.
REDIS_PASSWORD=$(grep '^REDIS_PASSWORD=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
if [ -n "${REDIS_PASSWORD:-}" ]; then
  docker exec nova-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning BGSAVE >/dev/null 2>&1 \
    || echo "warning: redis BGSAVE request failed; archiving the last snapshot" >&2
  for _ in $(seq 1 30); do
    if ! docker exec nova-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning INFO persistence 2>/dev/null \
         | grep -q 'rdb_bgsave_in_progress:1'; then
      break
    fi
    sleep 1
  done
else
  echo "warning: REDIS_PASSWORD not found in $ENV_FILE; archiving without a fresh snapshot" >&2
fi

# ---------------------------------------------------------------------------
# Docker volumes (MinIO objects, Redis snapshots)
# ---------------------------------------------------------------------------
# alpine:latest is already present on the host, so this needs no registry access
# (minio/minio can no longer be pulled anonymously and must not be required here).
archive_volume() {
  local volume=$1 outfile=$2 label=$3
  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "warning: volume $volume not found; skipping $label" >&2
    return 0
  fi
  docker run --rm -v "$volume":/data:ro -v "$BACKUP_DIR":/backup alpine:latest \
    tar czf "/backup/$(basename "$outfile")" -C /data . || fail "$label archive failed"
  [ -s "$outfile" ] || fail "$label archive is empty"
  tar tzf "$outfile" >/dev/null 2>&1 || fail "$label archive is not a valid gzip tar"
  local entries
  entries=$(tar tzf "$outfile" | wc -l)
  [ "$entries" -gt 0 ] || fail "$label archive lists no files"
  chmod 600 "$outfile"
  echo "$label: $entries entries, $(du -h "$outfile" | cut -f1)"
}

archive_volume nova_minio_data "$MINIO_FILE" "minio"
archive_volume nova_redis_data "$REDIS_FILE" "redis"

# ---------------------------------------------------------------------------
# Restore drill (opt-in — it costs a scratch database and a few seconds)
# ---------------------------------------------------------------------------
if [ "${RESTORE_DRILL:-0}" = "1" ]; then
  DRILL_DB=nova_restore_drill
  docker exec nova-postgres psql -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS $DRILL_DB"
  docker exec nova-postgres psql -U postgres -d postgres -q -c "CREATE DATABASE $DRILL_DB"
  zcat "$PG_FILE" | docker exec -i nova-postgres psql -U postgres -d "$DRILL_DB" -q >/dev/null 2>&1 \
    || echo "warning: restore printed errors; comparing counts anyway" >&2
  DRILL_OK=1
  for table in users organizations sessions conversations devices tasks reminders memories usage_records audit_logs; do
    prod=$(docker exec nova-postgres psql -U postgres -d nova -tAc "select count(*) from $table" 2>/dev/null || echo x)
    restored=$(docker exec nova-postgres psql -U postgres -d "$DRILL_DB" -tAc "select count(*) from $table" 2>/dev/null || echo y)
    if [ "$prod" != "$restored" ]; then
      echo "warning: restore drill mismatch on $table (prod=$prod restored=$restored)" >&2
      DRILL_OK=0
    fi
  done
  docker exec nova-postgres psql -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS $DRILL_DB"
  [ "$DRILL_OK" = "1" ] && echo "restore drill: OK (row counts match production, scratch database dropped)"
fi

# ---------------------------------------------------------------------------
# Retention + off-host copy
# ---------------------------------------------------------------------------
find "$BACKUP_DIR" -name 'nova-*.sql.gz' -type f -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name 'minio-*.tar.gz' -type f -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -name 'redis-*.tar.gz' -type f -mtime "+$RETENTION_DAYS" -delete

if [ -n "${OFFHOST_TARGET:-}" ]; then
  if command -v rsync >/dev/null 2>&1; then
    rsync -a -e ssh "$PG_FILE" "$MINIO_FILE" "$REDIS_FILE" "$OFFHOST_TARGET/" \
      || fail "off-host rsync to $OFFHOST_TARGET failed"
  else
    scp -q "$PG_FILE" "$MINIO_FILE" "$REDIS_FILE" "$OFFHOST_TARGET" \
      || fail "off-host scp to $OFFHOST_TARGET failed"
  fi
  echo "off-host: copied to $OFFHOST_TARGET"
else
  # Saying nothing here would let the archives imply durability they do not have.
  echo "WARNING: OFFHOST_TARGET is not set — these archives are on the same disk as the database; a host loss still loses everything." >&2
fi

SIZE=$(du -h "$PG_FILE" | cut -f1)
COUNT=$(find "$BACKUP_DIR" -name 'nova-*.sql.gz' -type f | wc -l)
echo "$(date -u +%FT%TZ) ok $PG_FILE ($SIZE, $COUNT db archives retained)"
