# NOVA — Next-Action Plan

Prioritised from the evidence in
[`NOVA_REAL_DEVICE_PRODUCTION_READINESS_REPORT.md`](./NOVA_REAL_DEVICE_PRODUCTION_READINESS_REPORT.md).
Nothing here is included without an observed failure or a measured gap behind it.

**Headline, current:** the assistant now *acts* correctly — create, update, cancel, complete,
reopen, remember, forget and snooze all work and are covered. The wake word, microphone, Sarvam
STT, model and Tamil TTS were verified end to end **on the physical device**, and Round 4 settled
the two scenarios the brief calls mandatory: a reminder **does** fire with the app fully closed and
the phone locked (Android starts the dead process for the alarm), arriving **1–3 minutes late**.
What stands between NOVA and a beta is no longer capability. It is **speed, reliability, and memory
that is actually used**: a spoken turn is still seconds-to-a-minute, one spoken request in six
produced no action, the models that speak Tamil cleanly are too slow to speak, and NOVA denies
facts it is holding as soon as a user has more memories than the grounding cap.

## What Round 6 closed

| Item | Status |
|---|---|
| P0-G · the assistant invented a commitment time | ✅ **fixed and proven at the database.** A prompt instruction was tried first and failed; the fix is a deterministic guard (`stated-time.ts` + the executor), now wired into the **streaming** loop too. The stored rows split cleanly: 4 at the fabricated **18:00** before the guard, 4 at **00:00** (date-only) after |
| P0-D · semantic memory inert without an embeddings key | ✅ **fixed with a provider-free path.** `rankMemoriesForTurn` gained a lexical term-overlap ranking that runs when embeddings cannot, falls back to importance when it cannot discriminate, and reports `mode: 'lexical'`. The candidate pool was widened to `min(limit × 4, 50)` — the measured fact was 14th by importance and was never even read before |
| §31 · the conversational phases | ✅ **every check passes** against the live API, including the two that exist specifically for the fabricated-time defect |
| — · `realtime/tool-loop.ts` called the executor with no user turn | ✅ wired — the same one-path-only gap the honesty guard had, reported by the subagent that found it rather than left silent |
| P0-I · the continuous repaint | 🔴 **found, not fixed** — see the P0 section |

## What Round 5 closed

| Item | Status |
|---|---|
| §21 · reboot the physical device | ✅ **run.** `BootReceiver` started the app after boot, the reminder's alarm was re-armed at its scheduled time, and it then **fired 7.8 s late** twenty-four minutes after the restart. The wake word does **not** return at boot — an Android 14 platform restriction, correctly handled in code — and returns by itself when NOVA is next opened (see P1-H) |
| §31 · the continuous-assistant story, phases 1–9 | ✅ **run** via `probe-continuous-assistant.mjs`. Six of seven conversational phases pass; one fails, and the setup phase exposed a fabricated time (see P0-G) |
| — · the offline screen blamed rate limiting for a lost connection | ✅ **fixed** (`_WarningBanner` was a `const` widget with no inputs, so it rendered the rate-limit advice on every visit to a page about connectivity). Widget test fails before the change |
| — · `adb reverse` does not survive a reboot | recorded as a **harness** fact, not a product defect — the phone had no route to the API until the tunnel was re-created, and the misleading screen was captured in that window |
| §14 · *"Remind me every Monday"* | ✅ **fixed end to end.** `repeat_rule` is an iCalendar RRULE subset, strictly validated; the assistant records it; `NovaReminder.repeatRule` reaches the scheduler, which arms the OS repeat component so the phone repeats the alarm with the app killed. Monthly-on-the-31st skips February rather than clamping, because Android's repeat walks forward a day at a time and would skip it anyway |
| — · Tamil TTS could be handed Malayalam/Devanagari/Bengali/CJK characters | ✅ **`script-validator.ts`** built, tested against all 8 raw live captures (52 tests), corpus-swept over 54 replies with **0 false positives**, and wired into `realtime/reply.ts#enqueue` log-only |
| — · a recurring reminder was described as a thing of the past | ✅ **fixed** — grounding resolves the next occurrence from the rule and states it (`user-context.ts#resolvedReminderAt`); a live weekly reminder no longer sits in `pastReminders` where the briefing counts it as missed |

## What Round 4 closed

| Item | Status |
|---|---|
| §10/§11 · background + app closed + screen locked | ✅ **verified on device** with the process dead: alarm armed, process started by Android for the broadcast, notification posted. Lateness quantified at 1–3 min and explained by the alarm's own `windowLength` |
| P1-B · the `jsonb <=> vector` landmine | ✅ **fixed and proven against live pgvector** (real distances, NULL vectors excluded, `storeEmbedding` now writes the indexed column) |
| P0-A step 2 · "maybe a smaller budget makes GLM fast" | ❌ **refuted with evidence** — at 1024 tokens `glm-5.3-flash` returns `HTTP 502` on 5 of 6 prompts (`stopReason: max_tokens`). No budget makes a reasoning model belong on the spoken path |
| — · the memory relevance ranker was unreachable | ✅ wired into all four grounding call sites (`chat`, `conversations`, `voice/chat`, the realtime socket); the two sweep callers deliberately pass no turn |

## What the earlier round closed

| Item | Status |
|---|---|
| P0-5 · no idempotency on create | ✅ **fixed**, independently re-verified against the live API + real Postgres (5 concurrent → 1 row; the negative space still creates 2) |
| P1-8 · memory correction appended, deletion impossible | ✅ **fixed** (`forget_memory`; supersession archives the old row; 25 of 33 new tests failed before) |
| P1-9 · snooze unimplemented | ✅ **fixed** (`update_reminder.in_minutes`, resolved against the server instant in the reminder's own timezone) |
| P0-4 · the model can confirm an action it never took | ✅ **fixed on the REST path in an earlier round, and now on the streaming voice path too** — where there was no guard at all, and where the guard could not read Tamil. Both fixed; the correction is spoken, and the floor reply is written in the user's language |
| — · the daily briefing crashed for minutes :13–:19 | ✅ **fixed** (was recorded as a "flaky test"; it was a deterministic production fault, 9 minutes in every 60) |
| — · spoken turns used the reasoning model | ✅ **fixed** (`ANTHROPIC_VOICE_MODEL`; 61.5 s mean → 3.7 s mean on the same six prompts) |

## Open P0 — must fix before production

### P0-I · With the wake word on, EVERY screen burns 74–98 % of a core — proven on an AOT build
**Measured on device with a control** (the app's own wake-word switch, same process throughout):

| Condition | CPU |
|---|---|
| wake word ON · Home screen foreground, idle | **82.9 %** of one core |
| wake word ON · Converse screen foreground, idle | **80.3 %** |
| wake word ON · backgrounded, screen off | **11.8 %** |
| wake word OFF · Home screen foreground | **0.0 %** |

Per-thread sampling attributes the foreground cost to Flutter's raster thread (`1.raster`, 29 %),
the platform main thread (22 %) and the Flutter UI thread (10 %): **the app repaints continuously
while the wake word is listening**, on every screen, and stops entirely when listening stops. So an
idle screen runs at 60 fps, and the app is unusable as a desk companion long before the battery
argument is even made.

**Measured on an AOT (profile) build**, so this is not a debug artefact — the debug build was
*cheaper*, which is how the caution got resolved rather than dropped. Five screens, wake word
listening: Home **97.9 %**, Me 83.4 %, Tasks 79.4 %, Memory 77.0 %, Converse 73.7 %; backgrounded
with the screen on 17.0 %, **screen off 12.6 %**; and **0.0 %** with listening switched off on the
same screen.

**Three root causes already ruled out by measurement**, so nobody has to redo them: the
`AudioRecord` loop (the hot thread is Flutter's `1.raster`), the avatar's breathing animation (Tasks
and Memory have no avatar and cost the same), and a per-frame `setState` on the mic level stream
(the rig uses an `AnimatedBuilder`). It is **global to the app, not one screen's animation.**

**Approach:** profile the AOT build and find the global ticker that is live only while
`WakeWordState.listening` is true — start at the app shell, then any `Ticker`,
`AnimatedBuilder` or `StreamBuilder` above the tab content. Do **not** tune individual screen
animations; the per-screen map says it is not their problem. **Regression test:** a widget test that
pumps an idle listening screen for several seconds and asserts frames are no longer being scheduled.
**Also worth a look:** the 12.6 % background cost is the KWS engine's own work — defensible, but
higher than a zipformer KWS should need, and `MAX_DECODES_PER_READ = 64` plus a per-read `getResult`
are the places to look.

### §48 · Release builds cannot run in this environment
The release APK builds, installs and launches, and then correctly refuses to start because its API
URL is neither HTTPS nor non-local — `lib/config/api_config.dart` guard, working as designed. The
only configured production host is unreachable, so there is nothing a release build may legitimately
point at and **§48 stays PARTIAL, blocked by environment** (build/install/launch PASS, functional run
BLOCKED). Fixing the deployment endpoint is the unblock; it is not a code change.


### P0-G · ✅ FIXED — the assistant invented a commitment time the user never gave
**Measured in the §31 run, with database evidence.** The user said *"tomorrow"* and no time:

> *"Both tasks are set for tomorrow by six o'clock in the evening."*

```
 Finish the website proposal | 2026-09-22 12:30:00 | completed
 Call the client             | 2026-09-22 12:30:00 | pending
```

`12:30Z` is 18:00 IST. No hour was ever mentioned. §5 names this case and the answer it wants —
*clarify, or leave it unset*.

**Root cause:** the closing instruction of `ASSISTANT_TOOLS_PROMPT` in
`services/api/src/services/assistant-tools.ts` says *"Use the current time and timezone given above
to resolve 'tomorrow', 'next Monday' and similar phrasing"* and never says what to do when a day was
given without a time, so the model fills the hour with a plausible default and states it as fact.

**A prompt fix was tried and it did not work.** An explicit instruction was added — *"A day on its
own is not a time … never say or store a clock time they did not give"* — and the §31 scenario was
re-run against the live API. The result, verbatim: *"Done. I've added both tasks for tomorrow by six
o'clock in the evening"*, with both rows again written at `18:00 IST`. The prompt sentence is kept
(it does no harm) but **it is not the fix**; the §31 probe now fails a check when any row carries a
time the user did not give, which is what caught this.

**Approach:** a deterministic guard in the executor — if the user's turn contains no clock time, a
supplied clock time is refused with a message the model can act on in one step. Same family as the
existing guards against fabricating *actions*, applied to *times*, and the same lesson: a request to
a model is not a guarantee. **Regression test:** a turn with a day and no time must produce either a
question or a row whose time the user supplied — asserted on the **row**, not on the reply, because
a reply can be corrected and a stored time cannot be un-believed.

### P1-H · The wake word stops at a reboot and returns only when the app is next opened
Round 5 measured the whole of this on device, and it is **smaller than it first looked** — the
first framing of it in this plan was wrong and is corrected here.

- After a reboot the wake-word service is **not** running while `nova_wake_word_enabled` still
  reads `true`.
- It comes back **by itself** the next time NOVA is opened:
  `Background started FGS: Allowed … uidState: TOP … Intent { act=com.leadup.nova.action.START_WAKE_WORD }`
  at 18:48:49, the moment the app was foregrounded. So the loss window is "from restart until the
  user next opens NOVA", not "until they go looking for a switch".
- The reason it cannot come back at boot is an **Android 14 platform restriction**, correctly
  handled in code: `FOREGROUND_SERVICE_MICROPHONE` is a while-in-use permission and
  `BOOT_COMPLETED` cannot start such a service, which `BootReceiver.kt` documents and skips. There
  is no compliant automatic fix.
- The settings screen and the wake-word notification are already honest about the intermediate
  state — status **"Paused"**, notification *"NOVA is paused" / "Wake word detection is not
  running"*. Those surfaces do not need work.

**What is left is one line of copy**, and it is therefore **P1, not P0**:
`home_page.dart#_wakeWordLine` returns `or say "$phrase"` for the paused state, which invites the
user to speak a wake word that is not being listened for. **Approach:** say it is paused and tapping
resumes it. **Regression test:** with `enabled: true, listening: false` the home line must not read
as an invitation to speak.

### P0-D · ✅ FIXED — semantic memory is no longer inert (provider-free lexical ranking)
**Measured live this round**, same question twice with only the stored `importance` changed:

| | memory state | reply |
|---|---|---|
| A | the relevant preference at importance **5**, under 13 distractors at **90** | *"I don't have that saved…"*, and on a second run a **confabulation**: *"You usually do your planning at standup, which is at ten fifteen in the morning"* |
| B | the **same** fact promoted to importance **99** | *"You usually do your daily planning at nine in the morning. Want me to set a reminder for that time tomorrow?"* |

With more saved memories than the 12-item cap, the fact that matters is dropped from the prompt, and
the user then either hears that NOVA never had it or hears a **different** memory asserted as their
own preference. The second is the §16 prohibition verbatim — *"NOVA must never confidently invent
memories"* — committed out of material that was never about the question.
The ranker that fixes it (`rankMemoriesForTurn`) is built, tested and wired, and
cannot run because `embeddingsAvailable()` is `Boolean(env.OPENAI_API_KEY)` and **that key is
unset**; `UserContext.memoryRetrieval` honestly reports `{ mode: 'importance', degradedReason }`.

**Area:** deployment configuration first, code second.
**Approach:** (1) set an embeddings provider — `OPENAI_API_KEY`, or an OpenAI-compatible local
embedder — and confirm `mode: 'relevance'` on a live turn; (2) re-run `probe-memory-recall.mjs` and
require A to answer like B; (3) if no provider is available, **raise the cap or say so in the UI**,
because a silent 12-memory ceiling is what produces *"I don't have that saved"* for something the
user did save. Reproduce with `node services/api/scripts/probe-memory-recall.mjs`.

### P0-E · Reminders can be minutes late, the window is visible in advance, and it is not disclosed
Measured three times on device: due→delivered **8 s** (Round 5, after a reboot, announced window
14 min), **1 min 57 s** (Round 4, window 3 min) and **2 min 57 s** (Round 4, window 3 min). So the
announced `windowLength` is a **ceiling, not a fixed delay** — most deliveries are prompt and the
risk is a tail that widens with how far ahead the alarm is set. Conditions throughout:
`SCHEDULE_EXACT_ALARM: granted=false`, `Uid mode: allow`, and **no battery-optimisation exemption**
for NOVA.
**Area:** `lib/features/reminders/reminder_reconciler.dart` (the `exact` flag it already computes),
the reminders screen and the home Status card.
**Approach:** surface *scheduled > 0 && inexact* from the **schedule outcome**, in plain language,
and offer a route to the system *Alarms & reminders* screen and to the battery-optimisation
exemption. Do not request `USE_EXACT_ALARM` — Play restricts it to alarm/calendar apps.

### P0-A · There is no model that is both fast enough to speak and clean enough to speak Tamil
Measured this round on the live route, six spoken prompts each:

| Model | mean latency | Tamil script in replies | wrong-script letters | behaves as required |
|---|---|---|---|---|
| claude-haiku-4-5 | **3.7 s** | yes on non-tool turns | **55** (51 Malayalam, 2 Devanagari, 1 Bengali, 1 CJK) | 6/6, then 5/6 |
| qwen3.8-flash | 12.1 s | **never** — romanised Tanglish only | 0 | 6/6 |
| glm-5.3-flash | 22.9 s | yes, fluent | 0 | 5/6 |
| glm-5.3 | **61.5 s** | yes, fluent | 0 | **4/6** (one `HTTP 502`) |

The spoken path now uses `claude-haiku-4-5` because latency is the product on a voice turn, and
the one-script prompt instruction removed the wrong-script characters (55 → 0 in the two runs
after it). **But that is a prompt mitigation of a model behaviour, not a guarantee** — and Round 5
proved it: the run this plan had counted as clean still carried a **Bengali vowel sign** inside
`மேலே`, invisible to a letters-only scan. Recommended, in order:
1. ✅ **The runtime script validator exists.** `services/api/src/services/script-validator.ts`,
   built and tested against the eight raw live captures, corpus-swept over 54 replies with **zero
   false positives**, and wired **log-only** into `realtime/reply.ts#enqueue` on the exact string
   Sarvam receives. It reports letters *and* combining marks. **What is left is a product decision,
   not a validation one:** on the streaming path sentences are already playing, so the only remedy
   that protects the ear is to withhold the sentence before it is enqueued — decide whether to drop
   it, substitute it, or keep reporting and leave the audio broken.
2. ~~Re-benchmark `glm-5.3-flash` on a lower `LLM_MAX_OUTPUT_TOKENS`.~~ **REFUTED in Round 4:** at
   1024 tokens it returns `HTTP 502` on 5 of 6 prompts (`stopReason: max_tokens`), and plain
   `glm-5.3` is still 26.6 s mean. Lowering the budget turns slow successes into hard failures.
3. **Do not put a reasoning model on the spoken path again.** `ANTHROPIC_VOICE_MODEL` and
   `ANTHROPIC_REALTIME_MODEL` exist to keep that decision explicit; the `.env.example` now says so.

### P0-B · ✅ FIXED — one spoken request in six produced no action at all
Measured on the Tanglish create path: the model claimed an action with no tool call, was
re-prompted once, still called no tool, and the user got *"I haven't changed anything yet"* — true,
but the reminder was never set. Same class on a second run: a clarifying question in Tamil and no
reminder. The honesty guard is working; what is missing is a **second chance that actually acts**.
> **What landed:** a second, narrower corrective turn (`UNBACKED_CLAIM_ACTION_CORRECTION`) sent at
> most once and **only** when the user's own words asked for a write, the first correction was
> already spent, nothing succeeded, and the reply was not a question back to the user. Worst
> case **+1 model call per turn**; the ceiling stays `MAX_TOOL_ITERATIONS = 3`. New
> `writeIntentUnfulfilled` / `askedUserBack` results separate "gave up" from "legitimately
> asked", so a shift from acting to asking stays visible without being scored as failure.
> Fail-before `29 failed / 37 passed`; after, `109 passed`. 33 new tests drive the real loop.
> **Residual, now closed:** the streaming loop (`realtime/tool-loop.ts`) — the primary voice path —
> had no corrective re-prompt at all and ended the turn after the apology. It now takes the same
> second chance, reusing the same correction constant, spent at most once and bounded by
> `MAX_TOOL_ITERATIONS`; `claimReprompted` reports it. Fail-before by reverting only that branch:
> `expected 1 to be 3` / `expected 1 to be 2`.

**Area:** `services/api/src/services/assistant-tools.ts` (`runAssistantToolLoop`).
**Approach:** when the re-prompt is answered with prose rather than a tool call *and the turn's
intent was a mutation the user clearly asked for*, execute the resolved intent if it is
unambiguous, or ask the one question that is blocking. Track `unbackedClaimRate` and
`noToolDespiteWriteIntentRate` per model so a model change cannot silently make this worse.

### P0-C · Wake-word reliability is unmeasured, and the only evidence is one detection in ~23 synthetic utterances
The chain is proven — foreground service, mic, sherpa-onnx KWS, detection at `score=1.0`, Sarvam
STT, Tamil reply, spoken — but the stimulus was macOS `say`, which is a poor proxy for a human
voice, and the app was verified to be *still listening* afterwards, so the misses were bad stimuli
and not a dead engine. **There is no false-negative rate for a real speaker.**
**Approach:** record ~30 utterances of *"Hey Nova"* from two or three real speakers at 0.5 m, 1 m
and 2 m, play them at a known level, and count detections from logcat. Adjust
`keywords.txt`/threshold only with that number in hand. This is cheap and it is the difference
between "the wake word works" and "the wake word works reliably".

## Open P1 — must fix before a serious beta

| ID | Issue | Area / approach |
|---|---|---|
| P1-A | ✅ **fixed** — see the Round 5 table. Residual: **interval** rules (*"every 2 weeks"*) cannot repeat with the app closed, because `flutter_local_notifications` exposes no interval component; the assistant refuses them by name and points at the nearest supported form, and the reconciler reports them in `notRepeating` rather than arming a wrong-time alarm. |
| P1-B | ✅ **the vector code is fixed; the retrieval is still inert — see P0-D.** Old text: **No semantic memory.** `packages/memory/src/search.ts#vectorSearch` orders by `memory_embeddings.embedding`, which is `jsonb`; the indexed column is `embedding_vec`. Reproduced: `ERROR: operator does not exist: jsonb <=> vector`. The class is dead code today, so the live path is `ILIKE` only and assistant memory grounding is "top 12 by importance", not "relevant to the question". | Fix the column reference **and** either wire relevance-ranked retrieval into `user-context.ts` or delete the dead class. A `jsonb <=> vector` line sitting in the tree is a trap for the next person who calls it. |
| P1-C | **The `?limit=200` trap.** `GET /reminders` (and siblings) cap `limit` at 100 and answer 400 above it. My own probe read that 400 as "zero rows" and reported a fabricated failure for every case. | Not a product bug — a **test-harness** hazard, now guarded in `probe-idempotency.mjs`. Audit the other probes for the same shape: a rejected request must never be read as an empty result. |
| P1-D | **The daily-briefing class of defect is now covered, but the pattern is not.** The failing assertion only tripped at certain wall-clock minutes. | Wherever a test builds a time relative to "now", either freeze the clock or enumerate the range. `briefing.test.ts` now enumerates all 60 minutes; find the other "some-times" assertions before they get dismissed as flakes. |
| P1-E | **`npx vitest run <path>` from the repo root collects nothing for the API package** (root alias set does not satisfy `routes/voice.ts:44`). A gate that looks like it ran is worse than no gate. | Fix the root `vitest.config.ts` aliases or make the root config refuse to claim the API package. `--root services/api` is the working invocation and is what every script should use. |
| P1-F | **Android will not give NOVA the wake word back after a reboot on API ≥ 34.** | Unchanged from the earlier plan; needs a user-facing explanation and a battery-optimisation prompt rather than code. |
| P1-G | **`SYSTEM_ALERT_WINDOW` is still `granted=false`**, so overlay and the proactive avatar remain unverifiable, and *"Tap to talk"* is still inert when the microphone is denied. | Grant on a test device and re-run §13; the inert-button case needs a visible, human explanation and a route to Settings. |

## P2 / P3 — unchanged from the earlier plan

The previously listed P2 items stand: speaking a reminder with the process dead (needs FCM + a
background isolate, or a native receiver driving Android TTS), overlay/notification-listener
capability, and the P3 items (barge-in, viseme fidelity, a real device-mic STT test, multi-hour
battery). Two are now partly answered: the **device microphone path is verified** (that was the
P3 "real device-mic STT test" and it now exists end to end), and the **avatar's listening state
is verified visually** on the Converse screen — `LISTENING` pill, listening face, "Listening…"
label and waveform, all captured.

## Suggested order of work

1. **P0-I** — stop the continuous repaint while listening. It is the single largest
   battery cost in the product and it is a UI ticker, not a model or a network call.
2. **P0-G** — stop the assistant inventing a time the user never gave. **A prompt instruction was
   tried first and failed** — the model still wrote 18:00 and still said it out loud — so this needs a
   deterministic guard in the executor, which is what is being built.
3. **P0-D** — set an embeddings key, then require probe A to answer like probe B. One configuration
   change turns a tested feature back on, and until it is done a user is told NOVA never saved
   something they did save.
4. **P0-E** — disclose the delivery window the platform imposes (observed 8 s to 2 min 57 s late,
   against announced windows of 3–14 min). Half a day, and it is the difference between "late" and
   "silently late".
5. **P0-C** — thirty real utterances and a detection count. Cheap, and it converts an assumption
   into a number.
6. **P0-B** — ✅ **done** (`+1` model call ceiling, 33 new tests). Residual, reported by the
   subagent and owned by `realtime/**`: the **streaming** loop still has no corrective re-prompt
   at all, so the action half does not cover socket turns — the primary voice path.
7. **P0-A** — ✅ **the runtime script validator has landed** (`script-validator.ts`, wired log-only
   into `realtime/reply.ts`). What remains is the *product* decision the validator deliberately does
   not make: whether to withhold a sentence before it is spoken, which is the only remedy that
   protects the ear on the streaming path.
8. **P1-C/D/E** — ✅ **done.** **P1-E**: the root `npx vitest run <path>` collects and passes, and a
   non-matching path exits 1 instead of 0; the cause — git-tracked build output in
   `packages/shared-types/src` where `src/index.js` exported **nothing** — is deleted, and a second
   consumer of the same trap (`apps/admin/tsconfig.json`, whose alias resolved to a directory that
   does not exist) now points at `dist`. **P1-D**: the file that hid the briefing crash takes a fixed
   instant instead of `Date.now()`, so a rendered-minute assertion can never move with the clock
   again. **P1-C**: every probe already asks for `limit=100` and throws on a non-200.

**Verification bar for every item**, re-measured after Round 6 (and now runnable from the repository root, which it was not before — see the report):
`flutter analyze` clean · `flutter test` **762 passing / 5 skipped** · `pnpm run build` 27/27 ·
`typecheck` 31/31 · `lint` 25/25 · `vitest run --root services/api` **843 passing / 50 files** ·
`vitest run --root packages/memory` **18 passing / 4 files** (live `DATABASE_URL`) — and each fix
must arrive with a test that **fails before it**.

---

# Archive — the earlier plan, kept with its status as of now

Everything below was written in earlier rounds. It is kept because the reasoning and the
measured numbers are still the evidence behind the current plan above; the headings carry their
current status so nothing here reads as an open item when it is closed. **Superseded by the
sections above wherever the two disagree.**

## P0 — Must fix before production

### P0-0 · The LLM provider has no credit — ✅ RESOLVED (provider repointed; fallback live)

> **Status now:** the deployment runs `apimaster.ai` as primary with `LLM_FALLBACK_*` pointing at
> a second route, so no single account can take the product down. Both relays are **resellers**,
> so the balance risk moved rather than disappeared — a first-party key would end the class. The
> duplicate-create hazard this section describes was subsequently fixed outright by P0-5.
**Measured:** since `2026-09-21T09:55:53Z`, every `POST /api/v1/voice/chat` returns
`503 AI_CREDIT_EXHAUSTED`. Server log:
`402 {"error":{"message":"Insufficient Balance","type":"billing_error"}}` from
`https://api.aicredits.in` (the `ANTHROPIC_BASE_URL`).
**The account still needs topping up — but the *product* no longer depends on one account.**

**A provider fallback now exists** (`services/api/src/services/llm-fallback.ts`, wired into both
`ai.ts` (REST) and `realtime/llm.ts` (voice) through one retry engine so they cannot drift).
This was the real defect: `withCircuitBreaker` only ever covered `'elevenlabs'` and `'google'`, so
**the LLM path had no fallback at all** and one exhausted account took the whole product down.

**Verified live by me, not just by unit test.** Pointing the fallback at a local OpenAI-format stub,
with the real primary returning 402:
```json
{ "text": "FALLBACK SERVED THIS TURN.", "model": "stub-model",
  "provider": "llm-fallback", "fellBack": true }
```
The stub's log confirmed the API called it with `auth=present` and the right model. With the
fallback cleared again, the primary error surfaces unchanged — `503 AI_CREDIT_EXHAUSTED` — so an
unconfigured deployment degrades exactly as before rather than changing behaviour.

**To activate, set these in `services/api/.env`:**
```
LLM_FALLBACK_BASE_URL=…
LLM_FALLBACK_API_KEY=…
LLM_FALLBACK_MODEL=…                  # optional; defaults to the primary's model id
LLM_FALLBACK_PROTOCOL=openai          # or anthropic (inferred if omitted)
LLM_FALLBACK_AUTH_STYLE=bearer        # api-key for an Anthropic-protocol relay
```
Both `BASE_URL` and `API_KEY` must be set for it to enable.

**The hazard it had to avoid, and did.** `runAssistantToolLoop` executes tools — creating
reminders and tasks — as it goes. If the primary failed *after* a tool had run, a naive retry
would **file the same reminder twice**. The retry is refused the moment a tool has executed or a
token has been emitted (`allowProviderFallback: toolCalls.length === 0`), and a test runs the real
tool loop, fails it mid-way, and asserts `executeToolUses` ran **exactly once** — confirmed to
fail if that guard is removed. On the streaming voice path the first token *is* the commit point,
so a provider that dies mid-sentence still ends the turn with partial speech and no retry:
buffering would have destroyed time-to-first-word, and that trade was made deliberately.

**Also fixed en route:** `realtime/llm.ts` was logging provider error *bodies* unredacted.
Credentials are now redacted where a provider's bytes enter the service, and a test proves a
provider that echoes the key back cannot leak it.

### P0-0a · Pick a fallback provider (needs your decision + key)
`api.aicredits.in` is a reseller, and so is apimaster.ai — moving between relays moves the
balance risk rather than removing it. A **first-party** key is the more durable choice. Rates for
May 2026 ([apidog](https://apidog.com/blog/chinese-llm-price-war-2026/)):

| Model | In $/M | Out $/M | Cache | Context | Note |
|---|---|---|---|---|---|
| GLM-5.1 | $0.98 | $3.08 | — | 200K | **recommended** — best structured reasoning ⇒ reliable tool selection and date arithmetic |
| Kimi K2.6 | $0.16–2.00 | ~$2.50 | **$0.07** | 128K | strongest tool-call *format* compliance; cache floor suits NOVA's large static prompt |
| Qwen3 Max | $0.78 | $3.90 | $0.156 | 262K | pick only if Tamil *text* quality dominates |
| DeepSeek V4-Flash | $0.14 | $0.28 | — | — | cheapest that works |
| DeepSeek V4-Pro | $0.435 | $0.87 | $0.0036 | 128K | **avoid on the voice path** — a thinking model at 600–900 ms TTFT |

NOVA's system prompt (grounding + 7 tool schemas + persona) is large and **reused every turn**,
so **cache-hit pricing dominates the bill** far more than headline rates — which is the argument
for Kimi despite its tiered input pricing.



### P0-1 · Cold start — ✅ RETRACTED, there is no defect. The app starts in ~2.8 s.
**My earlier report of a blank-screen hang was wrong, and the cause was my own test procedure.**
`flutter test integration_test/e2e/seed_session_e2e_test.dart` compiles *that test file* as the
app entrypoint and overwrites `build/app/outputs/flutter-apk/app-arm64-v8a-debug.apk`, so my
"seed then cold-start" order launched the **test harness**, which waits forever for a driver.
Independently re-verified: rebuild from the app target, install, cold start →
`Displayed com.leadup.nova/.MainActivity +2s778ms`, `splash windows: 0`, home screen renders.
**Do not spend engineering time here.** The only change needed was to the seed helper's
workflow comment, which now says to rebuild from the app target and reinstall after seeding.
The bounded-bootstrap work in `lib/app/startup.dart` is still worth keeping as hardening.
**Lesson worth institutionalising:** an integration-test run mutates build outputs that a
subsequent `flutter build` is assumed to produce — add the entrypoint check (0 refs to
`integration_test`, >0 to `package:nova_mobile/main.dart`) to any release/QA script.

### P0-2 · A new user's assistant has no clock — ✅ FIXED
`user-context.ts` no longer early-returns before the date header; `formatInZone` now carries
the year. Covered by `user-context.test.ts` (4 of 5 assertions failed pre-fix). Keep the test.

### P0-3 · The assistant could only create — ✅ FIXED, one residual
`update_reminder`, `cancel_reminder`, `complete_task`, `reopen_task` are live and verified.
**Residual (P0-4).**

### P0-4 · The model confirms actions it never performed — ✅ FIXED (REST **and** streaming)

> **Status now:** the guard is on both paths, and it reads Tamil. The streaming loop had **no**
> guard at all until this round, and the English-only patterns could not see
> *"…remind set பண்ணிட்டேன்"*. Both fixed; the correction is spoken after the claim and written in
> the user's language. Residual: **P0-B** above.
**Measured:** *"Actually reopen it"* → *"Done! I've reopened the task to prepare the client
proposal."* with server log `iterations:1, tools:[]` — **no tool call** — and the row still
`completed`. Same class as *"That's great! One down! 🎉"* while the task stayed `pending`.
**Implementation area:** `services/api/src/realtime/reply.ts` and the text-assembly step of
`runAssistantToolLoop` (`assistant-tools.ts`).
**Approach:** build the user-visible reply from **actual tool outcomes**, not from the model's
narration. If a turn's text claims a state change and `tools` is empty, that is a lie by
construction — either re-prompt, or prefix/replace with the true outcome. Consider requiring a
tool call when the intent is a mutation.

### P0-5 · No idempotency on create — ✅ FIXED and independently re-verified

> **Status now:** unique `dedupe_key` plus `BEFORE INSERT` triggers (migration `0005`), with a
> 60-second content window. Re-checked from outside the implementation with
> `services/api/scripts/probe-idempotency.mjs`: 5 concurrent identical creates → 1 row, and
> different title / different time / 10-minutes-later each still create their own row.
**Measured:** 5 identical concurrent `POST /api/v1/reminders` → **5 rows**; two identical
assistant asks → 2 duplicate reminders at the same `triggerAt`.
**Approach:** an idempotency key on the create paths, or a short-window dedupe on
`(userId, normalised title, triggerAt)`. The client sends a per-turn key so a retry or a
double-tap cannot duplicate.


---

### P0-6 · A denied notification permission silently swallows every reminder (NEW, HIGH)
**Device-measured.** The alarm was armed and verified in `AlarmManager` (`RTC_WAKEUP #5 … com.leadup.nova … ScheduledNotificationReceiver`), the screen was locked (`Dozing` + lockscreen), the reminder came due at `10:29:16Z` — and polling every 20 s through `10:30:13Z` showed **`posted=0`, nothing in `dumpsys notification`**. The user is told nothing.

**Root cause (code, not just permission):** `POST_NOTIFICATIONS` is declared and requested once during onboarding (`lib/core/permissions/permission_provider.dart:83`), and the **wake word** path correctly refuses and names it (`WakeWordService.kt:281-286`) — but **the reminder path never checks it**. Its only gate is the *in-app* Profile switch (`notification_delivery_cache.dart`). So a user who declines the OS dialog at onboarding, or revokes it later, loses **every** reminder while the reconciler keeps reporting `scheduled: N`.
**Area:** `lib/features/reminders/reminder_reconciler.dart` (+ the reminders screen and home Status card).
**Approach:** treat a denied `POST_NOTIFICATIONS` exactly like a denied exact-alarm — the
reconciler already models `exact`; add a `notificationsBlocked` flag to
`ReminderReconciliation`, surface it on the reminders screen and the home Status card in plain
language, and deep-link to the system notification settings. Re-request on Android 13+ the first
time a reminder is created.
**Regression test:** reconcile with the permission denied → the result carries
`notificationsBlocked: true` and the UI states it.

---

## P1 — Must fix before serious beta

### P1-1 · Modifying a reminder must not create a duplicate (H1)
Follows from P0-3, but needs its own guard: before creating, check for an existing non-dismissed
reminder with the same normalised title in the next 24 h and prefer an update. Evidence: state
after *"Actually make it 10 AM"* was two rows titled *"Finish the website proposal"*.

### P1-2 · Stale-session cold start must reach login (C1 adjacent)
The blank screen was reproduced with **both** a seeded stale session and cleared data, so fix
P0-1 first — but add an explicit assertion that an expired/refresh-failed session routes to
`/login` rather than hanging. `handleRefreshFailure` exists; prove it renders.

### P1-3 · Never show a self-contradictory reply (H7)
When the tool loop hits its cap, the returned text concatenated *"Done — Reminder set"* with
*"That didn't work: create_reminder failed…"*. Build the user-visible reply from the **final
tool outcome**, not from the last assistant text: if any write failed and none succeeded, say
so plainly; if one succeeded, do not surface the failed attempts.

### P1-4 · Disclose inexact reminders and offer the fix (H2)
`exact=false` is measured even with `SCHEDULE_EXACT_ALARM` granted; delivery ran 3.5–7 minutes
late. Surface it from the **schedule outcome** (`scheduled > 0 && !exact`) and offer a route to
the system *Alarms & reminders* screen. Do not request `USE_EXACT_ALARM` — Play restricts it to
alarm/calendar apps.

### P1-5 · Add an Indic STT fallback (M-new)
TTS already falls back (Sarvam → ElevenLabs → Deepgram). STT does not, so a Sarvam quota
failure becomes `HTTP 500` for every Tamil user. Mirror the TTS fallback chain.

### P1-6 · Remove or redirect the tool-less `/api/v1/chat/message` (M1)
It answers *"I don't have the ability to set reminders… use Google Assistant"*. Any client
pointed at it gets a chatbot that denies being NOVA. Either delete the route or have it call
`runAssistantToolLoop` like `/voice/chat` does.

### P1-7 · Proactive follow-up engine does not exist (M2)
The brief's §18 requires it and only `recording-reaper.ts` + `retention.ts` are scheduled.
Minimum viable: a job that finds overdue, still-open tasks/reminders not yet followed up, and
raises **one** follow-up (`briefing.ts` already knows how to narrate overdue items). Needs
frequency limits, quiet hours, dismissal and snooze from the outset — otherwise it becomes the
nagging the brief explicitly warns against.

### P1-8 · Memory correction appends instead of replacing — ✅ FIXED

> **Status now:** `forget_memory` exists, and `save_memory` archives the live row a new fact
> supersedes, so exactly one version stays live. 25 of 33 new tests failed before the fix.
**Measured:** *"Remember my favourite colour is blue"* then *"Actually my favourite colour is
green, not blue"* → the assistant says *"Updated!"* while **both** rows persist. The user is
left with contradictory memories and a confirmation that says otherwise.
**Area:** `services/api/src/services/assistant-tool-executor.ts` (`save_memory`) and
`services/api/src/services/memory.ts`. Either add `update_memory` and have the model prefer it
on a correction, or detect a superseding memory on write and archive the old one
(`memories.status` already supports `archived`/`corrected`). **Memory deletion is also still
unimplemented** — the model refuses *"Forget my favourite colour"*.

### P1-9 · Reminder recurrence, snooze — ✅ snooze fixed, ⚠️ recurrence still open

> **Status now:** **snooze works** (`update_reminder.in_minutes`). **Recurrence does not**, and it
> is not a small job — see **P1-A** above for why it needs both a server scheduler and a mobile
> scheduling change.
*"Remind me every Monday"* → *"I can only set it for a specific date and time rather than a
recurring schedule."* *"Snooze the plumber reminder by an hour"* → refused. The
`reminders.repeat_rule` column already exists, so recurrence is a tool plus an executor branch,
not a schema change. Snooze is `update_reminder` with `now + n`.

### P1-10 · Graceful failure shapes (NEW)
- STT with unusable audio returns **`HTTP 500`** `"An unexpected error occurred"`; it should be
  a 4xx with a human message (`routes/voice.ts`, the `STT_ERROR` path).
- Blocked prompt injection returns **`502 ai_blocked`**; a rejected input is not a server
  error and should be a 4xx.
- An LLM provider `402`/billing error should surface as its own message (see P0-0).

### P1-11 · `USER_TIMEZONE` is hard-coded (NEW)
`services/api/src/services/user-context.ts:46` exports `USER_TIMEZONE = 'Asia/Kolkata'` and it
is never derived from the user. Users have a `timezone` column (`schema.ts:76`) and
`reminders` stores one per row. Timezone *inference* from speech works well (verified: a New
York request landed at `13:00Z` with `America/New_York` stored), so this bites a user who never
states their zone — their whole grounding is rendered in IST. Read the stored preference, and
fall back to IST only when it is absent.

---

## P2 — Should fix

| ID | Issue | Area |
|---|---|---|
| P2-1 | No semantic memory; retrieval is `ILIKE` and no vector query exists (H4) | `services/api/src/services/memory.ts`, `packages/database` (needs a `vector` column + HNSW index) |
| P2-2 | Memory search `total` is page size, not match count (M4) | `services/api/src/services/memory.ts:182-186` |
| P2-3 | Speaking a reminder with the process dead is impossible (H3) | Needs FCM + background isolate, or a native `AlarmManager` receiver driving Android TTS |
| P2-4 | Wake word does not re-arm after reboot on API ≥ 34 (H6) | `BootReceiver.kt` is correct; needs a user-facing explanation and a battery-optimisation prompt |
| P2-5 | Overlay + notification-listener capabilities unverified/inert (H5) | Grant `SYSTEM_ALERT_WINDOW`; register the notification listener |

---

## P3 — Enhancement

- Barge-in / interruption during TTS (could not be tested without a microphone).
- Avatar viseme fidelity — the state machine (`idle/listening/thinking/speaking/sleeping/alert`)
  exists and is wired; its *visual* behaviour is unverified because of P0-1.
- A real device-mic STT test on CI-adjacent hardware; the TTS→STT round trip is a good proxy but
  does not exercise AEC or the mic path.
- Battery/long-run profile (multi-hour unattended run) — not measured.

---

## Suggested order of work

1. **P0-2** — smallest change, largest effect on the first-run experience; pure unit test first.
2. **P0-1** — unblocks *all* visual/avatar/overlay verification, which is currently BLOCKED.
3. **P0-3** then **P1-1** — turns a capture tool into something that can manage what it captures.
4. **P1-3**, **P1-4**, **P1-5**, **P1-6** — correctness and honesty of the existing surface.
5. **P1-7** — the first genuinely proactive behaviour.
6. P2/P3 once the above are green.

**Verification bar for every item:** the existing gates must stay green —
`flutter analyze` clean, `flutter test` 662 passing / 5 skipped, `gradlew :app:testDebugUnitTest`
66 passing, `pnpm run build` 27/27, `typecheck` 31/31, `test` 35/35, `lint` 25/25 — and each fix
must arrive with a test that **fails before it**.
