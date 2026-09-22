#!/usr/bin/env bash
#
# The job queue, verified against the running API and its worker.
#
# ## What this proves
#
# The console's Retry button answered `501 RETRY_NOT_SUPPORTED` because nothing enqueued: `job_executions`
# was a queue-shaped table with no producer, so an operator saw an empty table and a control that did
# nothing. This drives the real path — the scheduler enqueues, the worker claims and runs, a retry
# re-queues the work and it runs again, and retrying something already in flight is refused.
#
# Usage: bash services/api/scripts/verify-job-queue.sh   (API running on :3001)
# Exits non-zero on the first failure.

set -uo pipefail

# Resolved from this file's own location, not the caller's working directory.
#
# The first version used a repository-relative path for the token script, so running it after a `cd`
# anywhere else silently minted no token and five authenticated checks failed — a verification script
# that depends on where it is invoked from reports the caller's mistake as a product failure.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

API="${API:-http://127.0.0.1:3001/api/v1}"
PG_CONTAINER="${PG_CONTAINER:-nova-pgvector}"

passed=0
failed=0
check() {
	if [ "$2" = "$3" ]; then
		printf '  \033[32mPASS\033[0m %s\n' "$1"
		passed=$((passed + 1))
	else
		printf '  \033[31mFAIL\033[0m %s — expected %s, got %s\n' "$1" "$3" "$2"
		failed=$((failed + 1))
	fi
}
note() { printf '\n\033[1m%s\033[0m\n' "$1"; }
psql() { docker exec "$PG_CONTAINER" psql -U nova_user -d nova -t -A -c "$1" 2>/dev/null | tr -d '[:space:]'; }

TOKEN=$(node "$REPO_ROOT/services/api/scripts/mint-dev-admin-token.mjs" owner)

note "1. A worker is running and has handlers registered"
QUEUE=$(curl -s --max-time 20 -H "Authorization: Bearer $TOKEN" "$API/control/jobs?pageSize=1")
WORKER_RUNNING=$(printf '%s' "$QUEUE" | python3 -c "import json,sys; print((json.load(sys.stdin)['data'].get('worker') or {}).get('running'))")
HANDLERS=$(printf '%s' "$QUEUE" | python3 -c "import json,sys; print(','.join(sorted((json.load(sys.stdin)['data'].get('worker') or {}).get('handlers') or [])))")
check "a queue worker is running on this replica" "$WORKER_RUNNING" "True"
check "the periodic handlers are registered" "$HANDLERS" "logs.reap,providers.health_check"

note "2. The scheduler enqueues work and the worker runs it"
# Wait for at least one row the scheduler created — it enqueues on boot and every five minutes.
for _ in $(seq 1 20); do
	ROWS=$(psql "SELECT count(*) FROM job_executions WHERE enqueued_by='scheduler' AND status='succeeded'")
	[ "${ROWS:-0}" -gt 0 ] && break
	sleep 2
done
check "scheduled jobs have completed" "$([ "${ROWS:-0}" -gt 0 ] && echo yes || echo no)" "yes"

note "3. A successful run records what an operator needs"
RUN=$(psql "SELECT coalesce(duration_ms::text,'-') || '|' || enqueued_by || '|' || attempt || '/' || max_attempts FROM job_executions WHERE status='succeeded' ORDER BY created_at DESC LIMIT 1")
check "duration, enqueuer and attempt are recorded" "$(printf '%s' "$RUN" | awk -F'|' '{print ($1!="-") && ($2=="scheduler") && ($3=="1/3") ? "yes" : "no"}')" "yes"

note "4. Retry works — it was 501 before this release"
JOB=$(psql "SELECT id FROM job_executions WHERE status='succeeded' ORDER BY created_at DESC LIMIT 1")
CODE=$(curl -s --max-time 20 -o /tmp/job-retry.json -w '%{http_code}' -X POST \
	-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
	-d '{"reason":"verifying the retry action is real"}' "$API/control/jobs/$JOB/retry")
check "a retry returns 200 rather than 501" "$CODE" "200"
check "the retry reset the attempt budget" "$(psql "SELECT attempt || '/' || max_attempts FROM job_executions WHERE id='$JOB'")" "1/3"

note "5. The worker claims the retried job and completes it again"
for _ in $(seq 1 15); do
	STATE=$(psql "SELECT status FROM job_executions WHERE id='$JOB'")
	[ "$STATE" = "succeeded" ] && break
	sleep 2
done
check "the retried job ran and succeeded" "$STATE" "succeeded"

note "6. Retrying something already in flight is refused, not duplicated"
curl -s --max-time 20 -o /dev/null -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
	-d '{"reason":"first of two"}' "$API/control/jobs/$JOB/retry"
SECOND=$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
	-d '{"reason":"second of two"}' "$API/control/jobs/$JOB/retry")
check "a second retry while queued or running is refused" "$SECOND" "409"
for _ in $(seq 1 15); do
	STATE=$(psql "SELECT status FROM job_executions WHERE id='$JOB'")
	[ "$STATE" = "succeeded" ] && break
	sleep 2
done

note "7. A retry carries a reason, and is audited"
AUDITED=$(psql "SELECT count(*) FROM admin_audit_logs WHERE action='job.retry_requested' AND outcome='success'")
check "the retry is in the audit log" "$([ "${AUDITED:-0}" -gt 0 ] && echo yes || echo no)" "yes"
NO_REASON=$(curl -s --max-time 20 -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
	-d '{}' "$API/control/jobs/$JOB/retry")
check "a retry without a reason is refused" "$NO_REASON" "400"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
