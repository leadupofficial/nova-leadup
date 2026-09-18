#!/usr/bin/env python3
"""End-to-end verification of the NOVA auth API.

Exercises the full lifecycle against a running `services/api` instance and exits
non-zero on the first failure, so it can be used as a smoke test locally or in CI.

Covered:
  * registration returns a usable token pair and the user
  * a second registration for the same email is a 409
  * login works, and both "wrong password" and "unknown email" are 401 with the
    *same* message (no account enumeration)
  * /me works with a token and is 401 without one
  * refresh returns a new pair and rotates the refresh token
  * replaying a rotated-out refresh token is a 401
  * logout revokes the presented access token (401 "Token has been revoked") and the
    refresh token can no longer be used

This is the scripted equivalent of the manual checks used while fixing the stubbed auth
routes. It replaces the mobile app's dependency on a live backend for contract
coverage (see also apps/mobile/test/integration/auth_live_test.dart, which drives the
real Dart client against this same API).

Usage:
    python3 verify-auth.py                     # against http://127.0.0.1:3001
    python3 verify-auth.py --base-url http://localhost:3001

The auth routes are rate limited to 10 requests / 60s per IP, so the script honours the
`Retry-After` header and paces itself instead of failing spuriously.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

RESULTS = []


def call(base_url, method, path, body=None, token=None):
    """Returns (status, parsed_body). Retries once on 429 honouring Retry-After."""
    for attempt in range(2):
        req = urllib.request.Request(f"{base_url}/api/v1/auth{path}", method=method)
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        data = json.dumps(body).encode() if body is not None else None
        try:
            with urllib.request.urlopen(req, data) as resp:
                raw = resp.read().decode()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as exc:
            if exc.code == 429 and attempt == 0:
                wait = int(exc.headers.get("Retry-After", "60"))
                print(f"    (rate limited; waiting {wait}s)")
                time.sleep(wait + 1)
                continue
            raw = exc.read().decode()
            try:
                return exc.code, json.loads(raw)
            except json.JSONDecodeError:
                return exc.code, raw
    raise SystemExit("rate limited twice; increase the delay between runs")


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    suffix = f"   [{detail}]" if detail else ""
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{suffix}")
    return bool(ok)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default="http://127.0.0.1:3001")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    stamp = int(time.time())
    email = f"verify-auth-{stamp}@test.example.com"
    password = "verify-auth-password-123"

    print(f"verifying auth API at {base}\n")

    # --- registration ------------------------------------------------------
    print("registration")
    status, body = call(base, "POST", "/register", {"email": email, "password": password, "name": "Verify Auth"})
    data = (body or {}).get("data") or {}
    access = data.get("access_token")
    refresh = data.get("refresh_token")
    user = data.get("user") or {}
    check("POST /register -> 201", status == 201, f"got {status}")
    check("returns an access_token", isinstance(access, str) and len(access) > 20)
    check("returns a refresh_token", isinstance(refresh, str) and len(refresh) > 20)
    check("returns expires_in seconds", isinstance(data.get("expires_in"), int), str(data.get("expires_in")))
    check("returns token_type Bearer", data.get("token_type") == "Bearer")
    check("returns the created user with matching email", user.get("email") == email, str(user.get("email")))

    status, _ = call(base, "POST", "/register", {"email": email, "password": password})
    check("duplicate /register -> 409", status == 409, f"got {status}")

    # --- login -------------------------------------------------------------
    print("\nlogin")
    status, body = call(base, "POST", "/login", {"email": email, "password": password})
    login_data = (body or {}).get("data") or {}
    login_access = login_data.get("access_token")
    check("POST /login (correct password) -> 200", status == 200, f"got {status}")
    check("login returns an access_token", isinstance(login_access, str) and len(login_access) > 20)

    status, wrong = call(base, "POST", "/login", {"email": email, "password": "definitely-wrong"})
    wrong_msg = (wrong or {}).get("detail")
    check("POST /login (wrong password) -> 401", status == 401, f"got {status}")

    status, unknown = call(base, "POST", "/login", {"email": f"nobody-{stamp}@test.example.com", "password": "x"})
    unknown_msg = (unknown or {}).get("detail")
    check("POST /login (unknown email) -> 401", status == 401, f"got {status}")
    check(
        "wrong-password and unknown-email are indistinguishable",
        wrong_msg == unknown_msg == "Invalid email or password",
        f"{wrong_msg!r} vs {unknown_msg!r}",
    )

    # --- protected route ---------------------------------------------------
    print("\nprotected route")
    status, body = call(base, "GET", "/me", token=login_access)
    me = ((body or {}).get("data") or {}).get("user") or {}
    check("GET /me with a valid token -> 200", status == 200, f"got {status}")
    check("GET /me returns the same user id", me.get("id") == user.get("id"))

    status, _ = call(base, "GET", "/me")
    check("GET /me without a token -> 401", status == 401, f"got {status}")

    # --- refresh rotation --------------------------------------------------
    print("\nrefresh rotation")
    status, body = call(base, "POST", "/refresh", {"refreshToken": refresh})
    rotated = (body or {}).get("data") or {}
    new_access = rotated.get("access_token")
    new_refresh = rotated.get("refresh_token")
    check("POST /refresh -> 200", status == 200, f"got {status}")
    check("issues a new access_token", isinstance(new_access, str) and new_access != login_access)
    check("rotates the refresh_token", isinstance(new_refresh, str) and new_refresh != refresh)

    status, _ = call(base, "POST", "/refresh", {"refreshToken": refresh})
    check("replaying the rotated-out refresh token -> 401", status == 401, f"got {status}")

    status, _ = call(base, "GET", "/me", token=new_access)
    check("GET /me with the refreshed token -> 200", status == 200, f"got {status}")

    # --- logout + revocation ----------------------------------------------
    print("\nlogout and revocation")
    status, _ = call(base, "POST", "/logout", {"refreshToken": new_refresh}, token=new_access)
    check("POST /logout -> 204", status == 204, f"got {status}")

    status, body = call(base, "GET", "/me", token=new_access)
    check("logged-out access token is rejected -> 401", status == 401, f"got {status}")
    check(
        "rejection reason is reported",
        (body or {}).get("detail") == "Token has been revoked",
        str((body or {}).get("detail")),
    )

    status, _ = call(base, "POST", "/refresh", {"refreshToken": new_refresh})
    check("refresh after logout -> 401", status == 401, f"got {status}")

    passed = sum(1 for _, ok in RESULTS if ok)
    total = len(RESULTS)
    print(f"\n{passed}/{total} checks passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
