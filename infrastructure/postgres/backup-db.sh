#!/usr/bin/env bash
#
# NOVA database backup.
#
# There were no backups at all until this script: an agent's test cleanup once
# deleted real user rows and the only reason they came back was that autovacuum
# had not yet reused the heap pages. That is not a recovery strategy.
#
# Writes a compressed logical dump, verifies it is readable and non-empty before
# keeping it, and prunes old copies. Exits non-zero on any failure so cron mail
# and the log make a broken backup visible rather than silent.
set -euo pipefail

BACKUP_DIR=/opt/nova/backups
RETENTION_DAYS=14
STAMP=$(date -u +%Y%m%d-%H%M%S)
# The PID guards against two runs in the same second overwriting each other.
FILE="$BACKUP_DIR/nova-$STAMP-$$.sql.gz"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# A dump that is silently empty or truncated is worse than none, so every check
# below fails the run instead of leaving a file that looks like a backup.
docker exec nova-postgres pg_dump -U postgres -d nova --clean --if-exists \
  | gzip -9 > "$FILE"

if [ ! -s "$FILE" ]; then
  echo "backup failed: $FILE is empty" >&2
  rm -f "$FILE"
  exit 1
fi

# Confirm the gzip stream is intact ...
if ! gzip -t "$FILE" 2>/dev/null; then
  echo "backup failed: $FILE is not a valid gzip stream" >&2
  rm -f "$FILE"
  exit 1
fi

# ... and that it contains schema, not just a pg_dump preamble.
#
# `grep -q` would exit on the first match, giving zcat SIGPIPE; under `pipefail`
# that makes the pipeline fail and reports a perfectly good dump as broken. So
# count instead of short-circuiting, and absorb grep's no-match exit code.
TABLES=$(zcat "$FILE" | grep -c 'CREATE TABLE' || true)
if [ "${TABLES:-0}" -eq 0 ]; then
  echo "backup failed: no CREATE TABLE found in $FILE" >&2
  rm -f "$FILE"
  exit 1
fi

# Restore the file mode: the dump contains password hashes and user data.
chmod 600 "$FILE"

find "$BACKUP_DIR" -name 'nova-*.sql.gz' -type f -mtime "+$RETENTION_DAYS" -delete

SIZE=$(du -h "$FILE" | cut -f1)
COUNT=$(find "$BACKUP_DIR" -name 'nova-*.sql.gz' -type f | wc -l)
echo "$(date -u +%FT%TZ) ok $FILE ($SIZE, $COUNT retained)"
