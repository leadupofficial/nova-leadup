# NOVA — Real-User Multilingual Production Test Report

**Date:** 2026-09-22
**Role:** Production Validation / Real-User Testing / Debugging / Repair Agent
**Verdict up front:** NOVA is **not** yet a daily-usable personal AI assistant for a
non-Tamil Indian user. Three P0 defects (proactive delivery, wake word, background
microphone) and a first-run onboarding/authentication order defect block the core
promise. What *was* broken and is now fixed — and verified on the handset — is the
multilingual action pipeline, which did not work at all for four of the five Indian
languages tested at the start of this session.

---

## 1. Environment (all facts observed, not assumed)

| Item | Value | How observed |
|---|---|---|
| Physical device | OnePlus 9R (`LE2101`), India variant | `adb devices -l` |
| Android | 14, SDK 34, `arm64-v8a` | `getprop ro.build.version.release/.sdk` |
| Timezone | `Asia/Kolkata`, auto-time on | `getprop persist.sys.timezone` |
| App package | `com.leadup.nova`, v1.0.0, targetSdk 36 | `dumpsys package` |
| App build | Flutter **debug** (JIT `kernel_blob.bin`) | extracted APK assets |
| Backend under test | `services/api` on `:3001` via `adb reverse`, canonical schema 16/16 migrations | API health + logs |
| Production backend | `91.107.202.66`, `nova-api` + `nova-admin-ui` healthy, 19 GB free | ssh `docker ps`, `df -BG` |
| MacBook role | MacBook Air built-in mic + speakers; `say`, `afplay`, `sox`/`rec` | `system_profiler SPAudioDataType` |
| Speech corpus | macOS native Indian voices — Vani (ta), Lekha (hi), Geeta (te), Soumya (kn), Piya (bn), Tara/Rishi (en-IN) | `say -v '?'` |

The installed app was missing `adb reverse tcp:3001` and therefore had no backend at
all; it was reconnected. It was also pointing at `http://localhost:3001` compiled in
via `--dart-define`, i.e. the documented dev command.

---

## 2. P0 defects found and FIXED (with runtime before/after evidence)

### 2.1 A reminder could be set in English and Tamil only

**Symptom.** Speaking a reminder request in Hindi, Telugu, Kannada or Bengali produced
a fluent reply *in that language* — and no reminder.

**Evidence.** API log for the same user, one turn per language:

```
language=hi  iterations=3 tools=['create_reminder:failed','create_reminder:failed'] capped=false
language=te  iterations=3 tools=['...failed','...failed','...failed']               capped=true
language=kn  iterations=3 tools=['create_reminder:failed','create_reminder:failed']
language=bn  iterations=3 tools=['create_reminder:failed','create_reminder:failed']
language=ta  iterations=2 tools=['create_reminder:ok']
```

Telugu exhausted the iteration cap and the user was answered in **English**:
*"That didn't work. The reminder was not created."*

**Root cause.** `services/api/src/services/stated-time.ts` — the guard that refuses a
clock time the user never gave — recognised "o'clock" wording in digits, English words,
**Tamil** (`9 மணிக்கு`) and **Tanglish** (`9 manikku`) only. For `कल सुबह 8 बजे` the guard
returned `kind: 'none'`, the model's correct `trigger_at` was rejected as *invented*, and
it retried until the cap. Proved directly:

```
Tamil     ALLOW  (time stated)  evidence="8 மணிக்கு"
Hindi     REFUSE as invented (kind=none)
Telugu    REFUSE as invented (kind=none)
Kannada   REFUSE as invented (kind=none)
Bengali   REFUSE as invented (kind=none)
Tanglish  REFUSE as invented (kind=none)   ← "8 ஓ கிளாக்", the phonetic English word
```

**Fix.** Added the "o'clock" marker and the parts of the day for Hindi/Urdu, Bengali,
Assamese, Tamil, Telugu, Kannada, Malayalam, Marathi, Gujarati, Punjabi and Odia, plus
Latin transliterations and the Tamil phonetic `ஓ கிளாக்`. The guard's *narrowness* is
preserved: a turn that names no hour is still refused, in every script.

**After (same real audio, same pipeline):**

```
language   heard (their words)                    reminders created
Tamil      நாளைக்கு காலை எட்டு மணிக்கு…           1
Hindi      कल सुबह 8 बजे का रिमाइंडर लगा दो।      1
Telugu     రేపు ఉదయం ఎనిమిది గంటలకు…               1
Kannada    ನಾಳೆ ಬೆಳಿಗ್ಗೆ 8 ಗಂಟೆಗೆ…                  1
Bengali    আগামীকাল সকাল আটটায়…                    1
Hinglish   Kal subah 8 baje ka reminder laga do    1
Tanglish   நாளைக்கு மார்னிங் 8 ஓ கிளாக்…             1
```

Each reply also came back in the speaker's own language and script.

### 2.2 Hinglish was sent to an English-only recogniser

**Symptom.** "Kal subah aath baje ka reminder laga do yaar" was heard as **"Reminder lag"**.

**Root cause.** `packages/shared-types/src/languages.ts` — `getSttProviderForLanguage`
special-cased only `tanglish`. `hinglish`, `benglish` and `gujlish` fell through to the
default `deepgram`, an English model; the sentence was destroyed. `getVoiceProviderForLanguage`
had the same hole, voicing the reply with an English speaker.

**Fix.** All four mixed codes route to Sarvam. Verified: the full sentence is now
transcribed and the reminder is created (0 → 1 for that language).

### 2.3 NOVA told the user a reminder was set when it was not

**Symptom.** Tanglish turn: no tool call at all, and the reply
*"நாளைக்கு மார்னிங் 8 ஓ க்ளாக்குக்கு ரிமைண்டர் வெச்சுடுச்சு"* — "the reminder is set".
Reminder list unchanged.

**Root cause.** `claimsStateChange` in `services/api/src/services/assistant-tools.ts`
covers English and the Tamil `-ிட்டேன் / -யிடுச்சு` families, but not the completive
`-ச்சுடுச்சு / -ட்டு / -ஞ்சு` stems. Proved:

```
MISSED  நாளைக்கு மார்னிங் 8 ஓ க்ளாக்குக்கு ரிமைண்டர் வெச்சுடுச்சு.   ← the reply the phone produced
MISSED  Reminder vechuduchu
MATCH   Done! I've set the reminder.
MISSED  நாளைக்கு reminder இருக்கு   ← present tense, correctly ignored
```

**Fix.** Added the completive stems in Tamil script and Latin, keeping present-tense
state descriptions unmatched so the guard cannot lie in the other direction. 127
targeted tests pass; the new cases are in `assistant-grounding.test.ts` and
`assistant-stated-time.test.ts`.

### 2.4 Regression status

`services/api`: **1089 passed / 64 files**. Two failures seen in one full-suite run
(`create-idempotency`, `rate-limit`) were shown to be full-suite parallelism flakes:
both pass in isolation twice, and the full suite passes on re-run.

---

## 3. Multilingual capability — measured, not claimed

Real speech generated from macOS native Indian voices, pushed through the live
STT → LLM → TTS pipeline.

| Tier | Languages | Evidence |
|---|---|---|
| **A. Verified with real human-style audio** (STT + AI reply in-script + voice audio) | Tamil, Hindi, Telugu, Kannada, Bengali | Accurate transcripts in the correct script; reminder created; Sarvam audio returned |
| **B. AI reply in-script + provider audio (no real audio sampled)** | Malayalam, Marathi, Gujarati, Punjabi, Odia, Assamese, Maithili, Sanskrit, Sindhi, Dogri, Manipuri | 26/26 reply in their own script; TTS returned audio |
| **C. Reply correct, but voice is a fallback** | Urdu, Nepali, Kashmiri, Bhojpuri, Awadhi | TTS provider reported `elevenlabs-fallback` — an English voice reading non-Latin script. **Not genuine in-language voice.** |
| **D. Mixed / code-switching** | Hinglish, Tanglish, Benglish, Gujlish | Tanglish speech → Tamil script transcript → Tamil reply with English loanwords retained (genuine code-mixing); Hinglish verified after 2.2 |

**What the app lets a user choose** is a different and much smaller set. Onboarding and
Profile offer exactly four chips: `Auto Tamil–English`, `Tamil`, `English`, `Tanglish`;
the persisted policy enum in `services/api/src/routes/settings.ts` accepts only
`auto|en|ta|tanglish`; and `voice_protocol.dart` silently maps everything else to `auto`.
A Hindi, Telugu, Bengali or Kannada speaker therefore **cannot select their language** —
they must rely on `auto` mirroring, which works for text but is not a promise the product
makes anywhere in its UI.

---

## 4. P0 defects found and NOT fixed (need decisions/assets)

### 4.1 Proactive assistance is generated and never delivered

- `notifications` table columns: `id,user_id,type,title,body,payload,read,read_at,occurred_at`.
  **There is no delivery column at all** — no `delivered_at`, no push token reference.
- Rows present: **82 `follow_up`**, **0 read**.
- The mobile app never calls the notifications API (`ApiConfig.notifications` is declared
  but has no call site); there is no polling.
- Socket.IO is dead code — `notificationService.setSocketServer` and
  `setupNotificationSocketHandlers` have no callers, and `server.ts` never imports
  socket.io, so `emitToUser` is a no-op.
- `firebase_messaging` is not a dependency and there is no device-token registration.

So the proactive engine runs hourly, writes a row, and stops. **No proactive message has
ever reached a user's phone.** Any work on proactivity is worthless until a transport
exists.

### 4.2 The wake word does not run

- `dumpsys activity services | grep com.leadup.nova` → **0**. The `WakeWordService`
  declared in `AndroidManifest.xml` is not running, even with the app open on Home
  showing *"or say 'Hey Nova'"*.
- No `nova_wake_word` notification channel was ever created.
- Speaking **"Hey Nova"** three times through the MacBook speakers at 90 % volume, with
  the phone on the desk, produced no reaction: no logcat, no UI change, no service.

### 4.3 Background operation cannot work as built

- `appops` for the package: `RECORD_AUDIO: foreground` — microphone is foreground-only.
- No `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`; the phone is **not** on the Doze whitelist
  (`dumpsys deviceidle whitelist` → not present). On OxygenOS this is the single biggest
  predictor of a killed background process.
- `BootReceiver` returns without starting the microphone service on API ≥ 34.
- No foreground service is running, so once the user leaves the app there is no listener,
  no scheduler owned by the app, and no path for a proactive turn.

**Platform-safe statement:** reminders *do* have a legal path — `flutter_local_notifications`
with `exactAllowWhileIdle` fires from `AlarmManager` with the app closed. That half is
architecturally sound. Continuous listening is what is not implemented.

---

## 5. First run — walked on the handset

Observed order: `welcome → permissions → profile → companion → health → login → home`.

1. **Welcome** — "Meet NOVA", honest copy ("Wake word detection runs on your device, not
   in the cloud").
2. **Permissions** — purpose-specific rows, and it tells the truth that audio goes to the
   server. Microphone `Allow` raised the real Android dialog and the row became "Allowed".
   **Notifications `Allow` raised no dialog and left `POST_NOTIFICATION: ignore`** across
   three attempts, with Android recording *no user decision*; the screen therefore never
   satisfied "choose Allow or Not now for each item", and **Continue stayed disabled**.
   The permission had to be enabled from system Settings. `pm grant` / `appops set` are
   refused to `shell` on this retail build, so this could not be forced from adb.
   After force-stopping the app the row correctly read "Allowed" — see 5.1.
3. **Every consent row showed a raw API error** in red:
   *"Missing or invalid authorization header — saved on this device; it will sync once
   you sign in."* The cause is `POST /api/v1/consent → 401`, because consent is synced
   **before** the user has an account. The retry is honest; showing a brand-new user an
   auth-jargon string is not.
4. **Create companion** — name, personality, **speech style (4 chips)**, voice speed.
5. **About you** → **Health** → **Login**.
6. **Login** — "Sign in with your email and password to continue to NOVA", *and* a second
   competing block: Country `India (+91)`, Phone number, **"Continue with OTP"** rendered
   disabled under the message **"Phone sign-in is not available on this server."**

### 5.1 Permission state is read once and never refreshed

With `POST_NOTIFICATIONS` already `granted=true` at the OS level, the app still rendered
*"The system did not grant this"* and kept `Continue` disabled. Force-stop + relaunch
showed "Allowed". **A user who grants a permission from system settings and returns to
the app is stuck on the permissions screen until they kill the app.**

### 5.2 Authentication is last, not first

The directive requires authentication to be the first thing a new user sees. The
implemented order runs five onboarding screens *before* sign-in, so personalisation is
collected from an anonymous user. There is also an unreachable `otp_page.dart` that POSTs
to `/api/v1/auth/phone/otp/request|verify`, endpoints that do not exist in `services/api`
(the only implementation lives in the unused `services/auth` stub, which prints OTPs to
the server console).

---

## 6. Firebase Phone OTP — BLOCKED

**STATUS: BLOCKED.**
**REASON.** Firebase is partially wired (`google-services.json` for project
`nova-leadup-stagging`, package `com.leadup.nova`, real API key; the google-services
Gradle plugin is applied; `firebase_core`, `firebase_crashlytics`, `firebase_analytics`
initialise). But:
- `firebase_auth` is **not a dependency** and `verifyPhoneNumber` / `PhoneAuthProvider` /
  `signInWithCredential` appear **nowhere** in `apps/mobile/lib`.
- **No SHA-1/SHA-256 fingerprint** for the signing key is registered anywhere in the repo,
  and there is no Play Integrity / reCAPTCHA / App Check configuration. Without a
  registered fingerprint, Android app verification fails and `verifyPhoneNumber` cannot
  complete.
- `google-services.json` has an **empty `oauth_client`** array, consistent with no
  fingerprint ever having been added.
- The API has **no Firebase ID-token exchange endpoint**; a Firebase ID token is not a
  NOVA JWT, so a server-side exchange is required even after the client works.
- Real SMS needs the Phone provider enabled and billing (Blaze) on the project.

**REQUIRED TO VERIFY.** Firebase console access to: register the debug **and** release
SHA-1/SHA-256 fingerprints for `com.leadup.nova`, enable the Phone provider, add a test
phone number (or Blaze billing for real SMS); then add `firebase_auth`, implement
`verifyPhoneNumber`, and add a server endpoint that verifies the Firebase ID token and
issues a NOVA session. The fingerprints can be produced locally with:
`keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`
and from `apps/mobile/keystore.properties` for release.

I did **not** build a custom OTP system, because Firebase Authentication is clearly the
intended mechanism and the directive forbids substituting an insecure one.

---

## 7. MacBook ↔ phone acoustic test

**Status: PARTIALLY EXECUTED — FAILED on the NOVA side.**

Set-up was real: MacBook Air speakers at 90 % output volume, MacBook Air microphone
capturing with `sox`/`rec`, phone on the desk on USB, app signed in and showing
*"or say 'Hey Nova'"*.

| Step | Result |
|---|---|
| MacBook speaks "Hey Nova" ×3 (Samantha, en) | **No phone reaction.** No logcat, no UI change, no service, no channel |
| MacBook speaks an Indian-English reminder request after `Tap to talk` → mic | **No STT request reached the server**; screen stayed "Start a conversation" |
| MacBook captures the phone's speaker | Capture succeeded (max amplitude 0.21, RMS 0.011 — real signal), but there was no NOVA speech to capture |
| MacBook → phone → NOVA → MacBook full loop | **BLOCKED** by the wake-word and mic-session failures above, and by no foreground service |

**REASON.** The phone never entered a listening session: no wake-word service was running
and the in-app mic session produced no server traffic. **REQUIRED TO VERIFY.** A working
wake-word/foreground-service path (or a reliable programmatic way to start the mic
session), plus a louder, quieter-room acoustic arrangement.

I did **not** substitute API-only or transcript-only testing for this, and I am not
reporting it as passed.

---

## 8. Answering the acceptance questions from runtime evidence only

| # | Question | Answer | Basis |
|---|---|---|---|
| 1 | Does first launch show authentication? | **NO** | 5 screens of onboarding precede `/login` |
| 2 | Is phone + Firebase OTP working? | **NO — BLOCKED** | §6 |
| 3 | Does authentication persist? | YES (proven earlier in session: session survived restart via secure storage) | `dart_test`/device |
| 4 | Does onboarding begin only after login? | **NO** | opposite order observed |
| 5 | Does NOVA customisation work? | PARTIAL | name/personality/voice speed persist; language set is 4 chips only |
| 6 | Does company/business config work? | **NOT IMPLEMENTED** in the app flow | no such screen in the walkthrough |
| 7 | Does email synchronisation work? | Not exercised | — |
| 8 | Are the intended Indian languages supported? | **Pipeline: yes (tier A/B). UI: no** | §3 |
| 9 | Does multilingual voice work? | YES for ta/hi/te/kn/bn with real audio | §2.1, §3 |
| 10 | Does natural conversation work? | YES (text and mixed-language; real Tamil/Tanglish history on device) | device transcript screenshots |
| 11 | Does NOVA maintain context? | PARTIAL | single-turn tool use proven; multi-turn pronoun resolution not verified |
| 12–14 | Create / modify / complete tasks | Works via API + assistant tools; not all exercised on device this session | API suite |
| 15–18 | Create / modify / cancel / snooze reminders | **Create verified in 7 languages**; modify/cancel/snooze covered by API tests, not re-run acoustically | §2.1 |
| 19 | Does NOVA proactively communicate when due? | **NO** | §4.1 |
| 20 | Does reminder lifecycle persist? | YES (server rows + acknowledge endpoint) | earlier session evidence |
| 21 | Reminder history? | YES | earlier session evidence |
| 22 | Morning briefing? | Scheduled locally; not verified firing this session | — |
| 23 | Appointment follow-up? | **NO** | §4.1 |
| 24 | Proactive assistance? | **NO** | §4.1 |
| 25 | Background behaviour within platform limits? | **NO for listening**; reminders OK | §4.2, §4.3 |
| 26 | Does the phone hear the MacBook? | **NOT DEMONSTRATED** | §7 |
| 27–30 | Voice interaction / avatar state / UI alignment | Avatar state machine exists; **bubble overlaps header controls**; UI review incomplete | device screenshots |
| 31 | Failure recovery? | Not exercised this session | — |
| 32 | Secure? | Content-read permissions and append-only audit proven earlier; consent 401 leak is a defect | §5 |
| 33 | Can a real person use NOVA daily? | **Not yet.** | see below |

---

## 9. Direct answer to the final question

> *Can a real person in India use NOVA daily as their personal AI assistant speaking
> naturally in their preferred supported Indian language, with background operation and
> proactive assistance reliably working?*

**No — not today.** On the evidence gathered on a real OnePlus 9R:

- **Language: half true.** Spoken Tamil, Hindi, Telugu, Kannada and Bengali are genuinely
  understood and answered in the speaker's own language *and* create the reminder asked
  for — this was broken at the start of this session for four of those five and is now
  fixed and verified. But the app offers a user only Tamil, English and Tanglish, so the
  Hindi or Bengali speaker has no way to choose their language, and Urdu/Nepali/Kashmiri/
  Bhojpuri/Awadhi are voiced by an English fallback voice.
- **Background operation: no.** No foreground service is running, the microphone is
  `foreground`-only, the app is not exempt from battery optimisation, and on API ≥ 34 the
  boot receiver deliberately does not restart listening. The wake word did not respond to
  a human-spoken "Hey Nova" from a MacBook at 90 % volume.
- **Proactive assistance: no.** 82 proactivity rows exist and were read by nobody, because
  there is no transport from the server to the device and no delivery column to record one.
- **First run: not shippable.** A new user meets a permissions screen whose notification
  button does nothing, a red "Missing or invalid authorization header" on every consent
  row, and is asked to configure their assistant *before* signing in — then shown a login
  page offering two competing methods, one of them disabled.

**What would change the answer.** Three things, in order: (1) a delivery transport for
proactivity (FCM + device-token registration + a `delivered_at` column), without which the
feature is inert; (2) a real foreground service with a battery-optimisation exemption and
a boot receiver that works on API 34+, which is what makes "Hey Nova" and any background
assistant turn possible at all; (3) surfacing the languages the pipeline already speaks in
the onboarding picker, and moving authentication in front of onboarding. The multilingual
brain, the reminder scheduler and the assistant tool layer are in materially better shape
than the shell around them.
