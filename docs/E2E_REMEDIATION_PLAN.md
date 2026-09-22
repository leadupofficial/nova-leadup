# NOVA — End-to-End Test Report and Remediation Plan

**Device:** OnePlus 9R (`LE2101`), Android 14 / API 34, arm64-v8a, USB debugging.
**Backend:** Postgres+pgvector `:5433`, API `:3001`, MinIO `:9000` — all local, reached from
the phone over `adb reverse tcp:3001 tcp:3001`.
**Build under test:** `flutter build apk --debug --target-platform android-arm64
--dart-define=API_URL=http://localhost:3001`.

This round did two things the earlier verification rounds had not: it **built an on-device
harness that boots the real app with real providers** (no injected fakes), and it ran a
**parallel static audit** of the same six requirement areas. The two agreed on the most
important finding and disagreed usefully elsewhere.

---

## 1. What was added

| Artifact | Purpose |
|---|---|
| `apps/mobile/integration_test/e2e/e2e_support.dart` | Boots the **real** app — real Keystore secure store, real `SharedPreferences`, real platform channels, real API. Creates real accounts, seeds real sessions, provides pump/wait helpers and latency probes. |
| `apps/mobile/integration_test/e2e/smoke_e2e_test.dart` | Proves the harness itself: cold start reaches onboarding; a seeded session reaches the signed-in home. |
| `apps/mobile/integration_test/e2e/wake_word_e2e_test.dart` | Reaches the Kotlin service through the real `nova/wake_word` channel: availability, the "claims to be listening" defect, and start/stop actually running a foreground service. |
| `apps/mobile/integration_test/e2e/reminders_e2e_test.dart` | Arms a reminder to fire **after the test process dies**, so the OS alarm is the only thing left to deliver it — the honest form of the "app is completely closed" test. |
| `docs/E2E_STATIC_GAP_ANALYSIS.md` | Independent static audit: **40 findings** (7 CRITICAL, 11 HIGH, 20 MEDIUM, 2 LOW), every one with a `file:line`. |

The existing `integration_test/` suite is not a substitute for any of this: every file in it
injects fakes through Riverpod overrides, so it cannot answer "does the service actually
run", "does the notification actually post", or "does the memory actually survive".

---

## 2. What the device proved

**Harness: operational.** `smoke_e2e_test.dart` passes 2/2 on the device. A wiped phone
routes to onboarding (`Meet NOVA … Get started`); a seeded session routes to the signed-in
home (`Good afternoon, E2E User … Home, Converse, Tasks, Memory, Me`). The app boots against
the local API, the real secure store is honoured by the router, and real accounts can be
created and used.

**Finding D1 — the app claims to be listening when it is not.** The very first honest screen
capture contains, verbatim:

```
Status   Wake word   Listening for hey_nova.   Connected   /healthz
```

That run had `nova_wake_word_enabled` **absent** — the test deliberately never enabled the
wake word, and `isRunning()` was not consulted. So the app told a brand-new user it was
listening, when nothing was. Two defects in one line:

- `apps/mobile/lib/features/home/home_page.dart:391` renders
  `WakeWordAvailability.userMessage`, and
  `apps/mobile/lib/core/voice/wake_word_service.dart:66-83` answers
  `'Listening for $selected.'` whenever a model is merely **installed**.
- The same string renders the **raw identifier** `hey_nova`, while the line two rows above it
  renders the humanised `or say "Hey Nova"`. The home screen contradicts itself.

**Finding D2 — the shipped engine is not the documented one.** `models.json` declares
`hey_nova` backed by a **sherpa-onnx keywords file** (`wakeword/kws/keywords.txt`,
containing `▁HE Y ▁NO V A :2.0`), with `bpe.model`, `encoder/decoder/joiner.int8.onnx` and
`tokens.txt` alongside it. The documentation — and eight source comments — still describe an
`openWakeWord` pipeline built around `hey_jarvis_v0.1.onnx`, which is present but no longer
referenced. `docs/REQUIREMENTS_VERIFICATION.md` still asserts "only `hey_jarvis` ships, so
the choice is one option wide".

**Finding D3 — this device is the one the freeze was measured on.** The manifest itself
records the honest limitation at `apps/mobile/android/app/src/main/AndroidManifest.xml:236-243`:
`stopWithTask="false"` defeats swipe-away, but *"OxygenOS ALSO freezes the whole process when
the screen goes off (`OplusHansManager: freeze uid … scene: LcdOff`), which stops detection
regardless of this flag."* The connected device is a OnePlus 9R running OxygenOS. The "wake
word still works after the app is closed" requirement therefore **cannot** be met on this
hardware without a battery-optimisation exemption, and the app only offers a settings link.

**Blocker — `adb` cannot grant runtime permissions on this ROM.**
`adb shell pm grant com.leadup.nova android.permission.RECORD_AUDIO` fails with
`SecurityException: grantRuntimePermission: Neither user 2000 nor current process has
android.permission.GRANT_RUNTIME_PERMISSIONS`. Permissions must be granted through the UI,
and `WakeWordService.kt:244-254` makes `POST_NOTIFICATIONS` a **hard gate on the whole
wake-word feature** — denied by default on Android 13+. This is why the wake-word E2E run
could not complete in this round.

**Blocker — the device disconnected.** Mid-run, `adb` lost `601f9bc0` entirely
(`adb: device '601f9bc0' not found`), which aborted the wake-word suite with
`streamListen: (-32000) Service connection disposed`. This is a recurring USB-drop on this
handset, not an app fault. Every dynamic result above was captured before the drop.

**A second, better device replaced it — and it removes the permission blocker.** The
OnePlus was replaced on the bus by an **iQOO I2304, Android 16 / API 36, arm64-v8a** — the
newest platform the app targets, and one where `adb shell pm grant` **succeeds** (all of
`RECORD_AUDIO`, `POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM`, contacts, calendar, SMS, call
log were granted; only `USE_EXACT_ALARM`, a normal permission, is not shell-grantable).
`flutter devices` sees it as `I2304 • android-arm64 • Android 16 (API 36)` and
`adb reverse tcp:3001` is live. The wake-word suite is therefore unblocked on this device
and must be re-run there.

---

## 2b. What the live API proved (item 5, stress and limits)

Measured against the running server on `:3001` with a stdlib-only probe, so it never touched
the repository while other work was in flight.

**The limit is self-imposed, not capacity.** Raw throughput is not the constraint:

| Load | p50 | p95 | p99 | max | outcome |
|---|---|---|---|---|---|
| `GET /reminders` c=1, n=20 | 2.1 ms | 5.3 ms | 5.3 ms | 5.3 ms | 20/20 OK, 447 rps |
| `GET /memories` c=1, n=20 | 1.9 ms | 2.4 ms | 2.4 ms | 2.4 ms | 20/20 OK, 517 rps |
| `GET /reminders` c=100, n=100 | 3.3 ms | 7.8 ms | 11.1 ms | 11.1 ms | **100/100 HTTP 429** |

Latency barely moves between 1 and 100 concurrent requests — the database path is not the
bottleneck at this scale. What stops the sweep is the rate limiter.

**Two hard budgets, measured, not assumed:**

- **Auth: 10 requests/minute.** Login throttles at attempt **11** (attempts 1–10 → `401`,
  11+ → `429`), matching the documented figure.
- **Authenticated API: exactly 100 requests/minute per IP**, shared across *every*
  `/api/v1` endpoint. `GET /reminders` succeeded 100 times and returned `429` on the
  101st. Because it is per-IP and global, 100 requests spread across reminders, tasks,
  memories and the assistant in one minute exhaust the budget for all of them together —
  and a client behind one NAT shares it.

**Payload ceilings:**

- JSON body: 4 MiB accepted (then rejected by validation), **5 MiB → `413`**, matching
  `express.json({ limit: '5mb' })`.
- `413` body is *"The uploaded file is too large."* on a JSON endpoint with no file
  involved — wrong copy for this API surface.
- `POST /memories` requires **`sourceType`** and **`category`** (neither has a zod
  `.default()`). The mobile client sends both, so the app is correct; a caller omitting
  `sourceType` gets a bare `"Required"` with no field named. `?limit`/`?offset` fine.

**The absolute ceiling, spent against a fresh budget.** Firing the entire 100-request
allowance at full concurrency measures the real server path rather than the limiter:

```
c=100  n=100  wall=0.10s  rps= 972  ok=100/100  p50=57.4ms  p95=89.4ms  max=95.5ms
c=100  n=100  wall=0.04s  rps=2765  ok=  0/100  (all 429 - budget already spent)
c= 50  n=200  wall=0.08s  rps=2509  ok=100/200  p50=21.3ms  p95=37.3ms  max=40.2ms
```

So: **100 concurrent authenticated requests complete in 100 ms with a 100 % success rate**,
and the only thing that stops request 101 is the limiter. Under real load the bottleneck of
this system is not the database, not the Node process, and not the network — it is a
100-requests-per-minute-per-IP budget that every endpoint on the device shares.

**CRITICAL, source-confirmed — semantic memory does not exist anywhere in the API.**

There is **no vector retrieval path at all**: a repository-wide search for `<=>`, `cosine`,
or a pgvector operator in `services/api/src/` returns **nothing**. Retrieval is
`memoryContentMatches`, which is literally
`ilike(memories.content, '%term%')`
(`services/api/src/services/memory.ts:157-159`). Measured behaviour against three stored
memories:

```
?query='coffee'                    -> 1 row     (literal substring)
?query='dark roast'                -> 1 row     (literal substring)
?query='Ananya'                    -> 1 row     (literal substring)
?query='beverage preference'       -> 0 rows    <-- semantically identical
?query='what does the user drink'  -> 0 rows    <-- semantically identical
?query='where does my sister live' -> 0 rows    <-- semantically identical
```

The app's home screen advertises "Remembers context". The user can store "I prefer dark
roast coffee in the morning" and then fail to retrieve it by meaning. This is the user-visible
consequence of M-01/M-02/M-04, and it is **larger than those findings individually**: fixing
the embedding stub would still not make search semantic, because no query ever consults a
vector.

**A stale-server trap, recorded so it is not mis-reported.** The probe run *before* this one
showed `GET /memories?search=coffee` returning all 3 rows, i.e. the list filter appearing
inert. **That measurement is invalid.** The API process (PID 3325) started at **13:11:46**,
while `services/api/src/routes/memories.ts` and `services/api/src/schemas/index.ts` were
modified at **13:49:31** and **13:49:34** — the running process predates the source by
38 minutes. The current source *does* declare `search` in `MemoryListQuerySchema` and *does*
apply it in the list route (`routes/memories.ts:54-58`). The apparent defect was a stale
process, not a code defect. Anything measured against a long-running dev server must be
re-measured after a restart before it is called a bug.

**A second misreport, found while fixing the first.** `docs/REQUIREMENTS_VERIFICATION.md`
records "`services/api` vitest **254 passing**". That number cannot have been produced by the
code in this working tree. Running the suite before any fix in this round collected
**0 tests — all 20 suites failed at import**:

```
TypeError: Cannot read properties of undefined (reading 'origins')
    at src/server.ts:46
    at src/__tests__/setup.ts:86
```

`setup.ts`'s `vi.mock('../config')` was still returning the old flat config shape while
`server.ts` had moved to `config.cors.origins`. The API test suite was **structurally dead**,
so every "gates green" claim that rested on it — including the one in the status summary of
`REQUIREMENTS_VERIFICATION.md` — was resting on nothing. Repairing the mock revealed a true
pre-fix baseline of **283 passing**, now **301 passing** after the memory/embedding fixes and
their 18 new tests.

This is the same failure mode the document already warns about elsewhere: a number carried
forward from an earlier revision and never re-earned. It is the single most important
process finding of this round, because it means **the API's test coverage was unverified for
an unknown number of revisions**.

**And the mobile gates were not green either.** The working assumption going into this round
was `flutter analyze` clean and `flutter test` 622 passing / 5 skipped. Measured at the true
baseline, before any wake-word change:

- **`flutter analyze` was not clean — 6 issues.** Four were pre-existing
  (`lib/app/error_apps.dart:139`, `:149`, `lib/features/settings/delete_account_page.dart:172`,
  `integration_test/auth_flow_test.dart:84`); two were introduced by the new E2E harness in
  this round and have been fixed. The `delete_account_page.dart:172` one is
  `use_build_context_synchronously` — a genuine use-after-dispose hazard, not a style nit.
- **`flutter test` was 621 passed / 5 skipped / 1 FAILED**, not 622 / 5.
  `test/services/logger_service_test.dart` asserts
  `LoggerService._guard` `throwsStateError` before `initialize()`, but
  `lib/services/logger_service.dart:46-51` deliberately falls back to `debugPrint` and
  buffers the call, with the comment *"so the error-reporting path never becomes a crash
  source."* The implementation reflects a deliberate decision; the test was stale and had
  been failing at HEAD.

So **both** headline gate claims in the existing verification record were unearned at the
same time: the API suite could not import at all and collected zero tests, and the Flutter
suite had a long-standing failure that the recorded count silently absorbed. Neither is a
product defect. Both are evidence-integrity defects, and they are the reason every number in
this document was produced by running something in this round rather than quoted from the
previous one.

**Also confirmed, and out of scope for the wave that found it:** the same fabricated-success
defect as M-01 exists outside `services/api`, in `packages/memory/src/embedding.ts:15` and
`packages/memory/src/search.ts:22`, which return `new Array(1024).fill(0)` as an embedding.

---

## 2c. On-device E2E results — iQOO I2304, Android 16 (API 36)

Run against the **post-fix** build with the API restarted on the post-fix source, using
`flutter test integration_test/e2e/<file>.dart -d <device> --no-uninstall`.

**Wake word — 3/3 passed.**
- The native service reports the truth about this build:
  `{available: true, reason: ok, models: [hey_nova], selected: hey_nova}`.
- **D1 is fixed on real hardware.** With the wake word never enabled, the home Status card
  now reads **`Wake word is off`**, and `isRunning()` is `false`. Before the fix the same
  screen read `Listening for hey_nova.` — the app has stopped claiming to listen.
- **D2/D4 are fixed on real hardware.** `start()` now results in a foreground service that
  reports `isRunning() == true`, and `stop()` brings it back down. On Android 16 —
  the strictest platform the app targets — the microphone foreground service starts.

**Memory — 2/2 passed, including the isolation claim.**
- A memory created over the API is read back by its owner (1 row) and is **invisible to a
  different account**: `stranger sees 0 memories`, and a search by the stranger for the
  owner's marker returned `0 rows`. Cross-tenant reading is not possible through either the
  list or the search path.
- Stored content reaches the real UI: the home card shows `1 MEMORIES` and the Memory screen
  renders `Persisted E2E-PERSIST-1789980248360696`.
- The created row carries `embeddingId: null`. That is the **correct** post-fix behaviour:
  no embedding provider is configured, so no embedding is fabricated and none is claimed.

**Reminders — 2/2 passed, with one significant device finding.**
- `sync state: scheduled=1 cancelled=0 exact=false error=null` — the reminder is armed as a
  real OS notification, and re-syncing replaces rather than duplicates it (`cancelled=0`).
- The alarm is genuinely registered with `AlarmManager`, and it survives the app process:
  after the app was killed, `dumpsys alarm` still listed it.
- **Finding, measured on hardware: `exact=false` even though `SCHEDULE_EXACT_ALARM` is
  granted.** On Android 13+ that permission is not sufficient — the app needs the
  `canScheduleExactAlarms()` app-op, which only the user can enable. So on this device
  **every reminder is delivered through an inexact alarm**, which the OS may advance or
  delay. N-06 is confirmed as real user-visible behaviour, not a theoretical concern.

**The headline answer for item 6: the reminder DOES reach the user with the app fully
closed — but late, and only as a notification.** Driven from `adb` with no test harness in
the loop (seed → `curl` the reminder → launch the real app so it syncs → `HOME` →
`am kill`), with the process confirmed gone:

```
08:52:59Z  proc=0  notification present
NotificationRecord(pkg=com.leadup.nova ... channel=nova_reminders ... category=reminder)
  android.title = "NOVA reminder"
  android.text  = "E2E reminder — drink water"
```

So the OS alarm outlives the app and delivers the notification, with the reminder's own text
as the body. But the delivery timing is the defect: that reminder was due at **08:46:15Z**,
was still absent at **08:49:36Z**, and had appeared by **08:53Z** — **between 3.5 and 7
minutes late**, exactly what `exact=false` predicts. "Reminders trigger correctly when the
app is closed" is therefore **half true**: they arrive, and they are not on time.

The spoken half cannot be fixed from Dart at all. `flutter_local_notifications` invokes no
Dart callback when a scheduled notification is delivered — its background isolate callback
only runs when the user *taps* the notification — so with the process dead there is nothing
able to speak. This is a genuine platform limitation, correctly documented in
`reminder_sync.dart`, and the only way to satisfy "speaks everything aloud under all
conditions" literally is a push transport plus a background execution context (an FCM
high-priority message with a background isolate, or a native `AlarmManager` receiver that
calls Android TTS directly). That is an owner decision, not a bug fix.

**Two harness traps found the hard way, recorded so nobody repeats them:**
1. **`flutter test integration_test` uninstalls the app at the end.** After the reminders
   run, `com.leadup.nova` was gone and the `nova_reminders` channel with it — so a reminder
   "never delivered" simply because the package had been removed. `--no-uninstall` fixes it.
2. **The harness also force-stops the app, which cancels its alarms.** A reminder armed by a
   test and due after the test ends is recorded by `AlarmManager` as
   `Reason=pi_cancelled` and never posts. That is Android's stopped-package rule, not a NOVA
   defect. Proving the "app is completely closed" case therefore requires driving the real
   app from `adb` with `am kill` (which kills the process **without** putting the package in
   the stopped state) rather than from inside the test harness.

**Three defects found in the new test helpers themselves, and fixed** — worth recording
because each one initially looked like a product bug:
- `createMemory` omitted `sourceType`, which `CreateMemorySchema` requires (it has no zod
  `.default()`), so every write 400'd with a bare `"Required"`.
- `searchMemories` sent `?q=` where `MemorySearchSchema` names the field `query`.
- The wake-word service test failed once because the reinstall had wiped `RECORD_AUDIO`.
  The service logged `start() skipped - RECORD_AUDIO not granted` and emitted a
  `permission_denied` event the controller surfaces — correct behaviour. It did reveal a
  smaller latent issue: the `"start"` method handler answers `success(true)` even when it
  internally skipped, so only the event, never the return value, tells the truth.

---

## 3. What the static audit proved

Full detail in `docs/E2E_STATIC_GAP_ANALYSIS.md`. The findings that change the shape of the
work:

| ID | Sev | What it means |
|---|---|---|
| M-01, M-02 | CRITICAL | `generateEmbedding` (`services/api/src/services/ai.ts:497-502`) is a hard-coded `{embedding: [], dimensions: 0}` stub, and both real write paths bypass `createMemory` — so the database stores an empty vector **labelled `text-embedding-3-small`**. Memory "search" cannot work semantically, and the product reports success. |
| R-02 | CRITICAL | A meeting read into `Uint8List`, then the temp file deleted before upload (`meeting_recorder.dart:185`); the only other copy is a private field. A kill during upload **loses the meeting**, and `retryUpload()` is a no-op after restart despite error copy promising retry. |
| N-02 | CRITICAL | `listReminders()` fetches one 50-item page with no cursor, and the reconciler cancels every armed alarm not in that page — so a user with >50 reminders has alarms **silently deleted on every sync**. This reproduces the exact bug the reconciler's own docstring claims to prevent. |
| R-05 | CRITICAL | The transcription job is an in-process `setImmediate` with no durable queue and no `status='processing'` reaper — a restart mid-job strands the recording forever. |
| W-04 | HIGH | `WakeWordService.kt:498` permanently cancels the instance scope, but non-`stopSelf` failure paths leave the service alive to accept another `start`, which then runs the read loop on a dead scope: "Listening now", forever silent. |
| P-01 | HIGH | `rateLimit.ts:87-93` evicts the oldest 30 % of keys on every check — **including live brute-force blocks** on the auth limiter. A key flood resets every active rate limit. |

Two findings were explicitly confirmed as **genuine platform limits, not defects**: Android
14+ forbids starting a `microphone` foreground service from `BOOT_COMPLETED` (the guard at
`BootReceiver.kt:43-51` is correct), and `flutter_local_notifications` provides no Dart
delivery callback, so speaking at the exact moment with the process dead is not achievable
from Dart. The code is honest about the second one.

---

## 4. Remediation plan

Ordered by (severity × blast radius), executed in waves so that **exactly one writer owns
`apps/mobile` and one owns `services/api` at any moment**. Read-only research may run
alongside freely.

### Wave 1 — in flight
| Agent | Scope | Findings |
|---|---|---|
| A — mobile | wake-word subsystem, `apps/mobile` | D1, D2 (dynamic), W-01, W-02, W-03, W-04, W-05, W-06, W-08 |
| B — API | memory/embedding, `services/api` | M-01, M-02, M-03, M-04, M-05, M-08 |

### Wave 2 — queued
| Agent | Scope | Findings |
|---|---|---|
| C — mobile | reminders, `apps/mobile` | N-02, N-03, N-04, N-07, N-09 |
| D — API | recording pipeline, `services/api` | R-05, R-07, R-09, R-10 |

### Wave 3 — queued
| Agent | Scope | Findings |
|---|---|---|
| E — mobile | recording durability, `apps/mobile` | R-02, R-03, R-04, R-06 |
| F — API | rate limiting + realtime buffers, `services/api` | P-01, P-02, P-04, P-05 |

### Out of scope for these waves (needs an owner decision)
- **Real push transport.** N-05: "Device notifications" is a local OS alarm, so a dropped
  alarm cannot be re-delivered by the server. This is the only way to satisfy the brief's
  "push notifications … under all conditions" literally. It needs a provider (FCM) and a
  product decision, not a code fix.
- **Schema and migration changes.** M-04 (pgvector index), M-03 (`embedding_id`), R-09.
  `packages/database` has a single writer and must be changed deliberately.
- **Storage-copy hygiene.** R-12/W-08-style stale-documentation sweeps beyond the wake-word
  subsystem.
- **Battery-optimisation exemption.** D3 is a hardware/OEM constraint; the honest options are
  to keep the settings link, or to pursue the restricted
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission, which Play policy scrutinises.

### Acceptance criteria for every wave
1. `flutter analyze` clean; `flutter test` no regressions against the 622-passing baseline.
2. Gradle JVM unit tests pass (`./gradlew :app:testDebugUnitTest`).
3. API: `pnpm --filter @nova/api test` and `run build` — no new failures.
4. Root gates green: `pnpm run build` 27/27, `pnpm run typecheck` 31/31, `pnpm run test` 35/35,
   `pnpm run lint` 25/25.
5. Every fixed behaviour gains a test that fails before the fix.
6. No test is weakened or deleted to make a suite pass.

### Gate results, measured after waves 1–3

```
pnpm run build       27/27 successful
pnpm run typecheck   31/31 successful
pnpm run test        35/35 successful   (@nova/api: 23 files / 324 tests)
pnpm run lint        25/25 successful   (0 errors, 148 warnings)
flutter analyze      No issues found    (was 6 issues)
flutter test         625 passing / 5 skipped / 0 failing   (was 621/5/1 FAILED)
gradlew unit tests   BUILD SUCCESSFUL, 66 tests, 0 failures   (was 55)
```

Every number above was produced by running the command in this round. The two that moved most
are the two that were previously untrue: `flutter analyze` is clean for the first time, and
the API suite went from **collecting zero tests** to 324 passing.

### Dynamic testing — closed

All three suites were re-run on the iQOO I2304 (Android 16) against the **post-fix** build
and the **post-fix** API, and all passed:

```
wake_word_e2e_test   3/3 passed
memory_e2e_test      2/2 passed   (owner sees 1, stranger sees 0, stranger search 0 rows)
reminders_e2e_test   2/2 passed   (scheduled=1 cancelled=0, idempotent on re-sync)
```

Final gate state, every line re-run in this round:

```
pnpm run build       27/27      flutter analyze   No issues found  (was 6 issues)
pnpm run typecheck   31/31      flutter test      662 passing / 5 skipped / 0 failing
pnpm run test        35/35      gradlew           BUILD SUCCESSFUL, 66 tests, 0 failures
pnpm run lint        25/25
```

**Still not verified, and why:**
- **CPU during a listening window.** The `SherpaWakeWordEngine` spin fix (engine off 0 %,
  engine on with the old code 96–121 %) has not been re-measured on this device. The A/B was
  taken on the OnePlus 9R, which has since disconnected. This is a measurement gap, not a
  known defect: the guard is covered by 5 JVM unit tests.
- **A swipe-away / screen-off survival run on OxygenOS.** The manifest documents that
  OxygenOS freezes the process on screen-off (`OplusHansManager: freeze uid … scene: LcdOff`).
  That was measured on the OnePlus 9R; the iQOO is a different OEM and has not been tested
  for background survival.

### Open items that need an owner decision, not a code fix

1. **Semantic memory does not exist.** Retrieval is `ILIKE '%term%'`
   (`services/api/src/services/memory.ts:157-159`) and there is **no vector query anywhere**
   in `services/api`. Measured: `?query='beverage preference'` and
   `?query='what does the user drink'` both return **0 rows** against a stored "I prefer dark
   roast coffee", while `?query='coffee'` returns 1. The embedding stub is fixed (it no longer
   fabricates a vector), but fixing the stub alone does not make search semantic — nothing
   ever consults a vector. Closing this needs a `vector` column with an HNSW index, an
   embedding provider key, and an ANN retrieval path. The home screen currently advertises
   "Remembers context".
2. **Speaking with the process dead is not achievable from Dart.**
   `flutter_local_notifications` has no delivery callback. A push transport with a background
   isolate, or a native `AlarmManager` receiver calling Android TTS, are the only routes.
3. **Exact alarms cannot be forced.** Only the user can grant the `canScheduleExactAlarms()`
   app-op; `USE_EXACT_ALARM` is Play-restricted to alarm/calendar apps. Reminders are therefore
   delivered **inexactly** — measured 3.5–7 minutes late.
4. **`packages/memory` is dead and unbuildable.** Nothing imports `@nova/memory`; its
   `package.json` declares `main: dist/index.js` but there is no `src/index.ts`, so no
   entrypoint is ever emitted. Two services declare it as a dependency and import nothing.
5. **Schema changes not made** (out of scope for every wave): the HNSW index and vector column
   for memory, `memories.embedding_id` backfill, and
   `ALTER TABLE audio_recordings ADD COLUMN failure_reason text;` so a failed recording can
   say why.
6. **A downgrade path is uncovered.** The reminder-notification id bands changed; an upgrade
   is handled by a briefing-band sweep, but installing an older build over a newer one is not.
