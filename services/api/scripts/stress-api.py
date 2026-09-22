#!/usr/bin/env python3
"""Finds the load at which this API stops behaving.

Measures latency percentiles and error rate as concurrency rises, then reports the level
at which the system degrades rather than guessing from a single request. Also derives the
**rate limiter's** ceiling from the response headers, because that is the first limit any
client meets and it is not the same thing as the system's capacity.

Load is spread across several routes on purpose: the limiter keys on `IP + route`, so one
route is capped at 100 requests/minute however much capacity the process actually has.
Hitting only one route measures the limiter; hitting several measures the server.

Usage:
    python3 stress-api.py --base-url http://127.0.0.1:3001 --token <jwt>
"""
import argparse
import json
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter

RESULTS = []


def one_request(base_url, path, token, timeout=30):
    """Returns (status, elapsed_ms)."""
    req = urllib.request.Request(f"{base_url}{path}")
    req.add_header("Authorization", f"Bearer {token}")
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read()
            return resp.status, (time.perf_counter() - start) * 1000
    except urllib.error.HTTPError as exc:
        exc.read()
        return exc.code, (time.perf_counter() - start) * 1000
    except Exception:
        return 0, (time.perf_counter() - start) * 1000


def percentile(values, pct):
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, int(round((pct / 100.0) * len(ordered) + 0.5)) - 1)
    return ordered[max(0, idx)]


def run_level(base_url, token, paths, concurrency, per_worker):
    """Runs `concurrency` threads, each issuing `per_worker` requests."""
    latencies, statuses = [], []
    lock = threading.Lock()

    def worker(worker_id):
        local = []
        for i in range(per_worker):
            status, ms = one_request(base_url, paths[(worker_id + i) % len(paths)], token)
            local.append((status, ms))
        with lock:
            for status, ms in local:
                statuses.append(status)
                latencies.append(ms)

    threads = [threading.Thread(target=worker, args=(w,)) for w in range(concurrency)]
    started = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    elapsed = time.perf_counter() - started

    ok = [ms for s, ms in zip(statuses, latencies) if s == 200]
    return {
        "concurrency": concurrency,
        "requests": len(statuses),
        "elapsed_s": elapsed,
        "rps": len(statuses) / elapsed if elapsed else 0,
        "ok": len(ok),
        "errors": Counter(s for s in statuses if s != 200),
        "p50": percentile(ok, 50),
        "p95": percentile(ok, 95),
        "p99": percentile(ok, 99),
        "max": max(ok) if ok else 0,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--max-concurrency", type=int, default=40)
    args = ap.parse_args()
    base = args.base_url.rstrip("/")

    # Several distinct routes so the per-route limiter does not cap the whole run.
    paths = [
        "/api/v1/tasks?limit=10",
        "/api/v1/reminders?limit=10",
        "/api/v1/memories?limit=10",
        "/api/v1/settings/privacy",
        "/api/v1/subscriptions",
    ]

    print(f"stressing {base}\n")

    # ── What is the rate limiter's ceiling? ───────────────────────────────────
    print("rate limiter (the first limit a client meets)")
    req = urllib.request.Request(f"{base}/api/v1/tasks?limit=1")
    req.add_header("Authorization", f"Bearer {args.token}")
    with urllib.request.urlopen(req, timeout=20) as resp:
        headers = {k.lower(): v for k, v in resp.headers.items()}
    print(f"  RateLimit-Limit      : {headers.get('ratelimit-limit', '(not sent)')}")
    print(f"  RateLimit-Remaining  : {headers.get('ratelimit-remaining', '(not sent)')}")
    print(f"  Retry-After on 429   : {headers.get('retry-after', '(only on a 429)')}")

    # ── Concurrency ramp ─────────────────────────────────────────────────────
    print("\nconcurrency ramp (5 routes, so the per-route limiter is not the only ceiling)")
    print(f"  {'conc':>5} {'reqs':>6} {'rps':>7} {'p50':>8} {'p95':>8} {'p99':>8} "
          f"{'max':>8}  errors")
    levels = [1, 2, 5, 10, 20, args.max_concurrency]
    for concurrency in levels:
        per_worker = max(2, 40 // concurrency)
        r = run_level(base, args.token, paths, concurrency, per_worker)
        RESULTS.append(r)
        errs = ", ".join(f"{code}:{n}" for code, n in sorted(r["errors"].items())) or "none"
        print(f"  {r['concurrency']:>5} {r['requests']:>6} {r['rps']:>7.1f} "
              f"{r['p50']:>7.1f}ms {r['p95']:>7.1f}ms {r['p99']:>7.1f}ms "
              f"{r['max']:>7.1f}ms  {errs}")

    # ── Where does it break? ─────────────────────────────────────────────────
    print("\nfindings")
    worst_errors = 0
    worst_level = None
    for r in RESULTS:
        total_errors = sum(r["errors"].values())
        if total_errors > worst_errors:
            worst_errors = total_errors
            worst_level = r
    if worst_level:
        print(f"  first meaningful error rate at concurrency {worst_level['concurrency']}: "
              f"{dict(worst_level['errors'])}")
    else:
        print("  no errors at any level tested — the process itself did not fail; "
              "the limiter is the binding constraint")

    slowest = max(RESULTS, key=lambda r: r["p99"])
    print(f"  worst p99: {slowest['p99']:.0f}ms at concurrency {slowest['concurrency']}")

    peak = max(r["rps"] for r in RESULTS)
    print(f"  peak throughput observed: {peak:.1f} req/s")

    # Did latency grow worse than linearly with concurrency? That is the knee.
    if len(RESULTS) >= 2:
        first, last = RESULTS[0], RESULTS[-1]
        if first["p50"] > 0:
            growth = last["p50"] / first["p50"]
            conc_growth = last["concurrency"] / max(1, first["concurrency"])
            print(f"  p50 grew {growth:.1f}x while concurrency grew {conc_growth:.0f}x "
                  f"-> {'sub-linear, healthy' if growth < conc_growth else 'super-linear, saturating'}")

    print("\n" + "=" * 68)
    print(json.dumps(RESULTS, indent=2, default=str))


if __name__ == "__main__":
    main()
