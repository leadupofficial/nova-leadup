# NOVA — Real-User Production Test Report

**Date:** 2026-09-23
**Build under test:** Flutter debug, `com.leadup.nova` v1.0.0, `targetSdk 36`,
`arm64-v8a`, `--dart-define=API_URL=http://localhost:3001`
**Device:** OnePlus 9R (`LE2101`), Android 14 (SDK 34), `Asia/Kolkata`
**Backend:** `services/api` on `:3001` reached over `adb reverse`, Postgres on `:5433`
**Verdict up front:** the **first-run order defect is fixed and verified on the
handset**, and the **phone + Firebase OTP path now completes end to end from a
genuine fresh install** — Firebase ID token → `/api/v1/auth/firebase/exchange` →
a real session row → onboarding. Two things still block calling this production
ready: phone-auth **app verification is intermittent** because the project's
reCAPTCHA/Play Integrity configuration is missing (BLOCKED on a project Owner),
and the P0 proactive/wake-word/background gaps from the previous round are
unchanged.

---

## 1. Scope of this round

The round was driven by two explicit instructions: **"remove complete data in app
/ newly install app"** and the standing requirement that the **first screen must
be authentication**.

| # | Step | Result |
|---|---|---|
| 1 | Reset the app to a genuinely fresh-install state | **DONE** |
| 2 | Observe the real first-launch screen | **DONE** — defect reproduced |
| 3 | Fix the first-run order at the gate | **DONE** — code + tests |
| 4 | Rebuild, reinstall, re-observe | **DONE** — verified on device |
| 5 | Complete Firebase OTP with `+917868002606` / `123456` | **DONE** — verified on device |
| 6 | Verify the no-second-SMS fix on device | **PARTIAL** — see §5 |

---

## 2. Fresh install — how it was actually done

`adb shell pm clear com.leadup.nova` is **refused** on this handset:

```
java.lang.SecurityException: PID … does not have permission
android.permission.CLEAR_APP_USER_DATA to clear data of package com.leadup.nova
```

That is ColorOS hardening, not something to work around by disabling a security
feature. A genuine fresh install was produced instead by uninstalling and
reinstalling, which is strictly stronger — it removes the package, its data
directory and its permissions:

```
adb uninstall com.leadup.nova      → Success
adb install -r app-debug.apk       → Success
adb shell run-as com.leadup.nova ls /data/data/com.leadup.nova
  cache   code_cache                      ← no shared_prefs, files or databases
```

Every observation below starts from that state.

---

## 3. P0 — first-launch order (found, fixed, verified)

### Reproduced

Fresh install, `am start`, 14 s settle:

> **"Meet NOVA"** — *A voice-first companion that keeps track of your day.*
> three feature rows, and a **Get started** button.

The first screen a brand-new user saw was a marketing welcome page, i.e.
onboarding, and authentication sat behind it. This contradicts the required flow
(Launch → Phone → Firebase OTP → Verify → Authenticated → Onboarding) and it
means personalisation was being collected from an anonymous user.

### Root cause

`apps/mobile/lib/app/router.dart` decided its entry location from the onboarding
status first:

```dart
String _entryLocation(OnboardingService onboarding, AuthState auth) {
  if (onboarding.getStatus() != OnboardingStatus.complete) {
    return onboarding.resumeStep().routeName;   // → /onboarding/welcome
  }
  return auth.isAuthenticated ? '/' : '/login';
}
```

with the same ordering repeated in `redirect` (Gate 1 onboarding, Gate 2 auth).

### Fix

The auth gate now runs first, and `/onboarding/otp` is treated as an auth route
because it is the OTP step of signing in:

- `_entryLocation` returns `/login` for anyone without a session.
- `redirect` — `Gate 1: authentication comes first`; an authenticated user on
  `/onboarding/otp` is forwarded into onboarding (or `/` if onboarding is done).
- `splash_page.dart` sends a signed-out user to `SplashDestination.login`, not
  `onboarding`.
- `login_page.dart` — phone OTP is the only method rendered; email + password
  moved behind an explicit *"Use email and password instead"* switch, and the
  back chevron is not drawn when there is nothing to pop to.

### Verified on a fresh install

`/tmp/nova-val/auth_first2.png` — **Welcome back**, *"Sign in with your phone
number to continue to NOVA."*, `COUNTRY India (+91)`, `PHONE NUMBER`, one CTA
**Continue with OTP**, and the email/password switch. No company selection, no
campaign information, no customization, no language selection, no dashboard, no
second authentication method.

### Regression cost

Three tests encoded the old order and were updated to assert the required one
(`widget_test.dart`, `startup_test.dart`); the app now needs a session before
onboarding is reachable, so the "abandoned onboarding" case seeds one. No test
was deleted and no assertion was loosened.

---

## 4. P0 — Firebase phone OTP, end to end

### Project state (read from the API, not assumed)

`GET identitytoolkit.googleapis.com/v2/projects/nova-leadup-stagging/config`:

```json
"phoneNumber": { "enabled": true,
                 "testPhoneNumbers": { "+917868002606": "123456" } }
```

Android app `com.leadup.nova` is registered with SHA-1
`063fdc2f0fbd4cf70e38e71b05e67052a93f68c2` and SHA-256
`18bdf707cdb9fd26e69647097768d800279c7d80316885995b61ccdab7ae8ccf` — the debug
keystore's own fingerprints.

### Server chain — proven twice

| Step | Result |
|---|---|
| `accounts:sendVerificationCode` (`+917868002606`) | `200` + `sessionInfo` |
| `accounts:signInWithPhoneNumber` with **wrong** code `000000` | `400 INVALID_CODE` |
| `accounts:signInWithPhoneNumber` with **correct** code `123456` | `200`, uid `vZnCX8gd3RNxUjA46pDItGa9zdc2`, 896-char `idToken` |
| `POST /api/v1/auth/firebase/exchange` | `200`, NOVA access token (281 chars) |
| `GET /api/v1/auth/me` with that token | `200` — the session is real and authorised |

### On the handset — proven once

Driven only through the UI (`input tap` / `input text`), no injection:

| Observation | Evidence |
|---|---|
| Phone accepted, code requested | button enters its busy state |
| Code **sent** | `FirebaseAuth` callback ran; the app pushed the 6-digit screen |
| Masked destination rendered | screenshot reads `+91 XXXXXX 2606` |
| Firebase accepted the code | `FirebaseAuth: Notifying id token listeners about user ( vZnCX8gd3RNxUjA46pDItGa9zdc2 )` |
| Server opened a session | `sessions` row `71afc016-c5cb-4346-b3b8-676e047e05a3`, `created_at 2026-09-22T13:19:58.993Z` |
| The app authenticated | screenshot: onboarding **Meet NOVA / Get started** |

**This is the mandated flow, executed on the physical phone:**
fresh install → phone → Firebase OTP → verified → authenticated → NOVA onboarding.

### P0/P1 — app verification is intermittent (BLOCKED)

A repeat run failed at the send step. `logcat`:

```
E zza: Failed to initialize reCAPTCHA config: No Recaptcha Enterprise siteKey
       configured for tenant/project *
```

and the handset opened a browser Custom Tab at
`…gging.firebaseapp.com` showing:

> Unable to process request due to missing initial state. This may happen if
> browser sessionStorage is inaccessible or accidentally cleared.

Queried directly: `recaptchaenterprise.googleapis.com` is **disabled** for the
project (`403 … has not been used in project nova-leadup-stagging before or is
disabled`) and the config carries `recaptchaConfig: null`. Enabling it is refused:

```
POST serviceusage.googleapis.com/v1/projects/nova-leadup-stagging/services/recaptchaenterprise.googleapis.com:enable
403 PERMISSION_DENIED  Permission denied to enable service
```

The Firebase Admin SDK service account has no `serviceusage.services.enable`;
there is no `gcloud` and no application-default credentials on this machine.

**STATUS: BLOCKED**
**Reason:** the project has no reCAPTCHA Enterprise / Play Integrity configuration,
and the available credential cannot enable the APIs.
**Required:** a project Owner enables the reCAPTCHA Enterprise API (or Play
Integrity) and provisions the key for `com.leadup.nova` — full detail in
`NOVA_PRODUCTION_GAP_ANALYSIS.md` §B1.

Positive note: when it fails this way the app **recovers cleanly**. After the
browser was dismissed and the app restarted it returned to a clean login screen —
no crash, no stuck spinner, no wedged state.

---

## 5. P1 — two defects found while walking the flow

### 5.1 The OTP step sent a second SMS

`_phoneAuth.sendCode` is awaited before routing, so `codeSent` has already fired.
The route builder then constructed the page without `requestOnStart`, which
defaults to `true`, so `initState` sent another code for the same sign-in: **two
SMS per attempt**. Fixed by passing `requestOnStart: false` when the caller
supplied the transport; the bare `const OtpPage()` still sends on first build.

Locked in by `test/features/otp_no_double_send_test.dart`, which drives the real
router with `OtpPageArgs`. Mutation-checked: with the fix removed the test fails
with `Expected: <0>  Actual: <1>`.

*On-device re-verification of this specific fix is **PARTIAL** — the repeat run
hit the app-verification blocker in §4 before reaching the step, so the fix is
proven by the router test rather than by a handset screenshot.*

### 5.2 The OTP request could spin forever

`sendCode` completed only from a Firebase callback. Firebase's `timeout`
parameter governs automatic SMS retrieval, not the request, so when app
verification produced no attestation at all, **no callback fired and the button
spun indefinitely** — reproduced on the handset for over 60 s.

A `deadline` (45 s) now fails the future with a retryable message. Covered by
`test/features/firebase_phone_auth_test.dart` (4 tests, including the
`verification-timeout` case).

### 5.3 The login screen could not be built without Firebase

`FirebasePhoneAuth` resolved `FirebaseAuth.instance` in its constructor. In any
widget test that reached the login screen this threw `[core/no-app]` **while
`build` was running**, which cascaded into `setState() called during build` in
`RemoteControlGate`. The instance is now resolved lazily, and a failed
resolution surfaces as an ordinary `PhoneAuthFailure` instead of a crash. This is
why `device_registration_launch_test` and `startup_test` were failing.

### 5.4 A test had become a time bomb

`reminder_acknowledge_test.dart` pinned a reminder to `DateTime(2026, 9, 22, 9)`.
The reconciler deliberately skips reminders whose time has passed, so the test
started failing the day after it was written. Both fixtures are now relative to
`now`.

---

## 6. Evidence index

| Artefact | Path |
|---|---|
| Fresh install, first launch (defect) | `/tmp/nova-val/fresh_launch1.png` |
| Auth-first entry screen (fixed) | `/tmp/nova-val/auth_first1.png`, `auth_first2.png` |
| Phone typed into the live field | `/tmp/nova-val/phone_typed.png` |
| OTP step reached | `/tmp/nova-val/otp_entered.png` |
| Mask fix `+91 XXXXXX 2606` | `/tmp/nova-val/otp_mask.png` |
| reCAPTCHA fallback failure | `/tmp/nova-val/otp_no_resend.png` |
| Post-auth onboarding | `/tmp/nova-val/post_login.png` |
| Clean recovery after the failure | `/tmp/nova-val/after_browser.png` |
| Firebase + server probes | `/tmp/nova-val/otp_e2e.py`, `fbcfg2.py`, `fbenable.py` |

## 7. Verification status of the suite

| Check | Result |
|---|---|
| `flutter analyze` | **clean** |
| `flutter test` | **789 passed, 5 skipped, 0 failed** (was 783 passed / 1 failed at the start of the round) |
| New regression tests | 6 (`firebase_phone_auth_test.dart` ×4, `otp_no_double_send_test.dart` ×1, plus the reminder date fix) |
| Commits | `7731e64`, `12686c6` — pushed to `origin/main` |

## 8. What is still not tested — do not read this as complete

- **Proactive delivery, wake word, background microphone remain P0 OPEN.** 82
  `follow_up` rows, **0 read**, no delivery column, no FCM, dead socket.io. The
  proactive half of the product is still inert.
- **Language selection still offers only four codes** (auto / en / ta /
  tanglish) against the thirteen-plus the mandate lists. The API enum, both
  pickers and `voice_protocol.dart` all need widening; languages whose voice is
  an English fallback must be labelled partial rather than presented as
  supported.
- **Post-login onboarding order** is welcome → permissions → profile → companion
  → health. The mandate asks for profile → customization → company → language →
  permissions → walkthrough. Only the position of authentication was corrected
  this round.
- **The MacBook acoustic loop is untested this round.** The capture rig was
  proven previously; the last attempt failed and has not been retried.
- **The full multilingual matrix was not re-run this round.**
- `NOVA_MULTILINGUAL_TEST_REPORT.md` and `NOVA_VISUAL_UI_AUDIT.md` do not exist
  yet. Four screens are audited above; the rest are not.
MD

---

## 9. Addendum — onboarding walked end to end on the handset

Because the Firebase attestation blocker (§4) is intermittent, the rest of the
lifecycle was reached through the app's **other real authentication path** — the
email + password form behind the switch — using a genuine account created through
`POST /api/v1/auth/register`. Nothing was faked: real credentials, real session,
real onboarding.

| Screen | Evidence | Finding |
|---|---|---|
| Login (email form) | `email_form.png` | The switch I added renders correctly and is fully reversible |
| Onboarding welcome | `post_signin.png` | Reached **only** after the session existed |
| Permissions | `perm_fixed.png` | Both rows said *"The system did not grant this"* before anything was asked — **fixed**, now *"Not turned on yet"* |
| OS microphone dialog | `mic_dialog.png` | Real dialog; `RECORD_AUDIO: granted=true` |
| OS notification dialog | `notif_dialog2.png` | Real dialog; `POST_NOTIFICATIONS: granted=true` |
| Permissions resolved | `perm_scroll2.png` | Microphone *Allowed*, Notifications *Allowed*, Recording *Not now*, Memory *Allowed*, AI processing *Allowed* |
| About you | `onb_next.png` | Accepts a name; **top bar and back affordance are missing** (see §10) |
| Create companion | `onb_comp_scroll.png` | Name, personality, speech style, speed, preview |
| Your preferences | `onb_health.png` | Notifications toggle + Finish setup; **top bar also missing** |
| Home | `home.png` | Reached; avatar, *Tap to talk*, bottom nav, Today's Overview |

This also **corrects an earlier finding**. The previous round recorded *"notification
permission button raises no dialog"* as P1. This round the button raised the OS
dialog on the first tap and the permission was granted, so the earlier observation
was a transient device state rather than a broken request path.

## 10. Visual findings from the walkthrough

| # | Screen | Issue | Sev | Status |
|---|---|---|---|---|
| V1 | Home | The floating summon orb was drawn at the same top-right position as the top bar and sat **through the notification bell and the settings icon** | **P2** | **FIXED & RE-VERIFIED** (`home_fixed.png`) — Home keeps its hero avatar; every other screen keeps the orb |
| V2 | About you, Your preferences | No top bar, no back affordance, and the heading is jammed against the status bar — unlike Permissions and Create companion, which both have one. Large unused area below a two-control form | **P3** | OPEN |
| V3 | Create companion, Home | The avatar panel is a large empty box with the face low in it; the card reads as mostly void rather than a prominent avatar | **P2** | OPEN — the mandate asks for the avatar to be prominent; it is present but not composed |
| V4 | Home | "Today's Overview" cards are clipped behind the bottom notice and the nav bar | **P3** | OPEN |
| V5 | Create companion | Speech style offers only **Auto Tamil–English / Tamil / English / Tanglish** (`onb_companion.png`) — the language gap, now with visual evidence | **P1** | OPEN |

## 11. Commits from this round

| Commit | What |
|---|---|
| `7731e64` | Authenticate before onboarding; bound the phone-auth request; lazy Firebase; mask keeps its last four digits |
| `12686c6` | Stop the OTP step sending a second SMS |
| `6505040` | Report + gap analysis for the above |
| `b1caf4c` | Do not claim a permission refusal before the user is asked |
| `93c1c48` | Stop the floating orb covering the Home top bar |

`flutter analyze` clean; `flutter test` **789 passed, 5 skipped, 0 failed**.

---

## 12. Addendum — Indian language selection (2026-09-23)

Full detail and the per-language matrix are in
[`NOVA_MULTILINGUAL_TEST_REPORT.md`](./NOVA_MULTILINGUAL_TEST_REPORT.md).

### The defect

The app offered **four** language options — Auto Tamil–English, Tamil, English,
Tanglish — so Hindi, Telugu, Bengali, Marathi, Kannada, Malayalam, Gujarati,
Punjabi, Odia, Assamese and Urdu could not be chosen at all, even though the
recogniser and voice layers were already routed for them. A choice was also
impossible to express on the wire: the client rewrote anything outside
`{en, ta, hi, auto}` to `auto`, so the socket was never told what the user picked.
The four-value enum existed **twice** in the API — `routes/settings.ts` and
`schemas/index.ts` — which is how both copies drifted from the pipeline.

### The fix, at each layer, from one source of truth

- `LanguagePolicySchema` in `schemas/index.ts` is derived from the shared
  catalogue; `routes/settings.ts` imports it instead of defining its own.
- `kVoiceProtocolLanguages` is derived from `kSupportedLanguages` plus the mixed
  styles, so every offered language survives to the socket.
- Both pickers render one shared `languagePolicyOptions()`.
- Device-TTS fallback gained BCP-47 tags for the Indian languages.

### Verified on the handset and against a live API

| Check | Evidence |
|---|---|
| Picker lists 27 options covering every language the mandate names, plus Hinglish / Tanglish / Benglish / Gujlish | `lang_sheet.png` |
| **Telugu shows as selected** after being persisted via the API — a full round trip | `lang_sheet.png` |
| `PUT /settings/persona {languagePolicy:'te'}` | `200` |
| `GET /settings/persona` | returns `te` |
| `PUT {languagePolicy:'klingon'}` | `400` |
| Real Telugu turn via `/voice/chat` | `200` in 4.6 s, reply **60 Telugu characters / 0 Latin** |
| The reminder the turn claimed | **actually created** — 0 → 1 rows, `triggerAt 2026-09-24T09:00 Asia/Kolkata` |
| Real Telugu speech out | `/voice/tts` → `200`, **291,250 bytes** |

### Also fixed in this addendum

The summon orb still covered a control after the previous round's fix. Excluding
Home was not enough: on Profile it hid the **sign-out button**. The orb's
`top: 60` sits inside `NovaScaffold`'s top bar (`topInset` 44 + a 44px control row
+ 16px padding, ending at 104), so it now sits at 112 — a structural fix rather
than a list of routes to avoid. Re-verified on Home and Profile
(`home_fixed.png`, `profile_orb.png`).

### Still open on languages

Five languages (`ur`, `ne`, `ks`, `bho`, `awa`) return a correct reply in their own
script that is then **spoken by an English voice**. The catalogue claims Sarvam for
`ur`, `ne`, `bho` and `awa`, so the routing and the observed behaviour disagree and
must be reconciled; until then the picker should mark those as partial. Real
speech was sampled for seven languages only — the rest were driven as text through
the live pipeline and must not be described as verified.

---

## 13. Addendum — push transport for proactive nudges (2026-09-23)

This was the last P0 with no external blocker: the proactive half of the product
had **no transport at all**. `devices.push_token` existed, the admin console even
reported `hasPushToken`, and nothing ever wrote a token or sent a message — 82
`follow_up` rows, 0 read. The app never called `/notifications` either.

### What was built

| Layer | Change |
|---|---|
| API | `/device/register` accepts and stores `pushToken`; absent leaves the stored token alone, empty clears it. `GET /device/register` reports `hasPushToken`. |
| API | `services/fcm.ts` — FCM HTTP v1, OAuth minted from the service-account JSON with `jsonwebtoken` (already a dependency) and the global `fetch`, so no `firebase-admin`. One request per token; a token FCM reports as unregistered is returned and cleared. |
| API | `NotificationService.create` — the single insertion point the assistant, follow-up engine and reminder scheduler all use — pushes after writing the row, best-effort. |
| App | `firebase_messaging` obtains the token during registration, bounded by a timeout. |
| App | `PushForegroundHandler` draws a push that arrives while the app is open. |

### Verified on the handset, with real credentials

| Check | Evidence |
|---|---|
| A real FCM token reached the database from the phone | `devices.push_token`, 142 characters, `installation_id 5eec3a1126eaa0a684a1835f66a10bbb` |
| The server sent it | `devices: 1, sent: 1, failed: 0, configured: true` |
| App **backgrounded** → the user is told | shade: **NOVA · Call Arun · "You have a reminder to call Arun. Would you like to do it now?"** (`push_shade2.png`) |
| App **foregrounded** → nothing appeared | `push_shade.png` — empty. Diagnosed: Android only draws its own notification when the app is backgrounded, and the app had no `onMessage` handler |
| After the fix, foregrounded → visible | `fg_push_shade.png`; `dumpsys` reports `id=900001 channel=nova_reminders importance=4` |
| Token survives a tokenless re-register | `device-push-token.test.ts` — fails with the guard removed |

### Still open on this path

- **The app still has no notification surface.** `/notifications` (list, read,
  delete, unread-count) exists and the app calls none of it; the bell shows a
  hardcoded `0`. Dismiss the shade and the nudge cannot be found again inside NOVA.
- **Delivery is silent.** The channel is created with `Importance.high` but no
  sound, and Android groups a soundless high channel under the silent indicator.
  A reminder the user does not notice is not a reminder.
- **No `delivered_at`.** Nothing records whether FCM accepted a message, so "sent"
  cannot be distinguished from "received".
- **The follow-up engine has not been exercised through push.** What was proven is
  the transport, driven by the same service the engines call — not a live
  scheduled follow-up firing on its own.

`NOVA_VISUAL_UI_AUDIT.md` now exists and covers every screen photographed so far,
with the screens that were never opened listed as unaudited.

---

## 14. Addendum — the in-app notification inbox (2026-09-23)

The push transport from §13 put a nudge in the system shade. It could not be
found again inside NOVA: the bell showed a hardcoded `0` and went to Profile, and
`/notifications` — list, unread count, mark-read, delete — had existed since the
table was created with the app calling none of it.

### Verified on the handset

| Step | Evidence |
|---|---|
| Bell shows the true unread count | **4** (`bell_badge2.png`) — the account's real unread count, not a placeholder |
| Tapping it opens the inbox | `inbox.png` — every row with title, body and relative time ("2m ago"), unread rows accented, dismiss button each |
| Tapping a row marks it read **on the server** | database then held **1 read / 3 unread**; the row rendered as read and the badge fell to **3** (`inbox_read.png`) |
| Dismissing a row deletes it | **4 rows → 3** in the database |

### Two defects found while verifying

1. **The badge could never work.** `unreadNotificationCount` read `data['data']`,
   but the client's `_get` already unwraps the `{success, data}` envelope — so
   every call answered 0. The first device screenshot showed the bell with *no*
   badge at all, which is what exposed it. Now `parseUnreadCount`, which handles
   both shapes.
2. **The parse could throw in a build.** It cast `count` straight to `num?`; a
   string value would have thrown inside a widget build. The test written for it
   caught this on its first run (`type 'String' is not a subtype of type 'num?'`),
   and the conversion is now total.

Note this was found *by looking at the device*, not by the test suite — the tests
passed both before and after the counting bug, because no test exercised the parse
against the shape the client actually returns. That is precisely why the mandate
insists on real-device verification.

### Still open on this path

The remaining gaps from §13 are unchanged: **delivery is silent** (`sound=null`),
there is **no `delivered_at`** receipt, and the **follow-up engine has not been
exercised through push** — what is proven is the transport and the inbox, driven
by the same service the engines call.

---

## 15. Addendum — wake word, and the MacBook acoustic loop (2026-09-23)

This round tested the product's flagship affordance with the MacBook acting as
the human, and **corrected a P0 the previous rounds had recorded wrongly**.

### The correction

Earlier rounds recorded *"the wake word responds to nothing; `WakeWordService` is
never started"* as a P0. That was **not** the defect. `WakeWordController.arm()`
returns early when `state.enabled` is false, and the wake word is **off until the
user opts in** — the earlier checks simply never opted in. Enabling it on the
handset (Profile → Wake word listening → *Turn on*) started the service
immediately and correctly.

### Verified on the handset

| Step | Evidence |
|---|---|
| Enabling it starts the service | `ServiceRecord{com.leadup.nova/.WakeWordService}` `isForeground=true types=00000080` (microphone), channel `nova_wake_word` |
| The real model loads | `sherpa-onnx KWS started (model=wakeword/kws, keywords=wakeword/kws/keywords.txt, threshold=0.25)` / `Wake word engine started (models: hey_nova)` |
| **MacBook speaker → phone mic, foreground** | `SherpaWakeWord: DETECTION! hey_nova (keyword=HEY NOVA)` |
| **MacBook speaker → phone mic, app backgrounded** | two detections with NOVA on the launcher, 4 s apart |
| The foreground detection was acted on | NOVA opened a conversation, transcribed the speech ("Painover" — a mis-hearing of "Hey Nova"), and answered **in Telugu**, the pinned language, asking for clarification. Real STT, real model, real reply. |
| The background detection was announced | shade: **"NOVA — Heard \"Hey Nova\" — tap to talk"** |
| Tapping it after the fix | lands on **Converse, already LISTENING**, mic live (`tap_converse.png`) |

The acoustic loop the mandate asks for — **MacBook speaker → physical phone
microphone → NOVA → phone speaker/screen → MacBook** — is therefore proven end to
end: every detection in this run came from speech synthesised on the MacBook and
heard by the phone's microphone, with no injection or API substitution.

### What this round changed

Tapping "tap to talk" opened NOVA on Home and started nothing — the notification's
intent only launches the app. `_onResume` now honours a fresh background
detection, opening Converse and starting the session, bounded by a 90-second
freshness window so an old detection cannot ambush a later, unrelated visit.

### Still open

- **The wake word is never offered in onboarding** (P1). It works, and a new user
  has no reason to find it.
- **Three notification channels are silent** (`sound=null`, `nova_reminders`,
  `nova_wake_word`, `nova_wake_word_detection`). For a reminder in particular,
  silence defeats the purpose.
- **One unexplained `400`** was logged by the app during the resume path that
  starts the wake session. The session still started and the UI was correct, so it
  is not blocking — but it is unexplained and is recorded as such rather than
  waved away (P2).

---

## 16. Addendum — a reminder that actually fires (2026-09-23)

§15 of the mandate is explicit that *"a push notification alone is NOT a
successful reminder"* and that a reminder the user does not notice is not a
reminder. This round tested the reminder from a fresh install all the way to the
shade.

### Fixed first: the notifications were silent

Every reminder arrived silent — `sound=null`, filed under Android's "Silent"
group. The channel was created with `Importance.high` but no sound.

The subtlety that mattered: **Android never updates an existing channel.** Setting
`playSound` on the id already installed would have been silently ignored forever,
for every existing user, so the fix is a new id — `nova_reminders_v2` — carried in
both the app and the FCM payload (Android drops a notification whose channel does
not exist).

### Verified on a fresh install

| Step | Evidence |
|---|---|
| Fresh install (uninstall/reinstall, because channels survive an update) | auth-first entry screen, as in §3 |
| Sign in, complete onboarding | permissions/consent restored from the server; Home reached |
| The new channel exists **with sound** | `NotificationChannel{mId='nova_reminders_v2', mImportance=4, mSound=content://settings/system/notification_sound, mVibrationEnabled=true, mShowBanner=true}` |
| A reminder created two minutes out is armed | `dumpsys alarm`: `RTC_WAKEUP … ScheduledNotificationReceiver`, `origWhen` matching the exact instant requested |
| It fired | notification posted on `channel=nova_reminders_v2`, importance 4 |
| The user sees it | shade: **"NOVA reminder — Check the oven"**, in the *alerting* section, **not** under "Silent" (`reminder_fired.png`) |

### Two findings from the same run

1. **Reminders are inexact** — the armed alarm carries `windowLength 83734` (≈84 s)
   and the reminder set for 01:21:36 posted at 01:23:39. "Remind me at 6:00" can
   therefore arrive at 6:01:24. The cause is the exact-alarm permission not being
   held (P2, recorded as 4f).
2. **The OS notification prompt fires before onboarding explains it.** On a fresh
   install the "Allow NOVA to send you notifications?" dialog appeared over the
   *Get started* screen — before the app's own Permissions screen, which describes
   what each permission is for. The permission is requested by the push-token
   registration that runs at first sign-in (P3).

### Still not tested

The reminder's **conversational response loop** — saying "Done", "remind me again
in 30 minutes", or "cancel it" after the nudge and having the state and history
update. The notification fired and was dismissed; the reply was never spoken. That
is the remaining half of §15 and it is recorded as **P1 OPEN**, not as passing.

---

## 17. Addendum — answering a reminder by voice (2026-09-23)

§15's centrepiece is that a reminder is not a push notification: after the nudge
the user should be able to *say* something and have NOVA act. That was the P1 left
open last round. Testing it surfaced two further defects.

### The loop, now verified on the device

| Step | Evidence |
|---|---|
| A reminder fires | **"NOVA reminder — Call the plumber"**, alerting group |
| It is opened | lands on Home with the bell badge live |
| *Tap to talk* | opens Converse **and starts a turn** |
| The MacBook speaks | **"Done. I already called the plumber."** — transcribed correctly on screen |
| NOVA understands | proposes **`cancel_reminder`** with the reminder id `d5e60151-…`, behind a real approval gate with a 49-second expiry |
| Approved | `reminders.dismissed = true` in the database, confirmed through the API |

### The two defects this exposed

**1. "Tap to talk" never talked.** `HomePage`'s primary CTA was
`onPressed: () => context.go('/converse')` — navigation. On the handset it landed
on Converse in the READY state with nothing listening, and the spoken sentence
produced no turn at all. The floating orb was worse: `_summon` set the avatar to
"listening" and navigated, so a session *looked* started while nothing listened.
Only the wake word path called `startTurn`. Both now do, in the pinned language.

**2. No conversational action reached history.** The mandate requires the
interaction to be recorded. Cancelling the reminder by voice set `dismissed = true`
and left **no** row: `/activity` reads `audit_logs`, and the assistant's tool
executor wrote zero audit rows. The first fix hooked `executeToolUses` — and still
wrote nothing, because the realtime loop (`realtime/tool-loop.ts`) calls
`executeAssistantTool` directly. Hooked at that single funnel instead, a spoken
"Remind me to call the dentist tomorrow at five in the evening" now returns
`reminder.create | reminder | cde4950e-… | success` from `/activity`.

The lesson is worth recording: the first hook *looked* right and was verified only
because the device still showed no history row. A test asserting the hook existed
would have passed.

### Also confirmed this round

- A natural spoken date and time — *"tomorrow at five in the evening"* — resolved
  to `2026-09-24T17:00:00+05:30`, the correct next-day 5 PM in the user's zone.
- The approval gate works: the model's proposed action is shown with its exact
  arguments and must be approved, which is the right default for a write the user
  did not type.

### Still open

- **Snooze and "remind me again" by voice** were not exercised — only cancel.
- **Reminders are inexact** (row 4f): the armed alarm carries an ~84 s window, so
  a reminder set for 01:27:51 posted around 01:28:5x.

---

## 18. Addendum — version skew and a stuck black screen (2026-09-23)

### The unexplained 400 is explained

An earlier round logged an unidentified `400` from the app during the resume path
and recorded it honestly as unexplained. It is now identified:

```
[nova] device registration failed (non-fatal): DioException … status code of 400
```

`POST /device/register` carried a `pushToken` the deployed server did not know,
and the schema was `.strict()`:

```
{"pushToken":"abc123"} → 400  Unrecognized key(s) in object: 'pushToken'
```

The impact is not cosmetic. Registration is the **only** writer of
`devices.push_token`, so any client newer than the server can never register,
never stores a push token, and can never receive a proactive nudge. Fixed by
ignoring unknown keys on this client-reporting endpoint while still validating
every declared field — a client updates on its own schedule, so rejecting its new
fields is the wrong failure mode. Both halves are pinned by tests.

**This does not make push work on production by itself.** The API still has to be
deployed there; until it is, the deployed build predates the push transport
entirely.

### A stuck black screen — reproduced, not yet diagnosed

Approving a tool action left the app on a **fully black screen**. Reproduction, run
twice:

1. Approve an assistant action from the confirm sheet;
2. the screen goes black — status bar visible, nothing else;
3. Back exits to the launcher; reopening NOVA is **still** black;
4. only `am force-stop` followed by a launch restores it, back on Home.

The window in `logcat`:

```
[VoiceRealtime] tool approval granted: create_reminder (567ec710-…)
[VoiceRealtime] socket error: WebSocketChannelException: HttpException:
    Connection closed before full header was received, uri = …/voice/realtime
```

The widget tree does **not** throw — the app's `ErrorBoundary` would have drawn a
message rather than black — so something renders empty rather than failing. The
socket error is in the same window and is the obvious suspect, but I have not
proven it is the cause, so it is recorded as **P1 OPEN** with the reproduction
rather than closed with a guess. A user who approves an action can be left with an
unusable app and no in-app way out.

---

## 19. Addendum — the black screen, narrowed but not solved (2026-09-23)

The reproduced P1 from §18 was investigated. It is **not** fixed, and this entry
records what was ruled out so the next attempt does not repeat it.

### Ruled out

| Hypothesis | Why it is wrong |
|---|---|
| The confirm sheet is what fills the screen | Its background is `c.surface` (dark grey), and the sheet renders a "Confirm action" header and two buttons. The screen was uniformly black with no shell nav bar and no top bar. |
| `decideApproval` hangs, so the sheet never pops | It is `void`, not a `Future` — the `async` wrapper returns immediately, so `Navigator.pop` is always reached. |
| A widget threw | The app's `ErrorBoundary` would have drawn a message. Nothing was caught, and `logcat` shows no Flutter exception. |

What is still true and still unexplained: after approving, the app renders a
full-screen black surface with **no shell chrome at all** — no bottom nav, no top
bar — while the process stays alive and focused. Only `am force-stop` restores it.
The one signal in the same window is a dead voice socket:

```
tool approval granted: create_reminder (567ec710-…)
socket error: WebSocketChannelException: HttpException: Connection closed
    before full header was received, uri = …/voice/realtime
```

That is 18 seconds after the approval and is the obvious suspect, but correlation
is not causation and no fix was written against it.

### What was fixed

The sheet was `isDismissible: false` and `enableDrag: false` — a modal the user
cannot close. That is what turned a rendering fault into an unusable app. Both
call paths already treat a dismissal as "deny", so making it closable is safe and
well-defined, and the user now always has a way out. On-device verification of the
escape hatch was not performed: reaching the sheet needs a full voice turn with a
side-effecting tool, and the black screen is not reproducible on demand.

### Consequence for this round

The task lifecycle (§13) and the MacBook's capture of NOVA's spoken reply were the
planned work and were **not** completed: every attempt runs through a voice turn
that ends at the approval sheet, which is where the app becomes unusable. They
remain untested and are not claimed.

---

## 20. Addendum — the black screen: three hypotheses ruled out (2026-09-23)

Round 10 narrowed the black screen; this round ran experiments against it. It is
**still not fixed**, but the cause is now bounded and three plausible explanations
are eliminated.

### Measured

The frame is **pure `#000000`** at every sample point, while the app's real
background is a dark blue-grey (`(12,24,42)`). So it is not a scrim over the UI —
it is the window's own black showing through where a Flutter frame should be.
`dumpsys SurfaceFlinger` lists a **`Background for SurfaceView[com.leadup.nova/.MainActivity]`** layer alongside the Flutter `SurfaceView`, and `logcat` shows
`VRI[nova]: updateBlastSurfaceIfNeeded … lastSurfaceSize:Point(0, 0)` and
`handleResized abandoned!` around the same time. No Flutter frame is produced and
no exception is logged.

### It is intermittent

Four approvals on the same build and the same flow: **three black, one fine**.
That alone invalidates any claim that it is deterministic, and it means a single
green run proves nothing.

### Ruled out

| Hypothesis | Experiment | Result |
|---|---|---|
| Impeller / Vulkan is losing the surface | Disabled Impeller via `io.flutter.embedding.android.EnableImpeller=false`, rebuilt, repeated the flow | **Black persisted.** The opt-out was reverted — leaving a non-fix in the manifest would have been worse than nothing. |
| The confirm sheet fills the screen | Sampled its background: `c.surface`, and it renders a header and two buttons | Not the source |
| `decideApproval` hangs so the sheet never pops | Read it: `void`, not a `Future`; the async wrapper returns immediately | Cannot block the pop |
| A widget threw | `ErrorBoundary` would have drawn a message | Nothing caught |

### The one discriminate that survived

**Approving triggers it; dismissing does not.** Tapping the scrim on the same
sheet (which the previous round made possible) left the app rendering normally.
So the trigger is on the *approve* path — where the server runs the tool and
continues the turn — and not the sheet, not the socket in general, and not the
modal.

That is where the next attempt should start: the post-approval continuation
(tool result → model reply → speech) is the only thing that differs from the
dismiss path.

### Still open, and what it costs

The task lifecycle (§13) and the MacBook's capture of NOVA's spoken reply remain
untested — every route to them passes through an approval, which is where the app
can become unusable. They are not claimed. The escape hatch added in round 10
(the sheet is now dismissible) is in the build but was **not** exercised on the
device as a recovery path, only as the dismiss control in this experiment.


---

## 21. Addendum — the MacBook acoustic loop, both directions (2026-09-23)

Mandate §11 asks for the loop to run **both** ways: the phone must hear the
MacBook, and the MacBook must capture what the phone says back. The forward
direction was proven earlier; this round measured the return path.

### Method

The MacBook's microphone recorded continuously across the whole exchange
(`rec`, 48 kHz), the question was synthesised on the MacBook's speakers, and the
recording was analysed for RMS in windows either side of the exchange.

### Result

| Window | RMS | vs room floor |
|---|---|---|
| room baseline | 0.0050 | — |
| the question (MacBook speakers) | 0.0334 | **6.7×** |
| 14–18 s | 0.0052 | silence |
| **18–22 s** | **0.0176** | **3.5×** |
| **22–26 s** | **0.0137** | **2.7×** |
| 26–34 s | 0.0053 | silence |

The 0.25 s detail shows modulated, speech-like activity between ~18.5 s and
~24.5 s, starting after the question ended and stopping when the reply did, with
silence either side. That is NOVA's voice leaving the phone's speaker and arriving
at the MacBook's microphone.

**The complete loop is therefore verified:**
MacBook speaker → physical phone microphone → real STT → real model → real TTS →
physical phone speaker → MacBook microphone.

No injection, no transcript substitution and no API-only shortcut was used; the
only synthetic element is that the MacBook's side of the conversation is produced
by `say` rather than by a person, which is recorded honestly here.

### The reply itself

The question was *"What is on my schedule today?"* — asked as a plain
conversational turn, with **no write tool and therefore no approval**, which is
how this round got past the black screen of §20. NOVA answered:

> *"…twenty-one minutes past one this morning. For tomorrow, Thursday the
> twenty-fourth of September, you have: a call to make to the client at nine in
> the morning; call the dentist at five in the evening; buy milk at six in the
> evening. You also have two proposals due tomorrow at midnight — they're both on
> your task list."*

Every item is real: those reminders and tasks were created earlier in this
session, and the dates and times match what was actually stored. This is a
grounded, useful briefing rather than a generic reply — the behaviour the product
exists to provide.

### Observation, not a defect

NOVA's reply arrived at roughly half the amplitude of the MacBook's own question
(0.0176 vs 0.0334). The phone's speaker is small and faces away from the
microphone, and the two sources are not equidistant from it, so this is not
evidence of low playback volume. It is recorded as an observation only; nothing
was changed on the strength of it.

---

## 22. Addendum — the task lifecycle, and three defects it exposed (2026-09-23)

§13's lifecycle is create → modify → reschedule → snooze → complete → reopen →
history. Driving it through the assistant (with real conversation history, real
model, real database) found that **the middle of it did not exist**.

### Fixed

| Defect | Evidence | Fix |
|---|---|---|
| **Modify and reschedule had no tool** | *"move that to Friday"* → *"I need the time for Friday. What time would you like to be reminded…"* and the task never moved. The registry held only `create_task`, `complete_task`, `reopen_task`. | Added `update_task` (title, due_at, priority), same permission level as its siblings, advertised in the prompt, recorded as `task.update` |
| **A day with no time was treated as incomplete** | *"create a task to file the insurance claim on Thursday"* → *"What time on Thursday would you like?"* → **no task created**, and the next three turns could not recover. The tool's own description told the model to ask. | The description now says a task's deadline is optional, that a bare day is a complete answer, and to file it and say which day was used — while still refusing to invent an hour |
| **A placeholder id reached Postgres** | `reopen_task` called with `"task_id_for_warranty_claim"`; `TaskId` was `z.string().min(1).max(64)`, so it passed and the database raised `invalid input syntax for type uuid`. The turn ended *"the system rejected the request"*. | Ids are `z.string().uuid()`, so the model gets a validation failure it can retry from and the database is never asked to compare a non-uuid |

Re-run after the fixes:

| Turn | Reply | Stored state |
|---|---|---|
| "Create a task to file the passport form on Thursday" | *"Task added: file the passport form on Thursday at midnight."* | created, `pending` |
| "Move that to Friday" | *"Moved to Friday, September twenty-fifth."* | `dueAt` = **Friday 00:00 IST** |
| "Mark it complete" | *(action performed)* | `completed` |
| "Actually reopen it" | *"Done—the passport form task is back on your list for Friday."* | **still `completed`** |

### Left open, and why it matters

**Reopen acted on the wrong task and reported success.** `reopen_task:ok` is in
the log, the named task is still `completed`, and the user was told it had been
reopened. An earlier run said so outright: *"I apologize — I reopened the wrong
task. That was your gym membership, not the insurance claim."*

This is the most serious thing this round found: the user is told the right record
changed while a different one did. It is recorded as **P1 OPEN** with the
reproduction, not described as a passing step. The likely fix is to make a status
change confirm its target when more than one task could match, and to name the
changed task in the confirmation so a wrong target is visible rather than silent.

Also noted (P3): after a successful `complete_task` the reply was *"Got it. I'll
treat execution logs and tool results as actual operations performed."* The action
was real; the sentence is unrelated to it.

### Method note

My first two attempts at this test were wrong and said so: I sent each turn as a
**fresh single-message request**, so "that" had nothing to refer to and every
follow-up asked for clarification. That was the harness, not the product. The
runs above carry the accumulated conversation, the way the app does.

---

## 23. Addendum — the task lifecycle, working end to end (2026-09-23)

Last round left the reopen step open: `reopen_task:ok` was logged while the named
task stayed completed and a *different* task was silently reopened. That is now
fixed, and the lifecycle runs clean.

### The two causes

**1. Completed tasks were invisible to the assistant.** The context query read
`WHERE status IN ('pending','in_progress')`, and the assistant is given task ids
in that context. So a completed task had **no id the model could send**:

> *"I don't have the task ID for the library card in my list. Which task did you
> mean — is it one of the proposal tasks, or the gym membership, or something
> else?"*

and on another run it bound a *pending* task's id instead, which is how the wrong
record got mutated. Recently-completed tasks are now read on a second bounded
query (five, ordered by completion time) and rendered under their own heading.
The renderer also had to learn the state: it labelled anything not in progress as
"pending", which would have described a finished task as outstanding.

This is the same lesson the reminder section of that file already documents — a
24-hour window once made overdue reminders invisible and the assistant answered
"none of your reminders are overdue".

**2. A status change that reverses nothing was reported as a success.**
`setTaskStatus` wrote unconditionally, so reopening an already-pending task
returned `ok` for whatever row it was handed. It now refuses and **names the task
it actually received**, so a wrong target is visible rather than silent.

### Verified against the live model

| Turn | Reply | Stored state |
|---|---|---|
| "Create a task to file the bus pass on Thursday" | *"Done. I've added \"File the bus pass\" to your task list for Thursday."* | `pending` |
| "Move that to Friday" | *"Moved \"File the bus pass\" to Friday, twenty-fifth of September."* | due **Friday 00:00 IST** |
| "Mark it complete" | *"Done. I've marked \"File the bus pass\" as complete."* | `completed` |
| "Actually reopen it, I have not done it yet" | *"Got it. \"File the bus pass\" is back on your list as pending for Friday."* | **`pending`** |

This closes §13's create → modify → reschedule → complete → reopen, with the
conversation carrying its own history and every transition confirmed in the
database rather than taken from the reply.

### Still untested

- **Snooze** (there is no snooze tool for tasks; `update_reminder` carries
  `in_minutes` for reminders) and **recurring reminders** — recorded as row 19c.
- **History**: the `audit_logs` rows for these transitions were added in round 8
  and were not re-checked on this run.

---

## 24. Addendum — the reminder lifecycle and the morning briefing (2026-09-23)

Both were listed as untested. Both pass, each step read back from the database
rather than taken from the reply.

### The reminder lifecycle (§14)

| Turn | Reply | Stored state |
|---|---|---|
| "Remind me to call Arun tomorrow at 6 PM" | *"Reminder set for tomorrow at six in the evening to call Arun."* | `Thu 24 Sep 18:00 IST` |
| "Actually make that 7 PM" | *"now set for tomorrow at seven in the evening"* | `Thu 24 Sep 19:00 IST` |
| "Snooze it by 30 minutes" | *"Snoozed by thirty minutes … half past two in the morning."* | now + 30 min |
| "Make it repeat every day" | *"now set to repeat every day at half past two in the morning"* | `repeatRule = FREQ=DAILY` |
| "Cancel it, I will not need it" | *"Cancelled. Your reminder to call Arun won't notify you anymore."* | `dismissed = true` |

Timezone handling is correct throughout — every stored instant is the IST time
that was asked for — and the relative move names the resulting time plainly
enough for the user to notice it is now early morning.

**Missing reminders.** *"Do I have anything overdue right now?"* → *"You have two
overdue reminders that are still pending: Water filter — overdue since Tuesday at
eleven oh seven in the evening; Check the oven — overdue since early this
morning at one twenty-one."* An overdue reminder is exactly what a proactive
assistant exists to surface, and it did.

**One observation, not a defect.** Snoozing a reminder that was due *tomorrow* by
thirty minutes moved it to *now + 30 minutes*, because `in_minutes` is documented
as measured from the current time. That is the stated contract, and the reply said
so ("half past two in the morning"), so it is not misleading — but a user who says
"snooze" about a future reminder most likely means "thirty minutes later than
scheduled". Recorded as a product question (row 19e), not a bug.

### The morning briefing (§16)

`GET /briefing` returned:

```
source: grounded
text:   "Good morning. Your next reminder is Buy milk at six in the evening. You have
         two more reminders after that. Also worth flagging: two reminders went of…"
counts: overdue 0 · dueToday 0 · later 9 · upcomingReminders 3 · missedReminders 2
capabilities: calendar false · weather false · eveningRecap false · tasks true ·
              reminders true · memories true
guardRejection: ungrounded-quantity:one
```

Three things are worth noting. The summary is **grounded** in real rows. The
capability block is **honest** — it does not claim weather or calendar it does not
have. And the anti-fabrication guard had **already fired** on the model's own draft
(`ungrounded-quantity:one`), so the text the user receives is the grounded
fallback rather than a sentence with an invented number in it. That is the honesty
machinery the product needs, working on its own output.

### Still untested

- **Background and restart cases** for reminders: screen locked, device restart,
  network interruption, app killed. The reminder firing with the app *backgrounded*
  was verified in §16 of the earlier report; the rest need a reboot and are not
  claimed.
- **Snooze as a post-fire response** ("remind me again in 30 minutes" to a nudge
  that has already fired) — the relative move above was applied to a reminder that
  had not fired.

---

## 25. Addendum — the black screen: the mechanism, found (2026-09-23)

Rounds 10–11 ruled things out and left the cause open. This round attached to the
running Dart VM service and dumped the live widget tree, which settled it.

### The technique

The debug build prints its VM service URI to `logcat`. The service answers plain
HTTP, so no WebSocket client is needed:

```
adb forward tcp:<port> tcp:<port>
curl "http://127.0.0.1:<port>/<token>/getVM"                     # isolate id
curl "http://127.0.0.1:<port>/<token>/ext.flutter.debugDumpApp?isolateId=<id>"
```

Validated while the app was healthy, then used while it was black.

### What it showed

| State | Widget tree | Tail |
|---|---|---|
| Healthy, sheet up | **2044 lines** | Scaffold, Navigator, GoRouter, the shell |
| **Black, after approving** | **87 lines** | `Router<Object> → UnmanagedRestorationScope → _RouterScope → Builder → SizedBox.shrink()` |

The entire routed tree is **gone** — not unpainted, not scrolled away. The
`Builder` at the end is go_router's own, and go_router returns `SizedBox.shrink()`
when its configuration is empty. An empty `SizedBox` inside a dark `MaterialApp`
is exactly the pure `#000000` measured earlier, and it explains every symptom: no
shell chrome, the process alive and focused, no exception, and only a force-stop
restoring it.

This also fits the one discriminator that had survived: approving makes the server
continue the turn, so a navigation can race the sheet's pop — and a pop past the
root, or a navigation arriving during a pop, is what empties the match list.
Dismissing ends the turn instead.

### What was tried and reverted

A guard in `_NovaAppState` listened to `routerDelegate` and called `router.go('/')`
whenever `currentConfiguration.matches` was empty. It **did not work**: the screen
stayed black and the dump afterwards showed
`Builder → SingleChildRenderObjectElement(DEFUNCT)(no widget)` — the failure state
changed, the UI did not come back. Reverted, because a non-fix left in the tree is
worse than none; the same call was made about the Impeller opt-out in round 11.

### Where the next attempt should start

Not at the rendering backend (Impeller was exonerated with Skia) and not at the
sheet (a dismiss is fine). The question is **what empties go_router's match list
immediately after an approval**, and the answer is a navigation racing the sheet's
pop. Instrumenting `GoRouter`'s route-information changes around the approval —
logging every `location` the delegate receives — would name the caller directly.

### Status

**P1, open.** The mechanism is known and reproducible; the fix is not found. The
escape hatch from round 10 (the sheet is dismissible) is still the only thing
that reduces the harm, and it only helps before the action is approved.

---

## 26. Addendum — the black screen is fixed (2026-09-23)

Open for four rounds as a P1. Closed with a route trace, and verified on the
handset twice.

### The trace

A debug-only `NavigatorObserver` plus a delegate listener (`router.dart`,
`app.dart`) logged every route change and every router notification. One run
named the cause, after three rounds of elimination had not:

```
02:24:00.970  POP ModalBottomSheetRoute<bool> prev=converse   <- the sheet, correct
02:24:00.973  POP converse prev=-                             <- the page, 3 ms later
02:24:00.974  delegate matches=0 uri=                         <- empty -> black
```

### Why

`_maybePromptVoiceApproval` keeps a branch for *"the request went away while its
sheet was up (cancelled turn, server timeout) — take the sheet with it"*, and it
closed the sheet with `Navigator.maybePop()`.

But **approving clears `pendingApproval` as well** — it is the same signal that
branch watches — and `_showingVoiceApproval` is not reset until the
still-suspended call's `finally` runs. So the ordinary approve path fired the
branch and popped the sheet's *page* on top of the sheet's own pop.

That also explains the intermittency that misled earlier rounds: the outcome
depended on whether the `finally` had already run when the listener fired.

### The fix

`_decidingApproval` brackets the state change the user's decision causes. The
branch stands down while a decision is being applied, and still behaves as
before for a request that genuinely vanishes.

### Verified on the handset

| Run | Trace | Frame |
|---|---|---|
| 1st approval | one `POP ModalBottomSheetRoute`, no `POP converse`, no `matches=0` | `(14,35,45) (27,36,51) (5,15,33)` — rendering |
| 2nd approval | same | `(21,30,46) (2,5,17) (5,15,33)` — rendering |

Contrast with the failure, which was `(0,0,0)` at every sample point.

### What is kept

The route trace. It is gated on `kDebugMode` so release pays nothing, and a
routing fault is otherwise invisible — four rounds of reasoning about renderers,
sheets and sockets got nowhere, and one trace settled it.

### Effect on the rest of the validation

Approvals are the gate on every write the assistant proposes by voice. Tasks,
reminders and history can now be exercised end to end on the handset through the
spoken path, without the flow that made the app unusable.

---

## 27. Addendum — the device path through an approval, working (2026-09-23)

The black-screen fix removes the only thing that made the app unusable at an
approval, so the spoken path can now be exercised on the handset. One full
cycle, spoken by the MacBook and verified in the database:

| Step | Evidence |
|---|---|
| Said | *"Create a task to send the quarterly report tomorrow"* — through the MacBook's speakers |
| Heard | the phone transcribed it and the model proposed `create_task` |
| Approved | the sheet closed; the trace shows one pop and no `matches=0` |
| Persisted | `tasks`: **"Send a quarterly report"**, `status=pending` |
| Recorded | `audit_logs`: **`task.create \| agent \| task \| success`** |
| Said | NOVA: *"Added \"Send a quarterly report\" for tomorrow at midnight."* |
| The claim matches the record | API `dueAt` = `2026-09-23T18:30:00Z` = **Thu 24 Sep 00:00 IST** — midnight, as stated |

Before this round that flow ended on a black screen with the task created and the
app dead. Both the persistence and the history row were impossible to observe
through the voice path.

### Also worth recording

**NOVA refused to act on a truncated utterance.** On a later attempt the
microphone produced only *"Remind me to"*, and NOVA answered: *"Your message keeps
cutting off at \"Remind me to…\" — try sending it again; what's the reminder, and
for when?"* No tool was called. That is the right behaviour for an incomplete
command: it asked rather than guessing at a reminder that was never stated.

### A correction about my own method

I twice reported that "a second turn produced no tool call", and investigated it
as a possible defect. It was **my** error: the app was on **Converse**, and the
coordinate I tapped is the "Tap to talk" button on **Home**. On Converse that
point is the message list, so no turn started at all — the screenshot after the
"second turn" is byte-for-byte the same screen as before it. Nothing about the
product was demonstrated there, in either direction, and it is not counted as a
finding.

### Still untested

The multi-turn spoken lifecycle on the handset — modify, complete, reopen by
voice — was verified at the API level (§23) but only the **create** step has been
driven through speech on the device. The remaining steps need the Converse mic
control rather than the Home CTA.

---

## 28. Addendum — the task lifecycle, by voice, on the handset (2026-09-23)

§13's full lifecycle is now demonstrated through speech on the physical phone,
with the MacBook speaking and every transition approved in the sheet and then
read back from the API rather than taken from the reply.

| # | Spoken (MacBook → phone mic) | Tool the server ran | Verified state |
|---|---|---|---|
| 1 | *"Create a task to renew the domain in Thursday"* | `create_task:ok` | `pending`, due **Thu 24 Sep** |
| 2 | *"Move that task to Friday"* | `update_task:ok` | due **Fri 25 Sep 00:00 IST** |
| 3 | *"Mark the domain task as complete"* | `complete_task:ok` | `completed` |
| 4 | *"Actually reopen it, I have not done it yet"* | `reopen_task:ok` | **`pending`** |

The history recorded all four, in order, as the agent acting on the user's behalf:

```
task.create · task.create · task.update · task.complete · task.reopen   (all success)
```

### Why this is new

Three earlier rounds could not do this, for reasons that were all real and are now
fixed:

- **The black screen** (§26) ended the app at the first approval. Every step here
  passes through one.
- **`update_task` did not exist** (§23). "Move that to Friday" had nothing to call.
- **Reopening missed its target** (§23) because completed tasks were invisible to
  the assistant, so it either gave up or bound a pending task's id.

### Two details worth keeping

**The pronoun resolved across turns.** Turn 2 said "that task" and turn 4 said
"it", with no task named, and the server acted on the right id both times — the
one created in turn 1, shown in the sheet as
`38d68a4a-897d-4ddb-aaab-e6f1e36e9014`.

**A sloppy utterance was handled correctly.** Turn 1 was *"renew the domain in
Thursday"* — not grammatical — and resolved to Thursday 24 September, the right
day, without inventing anything or asking a question it did not need to ask.

### Method note

Last round I mistook the Home CTA's coordinates for the Converse mic and twice
reported "a second turn produced no tool call". The mic control on Converse is at
the bottom-right of the composer; used properly, every turn here started and
completed. The earlier observation was my error and remains withdrawn.

---

## 29. Addendum — failure handling (§23) (2026-09-23)

Four failure cases exercised against the real assistant and, where it applies,
the handset.

| Case | Result |
|---|---|
| **Duplicate command** — the same reminder asked twice in one conversation | **One** row, and NOVA said so: *"You already have a reminder to call the bank tomorrow at five o'clock in the evening."* No duplicate, and no silent skip either. |
| **Conflicting reminders** — two different titles at the *same instant* | Both kept (`11:30Z` = 17:00 IST), and the second turn noticed the first already existed rather than duplicating it. |
| **Nonsense input** — *"asdfgh qwerty zxcvbnm"* | *"That looks like keyboard mashing. Is everything okay…"* — graceful, no row created, no crash. |
| **Network failure** — API stopped, device pointed at a dead port | **Was silent; now fixed.** See below. |

### The network failure, and the fix

With nothing listening, the app sat on **"Thinking…" for over forty seconds**:
an empty reply bubble, nothing in `logcat`, and no explanation. A slow answer and
a dead server were indistinguishable to the user.

The cause was a partial deadline. `_ensureConnected` bounded only its wait for a
status event:

```dart
await _service.connect();                     // not bounded
return await completer.future.timeout(10s);   // bounded
```

A `connect()` that never returned hung the whole method, so the timeout was never
reached and the `offline` failure the controller already had a message for was
never raised. One shared `_connectDeadline` now covers both.

Re-verified against the same dead port: the app reports it at once — status
**ERROR**, banner *"The voice connection dropped. Reconnecting…"*, the avatar on
"Something went wrong", and a composer that still works.

### A note on my own method, again

My first attempt at this test was invalid: I killed the API on `:3099` but the
`adb reverse` rule had not taken effect, so the phone was still reaching the
user's API on `:3001` and answered normally. I only noticed because the reply was
grounded and contextual — impossible from a dead server. The test was redone
against a port with nothing listening, and `adb reverse --list` was checked
afterwards.

### Still untested in §23

Microphone denied, notification denied, expired OTP, app killed mid-turn, and
language-switch mid-conversation.

---

## 30. Addendum — measured latency (§24) (2026-09-23)

Measured rather than estimated, from the running system: the API logs a
`Realtime turn timings` line per spoken turn, and the device reports its own cold
start.

### Cold launch

```
adb shell am start -W -n com.leadup.nova/.MainActivity
TotalTime: 1781     WaitTime: 1791
```

**1.78 s** from tap to first frame, on a debug (JIT) build — a release build would
be faster, so this is an upper bound rather than a production figure.

### Per-turn, server side

| Turn | context build | model | first token |
|---|---|---|---|
| "What is on my schedule today?" | 15 ms | 3864 ms | 2112 ms |
| "How many reminders do I have right now?" | 11 ms | 2778 ms | 2302 ms |
| **mean** | **13 ms** | **3321 ms** | **2207 ms** |

Two conclusions worth acting on, and one that clears a suspicion:

- **The model call is the bottleneck**: ~3.3 s, against ~2.2 s to the first token.
  The user waits a little over two seconds before anything appears on screen.
- **The context layer is not a bottleneck.** It reads tasks, reminders and
  memories and formats them in **13 ms** — the three parallel reads in
  `user-context.ts` cost nothing next to the model.
- STT and TTS durations are **not** in these timings; the log stops at the model.
  Measuring them would need the realtime session to report its own stages.

### End to end, on the handset

The acoustic recording from §21 gives the user-facing figure for one spoken
exchange: the question finished at ~14 s into the recording and NOVA's reply began
at ~18.5 s — **about 4.5 s** from the end of speech to the start of the reply.
That is the same run whose audio was measured for the return path, so both
numbers come from one recording rather than two.

### Still unmeasured

TTS time to first audio, STT time after speech ends, reminder trigger latency, and
background wake-up — all named in §24 and none of them measured here.

---

## 31. Addendum — a reminder with the screen locked (§14) (2026-09-23)

§14 lists *screen locked* among the reminder cases and it had never been tested.
It is a real user scenario — a reminder that only works when the phone is awake is
not a reminder.

### What was done

A reminder titled "Locked screen check" was set for **02:51:21 IST**, two minutes
out. The app was backgrounded and resumed twice so its reconciler would arm the
alarm, then the screen was turned **off and locked** (`input keyevent 26`,
confirmed `mScreenOn=false`). Nothing else touched the phone.

### Result

| Check | Evidence |
|---|---|
| Fired while locked and screen-off | `dumpsys notification`: `id=185948139 … channel=nova_reminders_v2`, `importance=4`, with the screen still off |
| Visible to the user | the lock screen shows **"NOVA · now · NOVA reminder · Locked screen check"** |
| In the alerting group | it sits above the silent System UI rows, consistent with the sounding channel from §16 |

The whole chain therefore works on a locked device: the server row, the app's
reconciler arming the alarm, the alarm firing with the screen off, and the
notification landing on the lock screen in the channel that makes a sound.

This also re-verifies the reminder path end to end after every change since it was
last exercised — the sounding channel, the `update_task`/context work, the
black-screen fix and the connect-deadline fix all shipped in between.

---

## 32. Addendum — a reminder with the app killed (§17) (2026-09-23)

§17 lists *app killed* among the background cases. It is the ordinary state of an
Android app under memory pressure, so a reminder that needs the process alive is
not a reminder.

### What was done

A reminder titled "Killed app check" was set for **02:57:06 IST**. The app was
backgrounded and resumed twice so its reconciler would arm the alarm, then the
process was killed **without** the stopped state that `force-stop` creates:

```
02:54:36  adb shell am kill com.leadup.nova
          pidof com.leadup.nova -> (nothing)
```

`dumpsys alarm` still showed 12 `ScheduledNotificationReceiver` entries — the
alarm belongs to `AlarmManager`, not to the process.

### Result

| Check | Evidence |
|---|---|
| Fired with no app process | notification `id=570763834`, `channel=nova_reminders_v2`, `importance=4`, text **"Killed app check"** |
| The OS restarted the app to deliver it | `pidof` now returns **16750**, where it returned nothing before the fire time |

So the alarm survives process death and Android brings the app back to deliver it,
into the channel that makes a sound.

### Worth stating plainly

This is deliberately **not** the `force-stop` case. `adb shell am force-stop`
(and the user "Force stop" in Settings) puts an app into a stopped state and
**cancels its alarms** — a platform rule, not a NOVA defect. Someone who force-stops
NOVA will not get reminders until they open it again, and no correct implementation
can avoid that. The case tested here is the realistic one: the system reclaiming
the process.

---

## 33. Addendum — a reminder across a device restart (§14/§17) (2026-09-23)

§14 lists *device restart*. Android clears `AlarmManager` alarms on reboot, so the
question is whether anything re-arms them.

### What was done

A reminder titled "Reboot survival check" was set for **03:10:04 IST**. The app was
backgrounded and resumed twice to arm it, `dumpsys alarm` showed **18** entries
referencing the app, and the phone was rebooted at **03:03:34**.

### What was measured

| Time | Observation |
|---|---|
| 03:04:29 | boot complete; `dumpsys alarm` counts **0** for the app, no process |
| 03:11:31 | counts **18** again — the alarms are back; no notification yet, 87 s past the target |
| 03:14:58 | notification present, text **"Reboot survival check"** |

### Conclusion

**The reminder survives a restart.** `ScheduledNotificationBootReceiver` — the
flutter_local_notifications receiver, correctly declared in the manifest with
`BOOT_COMPLETED` and `MY_PACKAGE_REPLACED` — re-registers the pending schedule,
because the app arms reminders through the plugin's `zonedSchedule` rather than
its own alarms.

**Delivery can be several minutes late.** Due at 03:10:04, still absent at
03:11:31, present by 03:14:58 — so it landed somewhere in the 87 s–294 s window
after the target. That is the inexact-alarm behaviour already recorded in §13
(`windowLength` ≈ 84 s); after a reboot the system is busy and the batching is
worse.

### A correction to my own reading

My first post-boot reading was **0 alarms**, and the conclusion I was heading for
was "reminders do not survive a reboot". That was wrong. The boot receiver simply
had not re-registered yet 55 seconds after `sys.boot_completed` — the alarms came
back later. The measurement was right; the inference from a single early sample
was not. The fire time is what settled it.

### Still open in this area

Network interruption at the moment a reminder is due.

---

## 34. Addendum — microphone denied (§23) (2026-09-23)

### How the permission was changed

Not by the app — by the user's own Settings screen. This is worth recording
because the two obvious routes **do not work on this handset**:

```
adb shell pm revoke com.leadup.nova android.permission.RECORD_AUDIO
  -> Exception occurred while executing 'revoke'
adb shell appops set com.leadup.nova RECORD_AUDIO deny
  -> Exception occurred while executing 'set'
adb shell cmd appops set com.leadup.nova RECORD_AUDIO deny
  -> Exception occurred while executing 'set'
```

ColorOS refuses all three to `shell`. The permission was changed through
**Settings → Apps → NOVA → Permissions → Microphone → "Don't allow"**, and
confirmed from `dumpsys package` after each tap — the first attempt missed the
radio button and `granted` was still `true`, so the "test" would have proved
nothing.

### What happened

| Step | Observed |
|---|---|
| Mic revoked, mic tapped | Android's own dialog: **"Allow NOVA to record audio?"** — *While using the app / Only this time / Don't allow*. The app asks properly on first use. |
| **"Don't allow"** chosen | `RECORD_AUDIO: granted=false, flags=[… USER_FIXED …]` — permanently denied |
| On screen | a red banner: **"Microphone access is blocked. Turn it on for NOVA in Settings."**, with a dismiss |
| State | back to **READY** — not stuck in *Listening* or *Connecting*, no crash, composer and mic still usable |
| Granted again | **one tap, no restart**: the next mic tap showed **LISTENING** with the level meter and the banner gone |

### Why this passes

The failure is **named and actionable** ("blocked… turn it on in Settings"), the
app **does not pretend to listen** — the level meter stops and the state leaves
`listening` — and it recovers as soon as the permission returns. The banner also
appears for the *blocked* case rather than the recoverable one, which is the
distinction that matters: Android will not show its own dialog again once a
permission is `USER_FIXED`, so pointing at Settings is the only useful thing to
say.

### The device is left as found

The microphone is granted again and verified working, so later rounds are not
testing around a revoked permission.

### Also confirmed while in Settings

The App info screen reports **"Alarms & reminders — Denied"**, which is the system
UI's own statement of the finding in §32 from `dumpsys`. Two independent sources,
same conclusion.

---

## 35. Addendum — responding to a reminder that already fired (§15) (2026-09-23)

§15 is specific: a push is not a reminder unless the user can answer it. Three
answers were tested against a reminder created with a `triggerAt` **five minutes
in the past**, so it had already fired.

| User said | What happened | Verdict |
|---|---|---|
| *"I just took the medicine, but remind me again in 30 minutes"* | triggerAt moved **03:19 → 03:54** — thirty minutes from the request — and it persisted | **action PASS** |
| *"What time is the medicine reminder set for now?"* | *"three fifty-four in the morning"* — matches the record exactly | **PASS** |
| *"Actually cancel that medicine reminder"* | *"Done. I've cancelled the medicine reminder."* and `dismissed = true` on the row | **PASS** |

So a fired reminder can be rescheduled and cancelled after the fact, the state
persists, and reading the time back is accurate.

### But the confirmation named the wrong time

The reschedule reply was:

> *"Done. I'll remind you again at **twenty to four** in the morning."*

**Twenty to four is 03:40. The reminder was stored for 03:54.** The action was
correct — 03:54 is exactly thirty minutes after the 03:24 request — so the
*confirmation* is what is wrong, by fourteen minutes.

This matters more than a stray word: for a time-based commitment the sentence the
user hears is the whole product. "Remind me again in 30 minutes" answered with a
time fourteen minutes off is the app disagreeing with itself about the one fact
that matters. It is also the *opposite* of the read-back case above, where the
same assistant stated 03:54 correctly — so the model can read the true value and
still mis-state it when confirming.

### Recommended fix

The time is computed twice: once in the tool (correctly, in code) and once in the
model's prose (incorrectly). The confirmation should quote the value the tool
returned — or state that the reminder moved without naming a clock time — rather
than let the model re-derive it. Not attempted here; it is a prompt/response
change whose effect needs its own verification.

### Also noted

The read-back reply opened with *"You're right — I apologize. I didn't call any
tool."* in response to a plain question, which reads as a wobble even though the
information that followed was correct. Noted as a coherence defect, not chased.

---

## 36. Addendum — notifications denied (§23) (2026-09-23)

Changed the way the microphone case had to be changed: through **Settings → Apps →
NOVA → Permissions → Notifications**, because `pm revoke` and both `appops set`
forms are refused to `shell` on this handset (§34). Confirmed from `dumpsys package`
after the tap: `POST_NOTIFICATIONS: granted=false`.

### What happened

| Step | Observed |
|---|---|
| Toggled off, app launched | the app asks at once: **"Allow NOVA to send you notifications?"** — *Allow / Don't allow* |
| **"Don't allow"** | `granted=false, flags=[… USER_FIXED …]` |
| Home, after the reconcile pass | a warning card appears under **Status**: **"Reminders cannot reach you"** — *"Android is blocking NOVA's notifications, so a reminder is armed but never shown. Nothing is lost — …"* |
| Notifications granted again | the card is gone; Status shows only Wake word and Connected |

So the failure is **named and its consequence stated**, in the one place a user
would look, and the app does not silently keep arming reminders that can never be
seen. `r33_status3.png` is the capture.

### Two things I could not settle, and will not claim

**Whether that card persists while notifications stay denied.** One later capture
of the *same* denied session showed Status with only Wake word and Connected —
no card. I tried to re-check by relaunching and sampling twice, but **the swipes
did not scroll** (both captures came back at the top of Home), so those samples
prove nothing and the question is open. Either the card is transient, or the first
capture caught a reconcile that later reversed; I do not know which.

**Whether the card appears immediately after denying at the in-app prompt.** It
was not present in the capture taken right after denial (`r33_denied.png`) and was
present one reconcile later. That is consistent with a delay rather than a bug,
but one sample either way is not enough to say.

Both are recorded as open rather than guessed at.

### Corroboration of §16, from the system UI

The NOVA notification page lists **Categories → Reminders: "Notification drawer,
Banner, Lock screen, Ringtone, Vibrate"** — the system's own view of the channel
the §16 work created. A second, independent source for the sounding-channel fix.

### The device is left as found

Notifications are granted again and verified, and Home shows no warning card.

---

## 37. Addendum — resolving the notification-card question, and a regression I caused (2026-09-23)

### The open question, answered from the code path

§36 left it open whether the **"Reminders cannot reach you"** card persists while
notifications stay denied. Reading what drives it settles the *design*:

```dart
// reminder_reconciler.dart
final osBlocked = !await notifications.osPermissionGranted();
...
return ReminderReconciliation(..., notificationsBlocked: osBlocked, ...);
```

`osBlocked` is read **live from the OS on every reconcile** and passed into *every*
return path, and Home renders the card whenever the last result has
`notificationsBlocked == true`. So while the permission is denied the condition
stays true — the card is not transient by design.

That also explains both captures in §36 without needing a third: the card was
absent in `r33_denied.png` because no reconcile had run yet since the denial, and
absent in the later capture because **that screenshot was at the top of Home and
did not show the Status section at all**. The one capture that did show Status
(`r33_status3.png`) had the card.

**Stated as reasoning from the code plus one valid observation — not as a device
result.** The two-sample confirmation was attempted twice and both times the
notification toggle did not actually change state (`dumpsys` still reported
`granted=true`), so those samples prove nothing.

### A regression I caused, and fixed

While restoring the notification permission in §33, a tap intended for **Allow
notifications** landed on **Ringtone** instead — the two switches are on the same
screen, one above the other. That silently turned the reminder channel's sound
**off**, which is precisely the §16 defect: reminders arriving with no sound.

Caught here because the NOVA notification page now read **Ringtone: off** and the
Reminders category listed only *"Notification drawer, Banner, Lock screen,
Vibrate"*. Toggled back, and it reads **Ringtone: on** with the category listing
*"…Lock screen, Ringtone, Vibrate"* again.

The lesson is recorded rather than hidden: a settings screen with two adjacent
switches is not safe to drive by fixed coordinates, and a "restore" step needs
its own verification — which is how this was caught.

### Device state, verified at the end of this round

| Permission | State |
|---|---|
| `POST_NOTIFICATIONS` | `granted=true` |
| `RECORD_AUDIO` | `granted=true` |
| `SCHEDULE_EXACT_ALARM` | `granted=false` — as documented in §32 and row 4f |

The reminder channel is sounding again, and Home carries no warning card.

---

## 38. Addendum — the reschedule confirmation (row 31) (2026-09-23)

### Where the wrong time came from

§35 measured a reschedule confirmed as *"twenty to four"* (03:40) against a row
written for **03:54**. The tool had already returned the right answer, twice over:

```
summary: Reminder "Take the medicine" snoozed: it will now go off
         3:54 am (Asia/Kolkata), 30 minutes from now.
data:    trigger_at_local: "3:54 am"
```

and the prompt merely said *"repeat the resolved date and time when there is one"*
— which permits re-deriving it. The model converted a digital time into a
colloquial phrase and got the arithmetic wrong.

The instruction now says to **copy the time from the tool result exactly** and not
to convert, round or recompute it.

### What the change is supported by

| | Stored | Stated | Match |
|---|---|---|---|
| before | 03:54 | 03:40 (*"twenty to four"*) | **no** |
| after, run 1 | 04:04 | 04:04 (*"four oh four"*) | yes |
| after, run 2 | 04:04 | 04:04 (*"four oh four"*) | yes |

Both post-change runs also **moved the row**, so the action and the sentence
agreed in each.

### What that evidence is not

**2 of 2 is supporting evidence, not proof.** I did not run a controlled
before/after under matched conditions, and prompt behaviour is stochastic; two runs
of a failure that appeared once cannot establish a rate. The honest statement is
that the instruction now asks for the behaviour we want, and the two runs since
agree with it.

### Two measurements I threw away

- One harness sent *"remind me again in 30 minutes"* with no antecedent, and the
  assistant **correctly asked which reminder to snooze** instead of acting. That
  was my bug, not a product failure — and the reply was the right one.
- One run's parser could not read spoken digits (*"four oh three"*), reporting a
  mismatch that was actually a match.

Neither is counted in the table above.

---

## 39. Addendum — the app killed mid-turn (§23) (2026-09-23)

A write is proposed by voice and executed by the server, so killing the app between
the two is the case that decides whether the data survives intact. Driving it needed
no Settings screen — only the mic button — after two rounds of settings mis-taps.

### What was done

A task was dictated (*"create a task called midflight check to call the vendor
tomorrow"*), the approval sheet appeared with **"mid-fly check to call the vendor",
due 2026-09-24**, and then:

| Step | Action |
|---|---|
| 1 | **Approve and run** tapped |
| 2 | one second later, Home pressed to background the app |
| 3 | `adb shell am kill com.leadup.nova` — the process is gone (`pidof` empty) |
| 4 | twelve seconds for the server to finish the turn it was mid-way through |

### Result

| Check | Evidence |
|---|---|
| The action still completed | the row exists: **"mid-fly check to call the vendor"**, `status=pending` |
| The time is the one the sheet promised | `dueAt 2026-09-23T18:30:00Z` = **Thu 24 Sep 00:00 IST**, the sheet's `2026-09-24` |
| **Exactly one row — no duplicate** | `midflight rows AFTER: 1`, against `0` before |
| The app recovers | relaunched to **READY**, composer usable, "Start a conversation" |
| No crash, no ANR | no `FATAL`/`ANR` line for the package — the only matches were Crashlytics *initialising*, which my grep caught on the word |

Killing the client mid-turn therefore loses nothing and duplicates nothing: the
approval had already reached the server, the write happened once, and the app came
back clean. That is the behaviour a user would want and the opposite of the
half-applied state this test exists to catch.

### One transcription note

The dictation said "midflight" and the sheet read **"mid-fly"** — Deepgram heard it
that way. It changed nothing here (the title is echoed back to the user before the
write, which is exactly what the approval sheet is for), but it is a reminder that
the sheet is the last point at which a misheard word can be caught.

---

## 40. Addendum — a reminder due while the phone is offline (§14) (2026-09-23)

§14 lists *network interruption*. The question is whether a reminder needs
connectivity at the moment it is due — if it does, a reminder set before a flight
or in a basement is worthless.

### What was done

A reminder titled **"Offline fire check"** was set for **03:40:55 IST** and the app
was backgrounded and resumed twice so the reconciler armed it (`dumpsys alarm`
showed **30** entries for the package). Then connectivity was removed and confirmed
gone **before** the fire time:

```
adb shell cmd connectivity airplane-mode enable
settings get global airplane_mode_on  ->  1
ping -c 2 8.8.8.8                     ->  connect: Network is unreachable
```

### Result

| Time | Observation |
|---|---|
| 03:40:55 | the target time |
| 03:41:51 | no notification — **56 s late** |
| **03:43:55** | notification present, text **"Offline fire check"**, with the network unreachable the whole time |

**The reminder fires with no network at all.** That is the correct architecture —
the alarm belongs to `AlarmManager` and the notification is scheduled on the
device, so nothing about delivery depends on the API being reachable. This is the
behaviour §15's "a push alone is not a reminder" implies: the platform mechanism
carries it.

### The delay, and why I waited before writing this down

Delivery landed somewhere in the **56–180 s** window after the target. That is
wider than the ~84 s `windowLength` measured online in §13, which is plausible —
airplane mode is a strong hint to Doze that nothing needs waking for — but it is
one sample and I am not claiming a rate.

I nearly recorded this as a failure: at 03:41:51 the notification count was **0**.
The ~84 s window made 56 s late inconclusive rather than negative, so I waited, and
it arrived. That is the same mistake §33 documents in the other direction — reading
a single early sample as a conclusion. This time the wait was the difference
between a false FAIL and the correct answer.

### The device is left as found

Airplane mode is off, Wi-Fi is on, and connectivity is confirmed (2/2 ping, 0%
packet loss) — the first check after disabling airplane mode still showed *"Network
is unreachable"* because the route had not come up yet, which is why it was checked
again rather than assumed.

---

## 41. Addendum — the exact-alarm grant, and a correction to my own evidence (2026-09-23)

Row 4f says reminders are inexact until the user grants *Alarms & reminders*, and
that the app offers the grant. This round tried to prove the grant improves
punctuality. It did not get there, and along the way it invalidated evidence I had
already recorded.

### What was verified

**The app's prompt opens the right screen.** Tapping **Continue** on the Reminders
notice opened the system's own **"Alarms & reminders"** page — not a general
settings list — and that page states the stakes itself: *"If this permission is off,
existing alarms and time-based events scheduled by this app won't work."* So the
disclosure, the button and the destination all line up, and the wording matches the
measurement in §33.

### A correction to my earlier evidence

After switching the toggle on, two probes disagreed:

```
dumpsys package com.leadup.nova | grep SCHEDULE_EXACT_ALARM
  -> android.permission.SCHEDULE_EXACT_ALARM: granted=false

adb shell appops query-op SCHEDULE_EXACT_ALARM allow
  -> SCHEDULE_EXACT_ALARM: allow        (the package is listed)
```

**`dumpsys package … granted=false` is not a valid probe for this permission.** It
is an app-op-backed special permission, not a granted runtime permission, so it
reads `false` whether or not the user has allowed it. §32 and row 4f cite that
`granted=false` reading as evidence the access was not held — **that citation is
wrong**, and the grant may have been irrelevant to it. The app-op is the
authoritative check, and the app itself consults `scheduleExactAlarm.status`.

The screen's toggle was on and the app-op listed the package, so the grant appears
to have taken; the earlier `appops get` showing *"No operations. Default mode:
default"* was taken before, and is consistent with an op that had not been
explicitly set.

### What was not shown

**That the grant makes reminders punctual.** A reminder was set for 03:49:55 IST
and had not fired by 03:50:30, and only **1** alarm was registered for the package
where earlier runs showed 30 — so the arming itself is in doubt and the run cannot
distinguish "still inexact" from "never armed". Recorded as inconclusive rather
than as either result.

### A false lead, disproved

The app's notifications read **"Sign in required"** (several) and **"Configuration
message"**, which looked like a session that had expired — a serious finding, since
re-authentication needs Firebase OTP, which is blocked. It was wrong: after a clean
start the route trace reads `uri=/` and `PUSH home`, so the session is valid. Those
notifications are almost certainly stale, posted while the API was unreachable
during the offline and dead-port tests. Nothing was signed out, and nothing was
lost by checking before writing it down.

---

## 42. Addendum — granting exact alarms does not make reminders exact (2026-09-23)

Row 36 left the punctuality question "inconclusive". This round got a clean
measurement, and the answer is worse than inconclusive.

### The measurement

With the user's **Alarms & reminders** toggle ON (granted through the app's own
Continue button in §41, uid 10294 shown as `u0a294:allow` in `dumpsys alarm`), 30
alarms were armed from a fresh launch. Every NOVA alarm is **windowed**:

```
RTC_WAKEUP #5:  uid 10294 whenElapsed 3601120 windowLength 95769  ...
RTC_WAKEUP #7:  uid 10294 whenElapsed 3614120 windowLength 105530 ...
RTC_WAKEUP #15: uid 10294 whenElapsed 3651120 windowLength 133308 ...
                                          ... up to 1120342 ms
```

And the rendering is not ambiguous: **dumpsys prints `windowLength 0` for exact
alarms, and there are 32 of them on this device** from other apps. NOVA has none.

So after the grant, reminders are still scheduled with windows of **22 s to 19
minutes**. One fired **24 s late** in this run.

### Why

`reminder_reconciler.dart` computes `exact` from
`notifications.ensureExactAlarmPermission()` and passes it into `zonedSchedule`,
which selects `exactAllowWhileIdle` or `inexactAllowWhileIdle`. That probe reads
`permission_handler`'s view of the app-op — and on this device it returns
not-granted while Android itself says the app may schedule exact alarms. The mode
chosen is therefore always the windowed one, and **the grant changes nothing**,
while the Reminders screen tells the user that granting it will make reminders fire
"at the exact time you set".

### The fix I tried, and reverted

Attempting `exactAllowWhileIdle` first and falling back to the windowed mode only
on the plugin's own `exact_alarms_not_permitted` refusal — making the probe
advisory rather than authoritative. The plugin's gate is
`alarmManager.canScheduleExactAlarms()`, the same call Android uses, so a merely
pessimistic probe should no longer cost the user precision.

**Reverted, because it could not be shown to work.** After the rebuild the alarms
were still windowed, and the plugin logged no refusal — so I can neither confirm
the exact path was taken nor rule out that the reconciler simply did not re-arm
unchanged reminders. Leaving a change in the scheduling path that I cannot
demonstrate is a net risk, so the tree is back to what it was.

### The experiment that would settle it

Force a re-arm — change one reminder's time so the reconciler must reschedule it —
and read that alarm's `windowLength`. A `0` would confirm the fix; anything else
would mean the exact path is not being reached at all. That is one round's work and
is written down rather than guessed at.

### What is solid, regardless

The grant does **not** currently produce exact alarms. This is not an inference
from code: it is 30 armed alarms with non-zero windows, against 32 exact alarms
belonging to other apps on the same device.

---

## 43. Addendum — the exact-alarm experiment, run properly (2026-09-23)

§42 named the experiment that would settle whether the try-exact fix works: force a
re-arm and read *that* alarm's window. Done, and the answer is no.

### The method that made it decisive

`dumpsys alarm` prints each alarm's `origWhen` as epoch milliseconds. That means a
specific reminder can be matched to its own alarm instead of reading the whole list:

```
set a reminder at a distinctive instant  ->  origWhen 1790119221000
dumpsys alarm | grep "origWhen 1790119221000"  ->  windowLength ...
```

This removes the ambiguity that made §41 and §42 inconclusive — whether the
reconciler had re-armed anything at all. Each probe used a *newly created* reminder,
so its alarm can only have been armed by the build under test.

### The two measurements

| Build | Reminder | Alarm window |
|---|---|---|
| **unpatched** (probe-gated mode) | new, `origWhen 1790119221000` | **`windowLength 2109634`** (~35 min) |
| **patched** (attempt exact, fall back on refusal) | new, `origWhen 1790119685000` | **`windowLength 2379570`** (~40 min) |

**The fix changes nothing.** And no refusal was logged either — so the platform did
not reject the exact request. The plugin was asked for `exactAllowWhileIdle` and the
alarm still came out windowed.

### What this establishes

1. A freshly armed reminder on current code is **definitely inexact** —
   `windowLength 2109634` is 35 minutes of slop on a reminder whose whole purpose is
   a specific time. This is no longer inference from code; it is one alarm matched
   to one reminder by its own epoch.
2. **The permission probe is not the cause**, or at least not the only one.
   Bypassing it entirely — asking for the exact mode unconditionally — produced the
   same windowed alarm and no refusal. Whatever selects the windowed path happens
   below the Dart-side mode selection.
3. The Reminders screen's promise — *"To fire them at the exact time you set, NOVA
   needs Android's special 'Alarms & reminders' access"* — is **not deliverable as
   written** on this device and plugin version. The user can grant exactly what it
   asks for and still get a 35-minute window.

### Reverted again, deliberately

The patch was reverted a second time. It was written to fix a false-negative probe,
and the experiment shows the probe is not what is at fault; keeping it would leave
scheduling code changed on a theory the evidence contradicts.

### Where the next attempt should look

Below the Dart layer: `flutter_local_notifications` 22.3.1 chooses between
`setAlarmClock` and `setAndAllowWhileIdle` from the mode integer it receives. The
question is whether the Dart enum being sent for `exactAllowWhileIdle` maps to the
value that Java branch expects — a mismatch there would explain both symptoms: no
exception, and a windowed alarm.

---

## 44. Addendum — reminders are exact now, and the mode was the reason (2026-09-23)

Rounds 38–40 narrowed a real defect without fixing it: reminders on this handset
were armed with windows of 22–40 minutes. This round found the cause and fixed it.

### The instrumented measurement

A temporary `debugPrint` of the mode the app actually sends settled the open
question in one run:

```
[ModeProbe] requesting exactAllowWhileIdle (probe said exact=true)
[ModeProbe] exact request returned without throwing
```

So: **the permission probe was telling the truth**, the app asked for the exact
mode, and the plugin accepted it without raising anything — and the alarm still
came out windowed (matched to its own reminder by `origWhen`, `windowLength
1839803`). Three earlier attempts had blamed the probe; the instrumentation
disproved that in one line.

### The fix

`AndroidScheduleMode.alarmClock`, measured the same way on the same device:

| Mode requested | Alarm window for a specific reminder |
|---|---|
| `exactAllowWhileIdle` | `windowLength 1839803` — ~31 minutes |
| **`alarmClock`** | **`windowLength 0`** — exact |

`setAlarmClock` is honoured where this OEM batches the `exact*` modes. It also
skips the permission check entirely — the plugin only runs
`canScheduleExactAlarms()` on the `exact*` modes — so the reminder is punctual
whether or not the user grants *Alarms & reminders*.

Applied to the one-shot path, the repeating path and the daily briefing. The
one-shot path keeps a windowed fallback, so a platform that refuses the
alarm-clock call still schedules something rather than nothing.

### Verified after the final build

| Check | Evidence |
|---|---|
| The specific reminder's alarm | `origWhen 1790119299000` → **`windowLength 0`** |
| Across the app | **11** NOVA alarms with `windowLength 0`, where before the fix there were **none** |

### Why this took four rounds, honestly

Three attempts were written, built, measured and reverted — two of them on the
hypothesis that `permission_handler`'s probe was lying. Each revert was correct at
the time (the evidence did not support the change), and the instrumentation is what
finally separated "the app asks for the wrong thing" from "the platform ignores
what the app asks for". The lesson worth keeping is in the method: matching an
alarm to its reminder by `origWhen` turned a vague list of windows into a
one-reminder-one-alarm measurement.

### Follow-up this creates

The Reminders screen still tells the user that exact delivery *requires* the
*Alarms & reminders* grant. With `alarmClock` it no longer does. That notice is now
asking for something the app does not need, and should be revisited.
