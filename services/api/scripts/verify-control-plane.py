#!/usr/bin/env python3
"""
Cross-system verification: does an Admin Control Center action actually change what the
mobile client is told?

This is the objective's ultimate test in miniature, run against the running API and the
real mobile bootstrap contract. For each control it asserts the whole chain:

    admin change -> backend state -> client contract -> audit record

It also proves the guard rails: a role without a permission is refused, the refusal is
audited, an anonymous request is refused, and no secret value is ever returned.

Why Python rather than shell: this walks a sequence of stateful steps and compares typed
values (booleans, HTTP codes, JSON fields). Doing that in bash required nested quoting and
subshells that made a correct assertion look like a failure, which is exactly the kind of
false signal this script exists to prevent.

PROPAGATION: a flag or control write invalidates the server-side cache immediately, so
this process sees it on the next read. Other replicas keep their previous value until
their cache lapses (15s flags / 5s controls), which the console reports to operators. The
script therefore polls the client contract for a bounded time instead of sleeping a fixed
amount.

IDEMPOTENT: it deletes any pre-existing copy of the test flag first, so a previous run
cannot turn the create step into a 409 and produce a false failure.

Usage: python3 services/api/scripts/verify-control-plane.py [base-url]
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:3001"
API = f"{BASE}/api/v1"
HERE = Path(__file__).resolve().parent

FLAG = "PROACTIVE_ASSISTANT"
SUBJECT = "00000000-0000-4000-8000-000000000009"

GREEN = "\033[32m"
RED = "\033[31m"
BOLD = "\033[1m"
RESET = "\033[0m"

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


def token(role: str) -> str:
    """Mint a token with the same claims the auth service issues, for role testing.

    `.strip()` matters: `subprocess` returns stdout verbatim including the trailing
    newline, and a header value containing "\\n" is rejected by the JWT verifier — every
    admin request came back 401 until this was stripped, which made the whole suite look
    like an authorisation failure.
    """
    out = subprocess.run(
        ["node", str(HERE / "mint-dev-admin-token.mjs"), role],
        capture_output=True,
        text=True,
        check=True,
    )
    minted = out.stdout.strip()
    if not minted or minted.count(".") != 2:
        raise RuntimeError(f"token minting for role {role!r} produced {minted[:40]!r}")
    return minted


def request(method: str, url: str, bearer: str | None = None, body: dict | None = None):
    """Returns (status, parsed_json_or_None). Never raises on an HTTP error status."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")

    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            raw = response.read().decode()
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        status = error.code
    except Exception as error:  # connection refused, timeout, ...
        return 0, {"transport_error": str(error)}

    try:
        return status, json.loads(raw)
    except json.JSONDecodeError:
        return status, None


def data_of(payload) -> dict:
    """The `data` object, or an empty dict so a missing shape cannot throw."""
    if isinstance(payload, dict) and isinstance(payload.get("data"), dict):
        return payload["data"]
    return {}


SUPER = token("owner")
SUPPORT = token("support")


def bootstrap() -> dict:
    _, payload = request("GET", f"{API}/device/bootstrap")
    return data_of(payload)


def flag_value() -> bool | None:
    return bootstrap().get("flags", {}).get(FLAG)


def wait_for_flag(want: bool, tries: int = 15) -> bool:
    """Poll the client contract until it reports `want`."""
    seen: bool | None = None
    for _ in range(tries):
        seen = flag_value()
        if seen is want:
            return True
        time.sleep(1)
    print(f"     last observed value: {seen}")
    return False


def cleanup_flag() -> None:
    request(
        "DELETE",
        f"{API}/control/feature-flags/{FLAG}/overrides",
        SUPER,
        {"scopeType": "user", "scopeValue": SUBJECT, "reason": "verification cleanup"},
    )
    request(
        "DELETE",
        f"{API}/control/feature-flags/{FLAG}",
        SUPER,
        {"confirm": FLAG, "reason": "verification cleanup"},
    )


# ─── 0. Reachability ─────────────────────────────────────────────────────────

note("0. API reachable")
status, payload = request("GET", f"{BASE}/healthz")
health = payload.get("status") if isinstance(payload, dict) else None
print(f"     /healthz -> {status} status={health}")
check("GET /healthz answers ok", health == "ok", f"got {health!r}")

# ─── 1. Idempotent starting point ────────────────────────────────────────────

note("1. Pre-clean so the run is idempotent")
cleanup_flag()
print(f"     {FLAG} resolves to: {flag_value()} (no row -> documented default)")

# ─── 2. Enable through the Control Center ────────────────────────────────────

note("2. Admin creates and ENABLES the flag")
status, _ = request(
    "POST",
    f"{API}/control/feature-flags",
    SUPER,
    {
        "key": FLAG,
        "enabled": True,
        "rolloutPercent": 100,
        "description": "Proactive follow-ups",
        "reason": "cross-system verification",
    },
)
print(f"     POST /control/feature-flags -> {status}")
check("enable accepted by the API", status in (200, 201), f"HTTP {status}")
check("mobile bootstrap contract reflects ENABLED", wait_for_flag(True))
detail = next((f for f in bootstrap().get("flagDetails", []) if f["key"] == FLAG), {})
print(f"     source: {detail.get('source')} — {detail.get('reason')}")

# ─── 3. Disable through the Control Center ───────────────────────────────────

note("3. Admin DISABLES the flag")
status, _ = request(
    "PATCH", f"{API}/control/feature-flags/{FLAG}", SUPER, {"enabled": False, "reason": "cross-system verification"}
)
print(f"     PATCH -> {status}")
check("disable accepted by the API", status == 200, f"HTTP {status}")
check("mobile bootstrap contract reflects DISABLED", wait_for_flag(False))

# ─── 4. Rollout percentage is a real gate ────────────────────────────────────

note("4. Rollout percentage is a real cohort gate, not a label")
request("PATCH", f"{API}/control/feature-flags/{FLAG}", SUPER, {"enabled": True, "rolloutPercent": 0, "reason": "rollout"})
check("enabled at 0% reaches nobody", wait_for_flag(False))
request("PATCH", f"{API}/control/feature-flags/{FLAG}", SUPER, {"enabled": True, "rolloutPercent": 100, "reason": "rollout"})
check("enabled at 100% reaches the user", wait_for_flag(True))

# ─── 5. Per-user override ────────────────────────────────────────────────────

note("5. A per-user override beats the global state")
request("PATCH", f"{API}/control/feature-flags/{FLAG}", SUPER, {"enabled": False, "reason": "override base"})
request(
    "PUT",
    f"{API}/control/feature-flags/{FLAG}/overrides",
    SUPER,
    {"scopeType": "user", "scopeValue": SUBJECT, "enabled": True, "reason": "override verification"},
)
_, evaluation = request("GET", f"{API}/control/feature-flags/{FLAG}/evaluate?userId={SUBJECT}", SUPER)
evaluation = data_of(evaluation)
print(f"     global=disabled, user override=enabled -> source={evaluation.get('source')} enabled={evaluation.get('enabled')}")
check(
    "user override wins over a disabled global flag",
    evaluation.get("source") == "user_override" and evaluation.get("enabled") is True,
)

# ─── 6. Kill switch enforced on a real route ─────────────────────────────────

note("6. An emergency kill switch is enforced on a real route")
status, _ = request("PUT", f"{API}/control/controls/CONTROL_AI_ENABLED", SUPER, {"value": False, "reason": "verification"})
print(f"     PUT /control/controls/CONTROL_AI_ENABLED -> {status}")
time.sleep(1)
cap = bootstrap().get("capabilities", {}).get("ai")
# /chat is the route the mobile client calls for a typed AI turn.
chat_status, chat_body = request("POST", f"{API}/chat", SUPER, {"messages": []})
print(f"     capabilities.ai={cap}, POST /chat -> HTTP {chat_status}")
check("bootstrap reports AI unavailable", cap is False, f"got {cap!r}")
check("AI route refuses with 503", chat_status == 503, f"HTTP {chat_status}")
code = chat_body.get("code") if isinstance(chat_body, dict) else None
print(f"     refusal code: {code}")
check("refusal carries a machine-readable code", code == "CAPABILITY_DISABLED", f"got {code!r}")

# ─── 7. Restore ──────────────────────────────────────────────────────────────

note("7. Restore everything this verification changed")
status, _ = request("PUT", f"{API}/control/controls/CONTROL_AI_ENABLED", SUPER, {"value": True, "reason": "verification cleanup"})
print(f"     AI re-enabled -> {status}")
cleanup_flag()
check("flag removed and the documented default restored", wait_for_flag(True))

# ─── 8. RBAC ─────────────────────────────────────────────────────────────────

note("8. RBAC: a role without the permission is refused")
# Pick a real account for the user-operation probe.
_, users_payload = request("GET", f"{API}/control/users?pageSize=1", SUPER)
user_rows = data_of(users_payload).get("data", [])
target_user = user_rows[0]["id"] if user_rows else SUBJECT
print(f"     probing against real account: {target_user[:8]}…")
# SUPPORT_ADMIN is *designed* to be able to suspend and revoke sessions — that is the
# whole point of the role, and asserting a 403 there would be asserting the role is
# broken. What it must NOT reach is configuration, secrets, kill switches or
# conversation content. Each row states the expected outcome explicitly.
support_cases = [
    ("secret write", "PUT", f"{API}/control/config/secrets/ANTHROPIC_API_KEY", {"value": "sk-must-not-be-stored", "reason": "rbac"}, 403),
    ("secret delete", "DELETE", f"{API}/control/config/secrets/ANTHROPIC_API_KEY", {"reason": "rbac", "confirm": "ANTHROPIC_API_KEY"}, 403),
    ("kill switch", "PUT", f"{API}/control/controls/CONTROL_AI_ENABLED", {"value": False, "reason": "rbac"}, 403),
    ("flag create", "POST", f"{API}/control/feature-flags", {"key": "RBAC_PROBE", "enabled": True, "description": "probe", "reason": "rbac"}, 403),
    ("flag update", "PATCH", f"{API}/control/feature-flags/PROACTIVE_ASSISTANT", {"enabled": True, "reason": "rbac"}, 403),
    ("config write", "PATCH", f"{API}/control/config/AI_MAX_TOKENS", {"value": "4096", "reason": "rbac"}, 403),
    ("maintenance", "PUT", f"{API}/control/maintenance", {"enabled": True, "reason": "rbac", "confirm": "MAINTENANCE"}, 403),
    ("ai configure", "POST", f"{API}/control/ai/config", {"maxTokens": 4096, "reason": "rbac"}, 403),
    # Allowed by design, and asserted so a regression that *over*-restricts the support
    # role is caught too.
    ("user suspend (allowed)", "POST", f"{API}/control/users/{target_user}/suspend", {"disabled": False, "reason": "rbac"}, 200),
    ("conversation metadata (allowed)", "GET", f"{API}/control/conversations?pageSize=1", None, 200),
]
for label, method, url, body, expected in support_cases:
    status, _ = request(method, url, SUPPORT, body)
    print(f"     SUPPORT_ADMIN {label} -> HTTP {status} (expected {expected})")
    check(f"SUPPORT_ADMIN: {label}", status == expected, f"HTTP {status}")

# READ_ONLY is the floor: aggregate reads only.
readonly = token("read_only")
readonly_cases = [
    ("analytics", "GET", f"{API}/control/metrics/platform", None, 200),
    ("services", "GET", f"{API}/control/services", None, 200),
    ("user list", "GET", f"{API}/control/users?pageSize=1", None, 403),
    ("user detail", "GET", f"{API}/control/users/{target_user}", None, 403),
    ("flag list", "GET", f"{API}/control/feature-flags", None, 200),
    ("flag write", "PATCH", f"{API}/control/feature-flags/PROACTIVE_ASSISTANT", {"enabled": True, "reason": "rbac"}, 403),
    ("audit log", "GET", f"{API}/control/audit-logs?pageSize=1", None, 403),
    ("config write", "PATCH", f"{API}/control/config/AI_MAX_TOKENS", {"value": "4096", "reason": "rbac"}, 403),
]
for label, method, url, body, expected in readonly_cases:
    status, _ = request(method, url, readonly, body)
    print(f"     READ_ONLY {label} -> HTTP {status} (expected {expected})")
    check(f"READ_ONLY: {label}", status == expected, f"HTTP {status}")

# ─── 9. Anonymous ────────────────────────────────────────────────────────────

note("9. An unauthenticated request is refused")
anon_status, _ = request("GET", f"{API}/control/config")
print(f"     GET /control/config with no token -> HTTP {anon_status} (expected 401)")
check("anonymous access refused", anon_status == 401, f"HTTP {anon_status}")

# ─── 10. No secret leakage ───────────────────────────────────────────────────

note("10. No secret value is ever returned")
_, config_payload = request("GET", f"{API}/control/config", SUPER)
# The route groups keys by category under `configs` (the flat `entries` key was a
# guess that silently matched nothing, which made a leaked secret undetectable).
entries = [
    entry
    for group in data_of(config_payload).get("categories", [])
    for entry in group.get("configs", [])
]
secret_entries = [entry for entry in entries if entry.get("scope") == "secret"]
leaks = [entry["key"] for entry in secret_entries if entry.get("value") not in (None, "")]
print(f"     {len(secret_entries)} secret entries inspected; leaks: {leaks or 'none'}")
check("no secret value in the config read model", not leaks, f"leaked: {leaks}")
check("the catalog exposes a non-trivial number of secrets", len(secret_entries) >= 8, f"only {len(secret_entries)}")

# ─── 11. Audit trail ─────────────────────────────────────────────────────────

note("11. The audit log recorded every action, including the refusals")
_, audit_payload = request("GET", f"{API}/control/audit-logs?pageSize=200", SUPER)
audit = data_of(audit_payload)
rows = audit.get("data", [])
counts: dict[str, int] = {}
denied = 0
for row in rows:
    counts[row.get("action", "")] = counts.get(row.get("action", ""), 0) + 1
    if row.get("outcome") == "denied":
        denied += 1

expected = [
    "feature_flag.create",
    "feature_flag.update",
    "feature_flag.delete",
    "feature_flag.override_upsert",
    "control.update",
]
for action in expected:
    print(f"     {action}: {counts.get(action, 0)}")
print(f"     refusals recorded (outcome=denied): {denied}")
print(f"     total audit rows: {audit.get('totalItems')}")

missing = [action for action in expected if counts.get(action, 0) == 0]
check("every expected action was audited", not missing, f"missing: {missing}")
check("refused attempts were audited", denied > 0, f"denied={denied}")
check("audit rows carry the acting administrator", all(row.get("actor_email") for row in rows[:5]))

# ─── 12. Append-only enforcement ─────────────────────────────────────────────

note("12. The audit log is append-only")
# There is no UPDATE or DELETE route by design; the guarantee is enforced by a database
# trigger. This checks the API exposes no mutation path for the log at all.
put_status, _ = request("PUT", f"{API}/control/audit-logs", SUPER, {"outcome": "success"})
del_status, _ = request("DELETE", f"{API}/control/audit-logs", SUPER, {})
print(f"     PUT /control/audit-logs -> {put_status}, DELETE -> {del_status} (both must not be 200)")
check("no API path mutates the audit log", put_status != 200 and del_status != 200)

print(f"\n{BOLD}{passed} passed, {failed} failed{RESET}")
sys.exit(0 if failed == 0 else 1)
