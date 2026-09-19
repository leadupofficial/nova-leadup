# NOVA — Requirements Verification

**Method:** every claim below was produced by running something against the live system
or by reading the exact source, on 2026-09-19. Nothing here is inferred from a document.
Where a document and the code disagree, the code is reported and the document is named.

Production: `https://nova.leadup.in` · API healthy · 261 mobile tests passing.

---

## Status summary

| # | Requirement (owner's brief) | Status |
|---|---|---|
| 1 | Automatic voice onboarding greeting | **Works** |
| 1 | Greeting in the native language | **Works** |
| 2 | Low-latency real-time voice | **Works** — 2.4–3.4 s measured |
| 2 | Hands-free, no button | **Works** |
| 2 | Barge-in | **Works** |
| 2 | Custom / configurable wake word | **Partial** — service exists, phrase is not configurable |
| 3 | Background notification monitoring | **Not implemented** |
| 3 | Proactive spoken updates | **Not implemented** |
| 4 | Create/manage reminders by voice | **Works** |
| 4 | Speak reminders when they trigger | **Partial** — speaks only while the app is alive |
| 5 | Cost efficiency measured | **Works** — instrumented, rates unset |
| 5 | Low latency | **Works** |
| 6a | Device & system control | **Not implemented** |
| 6b | Meeting intelligence | **Not implemented** — metadata only |
| 6c | Call screening | **Not implemented** |
| 6d | Briefings / nudges | **Not implemented** |
| 6d | Cross-platform sync | **Faked** — reports success, does nothing |
| — | Tool confirmation before side-effecting actions (§5.7) | **Bypassed on the voice path** |

**Working: 8. Partial: 3. Not implemented: 6. One subsystem actively misreports.**

---

## What works, with evidence

### Voice pipeline (requirements 1, 2, 4, 5)

A live Tamil turn against production completes end to end, and a real spoken exchange
was held on a physical device — audio in, transcript `Vanakkam nova.`, a sensible Tamil
reply spoken back.

```
turn started → sarvam queuedBytes → fallback: deepgram → TTS ×5 sentences → turn complete
boundary=583ms  llm=1876ms  tts=328ms  TOTAL=2787ms
```

Verified over the socket: `handsFreeTurns=2`, `bargeInStops=1`, six languages
recognised, all three tools invoked by voice, cross-turn context retained.

### Onboarding greeting (requirement 1)

Spoken via the device voice, one-shot guarded by a persisted flag written before the
utterance, with a UI notice if the device has no voice for the language.

### Reminders (requirement 4)

Reconciled against the OS on load, change, start and resume; exact alarms requested when
due; the plugin's boot receiver lets one survive a reboot. **Measured: the arm64
download is 44.0 MB** after removing 19 unused dependencies.

### Avatar (§6.6)

Real. `nova_avatar_rig.dart` plus a `CustomPainter` implement expression states, blink,
head tilt and amplitude-driven mouth motion — the MVP spec exactly. It is **not**
Rive-based, which is why removing the unused `rive` dependency (21.4 MB) broke nothing.

### Cost instrumentation (requirement 5)

A live turn logs real quantities with costs honestly `null`:

```
stt: 3.928s (sarvam 0.7 + deepgram 3.228)   llm: 2119 in + 382 out   tts: 405 chars
totalUsd: null   unknownLegs: ["stt","llm","tts"]
```

Now emitted as **parseable JSON** through pino, with secrets redacted.

---

## What does not work

### Requirement 3 — notification monitoring is not implemented

`NotificationListener.kt` is a 62-line `BroadcastReceiver` that only calls `Log.d`. It is
declared in the manifest on a custom action, `nova.notification.POSTED`, **that nothing
in the app ever sends**. There is no `NotificationListenerService` and no
`BIND_NOTIFICATION_LISTENER_SERVICE` permission, so it *cannot* read system
notifications even in principle.

The server side is equally dead: `services/api/src/routes/notifications.ts` is **125
lines of complete CRUD** — list, create, mark-read, delete, unread-count — and
`server.ts` **never mounts it**. The app configures
`ApiConfig.notifications` at `api_config.dart:162` and **never calls it**.

So the feature is orphaned on both ends. Nothing about it works.

### Requirement 6d — integration sync reports success without doing anything

`services/integration-service/src/routes/integrations.ts`:

```ts
router.post('/connect', authenticateJwt, async (req, res, next) => {
  IntegrationSchema.parse(req.body);
  res.status(201).json({ id: `int-${Date.now()}`, status: 'connected', provider: req.body.provider });
});
```

No OAuth, no token storage, no provider call. It returns **"connected"** with a
fabricated id. `GET /status` is hardcoded to `{ integrations: [] }`, and `DELETE`
reports success without disconnecting anything.

This is worse than absence, because a client is told the integration succeeded. There is
real provider code in `packages/tools/src/integrations/` (calendar client, provider
registry) that this service does not use.

### §5.7 — the confirmation sheet is bypassed by voice

The master document requires the tool confirmation sheet "before every side-effecting
action". `ToolConfirmSheet` exists and is shown from `converse_page.dart:110` — **on the
typed path only**.

The voice path has no approval concept at all: `realtime/tool-loop.ts` contains no
reference to approval, `voice_protocol.dart` has no approval event, and
`voice_realtime_controller.dart` has no approval handling. The three voice tools
(`create_reminder`, `create_task`, `save_memory`) execute immediately.

**Observed directly:** a spoken Tamil command created a reminder and the row appeared
with no prompt.

Today's three tools are low-risk, so the exposure is bounded — but the gap is
structural. The moment a higher-risk tool (send a message, device control) is added to
the voice path it will execute unconfirmed.

### The stub routes that return success

Three route files exist, are never mounted, and each returns HTTP 200 with a
"pending" message:

| Route | Body |
|---|---|
| `subscriptions.ts` | `{ data: null, message: 'implementation pending' }` |
| `upload.ts` | `{ data: [], message: 'implementation pending' }` |
| `webhooks.ts` | `{ message: 'implementation pending' }` |

`subscriptions` matters most: the product is meant to be sold on a **basic subscription
tier**, and there is no subscription backend at all. A 200 with a success envelope is
harder to detect than a 404.

### Requirements 6a, 6b, 6c, 6d — not implemented

- **6a Device control** — no brightness, Wi-Fi, Bluetooth, DND or app-launch code.
  Note Android 10+ blocks programmatic Wi-Fi/Bluetooth toggles regardless.
- **6b Meeting intelligence** — `recording_page.dart` says so itself: *"NOT YET
  IMPLEMENTED: actual microphone capture and speaker diarisation… this screen currently
  records the session metadata and the timer only."*
- **6c Call screening** — no `CallScreeningService`, no `READ_CALL_LOG`, nothing.
- **6d Briefings / nudges** — no weather, calendar or location integration.

### Memory semantic search is a stub

`packages/memory/src/search.ts` — `hasEmbeddingsForUser()` returns `false`
unconditionally and the query embedding is `new Array(128).fill(0)`. **Text search
works** (verified: returns correct rows); **vector/semantic search does not run**, and
pgvector is a column with no populated embeddings.

*(This corrects an earlier claim of mine that semantic memory was working. The text
path works; the vector path is inert.)*

### Wake word phrase is not configurable

The service is real (454 lines, foreground service, correctly permissioned with
`FOREGROUND_SERVICE_MICROPHONE`), but no configurable phrase or hotword setting exists
in the client. Requirement 2 asks for a *customisable* wake word.

---

## Documented but never executed

`docs/operations/secrets-rotation.md` lists `JWT_SECRET`, `REFRESH_TOKEN_SECRET` and
`AUTH_ENCRYPTION_KEY` with a 90-day rotation policy. **Every "Last Rotated" field is
"—".** None has ever been rotated.

`services/` contains **14 services and 11 running containers**. Five are dead code:
`agent-orchestrator`, `api_disabled`, `notification-service`, `worker`, `workers`. They
are still referenced by the repo's `docker-compose.yml`, so removing them is not a plain
delete.

---

## The repository does not build

`pnpm run build` at the root **fails**: 2 of 14 tasks succeed and `@nova/admin` aborts.

```
src/routes/organizations.ts(2,33): error TS2307: Cannot find module '@nova/auth'
src/routes/users.ts(3,33):          error TS2307: Cannot find module '@nova/auth'
src/routes/featureFlags.ts(19,2):   error TS2304: Cannot find name 'res'.
src/routes/incidents.ts(3,10):      error TS2305: Module '"../middleware.js"' has no exported member 'authenticateJwt'.
src/utils/problem.ts(2,27):         error TS2307: Cannot find module './middleware.js'
```

Two further packages fail independently:

- **`@nova/types`** — `tsconfig.json` extends `@nova/config/tsconfig/base.json`, but its
  `package.json` declares `"dependencies": {}`. It extends a package it never depends on.
- **`@nova/policy`** — `src/rate-limiter.ts` imports `ioredis`, which is not in its
  dependencies (`["@nova/shared-types", "zod"]`).

**This is systemic.** Scanning every workspace package for imports it does not declare
found **14 of them**:

```
services/api                 compression, ioredis, xss          <- live API
services/realtime-gateway    ioredis, jsonwebtoken, pino       <- live
services/auth                compression, uuid
services/worker              compression, cors, express, helmet
services/integration-service cors, express, helmet, morgan
services/workflow-engine     pg
services/admin               @nova/auth, helmet, morgan
packages/policy              ioredis
packages/ai-core             vitest
packages/database            @nova/database (imports itself)
```

They resolve today only because pnpm hoists them into the root store. That works by
accident, not by declaration, and it breaks the moment the tree is pruned or a package
is built in isolation — which is exactly what a clean CI checkout does.

---

## Document problems that affect any analysis

| Document | Problem |
|---|---|
| `docs/NOVA-LEADUP-COMPREHENSIVE-AUDIT-REPORT.md` | **41 bytes.** A title line and nothing else. It is cited as a primary source and contains no requirements. |
| `NOVA_Master_Project_Document.md` §5, §18.3 | Specifies **React Native**. `apps/mobile` is **Flutter**. |
| `docs/architecture.md` vs `CURRENT_ARCHITECTURE.md` | One describes 2 services + MinIO; the other 10 services + AWS S3 SDK. One is stale. |
| `docs/contracts/voice-events.md` vs MPD §14 | **Conflicting event schemas.** `eventId/eventType/timestamp/source/correlationId` vs `id/type/occurredAt/requestId/sessionId`. Neither is declared canonical. |
| `services/` | **14 services, 11 running.** Five are dead code and still referenced by `docker-compose.yml`. |

---

## Bottom line

**No — the requirements are not all met, and the repository does not currently build.**

Against the 374 atomic requirements extracted from the master document and the brief:

- **The voice companion core is real and verified.** Realtime streaming, barge-in,
  hands-free operation, voice-driven reminders, a rigged avatar, cost and latency
  measurement. These genuinely meet their requirements.
- **The proactive half of the brief is largely absent** — notification monitoring,
  device control, meeting capture, call screening, briefings. Requirement 3 is not
  implemented at all.
- **Three things are worse than absent because they actively mislead.** The integration
  service returns `status: 'connected'` having done nothing; three routes answer HTTP 200
  with "implementation pending"; and the tool-confirmation safety rule that the master
  document requires before *every* side-effecting action is silently skipped on the voice
  path, which is the primary interface.
- **`pnpm run build` fails**, so the repo cannot be verified by its own commands, and 14
  packages import dependencies they never declare.

Order of work if the goal is "everything works": fix the build first (nothing else is
verifiable until it passes), then the truthfulness defects (a fake success and a 200
"pending" are worse than an honest failure), then the missing features.
