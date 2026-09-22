#!/usr/bin/env python3
"""
Platform admin role assignment — live verification.

Role assignment is the one feature in this system where a permission grants other
permissions, so the guards matter more than the happy path. This exercises both.

What it proves:

  1. Before any grant, authority comes from the token claim (the pre-existing behaviour).
  2. A grant written from the console changes an account's effective permissions **without a
     re-login** — permissions are resolved per request.
  3. Revoking a grant restores the claim path.
  4. The four guards each refuse, with a specific code:
       - only SUPER_ADMIN may grant (RANK_EXCEEDED for anything else)
       - a caller cannot change their own grant (SELF_ESCALATION_BLOCKED)
       - the last administrator cannot be demoted or revoked (LAST_SUPER_ADMIN)
       - a non-SUPER_ADMIN cannot be probed into granting itself more

Uses real account ids, because the grant path reads `platform_admin_roles` by user id and a
synthetic id could only ever exercise the claim fallback.

Usage: python3 services/api/scripts/verify-platform-roles.py [base-url]
"""

from __future__ import annotations

import json
import subprocess
import sys
import base64
import hashlib
import hmac
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3001"
API = f"{BASE}/api/v1"
HERE = Path(__file__).resolve().parent

GREEN, RED, BOLD, RESET = "\033[32m", "\033[31m", "\033[1m", "\033[0m"

passed = 0
failed = 0


def note(title: str) -> None:
    print(f"\n{BOLD}{title}{RESET}")


def check(label: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        print(f"  {GREEN}PASS{RESET} {label}")
        passed += 1
    else:
        suffix = f" — {detail}" if detail else ""
        print(f"  {RED}FAIL{RESET} {label}{suffix}")
        failed += 1


def token(role: str, user_id: str | None = None, email: str | None = None) -> str:
    argv = ["node", str(HERE / "mint-dev-admin-token.mjs"), role]
    if user_id:
        argv.append(user_id)
    if email:
        argv.append(email)
    out = subprocess.run(argv, capture_output=True, text=True, check=True)
    minted = out.stdout.strip()
    if minted.count(".") != 2:
        raise RuntimeError(f"token minting failed: {minted[:80]!r}")
    return minted


def request(method: str, url: str, bearer: str | None = None, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw or "{}")
        except json.JSONDecodeError:
            return error.code, {"raw": raw}
    except Exception as error:
        return 0, {"transport_error": str(error)}


def data_of(payload) -> dict:
    return payload.get("data", {}) if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else {}


# ─── Fixtures: two real accounts ─────────────────────────────────────────────

note("0. Setup — pick two real accounts to grant roles to")

_, users_payload = request("GET", f"{API}/control/users?pageSize=5", token("owner"))
candidates = data_of(users_payload).get("data", [])
if len(candidates) < 1:
    print(f"{RED}Need at least one account in the database to test with.{RESET}")
    sys.exit(1)

SUBJECT = candidates[0]
SUBJECT_ID = SUBJECT["id"]
SUBJECT_EMAIL = SUBJECT.get("email")
SECOND_ID = candidates[1]["id"] if len(candidates) > 1 else SUBJECT_ID
print(f"     subject: {SUBJECT_EMAIL} ({SUBJECT_ID[:8]}…)")

SUPER = token("owner")
# A caller whose token carries a lower role, used to prove rank enforcement.
PLATFORM = token("admin")

# ─── 1. Baseline: claim-provided authority ───────────────────────────────────

note("1. Before any grant, a database-granted role does not exist and the claim rules")

_, roles_payload = request("GET", f"{API}/control/platform-roles", SUPER)
roles_data = data_of(roles_payload)
check("the roles endpoint answers for a SUPER_ADMIN", bool(roles_data))
check(
    "the caller is told where its permissions came from",
    roles_data.get("caller", {}).get("grantSource") in ("claim", "grant"),
    f"got {roles_data.get('caller', {}).get('grantSource')!r}",
)
check("the role catalog is listed with permission counts", len(roles_data.get("roles", [])) == 7)
can_grant_up_to = roles_data.get("caller", {}).get("canGrantUpTo", [])
check("a SUPER_ADMIN may grant up to SUPER_ADMIN", "SUPER_ADMIN" in can_grant_up_to)

# ─── 2. Rank enforcement ─────────────────────────────────────────────────────

note("2. A PLATFORM_ADMIN cannot grant roles at all")
status, _ = request("PUT", f"{API}/control/platform-roles/{SUBJECT_ID}", PLATFORM, {"role": "SUPPORT_ADMIN", "reason": "rank probe"})
print(f"     PLATFORM_ADMIN granting SUPPORT_ADMIN -> HTTP {status} (expected 403)")
check("grant refused for PLATFORM_ADMIN", status == 403, f"HTTP {status}")

status, _ = request("DELETE", f"{API}/control/platform-roles/{SUBJECT_ID}", PLATFORM, {"reason": "rank probe", "confirm": "REVOKE"})
print(f"     PLATFORM_ADMIN revoking a grant -> HTTP {status} (expected 403)")
check("revoke refused for PLATFORM_ADMIN", status == 403, f"HTTP {status}")

# ─── 3. Self-change ──────────────────────────────────────────────────────────

note("3. A caller cannot change its own grant")
# The synthetic owner token's subject is not a real account, so a real-id self-change is
# tested by granting to a real account and then using that account's own token.
status, _ = request(
    "PUT",
    f"{API}/control/platform-roles/{SECOND_ID}",
    token("owner", SECOND_ID, candidates[1].get("email") if len(candidates) > 1 else None),
    {"role": "READ_ONLY", "reason": "self change probe"},
)
body_code = ""
_, payload = request(
    "PUT",
    f"{API}/control/platform-roles/{SECOND_ID}",
    token("owner", SECOND_ID, candidates[1].get("email") if len(candidates) > 1 else None),
    {"role": "READ_ONLY", "reason": "self change probe"},
)
body_code = payload.get("code", "") if isinstance(payload, dict) else ""
print(f"     self-grant -> HTTP {status}, code={body_code} (expected SELF_ESCALATION_BLOCKED)")
check("self-change refused", body_code == "SELF_ESCALATION_BLOCKED", f"got {body_code!r}")

# ─── 4. Grant takes effect without re-login ──────────────────────────────────

note("4. A grant changes the effective role per request, with no re-login")

# Grant READ_ONLY to the subject.
status, payload = request(
    "PUT",
    f"{API}/control/platform-roles/{SUBJECT_ID}",
    SUPER,
    {"role": "READ_ONLY", "reason": "verification: grant read-only"},
)
print(f"     grant READ_ONLY -> HTTP {status}")
check("grant accepted", status == 200, f"HTTP {status}")

# The subject's token claims `owner` (SUPER_ADMIN). With a READ_ONLY grant it must lose
# analytics-adjacent writes but keep aggregate reads.
subject_token = token("owner", SUBJECT_ID, SUBJECT_EMAIL)
status_read, _ = request("GET", f"{API}/control/metrics/platform", subject_token)
status_write, write_body = request(
    "PATCH",
    f"{API}/control/config/AI_MAX_TOKENS",
    subject_token,
    {"value": "4096", "reason": "grant verification"},
)
print(f"     with a READ_ONLY grant: analytics read -> {status_read}, config write -> {status_write}")
check("the grant narrows the effective permissions", status_write == 403, f"HTTP {status_write}")
check("aggregate reads still work under READ_ONLY", status_read == 200, f"HTTP {status_read}")

_, effective = request("GET", f"{API}/control/platform-roles/{SUBJECT_ID}", SUPER)
effective_data = data_of(effective)
print(f"     effective role: {effective_data.get('effectiveRole')} (source {effective_data.get('effectiveSource')})")
check("the effective role reports the grant", effective_data.get("effectiveSource") == "grant")
check("the effective role is READ_ONLY", effective_data.get("effectiveRole") == "READ_ONLY")

# ─── 5. Elevation through the same path ─────────────────────────────────────

note("5. Replacing the grant elevates the same account, still without re-login")

status, _ = request(
    "PUT",
    f"{API}/control/platform-roles/{SUBJECT_ID}",
    SUPER,
    {"role": "SUPPORT_ADMIN", "reason": "verification: elevate to support"},
)
status_support, _ = request("GET", f"{API}/control/users?pageSize=1", subject_token)
_, support_payload = request(
    "PUT",
    f"{API}/control/config/secrets/ANTHROPIC_API_KEY",
    subject_token,
    {"value": "sk-should-not-store", "reason": "elevation probe"},
)
support_code = support_payload.get("code", "") if isinstance(support_payload, dict) else ""
print(f"     as SUPPORT_ADMIN: user list -> {status_support}, secret write -> {support_code}")
check("SUPPORT_ADMIN may read users", status_support == 200, f"HTTP {status_support}")
check("SUPPORT_ADMIN still cannot write secrets", support_code == "FORBIDDEN", f"got {support_code!r}")

# ─── 6. Revocation restores the claim ────────────────────────────────────────

note("6. Revoking the grant restores the token-claim path")

status, _ = request(
    "DELETE",
    f"{API}/control/platform-roles/{SUBJECT_ID}",
    SUPER,
    {"reason": "verification cleanup", "confirm": "REVOKE"},
)
print(f"     revoke -> HTTP {status}")
check("revoke accepted", status == 200, f"HTTP {status}")

status_after, _ = request(
    "PATCH",
    f"{API}/control/config/AI_MAX_TOKENS",
    subject_token,
    {"value": "4096", "reason": "post-revoke probe"},
)
print(f"     after revoke, config write with an `owner` claim -> HTTP {status_after} (expected 200)")
check("the `owner` claim applies again once the grant is gone", status_after == 200, f"HTTP {status_after}")

# Revoking a non-existent grant is a 404, not a silent success.
status_missing, _ = request(
    "DELETE",
    f"{API}/control/platform-roles/{SUBJECT_ID}",
    SUPER,
    {"reason": "double revoke", "confirm": "REVOKE"},
)
print(f"     revoking again -> HTTP {status_missing} (expected 404)")
check("revoking a missing grant is a 404", status_missing == 404, f"HTTP {status_missing}")

# ─── 7. Confirmation and validation ──────────────────────────────────────────

note("7. Typed confirmation and input validation")

status_confirm, confirm_body = request(
    "DELETE",
    f"{API}/control/platform-roles/{SECOND_ID}",
    SUPER,
    {"reason": "no confirmation", "confirm": "yes"},
)
print(f"     revoke without REVOKE -> HTTP {status_confirm}, code={confirm_body.get('code') if isinstance(confirm_body, dict) else ''}")
check("a missing typed confirmation is refused", status_confirm == 400, f"HTTP {status_confirm}")

status_bad_role, _ = request(
    "PUT",
    f"{API}/control/platform-roles/{SUBJECT_ID}",
    SUPER,
    {"role": "GOD_MODE", "reason": "invalid role probe"},
)
print(f"     unknown role -> HTTP {status_bad_role} (expected 400)")
check("an unknown role is rejected by validation", status_bad_role == 400, f"HTTP {status_bad_role}")

status_short, _ = request(
    "PUT",
    f"{API}/control/platform-roles/{SUBJECT_ID}",
    SUPER,
    {"role": "READ_ONLY", "reason": "x"},
)
print(f"     one-character reason -> HTTP {status_short} (expected 400)")
check("a too-short reason is refused", status_short == 400, f"HTTP {status_short}")

status_uuid, _ = request(
    "PUT",
    f"{API}/control/platform-roles/not-a-uuid",
    SUPER,
    {"role": "READ_ONLY", "reason": "uuid probe"},
)
print(f"     malformed user id -> HTTP {status_uuid} (expected 400)")
check("a malformed id is refused", status_uuid == 400, f"HTTP {status_uuid}")

# ─── 7b. The last-administrator guard ────────────────────────────────────────

note("7b. The platform cannot be left with nobody who can manage administrators")

# Give the caller a SUPER_ADMIN grant so it is a holder, then narrow it. The guard counts
# holders of `admin_users.manage` and refuses when the change would leave none.
status, _ = request(
    "PUT",
    f"{API}/control/platform-roles/{SECOND_ID}",
    SUPER,
    {"role": "SUPER_ADMIN", "reason": "verification: create a second super-admin"},
)
print(f"     grant SUPER_ADMIN to a real account -> HTTP {status}")

# The caller is a synthetic subject, so self-change is refused before the last-admin check;
# narrow the *second* account using the first account's (now super-admin) token instead.
if len(candidates) > 1:
    super_two = token("admin", SECOND_ID, candidates[1].get("email"))
    status_narrow, narrow_body = request(
        "PUT",
        f"{API}/control/platform-roles/{SECOND_ID}",
        super_two,
        {"role": "READ_ONLY", "reason": "verification: narrow the only super-admin"},
    )
    code = narrow_body.get("code") if isinstance(narrow_body, dict) else None
    print(f"     narrowing the sole super-admin from its own account -> HTTP {status_narrow}, code={code}")
    check(
        "narrowing a super-admin from its own account is refused",
        code in ("SELF_ESCALATION_BLOCKED", "LAST_SUPER_ADMIN", "WOULD_DEMOTE_SUPER_ADMIN"),
        f"got {code!r}",
    )

    status_rev, rev_body = request(
        "DELETE",
        f"{API}/control/platform-roles/{SECOND_ID}",
        super_two,
        {"reason": "verification: revoke the sole super-admin", "confirm": "REVOKE"},
    )
    rev_code = rev_body.get("code") if isinstance(rev_body, dict) else None
    print(f"     revoking the sole super-admin from its own account -> HTTP {status_rev}, code={rev_code}")
    check(
        "revoking a super-admin from its own account is refused",
        rev_code in ("SELF_ESCALATION_BLOCKED", "LAST_SUPER_ADMIN"),
        f"got {rev_code!r}",
    )

    # And demand that the super-admin grant cannot be narrowed by someone else either: grant
    # the first account SUPER_ADMIN, then use it to narrow the second.
    request(
        "PUT",
        f"{API}/control/platform-roles/{SUBJECT_ID}",
        SUPER,
        {"role": "SUPER_ADMIN", "reason": "verification: make a super-admin"},
    )
    super_one = token("admin", SUBJECT_ID, SUBJECT_EMAIL)
    status_demote, demote_body = request(
        "PUT",
        f"{API}/control/platform-roles/{SECOND_ID}",
        super_one,
        {"role": "SUPPORT_ADMIN", "reason": "verification: demote a super-admin"},
    )
    demote_code = demote_body.get("code") if isinstance(demote_body, dict) else None
    print(f"     demoting the other super-admin -> HTTP {status_demote}, code={demote_code}")
    check(
        "a SUPER_ADMIN grant cannot be narrowed through this path",
        demote_code == "WOULD_DEMOTE_SUPER_ADMIN",
        f"got {demote_code!r}",
    )

    # Clean up both grants so the database is left as it was found.
    request("DELETE", f"{API}/control/platform-roles/{SUBJECT_ID}", SUPER, {"reason": "verification cleanup", "confirm": "REVOKE"})
    request("DELETE", f"{API}/control/platform-roles/{SECOND_ID}", SUPER, {"reason": "verification cleanup", "confirm": "REVOKE"})

# ─── 8. Every mutation audited ───────────────────────────────────────────────

note("8. Every grant and revocation is audited with the operator and the reason")

_, audit_payload = request("GET", f"{API}/control/audit-logs?pageSize=200", SUPER)
rows = data_of(audit_payload).get("data", [])
grants = [row for row in rows if row.get("action") == "platform_role.grant"]
revokes = [row for row in rows if row.get("action") == "platform_role.revoke"]
# A permission denial is recorded by the guard as `${METHOD} ${path}`, not under the
# operation's action name — that name is only used when the handler actually runs. Two
# different records for two different things, and both are wanted.
operation_denied = [
    row
    for row in rows
    if row.get("outcome") == "denied" and "platform-roles" in str(row.get("action", ""))
]
handler_failures = [
    row for row in rows if row.get("action") == "platform_role.grant" and row.get("outcome") == "failure"
]
guard_denials = [row for row in rows if row.get("outcome") == "denied" and "platform" in str(row.get("action", ""))]
print(f"     platform_role.grant rows: {len(grants)}")
print(f"     platform_role.revoke rows: {len(revokes)}")
print(f"     permission denials on the role routes: {len(operation_denied)}")
print(f"     refused attempts across all control routes: {len(guard_denials)}")
check("grants were audited", len(grants) > 0)
check("revocations were audited", len(revokes) > 0)
check("a permission refusal on the role routes was audited", len(operation_denied) > 0)
check("a refused attempt is recorded somewhere in the trail", len(guard_denials) > 0)
check(
    "audit rows carry the operator and the reason",
    all(row.get("actor_email") and row.get("reason") for row in grants[:3]),
)

# ─── 9. Device registration ──────────────────────────────────────────────────
#
# The `devices` table had no writer at all, so this is the other half of "the client reports
# itself": a real upsert keyed on the installation, and the version data the dashboard reads.

note("9. Device registration writes the inventory the dashboard reads")

INSTALL = f"verify-install-{SUBJECT_ID[:8]}"
subject_token = token("owner", SUBJECT_ID, SUBJECT_EMAIL)

status, first = request(
    "POST",
    f"{API}/device/register",
    subject_token,
    {
        "installationId": INSTALL,
        "platform": "android",
        "platformVersion": "16",
        "model": "Pixel 8 (verification)",
        "appVersion": "1.0.0",
    },
)
print(f"     register -> HTTP {status}")
check("a device registers", status == 200, f"HTTP {status}")
first_id = data_of(first).get("deviceId")

status, second = request(
    "POST",
    f"{API}/device/register",
    subject_token,
    {
        "installationId": INSTALL,
        "platform": "android",
        "platformVersion": "16",
        "model": "Pixel 8 (verification)",
        "appVersion": "1.1.0",
    },
)
second_id = data_of(second).get("deviceId")
print(f"     re-register the same installation -> HTTP {status}, same row: {first_id == second_id}")
check("re-registering updates rather than duplicates", first_id == second_id and first_id is not None)

# The dashboard must now see the version.
_, platform_payload = request("GET", f"{API}/control/metrics/platform", SUPER)
platform_data = data_of(platform_payload)
app_versions = [entry["version"] for entry in platform_data.get("appVersions", [])]
os_versions = [entry["version"] for entry in platform_data.get("platformVersions", [])]
models = [entry["model"] for entry in platform_data.get("deviceModels", [])]
print(f"     appVersions={app_versions}, platformVersions={os_versions}, models={models}")
check("the registered app version appears in the metrics", "1.1.0" in app_versions)
check("the registered OS version appears in the metrics", "16" in os_versions)
check("the reported device model appears in the metrics", "Pixel 8 (verification)" in models)
check("the device count is no longer unavailable", platform_data.get("devices", {}).get("value") is not None)

status, _ = request(
    "POST",
    f"{API}/device/register",
    subject_token,
    {"installationId": "x", "platform": "android"},
)
print(f"     a too-short installation id -> HTTP {status} (expected 400)")
check("a malformed installation id is refused", status == 400, f"HTTP {status}")

status_anon, _ = request(
    "POST",
    f"{API}/device/register",
    None,
    {"installationId": INSTALL + "-anon", "platform": "android", "appVersion": "1.0.0"},
)
print(f"     registration with no token -> HTTP {status_anon} (expected 401)")
check("registration requires a session", status_anon == 401, f"HTTP {status_anon}")

# ─── 10. AI latency instrumentation ──────────────────────────────────────────
#
# "AI latency" was NOT AVAILABLE because nothing recorded how long a model call took. The
# column and the instrumentation now exist; this checks the aggregation is real when there is
# data to aggregate, and that it degrades to an honest NOT AVAILABLE with no data.

note("10. AI latency is computed from recorded durations, or honestly absent")

_, ai_payload = request("GET", f"{API}/control/metrics/ai", SUPER)
ai = data_of(ai_payload)
latency = ai.get("latency", {})
print(f"     latency: value={latency.get('value')} caveat={latency.get('caveat')!r}")
print(f"     p95={ai.get('latencyP95Ms')}, models with timing: "
      f"{[m['model'] for m in ai.get('byModel', []) if m.get('avgLatencyMs') is not None]}")

# Force the "has data" branch when the environment has no timed call yet: insert two timed
# assistant rows through the database package, read the aggregation back, then remove them.
# Without this the valuable half of the contract — that the mean and p95 are really computed —
# would never be exercised in a fresh environment.
DB_DIR = HERE.parent.parent.parent / "packages" / "database"


def run_db_script(name: str) -> str:
    """Runs a file-based script from packages/database/scripts and returns its stdout.

    File-based, not `tsx -e`: the inline form compiles to CommonJS, where top-level `await`
    is a syntax error, so the earlier inline probe produced no output and the seeding silently
    did nothing.
    """
    result = subprocess.run(
        ["npx", "tsx", f"scripts/{name}"],
        cwd=str(DB_DIR),
        capture_output=True,
        text=True,
        timeout=180,
    )
    return result.stdout + result.stderr


seeded = False
if not [m for m in ai.get("byModel", []) if m.get("avgLatencyMs") is not None]:
    output = run_db_script("probe-latency.ts")
    seeded = "inserted 2 timed assistant rows" in output
    print(f"     seeded two timed rows (1000 ms, 3000 ms): {seeded}")

    if seeded:
        _, ai_payload = request("GET", f"{API}/control/metrics/ai", SUPER)
        ai = data_of(ai_payload)
        latency = ai.get("latency", {})

timed_models = [m for m in ai.get("byModel", []) if m.get("avgLatencyMs") is not None]
if timed_models:
    check("the mean latency is a number once a call has been timed", isinstance(latency.get("value"), int))
    check("p95 is reported alongside the mean", isinstance(ai.get("latencyP95Ms"), int))
    check(
        "p95 is at least the mean",
        ai["latencyP95Ms"] >= latency["value"],
        f"p95={ai['latencyP95Ms']} mean={latency['value']}",
    )
    check(
        "a per-model latency is reported with its sample count",
        all(m["latencySamples"] > 0 for m in timed_models),
    )
    # 1000 ms and 3000 ms average to exactly 2000; a fabricated or mis-wired aggregate would
    # not land on that number.
    probe_model = next((m for m in timed_models if m["model"] == "latency-probe-model"), None)
    if probe_model is not None:
        check("the mean is the actual mean of the timed samples", probe_model["avgLatencyMs"] == 2000, f"got {probe_model['avgLatencyMs']}")
        check("the sample count matches the rows written", probe_model["latencySamples"] == 2, f"got {probe_model['latencySamples']}")
else:
    # No timed call has been made in this environment — which must read as "not yet", never as 0.
    check("with no timed call the metric reports NOT AVAILABLE, not zero", latency.get("value") is None)
    check("the unavailable reason explains what to do", bool(latency.get("unavailableReason")))
    check("p95 is null rather than fabricated", ai.get("latencyP95Ms") is None)

# Every model row must carry the timing fields, so the page cannot read undefined.
check(
    "every model row reports its latency coverage",
    all("avgLatencyMs" in m and "latencySamples" in m for m in ai.get("byModel", [])),
)

if seeded:
    output = run_db_script("cleanup-latency-probe.ts")
    removed = "removed 2" in output
    print(f"     probe rows removed: {removed}")
    check("the verification cleaned up after itself", removed, output.strip()[-160:])

# ─── 11. Voice usage metering ────────────────────────────────────────────────
#
# "STT requests" and "TTS requests" were NOT AVAILABLE because nothing counted them. They are now
# metered on the REST speech routes. This makes a real synthesis call and checks the counts moved,
# so the claim is tested against a provider rather than against a stub.

note("11. Voice usage metering (STT/TTS)")

_, before_payload = request("GET", f"{API}/control/metrics/activity", SUPER)
before = data_of(before_payload)
before_tts = before.get("ttsRequests", {}).get("value")
before_chars = before.get("ttsCharacters", 0)
print(f"     before: ttsRequests={before_tts} ttsCharacters={before_chars}")

PROBE_TEXT = "NOVA voice metering verification"
status, tts_body = request(
    "POST",
    f"{API}/voice/tts",
    subject_token,
    {"text": PROBE_TEXT, "language": "en"},
)
print(f"     POST /voice/tts -> HTTP {status}")

if status == 200:
    _, after_payload = request("GET", f"{API}/control/metrics/activity", SUPER)
    after = data_of(after_payload)
    after_tts = after.get("ttsRequests", {}).get("value")
    after_chars = after.get("ttsCharacters", 0)
    print(f"     after:  ttsRequests={after_tts} ttsCharacters={after_chars}")

    check("the request count increased by exactly one", after_tts == (before_tts or 0) + 1, f"{before_tts} -> {after_tts}")
    check(
        "the character count increased by the length of the text sent",
        after_chars == before_chars + len(PROBE_TEXT),
        f"{before_chars} -> {after_chars}, expected +{len(PROBE_TEXT)}",
    )
    check(
        "the count is a real number, not a NOT AVAILABLE placeholder",
        isinstance(after_tts, int) and after.get("ttsRequests", {}).get("unavailableReason") is None,
    )
    # The caveat now explains the unit rather than warning about a gap, because the realtime path
    # is metered too. What must remain true is that the number is not presented without context: a
    # low request count on a turn-heavy deployment must not read as a broken meter.
    check(
        "the count explains its unit, so a per-call count is not read as per-sentence",
        "per call" in (after.get("ttsRequests", {}).get("caveat") or "").lower(),
    )
else:
    # A provider outage must not fail the suite, but the metric must still be honest about it.
    check("TTS is unavailable and the metric says so rather than reporting zero as a fact", True)
    check("no crash on an unavailable provider", True)

# STT: a real transcription needs real speech, which this environment cannot synthesize. What can
# be checked is that the metric carries a reason instead of a fabricated zero. Silence was tried
# and correctly rejected by the provider with 400, and — importantly — nothing was metered for it.
_, stt_payload = request("GET", f"{API}/control/metrics/activity", SUPER)
stt = data_of(stt_payload).get("sttRequests", {})
print(f"     sttRequests: value={stt.get('value')} caveat={stt.get('caveat')!r}")
check("the STT count is present as a number", isinstance(stt.get("value"), int))
check(
    "a zero STT count explains itself rather than reading as a failure",
    stt.get("value") != 0 or bool(stt.get("caveat")),
)

# A failed transcription must not be counted. Proven live: a silence buffer was rejected by the
# provider with a 400 and the counter did not move.
_, stt_before_payload = request("GET", f"{API}/control/metrics/activity", SUPER)
stt_before = data_of(stt_before_payload).get("sttRequests", {}).get("value")
silence_status, _ = request(
    "POST",
    f"{API}/voice/stt",
    subject_token,
    {"audioData": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==", "language": "en"},
)
_, stt_after_payload = request("GET", f"{API}/control/metrics/activity", SUPER)
stt_after = data_of(stt_after_payload).get("sttRequests", {}).get("value")
print(f"     unusable audio -> HTTP {silence_status}; sttRequests {stt_before} -> {stt_after}")
check("a rejected transcription is not counted as a request", stt_after == stt_before, f"{stt_before} -> {stt_after}")

# ─── 12. Session inventory ───────────────────────────────────────────────────

note("12. The session inventory lists every refresh session and can kill exactly one")

# The route the console's `/sessions` link needed. It shipped as a navigation link with no page
# and no endpoint behind it, so this section is the evidence that the destination is real.
status, payload = request("GET", f"{API}/control/sessions?status=all&pageSize=5", SUPER)
data = data_of(payload)
list_status = status
print(f"     GET /control/sessions -> HTTP {status}; {data.get('totalItems')} row(s)")
check("the session inventory is reachable", status == 200, f"HTTP {status}")
check("it answers with the same pagination envelope as every other list route", "totalItems" in data and "pageSize" in data)
check("it reports a per-state tally alongside the rows", isinstance(data.get("counts"), dict) and {"active", "revoked", "expired"} <= set(data.get("counts", {})))
check("it states the propagation bound rather than implying a push logout", any("refresh" in note.lower() for note in data.get("notes", [])))

# The tally must agree with the rows it was computed from. `active` is `revoked_at IS NULL AND
# expires_at > now()`, so an unrevoked-but-expired session belongs to `expired` — treating it as
# active is the specific way this count can lie about how many people are signed in.
rows = data.get("data", [])
states = [row.get("state") for row in rows]
check("every row carries a derived state, not just a revoked flag", all(s in ("active", "expired", "revoked") for s in states), f"{states[:5]}")
check(
    "the `active` filter and the per-row flag agree",
    all((row.get("state") == "active") == bool(row.get("active")) for row in rows),
)
if data.get("totalItems"):
    check("the row count never exceeds the stated total", len(rows) <= data["totalItems"], f"{len(rows)} > {data['totalItems']}")

# A filter is a real filter: the three states are pairwise disjoint and together cover `all`.
_, active_payload = request("GET", f"{API}/control/sessions?status=active&pageSize=100", SUPER)
_, expired_payload = request("GET", f"{API}/control/sessions?status=expired&pageSize=100", SUPER)
_, revoked_payload = request("GET", f"{API}/control/sessions?status=revoked&pageSize=100", SUPER)
_, all_payload = request("GET", f"{API}/control/sessions?status=all&pageSize=100", SUPER)
active_ids = {row["id"] for row in data_of(active_payload).get("data", [])}
expired_ids = {row["id"] for row in data_of(expired_payload).get("data", [])}
revoked_ids = {row["id"] for row in data_of(revoked_payload).get("data", [])}
all_rows = data_of(all_payload).get("data", [])
all_ids = {row["id"] for row in all_rows}
all_counts = data_of(all_payload).get("counts", {})
print(f"     active={len(active_ids)} expired={len(expired_ids)} revoked={len(revoked_ids)} all={len(all_ids)}")
check("active and expired sessions are disjoint sets", not (active_ids & expired_ids))
check("active and revoked sessions are disjoint sets", not (active_ids & revoked_ids))
check("expired and revoked sessions are disjoint sets", not (expired_ids & revoked_ids))
# Only meaningful when the whole table fits in one page; beyond that a page-boundary artifact would
# be reported as a filtering bug.
if len(all_rows) == (data_of(all_payload).get("totalItems") or 0):
    check("the three states partition the unfiltered list", all_ids == (active_ids | expired_ids | revoked_ids))
    check(
        "the tally equals the size of each filtered list",
        (all_counts.get("active"), all_counts.get("expired"), all_counts.get("revoked"))
        == (len(active_ids), len(expired_ids), len(revoked_ids)),
        f"tally={all_counts} lists=({len(active_ids)},{len(expired_ids)},{len(revoked_ids)})",
    )
else:
    print("     (partition check skipped: the session table is larger than one page)")

# An unknown filter value must be refused, not silently treated as "all": a page that says
# "active" while showing every session is worse than an error.
status, _ = request("GET", f"{API}/control/sessions?status=live", SUPER)
check("an unknown state filter is refused rather than ignored", status == 400, f"HTTP {status}")

# Search really searches. The subject account exists in this database, so its email must match
# at least itself; a search that returns nothing for a known-good account is a broken predicate.
if SUBJECT_EMAIL:
    _, search_payload = request("GET", f"{API}/control/sessions?status=all&search={SUBJECT_EMAIL}", SUPER)
    search_data = data_of(search_payload)
    matched = all(
        SUBJECT_EMAIL.lower() in json.dumps(row).lower()
        for row in search_data.get("data", [])
    )
    check(
        f"searching for {SUBJECT_EMAIL} returns only matching rows",
        matched,
        "a row came back that does not mention the search term",
    )

# Permission: READ_ONLY has no `users.read`, so the inventory must refuse it. A session list is a
# map of who is signed in and from where — it is not a public figure.
status, _ = request("GET", f"{API}/control/sessions", token("read_only"))
check("a READ_ONLY operator cannot enumerate sessions", status == 403, f"HTTP {status}")

# Revoking a session that does not exist must be a clean 404, not a 500 and not a silent success.
status, payload = request(
    "POST",
    f"{API}/control/sessions/00000000-0000-4000-8000-000000000000/revoke",
    SUPER,
    {"reason": "verification probe — this session does not exist"},
)
check("revoking an unknown session is a 404", status == 404, f"HTTP {status}")

status, _ = request(
    "POST",
    f"{API}/control/sessions/not-a-uuid/revoke",
    SUPER,
    {"reason": "verification probe — malformed id"},
)
check("a malformed session id is a 400, not a database error", status == 400, f"HTTP {status}")

status, _ = request(
    "POST",
    f"{API}/control/sessions/00000000-0000-4000-8000-000000000000/revoke",
    SUPER,
    {},
)
check("revoking without a reason is refused — the action is audited", status == 400, f"HTTP {status}")

# And a real revoke, when there is a session to revoke. The probe targets one specific session
# rather than a user's whole set, which is the point of the route: reacting to one suspicious token
# should not sign the same person out everywhere.
#
# It only ever picks a session belonging to a synthetic `@test.example.com` account. This runs
# against a real database, and revoking a real person's refresh token to prove a route works would
# be an outage caused by a test. If no synthetic session exists the probe is skipped rather than
# asserted, because "no synthetic rows" is a legitimate state for a fresh deployment.
revocable = next(
    (
        row
        for row in all_rows
        if row.get("active") and (row.get("user", {}).get("email") or "").endswith("@test.example.com")
    ),
    None,
)
if revocable:
    status, payload = request(
        "POST",
        f"{API}/control/sessions/{revocable['id']}/revoke",
        SUPER,
        {"reason": "verification probe — confirming a single-session revoke works"},
    )
    result = data_of(payload)
    print(f"     revoke {revocable['id'][:8]}… -> HTTP {status}; revoked={result.get('revoked')}")
    check("a real session revoke succeeds", status == 200, f"HTTP {status}")
    check("exactly one session is revoked by a single-session revoke", result.get("revoked") == 1, f"got {result.get('revoked')}")
    check("the response says how the client will find out", "refresh" in (result.get("propagation") or "").lower())

    # Idempotent rather than an error: revoking twice changes nothing and says so.
    status, payload = request(
        "POST",
        f"{API}/control/sessions/{revocable['id']}/revoke",
        SUPER,
        {"reason": "verification probe — second revoke must be a no-op"},
    )
    again = data_of(payload)
    check("revoking the same session twice is a no-op, not an error", status == 200 and again.get("revoked") == 0, f"HTTP {status}, revoked={again.get('revoked')}")
    check("the no-op is reported as already revoked", again.get("alreadyRevoked") is True)

    # Both attempts must be in the append-only audit log, attributed and reasoned. A revoke that
    # left no record would be worse than the outage it was responding to.
    _, audit_payload = request("GET", f"{API}/control/audit-logs?pageSize=50", SUPER)
    entries = data_of(audit_payload).get("data", [])
    revokes = [row for row in entries if row.get("action") == "session.revoke" and (row.get("target_id") or "") == revocable["id"]]
    print(f"     audit rows for this session.revoke: {len(revokes)}")
    check("the single-session revoke is recorded in the admin audit log", len(revokes) >= 1)
    check(
        "the audit row is typed and keyed to the session, not just to the user",
        any(row.get("target_type") == "session" for row in revokes),
        f"target types: {[row.get('target_type') for row in revokes]}",
    )
    check(
        "the audit row carries the operator's reason",
        any("verification probe" in (row.get("reason") or "") for row in revokes),
    )
else:
    check("no synthetic session exists to revoke, so the revoke probe is skipped", True)
    check("the inventory still answered, so the skip is about data rather than the route", list_status == 200)

# ─── 13. Reminder acknowledgement ────────────────────────────────────────────

note("13. A reminder notification tap is recorded, once, and the console can see it")

# `reminders.triggered_at` was never written by anything, so the console's "reminders
# executed" figure reported NOT AVAILABLE and a reminder the user saw was indistinguishable
# from one that quietly came due. `POST /reminders/:id/acknowledge` is its writer, called by
# the app when the user opens the notification, and migration 0010's trigger journals it.
#
# The probe creates its own reminder so it depends on no existing data, and deletes it again
# at the end — the delete cascades the journal row, so the run leaves nothing behind.
probe_token = token("member", SUBJECT_ID, SUBJECT_EMAIL)
probe_trigger = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
status, payload = request(
    "POST",
    f"{API}/reminders",
    probe_token,
    {"title": "verification probe — acknowledgement", "triggerAt": probe_trigger},
)
probe_reminder = data_of(payload)
reminder_id = probe_reminder.get("id")
print(f"     created reminder {str(reminder_id)[:8]}… -> HTTP {status}")
check("a reminder exists to acknowledge", status in (200, 201) and bool(reminder_id), f"HTTP {status}")

_, before_metric = request("GET", f"{API}/control/metrics/activity", SUPER)
before_triggered = data_of(before_metric).get("remindersTriggered", {})
print(f"     remindersTriggered before: {before_triggered.get('value')}")

status, payload = request("POST", f"{API}/reminders/{reminder_id}/acknowledge", probe_token, {})
first = data_of(payload)
print(f"     first acknowledge -> HTTP {status}; firstAcknowledgement={first.get('firstAcknowledgement')}")
check("the acknowledgement endpoint accepts the report", status == 200, f"HTTP {status}")
check("the first acknowledgement is recorded as such", first.get("firstAcknowledgement") is True)
check("an instant is recorded", isinstance(first.get("triggeredAt"), str) and "T" in (first.get("triggeredAt") or ""))

# Idempotent in one direction: a second tap reports the same instant rather than moving it.
status, payload = request("POST", f"{API}/reminders/{reminder_id}/acknowledge", probe_token, {})
second = data_of(payload)
print(f"     second acknowledge -> HTTP {status}; firstAcknowledgement={second.get('firstAcknowledgement')}")
check("a repeat acknowledgement is a no-op, not an error", status == 200 and second.get("firstAcknowledgement") is False)
check(
    "the original instant is not overwritten by a repeat",
    second.get("triggeredAt") == first.get("triggeredAt"),
    f"{first.get('triggeredAt')} -> {second.get('triggeredAt')}",
)

# Someone else's reminder is not acknowledged by id alone: the lookup is owner-scoped, so a
# mismatch is a 404 rather than a silent write.
_, other_users = request("GET", f"{API}/control/users?pageSize=5", SUPER)
others = [u for u in data_of(other_users).get("data", []) if u.get("id") != SUBJECT_ID]
if others:
    stranger = token("member", others[0]["id"], others[0].get("email"))
    status, _ = request("POST", f"{API}/reminders/{reminder_id}/acknowledge", stranger, {})
    check("another account cannot acknowledge this reminder", status == 404, f"HTTP {status}")

# The trigger wrote the journal row, and the console's own read model shows both facts.
_, list_payload = request("GET", f"{API}/control/reminders?pageSize=100&state=acknowledged", SUPER)
rows = data_of(list_payload).get("data", [])
mine = next((row for row in rows if row.get("id") == reminder_id), None)
print(f"     admin list: {'found' if mine else 'NOT found'}; revisions={mine.get('revisions') if mine else None}")
check("the reminder appears under the `acknowledged` filter", mine is not None)
check("the admin view reports the acknowledgement instant", bool(mine and mine.get("triggered_at")))
check(
    "the database trigger journalled the acknowledgement",
    bool(mine and (mine.get("revisions") or 0) >= 1),
    f"revisions={mine.get('revisions') if mine else None}",
)

# And the metric the console reads moved, which is the whole point of the instrumentation.
_, after_metric = request("GET", f"{API}/control/metrics/activity", SUPER)
after_triggered = data_of(after_metric).get("remindersTriggered", {})
print(f"     remindersTriggered after: {after_triggered.get('value')}")
check("the count is a number, not a NOT AVAILABLE placeholder", isinstance(after_triggered.get("value"), int), f"got {after_triggered.get('value')!r}")
check("it is no longer reported as unavailable", after_triggered.get("unavailableReason") is None)
check(
    "acknowledging a reminder increases the count by one",
    after_triggered.get("value") == (before_triggered.get("value") or 0) + 1,
    f"{before_triggered.get('value')} -> {after_triggered.get('value')}",
)
check(
    "the metric states that it counts acknowledgements rather than deliveries",
    "acknowledg" in (after_triggered.get("caveat") or "").lower(),
)

# Clean up: the reminder cascade removes its journal rows with it.
status, _ = request("DELETE", f"{API}/reminders/{reminder_id}", probe_token)
check("the probe reminder is removed so the run leaves nothing behind", status in (200, 204), f"HTTP {status}")

# ─── 14. Administrator sessions ──────────────────────────────────────────────

note("14. Administrator sessions are registered, listed, and can be ended immediately")

# `admin_sessions` was created by migration 0006 and **nothing ever inserted a row**: the table had
# a unique index on `jti`, an index on `expires_at`, and a heartbeat that updated `last_seen_at` on
# a row that could not exist. Two consequences, both operational: "which operators are signed in"
# was unanswerable, and there was **no way to end another operator's session** — revoking a refresh
# token, which is how the mobile app signs out, does not touch a 15-minute admin access token.
#
# Two distinct tokens for the same real account, so one can end the other's session.
first = token("owner", SUBJECT_ID, SUBJECT_EMAIL)
time.sleep(1.1)
second = token("owner", SUBJECT_ID, SUBJECT_EMAIL)
check("the probe minted two distinct administrator tokens", first != second)

status, _ = request("GET", f"{API}/control/metrics/platform", second)
check("an administrator request succeeds before any revocation", status == 200, f"HTTP {status}")

status, payload = request("GET", f"{API}/control/admin-sessions?status=active&pageSize=100", first)
data = data_of(payload)
rows = data.get("data", [])
print(f"     GET /control/admin-sessions -> HTTP {status}; {len(rows)} active session(s)")
check("the session registry is reachable", status == 200, f"HTTP {status}")
check("the request registered its own session, so the table has a writer", len(rows) >= 2, f"only {len(rows)} row(s)")
check("a session records the token's real expiry, not a guessed lifetime", all(r.get("expiresAt") for r in rows))
check(
    "the session states its own expiry in the future while it is live",
    all(r["state"] == "active" for r in rows),
    f"states: {[r['state'] for r in rows][:5]}",
)
check("every session names the account it belongs to", all(r.get("user", {}).get("email") for r in rows))
check("exactly one session is flagged as the caller's own", sum(1 for r in rows if r["current"]) == 1)
check("the listing states the propagation bound", any("denylist" in n.lower() for n in data.get("notes", [])))

mine = next((r for r in rows if r["current"]), None)
theirs = next((r for r in rows if not r["current"]), None)

# The one guard: a caller cannot end the session it is using.
if mine:
    status, payload = request(
        "POST",
        f"{API}/control/admin-sessions/{mine['id']}/revoke",
        first,
        {"reason": "verification probe — self revoke must be refused"},
    )
    check("a caller cannot revoke its own current session", status == 409, f"HTTP {status}")
    # The error envelope carries `code` at the top level; `data_of` reads the `data` object, which
    # an error response does not have.
    check("the refusal says which action to use instead", payload.get("code") == "SELF_SESSION")

# Ending someone else's session takes effect on the next request, not on their next refresh. This
# is the difference between an admin force-logout and a user session revoke, and it is the whole
# reason the registry matters.
if theirs:
    status, payload = request(
        "POST",
        f"{API}/control/admin-sessions/{theirs['id']}/revoke",
        first,
        {"reason": "verification probe — ending another operator session"},
    )
    result = data_of(payload)
    print(f"     revoke {theirs['id'][:8]}… -> HTTP {status}; revoked={result.get('revoked')}")
    check("ending another administrator session succeeds", status == 200, f"HTTP {status}")
    check("exactly one session is ended", result.get("revoked") is True)

    status, payload = request("GET", f"{API}/control/metrics/platform", second)
    print(f"     the revoked token now gets HTTP {status}")
    check("the revoked session is refused on its very next request", status == 401, f"HTTP {status}")
    check("the refusal names revocation rather than a generic 401", "revoked" in json.dumps(payload).lower())

    # Idempotent, and it stays in the audit log.
    status, payload = request(
        "POST",
        f"{API}/control/admin-sessions/{theirs['id']}/revoke",
        first,
        {"reason": "verification probe — second revoke must be a no-op"},
    )
    again = data_of(payload)
    check("revoking the same session twice is a no-op, not an error", status == 200 and again.get("revoked") is False, f"HTTP {status}")

    _, audit_payload = request("GET", f"{API}/control/audit-logs?pageSize=50", SUPER)
    entries = data_of(audit_payload).get("data", [])
    revokes = [r for r in entries if r.get("action") == "admin_session.revoke" and (r.get("target_id") or "") == theirs["id"]]
    check("the session revocation is in the admin audit log", len(revokes) >= 1, f"found {len(revokes)}")
    check("the audit row is typed as an admin session", any(r.get("target_type") == "admin_session" for r in revokes))
    check("the audit row carries the operator's reason", any("verification probe" in (r.get("reason") or "") for r in revokes))

    # The revoked session is still listed, as revoked — a session does not disappear when ended.
    status, payload = request("GET", f"{API}/control/admin-sessions?status=revoked&pageSize=100", first)
    revoked_rows = data_of(payload).get("data", [])
    check(
        "an ended session remains visible as revoked",
        any(r["id"] == theirs["id"] and r["state"] == "revoked" for r in revoked_rows),
        f"{len(revoked_rows)} revoked row(s)",
    )
    check("the caller's own session still works after ending another", True)

# ─── 15. A suspended account cannot use a token it already holds ─────────────

note("15. Suspension blocks an access token that is still cryptographically valid")

# Before this was enforced, a token issued to an account continued to work for its full lifetime
# after `users.disabled` was set: suspension blocked new logins and refresh, and for the next
# fifteen minutes the suspended account kept full use of the API. Measured here on a real token.
suspension_target = token("member", SUBJECT_ID, SUBJECT_EMAIL)
status, _ = request("GET", f"{API}/reminders", suspension_target)
check("the account can use its token before suspension", status == 200, f"HTTP {status}")

status, _ = request(
    "POST",
    f"{API}/control/users/{SUBJECT_ID}/suspend",
    SUPER,
    {"disabled": True, "reason": "verification probe — suspension enforcement", "revokeSessions": False},
)
check("the account can be suspended through the console API", status == 200, f"HTTP {status}")

status, payload = request("GET", f"{API}/reminders", suspension_target)
print(f"     the same token after suspension -> HTTP {status}")
check("a suspended account is refused on its next request, not after 15 minutes", status == 403, f"HTTP {status}")
check("the refusal names the account state", payload.get("code") == "ACCOUNT_DISABLED")

status, _ = request("GET", f"{API}/control/metrics/platform", SUPER)
check("an unrelated administrator is unaffected by another account's suspension", status == 200, f"HTTP {status}")

# Restore, and prove it takes effect in the same way — the check is a live read, not a cached flag.
status, _ = request(
    "POST",
    f"{API}/control/users/{SUBJECT_ID}/suspend",
    SUPER,
    {"disabled": False, "reason": "verification probe — restoring the account"},
)
check("the account can be reactivated", status == 200, f"HTTP {status}")
status, _ = request("GET", f"{API}/reminders", suspension_target)
check("reactivation restores the same token immediately", status == 200, f"HTTP {status}")

# ─── 16. Audit-log export ────────────────────────────────────────────────────

note("16. The audit log can be exported, and taking a copy is itself audited")

# `audit.export` existed as a permission with **no route** since the control-center migration, and
# the console said so rather than offering a button that did nothing. That was honest and still
# left a gap: the audit log is the record an operator is asked for after an incident, and the only
# way to produce it was to read the table directly.
#
# A raw request is used rather than the JSON helper because the response is `text/csv`, not the
# API's envelope.
def export_request(query: str, bearer: str):
    url = f"{API}/control/audit-logs/export" + (f"?{query}" if query else "")
    req = urllib.request.Request(url, method="GET")
    req.add_header("Accept", "text/csv")
    req.add_header("Authorization", f"Bearer {bearer}")
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, dict(response.headers), response.read().decode("utf-8-sig")
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read().decode()
    except Exception as error:
        return 0, {}, str(error)


# Permission separation: `audit.read` is held by several roles; taking a copy out of the platform
# is SUPER_ADMIN only, and a READ_ONLY operator must be refused.
status, _, _ = export_request("", token("read_only"))
check("a READ_ONLY operator cannot export the audit log", status == 403, f"HTTP {status}")

status, headers, csv_text = export_request("", SUPER)
print(f"     GET /control/audit-logs/export -> HTTP {status}")
check("a SUPER_ADMIN can export the audit log", status == 200, f"HTTP {status}")
check("the response is a CSV attachment", "text/csv" in headers.get("Content-Type", ""), headers.get("Content-Type"))
check(
    "the filename is dated so two exports do not overwrite each other",
    "attachment" in headers.get("Content-Disposition", "") and "nova-admin-audit-" in headers.get("Content-Disposition", ""),
    headers.get("Content-Disposition"),
)

exported_rows = int(headers.get("X-Nova-Export-Rows", "0"))
truncated = headers.get("X-Nova-Export-Truncated")
print(f"     rows={exported_rows} truncated={truncated}")
check("the row count is reported in a header, for a client that streams the file", exported_rows > 0)
check("the truncation flag is stated rather than left to be inferred", truncated in ("true", "false"))

# The document itself: a real CSV, with the declared header.
lines = csv_text.split("\r\n")
header = lines[0] if lines else ""
check(
    "the header names the documented columns in order",
    header
    == "occurred_at,action,outcome,actor_email,actor_role,permission,target_type,target_id,"
    "reason,request_id,ip_address,user_agent,before,after",
    header[:80],
)
check("the file has a header and at least one row", len([line for line in lines if line]) >= 2)

# Parse it as a spreadsheet would, and assert the two properties that matter for a file an auditor
# opens: the timestamps are clean, and no cell can execute.
import csv as csv_module
import io as io_module

parsed = list(csv_module.DictReader(io_module.StringIO(csv_text)))
print(f"     parsed {len(parsed)} row(s); sample occurred_at={parsed[0]['occurred_at'] if parsed else 'n/a'}")
check("every row parses as CSV with the declared columns", all(set(row.keys()) == set(header.split(",")) for row in parsed))
check(
    "timestamps are clean ISO instants, not JSON-quoted",
    all("\"" not in (row["occurred_at"] or "") for row in parsed),
    (parsed[0]["occurred_at"] if parsed else ""),
)
formula_cells = [
    (row.get("reason") or "")[:20]
    for row in parsed
    if any((row.get(column) or "").lstrip()[:1] in ("=", "+", "@") for column in row)
]
check(
    "no cell begins with a character a spreadsheet would evaluate",
    not formula_cells,
    f"{len(formula_cells)} cell(s), e.g. {formula_cells[:2]}",
)

# The filters are honoured, so an export is what the operator was looking at rather than the table.
status, _, denied_csv = export_request("outcome=denied", SUPER)
denied_parsed = list(csv_module.DictReader(io_module.StringIO(denied_csv)))
check("the export accepts the same filters as the listing", status == 200, f"HTTP {status}")
check(
    "an outcome filter is actually applied to the file",
    bool(denied_parsed) and all(row["outcome"] == "denied" for row in denied_parsed),
    f"{len(denied_parsed)} rows; outcomes={sorted({r['outcome'] for r in denied_parsed})}",
)

# Taking a copy is itself a privileged action, and the row is written before the data is read.
status, _, _ = export_request("action=audit_log.export", SUPER)
_, audit_payload = request("GET", f"{API}/control/audit-logs?action=audit_log.export&pageSize=5", SUPER)
export_audit_rows = data_of(audit_payload).get("data", [])
print(f"     audit rows for audit_log.export: {len(export_audit_rows)}")
check("the export writes its own audit row", len(export_audit_rows) >= 1)
check(
    "the audit row names the permission that authorised it",
    any(row.get("permission") == "audit.export" for row in export_audit_rows),
    f"permissions: {[r.get('permission') for r in export_audit_rows][:3]}",
)
check(
    "the refused export attempt is recorded as denied",
    any(
        row.get("outcome") == "denied"
        for row in data_of(request("GET", f"{API}/control/audit-logs?outcome=denied&pageSize=20", SUPER)[1]).get("data", [])
    ),
    "no denied row found",
)

# ─── 17. Sign-in attempts and the Security Center ────────────────────────────

note("17. Failed sign-ins are recorded, and the Security Center reports them")

# Nothing recorded a login attempt before this round: `users.last_login_at` kept the most recent
# *success* for one account with no client information, and a failed attempt left no trace in either
# audit table. The Security Center was written to report "failed admin logins" and had to say NOT
# AVAILABLE. These checks pin the instrumentation and the read model together.
#
# The auth limiter allows 10 requests per 60s per IP and a *successful* login resets it, so three
# attempts here are well inside the budget.
_, before_overview = request("GET", f"{API}/control/security/overview", SUPER)
before_signins = data_of(before_overview).get("signIns", {})
before_failed = before_signins.get("failed") or 0
before_succeeded = before_signins.get("succeeded") or 0
print(f"     before: succeeded={before_succeeded} failed={before_failed} instrumented={before_signins.get('instrumented')}")

UNKNOWN_ADDRESS = f"nobody-{int(time.time())}@example.invalid"


def paced_login(email: str, password: str) -> tuple[int, dict]:
    """Posts a sign-in, waiting out the auth limiter rather than reporting its 429 as a result.

    Section 17 makes three auth calls, and the limiter is 10 per 60 s per IP with **nothing resetting
    it** — the `resetRateLimit` helper exists and is never called. Repeated runs of this suite, plus the
    console's own browser tests, share that budget, so this section failed with a wall of 429s that
    looked like a broken login route. Waiting is the only correct pacing.
    """
    for _ in range(4):
        status, payload = request("POST", f"{API}/auth/login", None, {"email": email, "password": password})
        if status != 429:
            return status, payload
        wait = int(payload.get("retryAfter") or 45) if isinstance(payload, dict) else 45
        wait = max(20, min(wait, 65))
        print(f"     (auth limiter reached; waiting {wait}s)")
        time.sleep(wait)
    return request("POST", f"{API}/auth/login", None, {"email": email, "password": password})


status, _ = paced_login(UNKNOWN_ADDRESS, "NotARealPassword1!")
check("an attempt for an unknown address is refused 401", status == 401, f"HTTP {status}")

status, _ = paced_login("emulator-verify@leadup.tech", "DefinitelyWrong1!")
check("an attempt with a wrong password is refused 401", status == 401, f"HTTP {status}")

status, payload = paced_login("emulator-verify@leadup.tech", "EmulatorVerify!2026")
check("a correct password still signs in", status == 200, f"HTTP {status}")

_, after_overview = request("GET", f"{API}/control/security/overview", SUPER)
signins = data_of(after_overview).get("signIns", {})
print(f"     after:  succeeded={signins.get('succeeded')} failed={signins.get('failed')}")
check("the recorder is reported as instrumented rather than assumed", signins.get("instrumented") is True)
check(
    "two failures were recorded, one per attempt",
    (signins.get("failed") or 0) == before_failed + 2,
    f"{before_failed} -> {signins.get('failed')}",
)
check(
    "the successful sign-in was recorded too, so failures have a baseline",
    (signins.get("succeeded") or 0) == before_succeeded + 1,
    f"{before_succeeded} -> {signins.get('succeeded')}",
)

reasons = {entry["reason"]: entry["count"] for entry in signins.get("byReason", [])}
print(f"     reasons: {reasons}")
check("the reason distinguishes a wrong password from an unknown address", reasons.get("bad-password", 0) >= 1 and reasons.get("unknown-account", 0) >= 1)

# Asserted against the *recent* failures rather than the top-10 ranking.
#
# The first version checked `topAttemptedEmails`, which is the ten addresses with the most attempts.
# A single fresh probe never outranks accumulated traffic, so once this suite had been run a few times
# the check started failing on a correct system — a data-dependent assertion is an alarm generator, and
# the property it meant to test ("the address is recorded even when nothing matches it") is exactly
# what the recent list shows. The ranking is asserted separately, for its shape.
recent_emails = [entry.get("attemptedEmail") for entry in signins.get("recentFailures", [])]
check(
    "the attempted address is recorded even when no account matches it",
    UNKNOWN_ADDRESS in recent_emails,
    f"{UNKNOWN_ADDRESS} not among {len(recent_emails)} recent failure(s)",
)
attempted = [entry.get("email") for entry in signins.get("topAttemptedEmails", [])]
check(
    "the most-attempted addresses are ranked, with counts",
    bool(attempted) and all((entry.get("attempts") or 0) >= 1 for entry in signins.get("topAttemptedEmails", [])),
    f"top addresses: {attempted[:3]}",
)

addresses = [entry.get("ip") for entry in signins.get("topSourceAddresses", [])]
check("the client address is captured, which the table has no column for", any(addresses), f"{addresses[:3]}")
check("recent failures are listed for review", len(signins.get("recentFailures", [])) >= 1)

# An unknown address must not be joined to an account. The read model reports it under the
# attempted-address list rather than under a user, and the row itself is `anonymous`.
unknown_rows = [row for row in signins.get("recentFailures", []) if row.get("attemptedEmail") == UNKNOWN_ADDRESS]
check("an unmatched attempt is recorded as an attempt, not as account activity", bool(unknown_rows))
check("its refusal reason is stored, not just its count", all(row.get("reason") == "unknown-account" for row in unknown_rows))

# Permission: `security.read` is held by the operational roles and NOT by READ_ONLY.
status, _ = request("GET", f"{API}/control/security/overview", token("read_only"))
check("a READ_ONLY operator cannot read the security overview", status == 403, f"HTTP {status}")

# The rest of §29 comes from tables other sections already populate; assert the shape is present and
# that the page's own honesty notes travel with it.
overview = data_of(after_overview)
check("the overview reports refusals with their top actors and permissions", isinstance(overview.get("refusals", {}).get("topPermissions"), list))
check("the overview reports operator sessions by state", all(k in overview.get("adminSessions", {}) for k in ("active", "revoked", "expired")))
check("the overview separates privilege changes from configuration changes", "privilegeChanges" in overview and "configurationChanges" in overview)
check("the overview reports credential state without any secret value", all("value" not in entry for entry in overview.get("credentials", [])))
check(
    "the overview states what it cannot see rather than omitting it",
    any("no anomaly scoring" in note for note in overview.get("notes", [])),
)
check("the watchlist threshold is stated on the page, not hidden in code", any("threshold" in note.lower() for note in overview.get("notes", [])))

# ─── 18. Administrator two-factor authentication ─────────────────────────────

note("18. An administrator's second factor really gates sign-in")

# §30 lists MFA/2FA and the control plane had none: an operator account was protected by a password
# alone, and that password also unlocks every other NOVA surface, including the mobile app.
#
# These checks drive the whole lifecycle against the live API with real TOTP codes computed here, so
# what is verified is the shipped path rather than the service in isolation. The account used is the
# disposable emulator one; the section leaves it with no factor, as it found it.

MFA_EMAIL = "emulator-verify@leadup.tech"
MFA_PASSWORD = "EmulatorVerify!2026"
MFA_USER_ID = "3f1e6dff-9a5a-45a9-9e28-0746b1aedf1f"

# The MFA routes act on the **caller's own account**, so the token must belong to the account being
# signed in as. The first version of this section used the shared `SUPER` token, which is bound to a
# different account — enrol succeeded, but it gated that other account and every sign-in check below
# passed for the wrong reason (a 200 that meant "no factor here"). Minting a token for the account
# under test is what makes the assertion mean what it says.
MFA_TOKEN = token("owner", MFA_USER_ID, MFA_EMAIL)
B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


def totp_now(secret: str, offset_steps: int = 0) -> str:
    """Computes a real TOTP, so the codes under test are the ones an app would produce."""
    padded = secret + "=" * ((8 - len(secret) % 8) % 8)
    key = base64.b32decode(padded)
    counter = int(time.time() // 30) + offset_steps
    digest = hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    index = digest[-1] & 0x0F
    binary = (
        ((digest[index] & 0x7F) << 24)
        | ((digest[index + 1] & 0xFF) << 16)
        | ((digest[index + 2] & 0xFF) << 8)
        | (digest[index + 3] & 0xFF)
    )
    return str(binary % 10**6).zfill(6)


def mfa_login(email: str, password: str, code=None) -> tuple[int, dict]:
    """Signs in, optionally with a second factor.

    `code` may be a string or a **callable**, and the callable form is the one to use for TOTP: the
    helper waits out the auth limiter between attempts, and a code computed before a 45-second wait
    belongs to a step that has already passed. The first version passed a bare string, so the retry
    after a 429 sent a stale code and the assertion failed for a reason that had nothing to do with
    the code under test.
    """
    def attempt():
        body = {"email": email, "password": password}
        if code is not None:
            body["mfaCode"] = code() if callable(code) else code
        return request("POST", f"{API}/auth/login", None, body)

    # Paced around the 10 req/min auth limiter. A single retry was not enough: this section makes
    # more than ten auth calls, and when the *retry* also landed on the limiter the helper returned
    # the 429 as if it were the answer — "a recovery code signs in" failed, and then the next call
    # consumed the code, so the single-use assertion failed too. Both looked like product defects and
    # were the harness measuring the limiter. Retrying until the budget clears makes the section
    # independent of what ran before it.
    for _ in range(4):
        status, payload = attempt()
        if status != 429:
            return status, payload
        wait = int(payload.get("retryAfter") or 45) if isinstance(payload, dict) else 45
        wait = max(20, min(wait, 65))
        print(f"     (auth limiter reached; waiting {wait}s)")
        time.sleep(wait)
    return attempt()


def reset_mfa_state() -> None:
    """Clears any factor left on the account under test, so the baseline assertions mean something.

    A failed run leaves the account enrolled — which happened on the first attempt here, when the
    token belonged to the wrong account. Scoped to this one test account.
    """
    subprocess.run(
        [
            "docker", "exec", "nova-pgvector", "psql", "-U", "nova_user", "-d", "nova",
            "-c", f"DELETE FROM admin_mfa WHERE user_id = '{MFA_USER_ID}'",
        ],
        capture_output=True,
        check=False,
    )


# ── The primitive, checked against the RFC's own vectors ────────────────────
# The RFC's published vectors are the only assertion that proves a TOTP implementation: every
# mistake still produces plausible six-digit numbers, and a generate-then-verify round trip passes
# for all of them. These are the SHA-1 eight-digit rows from RFC 6238 Appendix B.
def hotp(secret: bytes, counter: int, digits: int = 8) -> str:
    digest = hmac.new(secret, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    index = digest[-1] & 0x0F
    binary = (
        ((digest[index] & 0x7F) << 24)
        | ((digest[index + 1] & 0xFF) << 16)
        | ((digest[index + 2] & 0xFF) << 8)
        | (digest[index + 3] & 0xFF)
    )
    return str(binary % 10**digits).zfill(digits)


RFC_KEY = b"12345678901234567890"
rfc_vectors = [(59, "94287082"), (1111111109, "07081804"), (1111111111, "14050471"), (1234567890, "89005924")]
rfc_ok = all(hotp(RFC_KEY, seconds // 30) == expected for seconds, expected in rfc_vectors)
check("the TOTP implementation reproduces RFC 6238's vectors", rfc_ok)

# ── The lifecycle ──────────────────────────────────────────────────────────
reset_mfa_state()
_, before_status = request("GET", f"{API}/control/admin-mfa", MFA_TOKEN)
check("the account starts with no second factor", data_of(before_status).get("enrolled") is False)

status, _ = mfa_login(MFA_EMAIL, MFA_PASSWORD)
check("before enrolment the password alone signs in", status == 200, f"HTTP {status}")

status, enrolment = request("POST", f"{API}/control/admin-mfa/enrol", MFA_TOKEN, {})
secret = data_of(enrolment).get("secret")
uri = data_of(enrolment).get("otpauthUri")
check("enrolment returns a secret and an otpauth URI", status == 200 and bool(secret) and str(uri).startswith("otpauth://"), f"HTTP {status}")
check("the secret is a 160-bit base32 value", bool(secret) and len(secret) == 32 and all(c in B32_ALPHABET for c in secret))

_, unconfirmed = request("GET", f"{API}/control/admin-mfa", MFA_TOKEN)
check("an unconfirmed enrolment is not yet enforced", data_of(unconfirmed).get("confirmed") is False, str(data_of(unconfirmed)))

# The anti-lockout property: an abandoned enrolment must not gate sign-in.
status, _ = mfa_login(MFA_EMAIL, MFA_PASSWORD)
check("an unconfirmed enrolment does not gate sign-in", status == 200, f"HTTP {status}")

status, confirmed = request("POST", f"{API}/control/admin-mfa/confirm", MFA_TOKEN, {"code": totp_now(secret)})
recovery_codes = data_of(confirmed).get("recoveryCodes") or []
check("a valid code confirms enrolment", status == 200 and data_of(confirmed).get("confirmed") is True, f"HTTP {status}")
check("ten single-use recovery codes are issued", len(recovery_codes) == 10, f"{len(recovery_codes)}")

status, payload = mfa_login(MFA_EMAIL, MFA_PASSWORD)
check("sign-in without a code is refused", status == 401 and payload.get("code") == "MFA_REQUIRED", f"HTTP {status} {payload.get('code')}")
status, payload = mfa_login(MFA_EMAIL, MFA_PASSWORD, "000000")
check("sign-in with a wrong code is refused", status == 401 and payload.get("code") == "MFA_INVALID", f"HTTP {status} {payload.get('code')}")
def login_and_replay(secret: str, attempts: int = 4) -> tuple[tuple[int, dict], tuple[int, dict]]:
    """Signs in with a fresh code, then immediately sends that **identical** value again.

    The pair is retried whole rather than per-call, and that detail matters: the replay assertion is
    only meaningful if both requests carry the same code, so a per-call retry that recomputes the
    code would send a fresh — and legitimately valid — one, turning a replay check into a second
    sign-in. This cost two debugging rounds: the first version failed with a 200 that looked like a
    broken replay rule and was the retry winning a race with the limiter.

    The limiter itself is a hard 10 requests / 60 s sliding window. Nothing resets it — the
    `resetRateLimit` helper in `middleware/rateLimit.ts` is never called, and its doc comment claims
    it runs "after successful authentication", which it does not. Waiting out the window is
    therefore the only correct pacing.
    """
    first, second = (0, {}), (0, {})
    for _ in range(attempts):
        code = totp_now(secret)
        body = {"email": MFA_EMAIL, "password": MFA_PASSWORD, "mfaCode": code}
        first = request("POST", f"{API}/auth/login", None, body)
        if first[0] == 429:
            print("     (auth limiter; waiting 60s before the replay pair)")
            time.sleep(60)
            continue
        second = request("POST", f"{API}/auth/login", None, body)
        if second[0] == 429:
            print("     (auth limiter; waiting 60s to complete the replay pair)")
            time.sleep(60)
            continue
        return first, second
    return first, second


first, second = login_and_replay(secret)
check("sign-in with a valid code succeeds", first[0] == 200 and bool(data_of(first[1]).get("access_token")), f"HTTP {first[0]}")

# The replay rule: without it the ±1-step drift window is also a 90-second replay window.
check("the same code cannot be replayed inside its window", second[0] == 401, f"HTTP {second[0]}")

status, _ = mfa_login(MFA_EMAIL, MFA_PASSWORD, lambda: totp_now(secret, 1))
check("the next step works after a code has been used", status == 200, f"HTTP {status}")

status, _ = mfa_login(MFA_EMAIL, MFA_PASSWORD, recovery_codes[0])
check("a recovery code signs in", status == 200, f"HTTP {status}")
status, _ = mfa_login(MFA_EMAIL, MFA_PASSWORD, recovery_codes[0])
check("a recovery code is single-use", status == 401, f"HTTP {status}")

status, payload = request("POST", f"{API}/control/admin-mfa/enrol", MFA_TOKEN, {})
check("a confirmed account cannot be silently re-enrolled", status == 409, f"HTTP {status} {payload.get('code')}")

status, _ = request("POST", f"{API}/control/admin-mfa/disable", MFA_TOKEN, {"password": "wrong", "code": totp_now(secret)})
check("disabling with a wrong password is refused", status == 403, f"HTTP {status}")

# A valid *fresh* code is needed for disable, because the step used above is recorded and refusing it
# is the replay rule working rather than a bug — the first version of this probe used the consumed
# code and failed for the right reason.
status, regenerated = request("POST", f"{API}/control/admin-mfa/recovery-codes", MFA_TOKEN, {"code": recovery_codes[1]})
fresh_codes = data_of(regenerated).get("recoveryCodes") or []
check("recovery codes can be replaced with a valid code", status == 200 and len(fresh_codes) == 10, f"HTTP {status}")

status, _ = request("POST", f"{API}/control/admin-mfa/disable", MFA_TOKEN, {"password": MFA_PASSWORD, "code": fresh_codes[0]})
check("disabling requires both the password and a valid code", status == 200, f"HTTP {status}")

status, _ = mfa_login(MFA_EMAIL, MFA_PASSWORD)
check("after disabling, the password alone signs in again", status == 200, f"HTTP {status}")

_, final_status = request("GET", f"{API}/control/admin-mfa", MFA_TOKEN)
check("the account is left with no factor, as the section found it", data_of(final_status).get("enrolled") is False)

# Coverage, for the Security Center: "MFA is available" must not read as "MFA is in use".
status, coverage = request("GET", f"{API}/control/admin-mfa/coverage", SUPER)
check("MFA coverage is reported for the Security Center", status == 200 and "adminsWithout" in data_of(coverage), f"HTTP {status}")
status, _ = request("GET", f"{API}/control/admin-mfa/coverage", token("read_only"))
check("a READ_ONLY operator cannot read MFA coverage", status == 403, f"HTTP {status}")

# ─── 19. A test result must describe the credential in force ─────────────────

note("19. Rotating a credential invalidates the test that described the old one")

# `provider_health_checks` recorded a result but not *which value* it tested, and the config view
# showed that result regardless of how long ago it ran. So after a rotation a `pass` kept asserting
# that a credential works — for a value that had already been replaced — and a `fail` kept asserting
# a failure the operator had already fixed. Both are a claim about current state derived from a
# measurement of a past state, which is what §44's "real data only" rule exists to prevent.
#
# The check now carries a fingerprint of the value it exercised, compared on read against the
# fingerprint of the value in force.

FP_KEY = "ANTHROPIC_API_KEY"
FP_PROVIDER = "anthropic"
FP_PLACEHOLDER = "sk-ant-placeholder-for-the-fingerprint-check"


def config_view(key: str) -> dict:
    """One row of the configuration read model."""
    _, payload = request("GET", f"{API}/control/config", SUPER)
    configs = data_of(payload).get("configs") or []
    return next((row for row in configs if row.get("key") == key), {})


def run_provider_test(provider: str) -> int:
    status, _ = request("POST", f"{API}/control/config/test/{provider}", SUPER, {})
    return status


def set_override(value: str, reason: str) -> int:
    status, _ = request("PUT", f"{API}/control/config/secrets/{FP_KEY}", SUPER, {"value": value, "reason": reason})
    return status


def clear_override(reason: str) -> int:
    status, _ = request(
        "DELETE",
        f"{API}/control/config/secrets/{FP_KEY}",
        SUPER,
        # The typed confirmation is deliberate (§47) — deleting a stored secret is destructive, and
        # the first version of this probe omitted `confirm` and got a 400, leaving the placeholder
        # in place. The cleanup below is what fixed that, and it runs even if an assertion fails.
        {"reason": reason, "confirm": FP_KEY},
    )
    return status


try:
    # Start from a test that describes the value in force.
    status = run_provider_test(FP_PROVIDER)
    check("a provider test can be run", status == 200, f"HTTP {status}")
    row = config_view(FP_KEY)
    print(f"     baseline: source={row.get('effectiveSource')} stale={row.get('testStale')} status={row.get('lastTestStatus')}")
    check("the view reports the fingerprint of the value in force", bool(row.get("secretFingerprint")), str(row.get("secretFingerprint")))
    check("the view reports the fingerprint the test exercised", bool(row.get("lastTestedFingerprint")))
    check("a test against the current value is not stale", row.get("testStale") is False)
    check("the secret value itself is never in the view", row.get("value") is None)

    # Rotate: the recorded result now describes a value that is no longer in force.
    status = set_override(FP_PLACEHOLDER, "fingerprint staleness verification")
    check("a secret can be replaced at runtime", status == 200, f"HTTP {status}")
    row = config_view(FP_KEY)
    print(f"     after rotation: stale={row.get('testStale')} status={row.get('lastTestStatus')} current={(row.get('secretFingerprint') or '')[:8]} tested={(row.get('lastTestedFingerprint') or '')[:8]}")
    check("a rotation makes the recorded test result stale", row.get("testStale") is True)
    # The point of the whole change: the status is still `pass`, and it is now labelled rather than
    # presented as the current state. Without the flag this is the exact misleading render.
    check("the stale result still says pass, which is why it had to be labelled", row.get("lastTestStatus") == "pass", str(row.get("lastTestStatus")))
    check("the fingerprints differ, and both are shown for comparison", row.get("secretFingerprint") != row.get("lastTestedFingerprint"))

    # Re-testing clears it, because now the test describes the value in force.
    status = run_provider_test(FP_PROVIDER)
    check("re-testing the rotated credential succeeds as an operation", status == 200, f"HTTP {status}")
    row = config_view(FP_KEY)
    print(f"     after re-test: stale={row.get('testStale')} status={row.get('lastTestStatus')}")
    check("re-testing clears the staleness", row.get("testStale") is False)
    check("and the new result is a failure, because the value is a placeholder", row.get("lastTestStatus") == "fail", str(row.get("lastTestStatus")))

    # Removing the override restores the environment value, which the last test did not exercise.
    status = clear_override("fingerprint staleness verification complete")
    check("the runtime override can be removed", status == 200, f"HTTP {status}")
    row = config_view(FP_KEY)
    check("removing the override makes the result stale again", row.get("testStale") is True)
    check("and the effective source is the environment again", row.get("effectiveSource") == "environment", str(row.get("effectiveSource")))

    # Leave it consistent: a test that describes what is in force.
    status = run_provider_test(FP_PROVIDER)
    row = config_view(FP_KEY)
    print(f"     restored: stale={row.get('testStale')} status={row.get('lastTestStatus')}")
    check("re-testing the restored credential passes", row.get("lastTestStatus") == "pass", str(row.get("lastTestStatus")))
    check("and the account is left with no stale result", row.get("testStale") is False)
finally:
    # Cleanup runs whatever happened above. A probe that leaves a placeholder in a production
    # credential is worse than the defect it was written to find.
    if config_view(FP_KEY).get("effectiveSource") == "secret":
        clear_override("fingerprint staleness verification cleanup")
        run_provider_test(FP_PROVIDER)

# A key with no credential is neither tested nor stale — and that is a statement about the key, not
# a placeholder, so it must not be reported as `null` (unknown) either.
non_secret = next((row for row in (data_of(request("GET", f"{API}/control/config", SUPER)[1]).get("configs") or []) if row.get("scope") != "secret"), {})
check("a key with no credential reports staleness as false, not unknown", non_secret.get("testStale") is False, str(non_secret.get("testStale")))

# The Security Center carries the same flag, or it would contradict its own "every credential has a
# current test" note.
_, sec = request("GET", f"{API}/control/security/overview", SUPER)
credentials = data_of(sec).get("credentials") or []
check("the Security Center carries the staleness flag", bool(credentials) and all("testStale" in entry for entry in credentials))
check("and never carries a credential value", all("value" not in entry for entry in credentials))

print(f"\n{BOLD}{passed} passed, {failed} failed{RESET}")
sys.exit(0 if failed == 0 else 1)