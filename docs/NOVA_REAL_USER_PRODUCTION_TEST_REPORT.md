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
