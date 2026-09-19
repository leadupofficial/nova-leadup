# NOVA — Development Roadmap

Built from an audit of the actual repository on 2026-09-19, not from the feature list
alone. Anything marked **measured** was verified by running it, not read from code.

---

## 1. Where the product actually stands

### Working and verified

| Capability | Evidence |
|---|---|
| Realtime voice pipeline (streaming STT → LLM → chunked TTS → barge-in) | full turns run against production; `handsFreeTurns=2`, `bargeInStops=1` |
| Voice-driven reminders, memory, tasks | all three tools exercised by voice; rows verified in Postgres |
| Cross-turn context | name given in turn 1, used correctly in turn 2 |
| On-device wake word | `WakeWordService.kt`, 454 lines, foreground service |
| Spoken onboarding greeting | device voice, one-shot guarded |
| Reminders that fire | reconciled with the OS, survive reboot |
| Per-turn cost measurement | live cost record per turn |
| Semantic memory | `packages/memory` + pgvector; `/memories/search?query=` |
| 22-language catalogue | routed; 6 languages exercised end to end |

### Declared but not real

| Thing | Reality |
|---|---|
| `NotificationListener` | a 62-line `BroadcastReceiver` that only `Log.d`s. **Wrong Android component** — reading notifications needs `NotificationListenerService`. |
| `pino` / `pino-pretty` | declared runtime deps; `logger.ts` is a hand-rolled `console.log` wrapper. **No structured logging exists.** |
| `rive` | 21.4 MB of native libs shipped, zero imports |
| `drift` + `sqlite3_flutter_libs` | an embedded database, zero imports |
| 5 codegen packages | zero annotations, zero generated files |
| `intl` | unused — in a 22-language product |
| + `uuid`, `sensors_plus`, `local_auth`, `equatable`, `package_info_plus`, `path`, `cupertino_icons`, `@nova/voice` | never imported |

**14 of 33 Flutter deps and 3 server deps are dead.**

---

## 2. Repository sprawl

`services/` contains **14 services; 11 containers run**. Five are dead code:

```
agent-orchestrator   api_disabled   notification-service   worker   workers
```

Note the duplicates: `worker` **and** `workers`; `notifications` **and**
`notification-service`; `api` **and** `api_disabled`; `realtime-gateway` **and**
`voice-api` — while the realtime voice path actually lives inside `services/api`.

This is the residue of parallel builds. It costs onboarding time and makes the
architecture unreadable. Worth one deliberate consolidation pass.

---

## 3. Call recording — your approach is the right one

**You are correct, and my earlier caution was too blunt.** Reading the OEM's existing
recording folder *with consent* is a fundamentally different act from recording a call,
and it is the version that can actually ship. Here is the precise position:

**Why the app cannot record calls itself.** Since Android 10 the `VOICE_CALL` audio
source is closed to third-party apps, and in 2022 Google [banned call-recording apps
that used the Accessibility API](https://soyacincau.com/2022/04/22/new-google-policy-kills-call-recording-apps-but-googles-own-dialer-still-lets-you-do-it/).
Only system dialers — Google's, and OEM dialers like Vivo's — can record.

**Why your version is different.** On a Vivo (the device in hand) the dialer already
records to a folder such as `/storage/emulated/0/Record/Call`. The OEM handled the
consent announcement and the recording. NOVA is then only reading files the user
already owns and explicitly points it at.

**The clean technical path is SAF, not a broad permission.** Do *not* ask for
`MANAGE_EXTERNAL_STORAGE` — Play grants "All files access" only to a narrow set of use
cases and a companion app is likely to be rejected. Instead:

1. `ACTION_OPEN_DOCUMENT_TREE` — a system dialog where the user picks the call
   recording folder once.
2. `takePersistableUriPermission` — durable read access to that folder, no broad
   storage permission required.
3. Watch the folder; on a new file, run it through the existing STT path and produce a
   summary.

This is exactly "access the call recording folder with user consent", it is
Play-compliant, and it needs no restricted permission.

**Still required before shipping:**
- Declare call-recording processing in the **Data Safety** form.
- The recordings contain **the other party's voice**. In two-party-consent
  jurisdictions, *processing* a recording the user lawfully holds is generally the
  user's responsibility, but the app should surface that and not hide it.
- Confirm which OEM folder paths to offer — they differ per manufacturer, so the folder
  picker must be manual rather than hardcoded.

**Verdict: build it, with SAF and an explicit consent screen.**

---

## 4. Text improvement — what you described, and how to build it

Your ask: *type text in a box, NOVA works in the background, asks in your native
language, converts the text properly, and sends it.* Two Android mechanisms can do
this, and one is clearly better.

### Option A — an NOVA keyboard (recommended)

A custom `InputMethodService`. It appears as a normal keyboard in **every** app, and
adds a NOVA key:

- Type or paste rough text → tap **Improve** → NOVA rewrites it in your language and
  inserts it into the field → you press send in the host app.
- Can also offer: translate, make formal/casual, shorten, fix grammar, transliterate
  Tanglish → Tamil script.
- Works in WhatsApp, Gmail, anything with a text field. No accessibility permissions.
- You already have `tanglish`/`hinglish` language codes, so code-mixed input is a
  first-class case rather than an afterthought.
- It is a proven pattern — [Deskdrop](https://github.com/SvReenen/Deskdrop) is an
  open-source Android keyboard with local and cloud AI.

Cost note: rewrite is one short LLM call, no STT and no TTS unless the user asks for
it, so it is far cheaper per use than a voice turn.

### Option B — an accessibility service

Can read text and tap buttons in other apps, so it could fill a field *and* press send
with no user action. **Prefer not to.** Accessibility access is a sensitive permission,
Play scrutinises its use, and "an assistant that reads and taps through your apps" is a
hard sell to both Google and users. Use it only if the keyboard proves insufficient.

**Recommendation: build the keyboard.** It covers the described flow, needs no
sensitive permission, and is the more trustworthy product.

---

## 5. Roadmap

### Phase 0 — Clean the foundation  *(~1–2 days, do this first)*

- ~~Remove the dead Flutter deps~~ — **done**, 19 removed.
- Delete or archive the 5 dead services.
- Replace the `console.log` logger with real pino.

**Outcome:** dependency list honest, logs parseable, download 17% smaller. **This phase
is a prerequisite for measuring every later phase.**

#### APK size — corrected

An earlier draft of this file claimed the download was "101 MB" and that arm64-only
would save ~55 MB. **That was wrong, and by a factor of six.** The build already
emits per-ABI splits, so a real arm64 phone downloads `app-arm64-v8a-release.apk`.
The 101 MB figure is the *universal* artifact, used only for sideloading.

Measured before and after removing the dead dependencies:

| Artifact | Before | After |
|---|---|---|
| **arm64 split (what users download)** | **53.3 MB** | **44.0 MB** |
| universal (sideload) | 101.4 MB | 77.9 MB |
| armeabi-v7a split | 26.7 MB | 19.9 MB |
| x86_64 split | 36.3 MB | 28.2 MB |

So the real win is **9.3 MB, 17% smaller**, not 55 MB. Rive and SQLite are gone
entirely. What remains in the arm64 split:

```
17.4 MB  libonnxruntime.so   ← the wake-word model; now the largest single component
11.2 MB  libflutter.so
 8.0 MB  libapp.so
```

The wake-word runtime is now the biggest thing in the app, so further size work
means evaluating a lighter engine, not more pruning.

---

### Phase 1 — Make the companion present  *(the "Jarvis" feel)*

1. **Wake word opens a session.** The service exists; wire "Hey Nova" (configurable) to
   start a realtime session rather than only notifying.
2. **Reminders that speak with the app closed.** Extend the existing `WakeWordService`
   foreground service to check due reminders and speak them. This is the honest fix for
   the gap left in the current build.
3. **Real notification monitoring.** Replace the stub with a
   `NotificationListenerService`, filter by priority and app, speak high-priority
   alerts.

**Needs:** notification-access grant, an opt-in per-app allowlist, and a battery-policy
review. Continuous background work is a Play policy surface and a battery complaint
generator — ship it opt-in.

---

### Phase 2 — Call intelligence  *(your idea, now scoped)*

- SAF folder picker + persisted permission (§3).
- Watch for new recordings → STT → summary → action items.
- Speak the summary, or file it as a note.
- Consent screen and Data Safety declaration.

Reuses the existing STT and the existing `create_reminder`/`create_task` tools, so the
"send a text with the agreed meeting time" follow-up is mostly already built.

---

### Phase 3 — Text improvement keyboard  *(your idea)*

- `InputMethodService` with an Improve/Translate/Shorten key.
- Reuses the existing chat/completion path; no new backend.
- Tanglish and Hinglish handled natively.
- Ship it as an optional keyboard the user enables, not a default.

---

### Phase 4 — Proactive life organiser  *(their §6.4)*

- **Daily briefing / evening recap.** Grounding already injects tasks, reminders and
  memories into every prompt, so this is mostly a scheduled prompt plus TTS. Weather and
  calendar are the new integrations.
- **Context-aware nudges** (leave now, traffic is heavy) need location and traffic.
- **Cross-platform sync** (Google Workspace, Outlook) is the largest integration effort
  in the whole spec — OAuth per provider, refresh, webhooks. Its own phase.

---

### Phase 5 — Meeting intelligence  *(their §6.2)*

Start/stop and live transcription are easy reuses of the voice pipeline. **Speaker
diarisation is separately billed** on both Deepgram and Sarvam — confirm your plan
covers it before promising the feature. Action-item tagging is an LLM pass.

---

### Phase 6 — Device & system control  *(their §6.1)*

Feasible: open apps, media playback, brightness (`WRITE_SETTINGS`), DND (user-granted).

**Not feasible as specified:** Android 10+ **blocks programmatic Wi-Fi and Bluetooth
toggles** for third-party apps. You can open the settings panel, not flip the switch.
Smart-home is a separate surface (Matter, or per-vendor APIs).

---

## 6. Features I would add beyond the brief

Ordered by value per unit of effort.

| Feature | Why |
|---|---|
| **Offline mode** — on-device STT/TTS when there is no network | The app is currently useless on a plane or in a tunnel. You already ship `flutter_tts` and a wake-word model; a degraded offline path is mostly wiring. |
| **Cost-aware model routing** | Measured: ~2,100 input tokens per turn, dominated by the grounding prompt. Route trivial turns ("what time is it") to a cheaper model and reserve the good one for real questions. Biggest margin lever you have. |
| **Prompt trimming** | Same measurement. A large slice of those 2,100 tokens is static. It is both the largest latency component *and* the largest token spend. |
| **Voice notes → structure** | Dump a rambling thought; get tasks, reminders and notes out. Reuses the tools you already have. High perceived magic, low build cost. |
| **Routines** | "Good morning" runs a sequence — briefing, weather, first meeting. Multi-step voice macros over existing tools. |
| **Semantic memory recall** | pgvector and `packages/memory` already exist but are underused. "What did I say about the Kumar invoice?" should just work. |
| **Multi-device continuity** | Start on the phone, finish on the web. `apps/web` and `apps/mobile` share a backend already. |
| **Latency instrumentation in the client** | Server latency is measured; perceived latency is not. Measure speech-end → sound-out on the device. |

---

## 7. Risks

| Risk | Impact |
|---|---|
| **Sarvam out of credit** | Every Indic turn pays a failed Sarvam attempt first; ElevenLabs carries the load at higher cost. Cheapest single improvement available. |
| **Wake word model size** | `libonnxruntime` is 50.9 MB across ABIs — the largest thing in the app. Evaluate a smaller runtime or a lighter engine. |
| **No structured logs** | Blocks real cost and reliability measurement. Phase 0. |
| **Background execution limits** | Every Phase 1 feature fights Android here. Budget for it. |
| **22 languages, 7 uncredentialed** | Assamese, Maithili, Sanskrit, Sindhi, Kashmiri, Dogri, Manipuri route to a Google provider with no key anywhere. The API reports this honestly; it is not fixed. |
| **Tamil `auto` transliterates** | With `auto`, Deepgram returns "Vanakkam nova" not Tamil script. Setting speech style to Tamil explicitly fixes it. |
| **Call recordings contain a second party** | Consent and Data Safety must be explicit. Legal review advised before shipping Phase 2 in multiple jurisdictions. |
