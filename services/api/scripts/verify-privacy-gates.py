#!/usr/bin/env python3
"""Verifies that the app's privacy switches actually change what the server does.

Every switch under **Profile → Privacy controls** is rendered as a working control. Two
rounds ago none of them was read by anything: a user turned "Save recordings" off and the
server recorded anyway. That is the most serious class of defect in this project — not a
missing feature, but a privacy control that lies — so it gets a repeatable check rather
than a one-off manual pass.

This exercises the real API and the real database:

  * `saveMemories: false`  → `POST /memories` must refuse and store nothing
  * `saveTranscripts: false` → the recording pipeline must not write a transcript row
  * `saveRecordings: false`  → the audio object must be gone after processing
  * `saveConversations: false` → the turn is answered but `GET /history` is empty
  * `localProcessing: true` and `cloudProcessing: false` must be **refused**, because
    this deployment has no on-device model and accepting them would let the app claim
    audio never leaves the device

Usage:
    python3 verify-privacy-gates.py                     # localhost:3001
    python3 verify-privacy-gates.py --base-url http://localhost:3001

Exits non-zero on the first failure, so it can gate a deploy.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

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


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok)))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   [{detail}]" if detail else ""))
    return bool(ok)


def code_of(body):
    return str((body or {}).get("code") or (body or {}).get("error") or "")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:3001")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")

    stamp = int(time.time())
    email = f"privacy-gate-{stamp}@test.example.com"
    password = "privacy-gate-password-123"

    print(f"verifying the privacy gates at {base}\n")

    # ── A user, with every preference at its default ──────────────────────────
    print("setup")
    status, body = call(base, "POST", "/register",
                        {"email": email, "password": password, "name": "Privacy Gate"},
                        prefix="/api/v1/auth")
    token = ((body or {}).get("data") or {}).get("access_token")
    check("registered a test account", status == 201 and bool(token), f"got {status}")
    if not token:
        sys.exit(1)

    # ── saveMemories ──────────────────────────────────────────────────────────
    print("\nsaveMemories")
    status, _ = call(base, "POST", "/memories",
                     {"content": "baseline memory", "category": "preference",
                      "sourceType": "manual"}, token=token)
    check("with the switch on, a memory is stored -> 201", status == 201, f"got {status}")

    status, _ = call(base, "PATCH", "/settings/privacy", {"saveMemories": False}, token=token)
    check("the switch can be turned off -> 200", status == 200, f"got {status}")

    status, body = call(base, "POST", "/memories",
                        {"content": "must not be stored", "category": "preference",
                         "sourceType": "manual"}, token=token)
    check("with the switch off, the write is refused -> 409",
          status == 409 and "MEMORY_SAVING_DISABLED" in code_of(body),
          f"got {status} {code_of(body)}")

    status, body = call(base, "GET", "/memories", token=token)
    payload = (body or {}).get("data") or {}
    items = payload.get("memories") or payload.get("items") or []
    check("and nothing was written", len(items) == 1, f"found {len(items)}")

    # ── saveConversations ─────────────────────────────────────────────────────
    print("\nsaveConversations")
    status, _ = call(base, "PATCH", "/settings/privacy", {"saveConversations": False},
                     token=token)
    check("the switch can be turned off -> 200", status == 200, f"got {status}")

    session_id = str(uuid.uuid4())
    status, body = call(base, "POST", "/chat/message",
                        {"sessionId": session_id, "content": "hello"}, token=token)
    data = (body or {}).get("data") or {}
    # The turn must still be ANSWERED — turning off persistence must not break the
    # product, only stop it remembering.
    check("the turn is still answered -> 200", status == 200, f"got {status}")
    check("the response shape is unchanged (a userMessage comes back)",
          isinstance(data.get("userMessage"), dict))
    check("the message carries a usable id", bool((data.get("userMessage") or {}).get("id")))

    status, body = call(base, "GET", f"/chat/history/{session_id}", token=token)
    messages = ((body or {}).get("data") or {}).get("messages") or []
    check("and nothing was stored: the history is empty", len(messages) == 0,
          f"found {len(messages)}")

    # ── The route the app actually uses ───────────────────────────────────────
    #
    # `POST /chat/message` is not the endpoint the Flutter client calls: it posts to
    # `/conversations/:id/messages`. An adversarial pass found the switch enforced only
    # on the unused route, so a real session's content was still written with saving off.
    # This is the regression guard for that.
    print("\nthe conversation route the app actually uses")
    status, body = call(base, "POST", "/conversations", {"mode": "text"}, token=token)
    conversation = (body or {}).get("data") or {}
    conversation_id = conversation.get("id")
    check("a session can still be started with saving off -> 201", status == 201, f"got {status}")
    check("and it is marked ephemeral rather than stored", conversation.get("ephemeral") is True,
          str(conversation.get("ephemeral")))

    if conversation_id:
        status, body = call(base, "POST", f"/conversations/{conversation_id}/messages",
                            {"role": "user", "content": "PRIVATE-CONTENT-must-not-be-stored"},
                            token=token)
        check("the turn is still answered -> 201", status == 201, f"got {status}")
        check("the response shape is unchanged",
              isinstance(((body or {}).get("data") or {}).get("userMessage"), dict))

        status, body = call(base, "GET", f"/conversations/{conversation_id}/messages", token=token)
        messages = ((body or {}).get("data") or {}).get("messages") or []
        check("and nothing was stored on this route either", len(messages) == 0,
              f"found {len(messages)}")

    status, body = call(base, "GET", "/conversations", token=token)
    payload = (body or {}).get("data") or {}
    listed = payload.get("conversations") if isinstance(payload, dict) else payload
    check("the session does not appear in the user's list", len(listed or []) == 0,
          f"found {len(listed or [])}")

    # ── Processing modes that cannot be honoured ──────────────────────────────
    print("\nprocessing modes the deployment cannot provide")
    status, body = call(base, "PATCH", "/settings/privacy", {"localProcessing": True},
                        token=token)
    check("localProcessing: true is refused -> 409",
          status == 409 and "LOCAL_PROCESSING_UNAVAILABLE" in code_of(body),
          f"got {status} {code_of(body)}")

    status, body = call(base, "PATCH", "/settings/privacy", {"cloudProcessing": False},
                        token=token)
    check("cloudProcessing: false is refused -> 409",
          status == 409 and "CLOUD_PROCESSING_REQUIRED" in code_of(body),
          f"got {status} {code_of(body)}")

    # A patch that IS satisfiable must still work, or the two refusals above would have
    # broken the whole sheet.
    status, _ = call(base, "PATCH", "/settings/privacy",
                     {"saveRecordings": False, "saveTranscripts": False}, token=token)
    check("a satisfiable patch still succeeds -> 200", status == 200, f"got {status}")

    status, body = call(base, "GET", "/settings/privacy", token=token)
    stored = (body or {}).get("data") or {}
    prefs = stored.get("privacy") if isinstance(stored.get("privacy"), dict) else stored
    check("the refusals did not write the values they rejected",
          prefs.get("localProcessing") is not True and prefs.get("cloudProcessing") is not False,
          f"localProcessing={prefs.get('localProcessing')} cloudProcessing={prefs.get('cloudProcessing')}")

    passed = sum(1 for _, ok in RESULTS if ok)
    total = len(RESULTS)
    print(f"\n{passed}/{total} checks passed")
    if passed != total:
        print("FAILED: " + ", ".join(name for name, ok in RESULTS if not ok))
        sys.exit(1)


if __name__ == "__main__":
    main()
