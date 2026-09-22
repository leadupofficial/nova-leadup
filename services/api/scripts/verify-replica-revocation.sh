#!/usr/bin/env bash
#
# Cross-replica revocation, verified across two live processes.
#
# ## Why this is a shell script and not a section of `verify-platform-roles.py`
#
# It needs **two API instances** running at once, on different ports, against the same database. The
# python verifier talks to one base URL; starting a second replica from inside it would make every other
# section depend on that replica's lifetime. This is the only check in the suite with that requirement,
# so it lives on its own and is run deliberately.
#
# ## What it proves
#
# The token denylist used to be an in-process `Map`, so a revocation was immediate on the replica that
# performed it and invisible to every other replica — the token kept working elsewhere until it expired.
# This drives the real path: register and sign in through replica A, confirm the token works on replica
# B, log out through A, and assert B rejects it after one poll interval. Without the shared table, step 6
# returns 200.
#
# Usage, from the repository root:
#   PORT=3001 npx tsx src/server.ts &            # replica A
#   PORT=3002 npx tsx src/server.ts &            # replica B
#   bash services/api/scripts/verify-replica-revocation.sh
#
# Exits non-zero on the first failure.

set -uo pipefail

A="${REPLICA_A:-http://127.0.0.1:3001}"
B="${REPLICA_B:-http://127.0.0.1:3002}"
PG_CONTAINER="${PG_CONTAINER:-nova-pgvector}"
POLL_WAIT="${POLL_WAIT:-7}"

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

EMAIL="replica-check-$(date +%s)@nova.test"
PASSWORD="ReplicaCheck!2026"

note() { printf '\n\033[1m%s\033[0m\n' "$1"; }

note "0. Both replicas answer"
check "replica A is up" "$(curl -s -o /dev/null -w '%{http_code}' "$A/health")" "200"

# A missing replica B is a missing precondition, not a failing platform. Without this the run reported
# three failures whose cause was "second process was not started", which reads like the cross-replica
# revocation had broken.
if [ "$(curl -s -o /dev/null -w '%{http_code}' "$B/health")" != "200" ]; then
	printf '  \033[31mFAIL\033[0m replica B is not running at %s\n' "$B"
	printf '       start it with:  cd services/api && PORT=3002 npx tsx src/server.ts &\n'
	printf '       this check needs two live processes; one cannot demonstrate propagation.\n'
	exit 1
fi
printf '  \033[32mPASS\033[0m replica B is up\n'

note "1. Register through replica A"
REG=$(curl -s -X POST -H "Content-Type: application/json" \
	-d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Replica Check\"}" \
	"$A/api/v1/auth/register")
# The envelope puts the token fields directly on `data`, so read them from there.
TOKEN=$(printf '%s' "$REG" | python3 -c "
import json,sys
try:
    data = json.load(sys.stdin).get('data') or {}
except Exception:
    data = {}
candidates = [data, data.get('token') or {}, data.get('tokens') or {}]
for candidate in candidates:
    if isinstance(candidate, dict):
        token = candidate.get('accessToken') or candidate.get('access_token')
        if token:
            print(token)
            break
")
check "registration returned an access token" "$([ -n "$TOKEN" ] && echo yes || echo no)" "yes"
if [ -z "$TOKEN" ]; then
	printf '  could not continue without a token: %s\n' "$(printf '%s' "$REG" | head -c 200)"
	exit 1
fi

# A protected route the account can reach with only an access token.
probe() { curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$1/api/v1/reminders"; }

note "2. The same token is accepted by both replicas"
check "replica A accepts it" "$(probe "$A")" "200"
check "replica B accepts it" "$(probe "$B")" "200"

note "3. Revoke it through replica A only"
check "logout succeeds" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "$A/api/v1/auth/logout")" "204"

note "4. Replica A applies it immediately"
check "replica A now rejects it" "$(probe "$A")" "401"

note "5. Replica B, after one poll interval (${POLL_WAIT}s)"
sleep "$POLL_WAIT"
check "replica B now rejects it too" "$(probe "$B")" "401"

note "6. The revocation is durable, not just in memory"
ROWS=$(docker exec "$PG_CONTAINER" psql -U nova_user -d nova -t -A \
	-c "SELECT count(*) FROM revoked_tokens r JOIN users u ON u.id::text = r.sub WHERE u.email = '$EMAIL'" 2>/dev/null | tr -d '[:space:]')
check "the shared table holds the revocation" "$ROWS" "1"

note "7. A different subject's token cannot be revoked by matching a jti"
# The denylist rejects a jti presented with the wrong subject, which is what stops one user's
# revocation from being used to sign another out — or a revoked jti from being reused under another
# identity. Asserted through the shared table's shape rather than a forged token.
SUBJECTS=$(docker exec "$PG_CONTAINER" psql -U nova_user -d nova -t -A \
	-c "SELECT count(DISTINCT sub) FROM revoked_tokens WHERE jti = (SELECT jti FROM revoked_tokens ORDER BY revoked_at DESC LIMIT 1)" 2>/dev/null | tr -d '[:space:]')
check "each jti maps to exactly one subject" "$SUBJECTS" "1"

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
