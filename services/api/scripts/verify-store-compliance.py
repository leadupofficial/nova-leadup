#!/usr/bin/env python3
"""End-to-end verification of the two store-mandated account flows.

Both Google Play and the App Store make these publishing gates rather than features,
so they need a repeatable check and not a one-off manual pass:

  * **Account deletion.** App Review Guideline 5.1.1(v) requires an app that creates
    accounts to let the user delete the account from inside the app, and Play's
    account-deletion requirement additionally demands a publicly reachable web
    resource. This exercises the in-app path (`DELETE /api/v1/account`), its guard
    rails, the web request path (`POST /api/v1/account/deletion-request`), and the
    consequence of a successful delete — the access token must stop working and the
    credentials must stop signing in.
  * **AI content reporting.** Play's AI-Generated Content policy requires in-app
    reporting of offensive model output. This exercises `POST /api/v1/ai/reports`.

Usage:
    python3 verify-store-compliance.py                      # against localhost:3001
    python3 verify-store-compliance.py --base-url http://localhost:3001
    python3 verify-store-compliance.py --console-url http://localhost:3000
        # additionally checks that the public privacy-policy and deletion-request
        # pages answer WITHOUT a session cookie. That is the Play requirement the
        # console can silently break: a 200 whose body is a login redirect looks
        # live to a crawler and dead to a reviewer.

Exits non-zero on the first failure, so it can run as a deploy gate.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request

RESULTS = []


def call(base_url, method, path, body=None, token=None, prefix="/api/v1"):
    """Returns (status, parsed_body). Retries once on 429 honouring Retry-After."""
    for attempt in range(2):
        req = urllib.request.Request(f"{base_url}{prefix}{path}", method=method)
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


def get_text(url, headers=None):
    """Returns (status, body_text, redirect_target). Follows nothing."""
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    request = urllib.request.Request(url, headers=headers or {})
    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=10) as resp:
            return resp.status, resp.read().decode("utf-8", "replace"), resp.headers.get("Location")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace"), exc.headers.get("Location")


def get_text_with_headers(url, headers):
    return get_text(url, headers)


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    suffix = f"   [{detail}]" if detail else ""
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{suffix}")
    return bool(ok)


def err_code(body):
    """The API reports a machine code in several shapes; accept all of them."""
    if not isinstance(body, dict):
        return ""
    return str(body.get("code") or body.get("error") or "")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:3001")
    parser.add_argument("--console-url", default=None)
    parser.add_argument(
        "--admin-token",
        default=None,
        help="A signed admin JWT, to check the public URLs also work for a signed-in "
             "visitor. Without it only the signed-out case is exercised (pass "
             "`--console-url` as well).",
    )
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    stamp = int(time.time())
    email = f"verify-store-{stamp}@test.example.com"
    password = "verify-store-password-123"

    print(f"verifying store-compliance API at {base}\n")

    # --- registration ------------------------------------------------------
    print("registration")
    status, body = call(
        base, "POST", "/register", {"email": email, "password": password, "name": "Store Verify"},
        prefix="/api/v1/auth",
    )
    data = (body or {}).get("data") or {}
    token = data.get("access_token")
    check("POST /auth/register -> 201", status == 201, f"got {status}")
    check("returns an access_token", isinstance(token, str) and len(token) > 20)
    if not token:
        print("\ncannot continue without a token")
        sys.exit(1)

    # --- deletion preview --------------------------------------------------
    print("\ndeletion preview")
    status, body = call(base, "GET", "/deletion-preview", token=token, prefix="/api/v1/account")
    preview = (body or {}).get("data") or {}
    check("GET /account/deletion-preview -> 200", status == 200, f"got {status}")
    check("reports the account's own email", preview.get("email") == email, str(preview.get("email")))
    check("reports recording and consent counts", isinstance(preview.get("recordings"), int)
          and isinstance(preview.get("consentRecords"), int))
    # Without this the client cannot know whether to show a password field, and an
    # account with no password_hash would be stuck on a screen it can never satisfy.
    check("reports whether a password is required", preview.get("requiresPassword") is True,
          str(preview.get("requiresPassword")))
    check("states the retention period", "30 days" in str(preview.get("retentionPeriod")), str(preview.get("retentionPeriod")))

    status, _ = call(base, "GET", "/deletion-preview", prefix="/api/v1/account")
    check("GET /account/deletion-preview without a token -> 401", status == 401, f"got {status}")

    # --- deletion guard rails ---------------------------------------------
    print("\ndeletion guard rails")
    status, body = call(base, "DELETE", "/", {"confirm": "DELETE"}, token=token, prefix="/api/v1/account")
    check("DELETE with no password -> 400 PASSWORD_REQUIRED",
          status == 400 and "PASSWORD_REQUIRED" in err_code(body), f"got {status} {err_code(body)}")

    status, body = call(base, "DELETE", "/", {"password": password}, token=token, prefix="/api/v1/account")
    check("DELETE without the literal confirm -> 400",
          status == 400, f"got {status} {err_code(body)}")

    status, body = call(base, "DELETE", "/", {"confirm": "DELETE", "password": "definitely-wrong"},
                        token=token, prefix="/api/v1/account")
    check("DELETE with the wrong password -> 401",
          status == 401 and "INVALID_PASSWORD" in err_code(body), f"got {status} {err_code(body)}")

    status, _ = call(base, "DELETE", "/", {"confirm": "DELETE", "password": password},
                     prefix="/api/v1/account")
    check("DELETE without a token -> 401", status == 401, f"got {status}")

    # The account must still exist after all of the above.
    status, _ = call(base, "GET", "/deletion-preview", token=token, prefix="/api/v1/account")
    check("the account survives every refused deletion", status == 200, f"got {status}")

    # --- AI content reporting ---------------------------------------------
    print("\nAI content reporting")
    status, body = call(base, "POST", "/reports",
                        {"messageId": "verify-msg-1", "reason": "harmful", "excerpt": "x" * 40},
                        token=token, prefix="/api/v1/ai")
    check("POST /ai/reports -> 201", status == 201, f"got {status}")
    check("reports that it was recorded", ((body or {}).get("data") or {}).get("recorded") is True)

    status, body = call(base, "POST", "/reports", {"messageId": "m", "reason": "not-a-real-reason"},
                        token=token, prefix="/api/v1/ai")
    check("an unknown reason -> 400", status == 400, f"got {status} {err_code(body)}")

    status, body = call(base, "POST", "/reports", {"messageId": "m", "reason": "unsafe", "excerpt": "y" * 501},
                        token=token, prefix="/api/v1/ai")
    check("an over-long excerpt -> 400 (a report is not a conversation copy)", status == 400, f"got {status}")

    status, _ = call(base, "POST", "/reports", {"messageId": "m", "reason": "unsafe"}, prefix="/api/v1/ai")
    check("POST /ai/reports without a token -> 401", status == 401, f"got {status}")

    # --- public web deletion request --------------------------------------
    print("\npublic web deletion request")
    status, known = call(base, "POST", "/deletion-request", {"email": email},
                         prefix="/api/v1/account")
    check("known email -> 202", status == 202, f"got {status}")
    status, unknown = call(base, "POST", "/deletion-request", {"email": f"nobody-{stamp}@test.example.com"},
                           prefix="/api/v1/account")
    check("unknown email -> 202", status == 202, f"got {status}")
    # A public form that distinguishes the two is an account-enumeration oracle.
    check("known and unknown emails are indistinguishable",
          json.dumps(known, sort_keys=True) == json.dumps(unknown, sort_keys=True))
    status, _ = call(base, "POST", "/deletion-request", {"email": "not-an-email"},
                     prefix="/api/v1/account")
    check("a malformed email -> 400", status == 400, f"got {status}")

    # --- the web-filed request is actually completable ---------------------
    #
    # The published policy on /delete-account promises the request is verified and
    # completed within 30 days. That is only true if an owner can action the queue, so
    # the whole lifecycle is checked: it is owner-only, it requires the literal, and
    # completing it really removes the account.
    if args.admin_token:
        print("\nweb deletion request: the owner can complete it")
        status, body = call(base, "GET", "/deletion-requests", token=token, prefix="/api/v1/account")
        check("a normal user cannot read the queue -> 403", status == 403, f"got {status}")

        status, body = call(base, "GET", "/deletion-requests", token=args.admin_token,
                            prefix="/api/v1/account")
        queue = ((body or {}).get("data") or {}).get("requests") or []
        check("an owner can read the queue -> 200", status == 200, f"got {status}")
        mine = [r for r in queue if r.get("email") == email]
        check("the filed request is in the queue", len(mine) == 1, f"found {len(mine)}")
        check("and it carries the requester's address so ownership can be checked",
              bool(mine and mine[0].get("email")))

        if mine:
            request_id = mine[0]["id"]
            status, _ = call(base, "POST", f"/deletion-requests/{request_id}/complete",
                             {}, token=args.admin_token, prefix="/api/v1/account")
            check("completing without the literal confirm -> 400", status == 400, f"got {status}")

            status, _ = call(base, "POST", f"/deletion-requests/{request_id}/complete",
                             {"confirm": "DELETE"}, prefix="/api/v1/account")
            check("completing without a session -> 401", status == 401, f"got {status}")

            status, body = call(base, "POST", f"/deletion-requests/{request_id}/complete",
                                {"confirm": "DELETE"}, token=args.admin_token,
                                prefix="/api/v1/account")
            check("completing as an owner -> 200", status == 200, f"got {status}")

            status, _ = call(base, "POST", "/login", {"email": email, "password": password},
                             prefix="/api/v1/auth")
            check("the account is gone afterwards -> 401", status == 401, f"got {status}")

            status, body = call(base, "GET", "/deletion-requests", token=args.admin_token,
                                prefix="/api/v1/account")
            left = [r for r in (((body or {}).get("data") or {}).get("requests") or [])
                    if r.get("email") == email]
            check("and the queue no longer lists it", len(left) == 0, f"found {len(left)}")
            # The account is gone, so the remaining checks below must not re-use it.
            return _finish()

    # --- the real deletion -------------------------------------------------
    print("\naccount deletion")
    status, body = call(base, "DELETE", "/", {"confirm": "DELETE", "password": password},
                        token=token, prefix="/api/v1/account")
    check("DELETE with the correct password -> 200", status == 200, f"got {status}")
    check("reports deleted: true", ((body or {}).get("data") or {}).get("deleted") is True)

    # The row is gone but the JWT is still cryptographically valid until it expires,
    # so the route denylists its jti. Without that an attacker (or a stale client)
    # keeps a working token for a deleted account.
    status, body = call(base, "GET", "/me", token=token, prefix="/api/v1/auth")
    check("the deleted account's access token -> 401", status == 401, f"got {status}")

    status, _ = call(base, "POST", "/login", {"email": email, "password": password},
                     prefix="/api/v1/auth")
    check("logging in as the deleted account -> 401", status == 401, f"got {status}")

    status, _ = call(base, "GET", "/deletion-preview", token=token, prefix="/api/v1/account")
    check("the deleted account can no longer read its preview", status == 401, f"got {status}")

    # --- public store URLs -------------------------------------------------
    if args.console_url:
        console = args.console_url.rstrip("/")
        print(f"\npublic store URLs at {console}")
        for path, needle in (
            ("/privacy", "What we collect"),
            ("/delete-account", "Request account deletion"),
            # The Support URL goes in the store listing metadata; App Review 1.5 also
            # wants a contact path. A support page that silently starts requiring a
            # session is a rejection waiting to happen, so it is checked here too.
            ("/support", "support@leadup.tech"),
        ):
            status, text, location = get_text(f"{console}{path}")
            check(f"GET {path} -> 200 without a session", status == 200,
                  f"got {status}" + (f" -> {location}" if location else ""))
            # A 200 whose body is the session spinner or a login redirect is the exact
            # failure mode this check exists for: the URL looks live to a crawler and
            # dead to an App Review or Play reviewer.
            check(f"{path} renders real content, not the session gate", needle in text)
            check(f"{path} is not a login redirect", "Verifying session" not in text)

        status, _, location = get_text(f"{console}/users")
        check("GET /users still requires a session", status in (302, 307) or (location or "").startswith("/login"),
              f"got {status} -> {location}")

        # A *signed-in* visitor must also be able to read them. The middleware used to
        # bounce anyone with a valid session cookie from a public route to the
        # dashboard, so the published URL looked broken to exactly the people checking
        # it: a reviewer who had signed in, or whoever was filling in the Data safety
        # form. Testing only the signed-out case hid that.
        if args.admin_token:
            print("\nsame URLs with a signed-in admin session")
            for path, needle in (
                ("/privacy", "What we collect"),
                ("/delete-account", "Request account deletion"),
                ("/support", "support@leadup.tech"),
            ):
                status, text, location = get_text_with_headers(
                    f"{console}{path}", {"Cookie": f"admin_token={args.admin_token}"}
                )
                check(f"GET {path} with a session -> 200, not a dashboard redirect",
                      status == 200, f"got {status}" + (f" -> {location}" if location else ""))
                check(f"{path} still renders the policy/request content when signed in",
                      needle in text and "Verifying session" not in text)

            status, _, location = get_text_with_headers(
                f"{console}/login", {"Cookie": f"admin_token={args.admin_token}"}
            )
            check("GET /login with a session still bounces to the dashboard",
                  status in (302, 307) and (location or "").endswith("/"),
                  f"got {status} -> {location}")

    return _finish()


def _finish():
    passed = sum(1 for _, ok in RESULTS if ok)
    total = len(RESULTS)
    print(f"\n{passed}/{total} checks passed")
    if passed != total:
        print("FAILED: " + ", ".join(name for name, ok in RESULTS if not ok))
        sys.exit(1)


if __name__ == "__main__":
    main()
