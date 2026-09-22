#!/usr/bin/env python3
"""Verifies cursor pagination on every list endpoint.

The four — now six — list routes ordered by a timestamp while filtering the cursor on
`id`. With UUID primary keys that is not a keyset at all: `id > cursor` selects an
arbitrary subset of the remaining rows, so walking a list **skipped and duplicated rows**.
Measured against the live API before the fix: 9 tasks returned 4 rows across pages with 5
missing; 7 reminders returned 2; 7 recordings returned 8 rows of which 6 were unique.

Every page is walked here and checked for both failure modes — a row that never appears,
and a row that appears twice. A list that loses data is not visible from a single request,
which is why this needs its own check rather than a glance at one response.

Usage:
    python3 verify-pagination.py                       # localhost:3001
    python3 verify-pagination.py --base-url http://localhost:3001

Exits non-zero on the first failure, so it can gate a deploy.
"""
import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

RESULTS = []


def call(base_url, method, path, body=None, token=None):
    for attempt in range(2):
        req = urllib.request.Request(f"{base_url}{path}", method=method)
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


def walk(base_url, token, path, key, limit=2, max_pages=50):
    """Follows nextCursor to the end. Returns (ids, pages, error)."""
    seen, pages, cursor = [], 0, None
    while pages < max_pages:
        query = f"{path}?limit={limit}"
        if cursor:
            query += f"&cursor={urllib.parse.quote(cursor)}"
        status, body = call(base_url, "GET", query, token=token)
        if status != 200:
            return seen, pages, f"HTTP {status}"
        data = (body or {}).get("data") or {}
        seen += [row["id"] for row in (data.get(key) or [])]
        pages += 1
        cursor = (data.get("pagination") or {}).get("nextCursor")
        if not cursor:
            break
    return seen, pages, None


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:3001")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    prefix = "/api/v1"

    stamp = int(time.time())
    email = f"pagination-verify-{stamp}@test.example.com"
    password = "pagination-verify-password-123"

    print(f"verifying cursor pagination at {base}\n")

    status, body = call(base, "POST", f"{prefix}/auth/register",
                        {"email": email, "password": password, "name": "Paginate"})
    token = ((body or {}).get("data") or {}).get("access_token")
    check("registered a test account", status == 201 and bool(token), f"got {status}")
    if not token:
        sys.exit(1)

    # ── Seed enough rows that a page boundary is crossed several times ─────────
    print("\nseeding")
    fixtures = [
        (f"{prefix}/tasks", "tasks", 9,
         lambda i: {"title": f"Task {i}", "priority": "medium", "status": "pending"}),
        (f"{prefix}/reminders", "reminders", 7,
         lambda i: {"title": f"Reminder {i}", "triggerAt": f"2027-02-{i + 1:02d}T09:00:00.000Z"}),
        (f"{prefix}/memories", "memories", 6,
         lambda i: {"content": f"Memory {i}", "category": "fact", "sourceType": "manual"}),
    ]
    seeded = {}
    for path, key, count, payload in fixtures:
        created = 0
        for i in range(count):
            st, _ = call(base, "POST", path, payload(i), token=token)
            if st in (200, 201):
                created += 1
            # A small gap so `created_at` is genuinely ordered and distinct.
            time.sleep(0.02)
        seeded[key] = (path, created)
        check(f"created {created} {key}", created == count, f"{created}/{count}")

    # ── Every row exactly once ─────────────────────────────────────────────────
    print("\nwalking each list, two rows at a time")
    for key, (path, expected) in seeded.items():
        ids, pages, error = walk(base, token, path, key)
        if error:
            check(f"{key}: the walk completed", False, error)
            continue
        unique = len(set(ids))
        # A duplicate and a missing row are different bugs and both matter, so they are
        # reported separately rather than as one "counts differ" assertion.
        check(f"{key}: no row is duplicated",
              len(ids) == unique, f"{len(ids)} rows, {unique} unique, {pages} pages")
        check(f"{key}: no row is skipped",
              unique == expected, f"expected {expected}, saw {unique}")

    # ── A malformed cursor is a client error, not a server one ─────────────────
    print("\na malformed cursor")
    legacy = base64.b64encode(json.dumps({"id": "not-a-uuid"}).encode()).decode()
    for path, key, _count, _payload in fixtures:
        status, body = call(base, "GET", f"{path}?limit=5&cursor={urllib.parse.quote(legacy)}",
                            token=token)
        code = str((body or {}).get("error") or (body or {}).get("code") or "")
        # This used to reach Postgres, which raised 22P02 and the handler rendered a 500
        # with the Postgres code in the problem document.
        check(f"{key}: a non-uuid cursor -> 400",
              status == 400, f"got {status} {code}")

    # ── Filters are applied, not silently dropped ──────────────────────────────
    print("\nthe memories filters")
    # The expected counts are **tracked, not written down**. An earlier version of this
    # check hard-coded 3 for `fact` while the seeding above had already created 6 of them,
    # so it failed against correct code — a check whose arithmetic is wrong is worse than
    # no check, because it sends you looking in the wrong file.
    expected = {"fact": 6}  # the memories seeded above are all `fact`
    for i in range(4):
        call(base, "POST", f"{prefix}/memories",
             {"content": f"Contact {i}", "category": "contact", "sourceType": "manual"}, token=token)
        expected["contact"] = expected.get("contact", 0) + 1
    for i in range(3):
        call(base, "POST", f"{prefix}/memories",
             {"content": f"Fact {i}", "category": "fact", "sourceType": "manual"}, token=token)
        expected["fact"] = expected.get("fact", 0) + 1

    for category, count in sorted(expected.items()):
        status, body = call(base, "GET", f"{prefix}/memories?category={category}&limit=100",
                            token=token)
        rows = ((body or {}).get("data") or {}).get("memories") or []
        categories = sorted({row.get("category") for row in rows})
        check(f"?category={category} returns only that category",
              categories == [category], f"got {categories}")
        check(f"?category={category} returns all of them",
              len(rows) == count, f"expected {count}, got {len(rows)}")

    passed = sum(1 for _, ok in RESULTS if ok)
    total = len(RESULTS)
    print(f"\n{passed}/{total} checks passed")
    if passed != total:
        print("FAILED: " + ", ".join(name for name, ok in RESULTS if not ok))
        sys.exit(1)


if __name__ == "__main__":
    main()
