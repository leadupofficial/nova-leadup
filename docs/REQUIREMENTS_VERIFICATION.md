# NOVA — Requirements Verification

**Method:** every claim below was produced by running something against the live
system or by reading the exact source. Nothing here is inferred from a document.
Where a document and the code disagree, the code is reported and the document named.

Production: `https://nova.leadup.in` · API reachable, login works, and the published
APK downloads. Its admin health endpoint reports the database as down while that same
database answers logins — a reporting bug fixed in source but not yet redeployed; see
"Production, checked directly" below.

> **This document was first written when most of the product did not exist, and has
> been revised as work landed.** The status table below is current. Sections further
> down are marked with the date they were verified; where an earlier section says
> something is missing that now works, the table is right and the prose is history.
> The revision is recorded rather than silently rewritten because the earlier claims
> were the evidence that drove the work.
>
> **Revision 2026-09-19 (evening).** Everything the earlier revision listed under
> "What does not work" except semantic memory, weather/recap/traffic and
> cross-platform sync has since been implemented and re-verified. That prose is now
> collapsed into "Earlier findings, and where each one stands now" so the document
> stops contradicting its own table and its own conclusion.

---

## Status summary (current)

Gates, re-run 2026-09-19 with `--force` so nothing was served from the Turbo cache:
`pnpm run build` 27/27 · `pnpm run typecheck` 31/31 · `pnpm run test` 34/34
(`services/api` vitest 254 passing) · `pnpm run lint` 25/25 · `flutter analyze` clean ·
`flutter test` 579 passing, 5 skipped. The live API answered `verify-auth.py`
**24/24** against Postgres on `:5433`, and the real Dart auth client passed both of
its live contract tests against that API. Details in "Re-verified" below.

| # | Requirement (owner's brief) | Status |
|---|---|---|
| 1 | Automatic voice onboarding greeting | **Works** |
| 1 | Greeting in the native language | **Partial** — copy exists for en/ta/tanglish only; every other language falls back to English, and it is spoken by the *device* voice because onboarding runs before sign-in |
| 2 | Low-latency real-time voice | **Works** — 2.4–3.4 s measured (not reproducible from the repo; see the note below) |
| 2 | Hands-free, no button | **Works inside an open session** — one tap opens the session; the wake word now opens one too (below) |
| 2 | Barge-in | **Works** |
| 2 | Custom / configurable wake word | **Partial** — selection among installed classifiers works and the server validates it, but only `hey_jarvis` ships, so the choice is one option wide |
| 3 | Background notification monitoring | **Works while the Flutter engine is alive** — a real `NotificationListenerService`; when the engine is dead the event is dropped rather than buffered |
| 3 | Proactive spoken updates | **Works, opt-in** — spoken on arrival for high-priority notifications once the user has opted in *and* confirmed for the session. Until 2026-09-20 the only way to hear one was to open the inbox and tap it |
| 4 | Create/manage reminders by voice | **Partial** — `create_reminder` works by voice; update/list/delete exist only over REST and in the UI |
| 4 | Speak reminders when they trigger | **Partial** — speaks only while the app is alive |
| 5 | Cost efficiency measured | **Works** — instrumented; rates still unset |
| 5 | Low latency | **Works** |
| 6a | Device & system control | **Works on-device, not on the voice path** — the Android implementation is real, but the tool is not sent to the model, so the typed console is the only entry point; Wi-Fi/Bluetooth are deep-link only by platform policy |
| 6b | Meeting capture, transcription, summaries | **Partial** — start/pause/stop, async transcription, summaries and action items are real; **live transcription and speaker diarisation are both off** in the module's own capability flags |
| 6c | Call screening | **Delivered as the lawful version** — the user's own dialer recordings via SAF, not live screening |
| 6d | Daily briefing | **Works** — tasks/reminders/memories; `calendar: false`, so it cannot know about meetings |
| 6d | Evening recap, weather, traffic nudges | **Not built, not stubbed** — no provider exists and the master document does not define them |
| 6d | Cross-platform sync | **Still not real** — see below |
| 6a | Smart Home Integration (IoT lights, thermostats, locks) | **Not built** — the brief asks for it; the master document does not, and no vendor/Matter client exists anywhere in the tree. `docs/ROADMAP.md` records it as a separate integration surface, not an extension of device control |
| 5 | Subscription billing / payment gateway | **Not built; the entitlement layer is** — plans, quotas and per-turn usage are real and enforced server-side (`GET /api/v1/subscriptions` returns the tier matrix), but there is no gateway and no price list. Pricing was explicitly left to the owner |
| 6a–6c | Android-only native paths on real hardware | **Compile-verified, not device-verified** — the notification listener, device control and SAF call-recording import build into the shipped APK and are covered by JVM/Dart tests, but have not been exercised on a physical device (none has been attached) |
| — | Language catalogue | **23 entries** (`en` + 22 Indian languages) in `packages/shared-types/src/languages.ts`, not 22; seven route to a Google provider with no key configured |

### Nothing in the live product misreports success

An earlier revision of this document said `integration-service` reported connections
that never happened. **That was wrong, and I checked rather than assuming.** The
source was already changed to answer 501 in an earlier round; what I saw was a
comment describing the old behaviour. The deployed container does still hold the old
code — but the service is **not routed**: nginx sends `/` to the console, `/api/` to
the API, `/ws/realtime` and `/socket.io/` to the gateway, and there is no rule
pointing at the integration service's port at all. Nothing public can reach that
endpoint, so it cannot mislead anyone.

The honest position: the source is correct, the running container is stale, and the
whole service is unreachable. It should either be deployed and routed, or removed —
it is currently a container nobody can call. That is untidiness, not a live defect,
and the difference matters enough to state.

### Evening recap, weather and traffic nudges

**Not built, and deliberately not stubbed.** The owner's brief asks for all three.
None appears in the master document, and there is no weather provider, table or route
anywhere in this repository. Rather than return invented data, the briefing endpoint
reports capability flags (`weather: false`, `eveningRecap: false`,
`locationNudges: false`) and the settings screen shows a NOT CONNECTED list. A fake
weather line would be worse than an absent one.

### Wake word caveat

The wake word is **model-driven**: openWakeWord reads classifiers from
`android/app/src/main/assets/wakeword/models.json`. The user can select among
installed models, and the setting persists — `PATCH /api/v1/device/wake-word/config`
rejects a word the device has not reported as installed, so the server cannot record
a preference the device will not honour. Only one model ships — `hey_jarvis` — so
today the honest screen says so rather than offering a choice that does nothing.
Adding "Hey Nova" means adding a real ONNX classifier to that manifest; the comment
in the file documents how, and no fake model was shipped to make the screen look
fuller than it is.

---

## Re-verified 2026-09-20 (earlier run, before the store-policy round)

Every command below was run in this working tree. `--force` was passed to Turbo so
the numbers are executions, not cache replays.

```
pnpm run build --force        27 successful, 27 total
pnpm run typecheck --force    31 successful, 31 total
pnpm run test --force         35 successful, 35 total   (api 254, auth 27, @nova/admin 7, admin UI 7)
pnpm run lint --force         25 successful, 25 total
flutter analyze               No issues found!
flutter test                  587 passing, 5 skipped
flutter build apk --debug     ✓ Built app-debug.apk   (Android/Kotlin toolchain, 49.4s)
verify-auth.py                24/24 checks passed        (live API + Postgres :5433)
auth_live_test.dart           2 passed                   (real Dart client, live API)
endpoint smoke                27 GETs + 7 creates + 12 read-back/patch, 0 × 5xx
admin API authz               normal user → 403, owner → 501 (honest stub)
admin console error state     bogus cookie → error card on all six pages, no empty state
admin console session gate    bad/expired cookie → 307 /login + cleared cookie; owner → 200
offline route                 connectivity off → /offline, back → router gates
```

`services/admin` is part of the test gate for the first time (35 tasks, was 34),
`apps/admin` has tests for the first time (7), and the four unhandled rejections that
made `@nova/auth`'s suite fail while its 27 tests passed are gone (0 errors).

### Store submission round — 2026-09-20 (Google Play + App Store policy)

Two read-only audit subagents walked the mobile app against the current Play Developer
Program Policy and the App Store Review Guidelines and cited clause numbers. Their
findings were then fixed in this tree. Each claim below is a command that was run, not
a reading of the source.

**The iOS build had never worked.** Both `ios/Flutter/Debug.xcconfig` and
`Release.xcconfig` contained `#include: "Flutter/Generated.xcconfig"` — the colon is
not xcconfig syntax, so the directive never parsed and `FLUTTER_ROOT` was never
defined; the `Run Script` phase then expanded to
`/packages/flutter_tools/bin/xcode_backend.sh` and every archive failed. Corrected to
the stock template's `#include "Generated.xcconfig"` and verified:

> **Correction (adversarial re-check).** An earlier version of this note also called the
> *path* wrong, claiming it pointed at `ios/Flutter/Flutter/Generated.xcconfig`. That is
> false: Xcode falls back to `SRCROOT` for unresolved includes, so
> `#include "Flutter/Generated.xcconfig"` resolves correctly — proved by
> `xcodebuild -showBuildSettings` on a scratch copy, which printed `FLUTTER_ROOT` with
> the old path and printed nothing with `#include:` plus the new path. **The colon alone
> was the defect.** The same `SRCROOT` fallback is why the retained
> `#include? "Pods/Target Support Files/…"` line resolves at all (`OTHER_LDFLAGS`
> carries `-framework "flutter_tts"`, `GCC_PREPROCESSOR_DEFINITIONS` carries
> `COCOAPODS=1`). The new path is still the stock one, so nothing needs reverting.



```
xcodebuild -showBuildSettings | grep FLUTTER_ROOT
    FLUTTER_ROOT = /opt/homebrew/share/flutter      ← was absent before the fix
```

**Android — the shipped bundle contains only permissions the app uses.** The earlier
removal pass missed the permission Play actually keys the Data safety form off, because
it is not in the `android.permission.*` namespace. Verified against the **merged release
manifest and the AAB itself**, not the source manifest:

```
flutter build appbundle --release          exit 0 · ✓ Built app-release.aab (94.3 MB)
   (previously exited 1: Flutter's post-build apkanalyzer probe lacked +x)
merged release manifest        13 permissions, 0 flagged
AAB manifest scan              AD_ID 0 · BIND_GET_INSTALL_REFERRER_SERVICE 0 ·
                               ACCESS_ADSERVICES_AD_ID 0 · CAMERA 0 · READ_MEDIA_IMAGES 0 ·
                               USE_BIOMETRIC 0
android:allowBackup            "false"      (was unset ⇒ automatic Google Drive backup)
android:debuggable             absent
usesCleartextTraffic           absent
```

**Account deletion works end to end.** Both stores make this a publishing gate (App
Review 5.1.1(v); Play's account-deletion requirement needs an in-app path *and* a public
web resource). A throwaway account was created against the live local API and Postgres,
then deleted through the new route — including the case the schema makes hard, where the
user has an `audit_logs` row and a `leads`/`lead_follow_ups` row whose foreign keys have
no `ON DELETE` action and would abort the delete:

```
GET    /api/v1/account/deletion-preview     200  {email, recordings, consentRecords}
DELETE /api/v1/account (no password)        400  PASSWORD_REQUIRED
DELETE /api/v1/account (no confirm)         400  VALIDATION_ERROR "expected DELETE"
DELETE /api/v1/account (wrong password)     401  INVALID_PASSWORD
DELETE /api/v1/account (correct)            200  {deleted:true}   ← audit row detached, not orphaned
GET    /api/v1/auth/me with the same token  401  "Token has been revoked"
POST   /api/v1/auth/login (same creds)      401  INVALID_CREDENTIALS
POST   /api/v1/account/deletion-request     202  identical body for known and unknown email
POST   /api/v1/ai/reports                   201  {recorded:true}
```

The whole set is now a repeatable script rather than a one-off, so it can run as a
deploy gate — including the failure mode that is easy to miss, where the public URLs
answer 200 for a signed-out crawler and redirect a signed-in reviewer:

```
python3 services/api/scripts/verify-store-compliance.py \
    --console-url http://127.0.0.1:3100 --admin-token "$ADMIN_JWT"
    39/39 checks passed
```

**Public store URLs now exist** and are exempted from the console's session gate:
`/privacy` and `/delete-account`, both prerendered static by `next build`:

```
next build (apps/admin)   ○ /privacy  ○ /delete-account   (static, no auth)
public.serve()            both routes answer without a session cookie
```

**Policy surfaces added or corrected**, each mapped to the clause that required it:

| Change | Why |
| --- | --- |
| `DeleteAccountPage` + `DELETE /api/v1/account` | App Review 5.1.1(v); Play account-deletion requirement |
| `PrivacyPolicyPage` + `/privacy` + `/delete-account` pages | App Review 5.1.1(i); Play User Data (policy must be readable in-app *and* be a public URL) |
| `POST /api/v1/ai/reports` + a Report action on every NOVA reply | Play AI-Generated Content policy (in-app reporting); App Review 1.2 |
| `ai_processing` consent row naming Sarvam/Deepgram/ElevenLabs/Anthropic | App Review 5.1.2(i) — disclose third-party AI sharing and get explicit permission |
| Microphone consent copy now says audio leaves the device | Play prominent-disclosure requirement |
| Contacts & Calendar consent row deleted | Neither platform declares the permission; the row promised a capability that could not be granted |
| "Share health data / daily step goal" deleted from onboarding | No Health Connect, no `ACTIVITY_RECOGNITION`, no pedometer — the copy claimed data the app cannot read |
| Exact-alarm request is now user-initiated only, behind a disclosure card | Play restricted-permission policy forbids opening the system screen unprompted |
| `BootReceiver` guard `API>=35` → `API>=34` | Android 14 already forbids background microphone FGS creation |
| Device-control page gated on `status.supported` | App Review 2.3.1(a) — the iOS build rendered an Android-only console |
| "Enterprise SSO available" line removed | App Review 2.3.1(a) — no SSO exists |
| `aps-environment` entitlement removed | Dead: no `firebase_messaging`, no registration. It forced the Push capability onto the App ID |
| `PrivacyInfo.xcprivacy` + Name and EmailAddress | They are collected at registration and were missing from the manifest |
| False "Firebase config is a placeholder" comments corrected | `google-services.json` is real (project `nova-leadup-stagging`), so Crashlytics and Analytics are **live on Android**; iOS is still inert |
| `ios/Podfile` platform pinned to 15.0; Fastfile ipa path fixed | Tooling: the path resolved one directory short on every upload |
| `PRODUCTION_CHECKLIST.md` rewritten | It described an Expo/EAS app and target API 34 |

```
flutter analyze               No issues found!
flutter test                  606 passing, 5 skipped   (was 587; +19 store-policy/routing)
flutter build ios --no-codesign --release
                              ✓ Built build/ios/iphoneos/Runner.app (28.9 MB)   ← first ever
                              PrivacyInfo.xcprivacy present in the bundle, 8 collected types
pnpm run build                27 successful, 27 total
pnpm run typecheck            31 successful, 31 total
pnpm run test                 35 successful, 35 total
pnpm run lint                 25 successful, 25 total (0 errors)
```

**Both app icons were placeholders.** The iOS marketing icon was byte-identical to
Flutter's template default (md5 `c785f893…`), and the Android launcher was a flat blue
square with a nearly invisible dot; `mipmap-anydpi-v26/ic_launcher_round.xml` drew a
plain white circle. A placeholder icon is an outright App Store rejection and a Play
listing-quality failure, so both sets were regenerated from the app's own design tokens
(`primary #5778DF` → `accent #3BCFCF`, the voice-waveform motif the app already uses):

```
ios/Runner/Assets.xcassets/AppIcon.appiconset   15 files, all sizes from Contents.json,
                                                every one hasAlpha=no (alpha in the 1024
                                                marketing icon is a rejection)
android/.../mipmap-*/ic_launcher.png            48/72/96/144/192
android/.../mipmap-*/ic_launcher_round.png      same sizes
android/.../mipmap-*/ic_launcher_foreground.png 108/162/216/324/432 (66% safe zone)
android/.../mipmap-anydpi-v26/ic_launcher{,_round}.xml
                                                both now <adaptive-icon> with a
                                                gradient background drawable
```

These are token-derived, not a delivered brand asset: if Leadup has an official NOVA
mark, replace the masters and regenerate. `splashscreen_logo.png` is referenced by
nothing (the launch screen is `@color/launch_background` alone) and was replaced too,
so wiring a splash later picks up the real mark.

### Second adversarial pass — 2026-09-20

Two independent read-only audits were run against the tree after the store round: one
trying to falsify the claims above, one sweeping the console and the web app. Both
found real defects, which were then fixed. The falsification pass also **corrected one
claim** (see the xcconfig note) — the rest held, including the FK inventory (exactly
three `users` FKs lack an `ON DELETE` action: `audit_logs.user_id`,
`leads.assigned_to`, `lead_follow_ups.assigned_to`, plus `tasks.assignee_id` which the
database handles itself) and all 15 iOS icons (none byte-identical to the SDK template,
`hasAlpha=no` on every one).

Fixed from those two passes:

| Defect | Severity | What changed |
| --- | --- | --- |
| `apps/web` "Delete Account" linked to `/delete-account`, a route that app does not serve → **404** | blocker (a regression introduced by the store round) | Absolute URL, env-overridable (`NEXT_PUBLIC_ACCOUNT_DELETION_URL`), defaulting to the console's public origin |
| Notification Assistant rendered the whole Android-only console on iOS | App Review 2.3.1(a) | Gated on `state.isSupported`; the Profile row's subtitle says "Android only" off Android |
| Console middleware redirected any **signed-in** visitor away from `/privacy` and `/delete-account` to `/` | store policy | Only `/login` bounces now; a usable session is not cleared by visiting a public URL |
| `admin_token` cookie written for **one year, no `Secure`**, in two places that bypassed the shared helper | security | Every write now goes through the exported `writeTokens` (1 hour, `Secure` on https) |
| Guard refresh renewed localStorage but not the cookie, so a successful refresh bounced the operator to `/login` | real bug | Refresh calls `writeTokens`; also switched to `getPublicEnv()` so the base carries `/api/v1` |
| Console showed a page length as a total ("N total organizations", "Active Users", incident counts) | real bug | Uses `totalItems` and states truncation |
| `Math.round(tokens * 0.00002)` → every tenant under 50k tokens showed **$0.00** | real bug | Four-decimal cost, and the console formats sub-cent amounts instead of `toFixed(2)`-ing them back to zero |
| Languages table painted a green "Enabled" dot for every row unconditionally | fabricated data | Column renamed "Routing", derived from the provider mappings it can actually see |
| Dashboard was the only page that swallowed the health error (`catch { return null }`) | real bug | Uses `describeLoadError`, so a 401 is distinguishable from a connection refusal |
| "Push / Email / SMS notifications" switches with no backend behind any of them | false capability | Only the two channels that can deliver are offered; `push` relabelled "Device notifications" (delivery is a local scheduled notification, not FCM); the sheet says email/SMS are not available yet |
| Onboarding still persisted `healthDataAccess` and a `'health'` notification category | contradicted the policy and the Data safety form | Neither is written; the policy's "No health, fitness or step data" is now true of the stored state too |
| "Verify email" pill shown to **every** account with no verify endpoint | false capability | Removed; nothing gates on the flag |
| `'V2 · Beta'` pill in a production binary | App Review 2.2 | Names the release instead |
| `login_page.dart` header comment said the SSO notice "is kept" while the body said it was removed | doc defect | Comment corrected to match |

Two further items are **known and deliberately not done**: the Profile still offers the
"Notification assistant" row on iOS (it leads to the screen that now explains the
limit, matching how the wake-word and call-recording rows behave), and `email`/`sms`
preferences still round-trip through `/settings/preferences` for API compatibility —
they are simply no longer presented as working switches.

### On-device verification — 2026-09-20 (Android 16, API 36)

A headless Pixel 9 AVD (`google_apis`, API 36 — the app's own `targetSdk`) was booted,
the debug APK was installed with `--dart-define=API_URL=http://127.0.0.1:3001` over
`adb reverse`, and a real account was registered and signed in against the live local
API. This is the first time the store-critical surfaces have been seen on a device
rather than inferred from tests, and it found a bug every test had missed.

**Confirmed on device:**

| What | Result |
| --- | --- |
| App launches, signs in, renders Home with real account data | ✅ "Good morning / Alex", avatar, Tap to talk, bottom nav |
| Consent step — microphone disclosure | ✅ "Your audio is sent to our server to be transcribed and answered — it is not processed only on this device." |
| Consent step — no Contacts & Calendar row | ✅ |
| Consent step — AI processing row | ✅ Names Sarvam AI, Deepgram, ElevenLabs, Anthropic; renders **only** an Allow button, no dead "Not now" |
| Consent step — every row resolves | ✅ Continue enables only once all five are Allowed |
| Consent step — honest pre-auth failure | ✅ "Missing or invalid authorization header — saved on this device; it will sync once you sign in." |
| Onboarding preferences | ✅ Only Notifications and Voice commands — the fabricated step-goal slider and "Share health data" switch are gone |
| Login | ✅ No "Enterprise SSO" notice; OTP button disabled with "Phone sign-in is not available on this server." |
| Profile | ✅ No "Verify email" pill in the header |
| Profile → Account | ✅ "Privacy policy" and "Delete account" rows present |
| Delete account | ✅ Live server data ("your account for …", "0 recordings", "0 consent records", retention), typed-DELETE + password, button disabled until both |
| Privacy policy | ✅ Full policy renders in-app with the off-device audio disclosure |
| App icon and splash | ✅ The generated waveform mark appears in the launcher and on the splash screen |

**A real bug the tests did not catch.** Tapping "Delete account" rendered go_router's
*"No screen matches /delete-account"*. Both store routes are children of `/me`, and the
Profile rows pushed the bare absolute paths. The existing route-resolution test passed
because it asserts the *route* `/me/delete-account` resolves — it never tapped the row.
Fixed, and a new test now taps both Profile rows and fails on
`find.textContaining('No screen matches')`; it was verified to fail against the old
paths before the fix was restored.

**Also removed from onboarding:** the "Emergency contact" block (a third party's name,
phone and relationship). Nothing in the app ever read it back, the copy promised "NOVA
can reach them if you ask for help" with no such flow, and the privacy policy did not
mention it — a false capability claim plus an undisclosed collection of someone else's
personal data. Existing stored values are carried through untouched.

```
flutter analyze               No issues found!
flutter test                  607 passing, 5 skipped
```

The AVD and the API server used for this were both shut down afterwards.

### Release-artifact audit — 2026-09-20

The two artifacts that would actually be uploaded were inspected directly rather than
inferred from source.

**iOS — `build/ios/iphoneos/Runner.app`** (from `flutter build ios --no-codesign --release`)

```
CFBundleDisplayName            NOVA
CFBundleIdentifier             com.leadup.nova        CFBundleShortVersionString 1.0.0 / 1
MinimumOSVersion               15.0                   UIDeviceFamily [1, 2]
ITSAppUsesNonExemptEncryption  false
UIBackgroundModes              ["audio"]              (only)
NSMicrophoneUsageDescription   "NOVA listens only while you are talking to it, or while you
                                have started a recording. Audio is sent to NOVA's server to
                                be transcribed and answered."
PrivacyInfo.xcprivacy          present in the bundle root
```

Every privacy-sensitive key a reviewer looks for is **absent**, not merely unused:
`NSAppTransportSecurity`, `NSUserTrackingUsageDescription`, `NSContactsUsageDescription`,
`NSCalendarsUsageDescription`, `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`,
`NSPhotoLibraryAddUsageDescription`, `NSLocationWhenInUseUsageDescription`,
`NSBluetoothAlwaysUsageDescription`, `NSLocalNetworkUsageDescription`,
`NSSpeechRecognitionUsageDescription`, `NSHealthShareUsageDescription`,
`NSFaceIDUsageDescription`, `UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`.

**No App Tracking Transparency prompt is possible — but the reasoning needed
correcting.** An earlier version of this note said `AppTrackingTransparency.framework`
and `AdSupport.framework` are "neither linked **nor bundled**". The first half is right;
the second is wrong. `GoogleAppMeasurementIdentitySupport.framework` **is** bundled (it
comes in with GoogleAppMeasurement), and `strings Runner.app/Runner` finds
`ASIdentifierManager`, `advertisingIdentifier` and `ATTrackingManager`. A naive scan
therefore looks alarming.

The conclusion still holds, for a narrower reason: **no binary in the bundle links
`AdSupport`, `AppTrackingTransparency` or `AdServices`** — checked with `otool -L` across
`Runner` and every framework in `Frameworks/`, which returns zero hits. Google's
"identity support" framework resolves the IDFA at runtime through a *weak* AdSupport
lookup, so with AdSupport absent the lookup finds nothing, no IDFA is read and no ATT
prompt can be presented.

Removing the framework entirely would require switching the iOS dependency from the
`FirebaseAnalytics` SPM product to `FirebaseAnalyticsWithoutAdIdSupport`, which the
Flutter plugin hardcodes at
`~/.pub-cache/hosted/pub.dev/firebase_analytics-11.6.0/ios/firebase_analytics/Package.swift:101`.
The CocoaPods-side flag `FIREBASE_ANALYTICS_WITHOUT_ADID` has no effect on an SPM build,
and patching the pub-cache file would not survive `flutter pub get`. So this is not a
repository-side change; `NSPrivacyTracking=false` with an empty
`NSPrivacyTrackingDomains` remains correct, and the App Privacy answer is "Data Not Used
to Track You".

**Every Apple-listed third-party SDK in the app ships its privacy manifest.** Checked
against Apple's current
[Third-party SDK requirements](https://developer.apple.com/support/third-party-SDK-requirements/)
list. All 25 manifests in the bundle were enumerated; the listed SDKs actually present —
`Flutter`, `connectivity_plus`, `flutter_local_notifications`, `nanopb`,
`GoogleDataTransport`, `GoogleUtilities`, `FirebaseCore`, `FirebaseCoreExtension`,
`FirebaseCoreInternal`, `FirebaseCrashlytics`, `FirebaseInstallations`,
`Promises`/`FBLPromises` — each have one. The SDKs Apple lists that this build does *not*
contain (Alamofire, Charts, leveldb, OneSignal, …) are absent because they are not used.

> **A false alarm worth recording.** `FirebaseAnalytics.framework`,
> `GoogleAppMeasurement.framework` and `GoogleAdsOnDeviceConversion.framework` ship with
> **no** privacy manifest, which looks like an ITMS-91056 problem. It is not:
> **none of those three is on Apple's list**, which is why Google distributes them
> without one. Their collection is declared by the app's own `PrivacyInfo.xcprivacy`
> (DeviceID, CrashData, PerformanceData) and by the App Privacy questionnaire. Do not
> "fix" this by hand-adding a manifest.

**Android — `build/app/outputs/bundle/release/app-release.aab`**

```
signature      META-INF/NOVA.RSA + NOVA.SF
certificate    CN=NOVA, OU=Leadup Technologies, O=Leadup Technologies, C=IN
               valid 2026-09-17 → 2054-02-02, SHA256 B6:FE:10:0E:52:11:DD:08:1E:44:2C:A4:ED:DD:FC:D8:E1:FE:12:CD:13:FA:F1:C7:90:1D:24:EE:24:A1:D8:53
               i.e. the release upload key, NOT the Android debug key
```

That is the key Play App Signing expects for the first upload. **It is not in the
repository and must be backed up**: losing it costs an upload-key reset through Play
support. `keystore.properties` and the `.jks` are correctly git-ignored, and `git log
--all` shows no signing secret was ever committed.

### Policy-copy drift, caught and guarded — 2026-09-20

The privacy policy is published twice, and both stores require both copies: the public
URL (`apps/admin/src/app/privacy/page.tsx`) and the in-app text
(`apps/mobile/lib/features/settings/privacy_policy_page.dart`). They were hand-
duplicated and had drifted — the in-app copy gained "No health, fitness or step data"
when onboarding stopped collecting any, and the public page did not. So the URL a
reviewer opens and the text they read inside the app disagreed about health data, and
nothing compared them.

Aligned, and now guarded: `apps/admin/src/__tests__/privacy-policy-consistency.test.ts`
reads both files and asserts 13 shared claims appear in each, that neither claims a
capability the app does not have, and that the in-app copy names the public URL it
mirrors. Verified to fail when the line is removed from either copy.

```
pnpm --filter nova-admin test     2 files, 22 tests passed
verify-store-compliance.py        34/34 checks passed
verify-auth.py                    24/24 checks passed
```

### Production is running a pre-change build — the store URLs do not exist yet

Probed from this machine on 2026-09-20. This is the one blocker that stands between the
repository and a submission, and it cannot be cleared from the repository:

```
https://nova.leadup.in/healthz                          200     API is up
https://nova.leadup.in/api/v1/consent                   401     pre-existing, auth-gated — fine
https://nova.leadup.in/api/v1/account/deletion-preview  404     NOT DEPLOYED
https://nova.leadup.in/api/v1/ai/reports                404     NOT DEPLOYED
DELETE https://nova.leadup.in/api/v1/account            404     NOT DEPLOYED
https://nova.leadup.in/privacy                          307 → /login?next=%2Fprivacy
https://nova.leadup.in/delete-account                   307 → /login?next=%2Fdelete-account
https://nova.leadup.in/                                 307 → /login      nginx/1.24.0 (Ubuntu)
```

`/healthz` and `/api/v1/consent` answering correctly while `/api/v1/account/*` 404s
proves the API is reachable and simply running an older image — not a routing or DNS
problem. Likewise `/privacy` returning **307 rather than 404** proves the deployed
console predates this work: only `/login` is public in that middleware, and neither new
page exists in that build.

**Consequence: none of the store-mandated surfaces is live.** The privacy-policy URL,
the account-deletion web resource, the in-app deletion endpoint and the AI-reporting
endpoint must all be deployed before a submission can be made. Entering any of these
URLs in Play Console or App Store Connect today would fail the store's own check.

To deploy: build and roll out `services/api` and `apps/admin` from this revision. The
exact acceptance check afterwards is:

```
python3 services/api/scripts/verify-store-compliance.py \
    --console-url https://nova.leadup.in --admin-token "$ADMIN_JWT"
```

which must print `39/39 checks passed`. Until it does, the URLs are not ready.

### Store-submission answer set, and the defects deriving it exposed

A read-only pass produced the full console answer set (Play Data safety, App content,
store listing; App Store App Privacy, export compliance, age rating, review notes) with
file:line evidence for each. Four blockers and six further defects fell out of it.

**Blockers (all outside the repository, except the first):**

| # | Blocker | State |
| --- | --- | --- |
| 1 | Production predates this work | `/privacy` and `/delete-account` → 307 to `/login`; `/api/v1/account/*` → 404. See the deployment section above. |
| 2 | `PrivacyInfo.xcprivacy`, `ios/Podfile`, `ios/Podfile.lock` are **untracked** | A fresh clone or CI archive would ship **no privacy manifest** (ITMS-91053/91056) and could not `pod install`. Not gitignored; file mode was `600`, now `644`. **Needs a commit.** |
| 3 | No review/demo account existed | `seed-admin.mjs` creates an *owner*; `packages/database/src/seed.ts` writes an invalid bcrypt hash so its demo user can never sign in. **Added `services/api/scripts/seed-review-account.mjs`**, which creates an ordinary `user` with a random password printed once, refuses to run under `NODE_ENV=production` without an explicit override, and is idempotent. |
| 4 | No Support URL anywhere | **Added `/support`** to the console, exempted from the session gate alongside the other two public URLs. Gives the listing a real Support URL and App Review 1.5 the contact info it asks for. |

**Defects fixed:**

| Defect | Impact |
| --- | --- |
| **Three** conflicting password rules, two of them dead | `routes/auth.ts` defined `min(8)` inline (the live one), `schemas/index.ts` said 12 and is imported by nothing, and `utils/validation.ts` said 8 and is imported by nothing. The app matched the live 8 *by luck* — nothing tied the two together. They now share one `PASSWORD_MIN_LENGTH = 12`; the register route imports it, the client mirrors it, and the dead helper is aligned. **This does change live behaviour: the minimum goes 8 → 12.** Verified: a 9-character password now returns 400 `"Password must be at least 12 characters"` and a 12-character one returns 201. |
| AI safety prompt rule 1 read *"NEVER reveal, quote, or summarize your or ."* — two empty interpolations | The system prompt's prompt-extraction guard named nothing and was unenforceable. Rewritten explicitly, with a new rule against reciting another person's saved content. |
| Both policy copies said recordings are stored in **Amazon S3**; the implementation is self-hosted **MinIO** (`audio-storage.ts`) | A false statement about where user data lives. Both copies now say "self-hosted, S3-compatible". |
| `account.deleted` audit rows stored the **email** while the policy promises audit entries are kept "without the link to your identity" | The row most likely to outlive the account contradicted the published policy. The address is no longer written; the opaque user UUID stays. |
| `deleteFlagAction` existed but no UI called it | The console could add and toggle feature flags but never remove one. A confirmed Delete control is now wired. |
| `Info.plist` export-compliance comment claimed "Standard HTTPS/TLS only" | Inaccurate — the app also uses the Keychain via `flutter_secure_storage`. `ITSAppUsesNonExemptEncryption=false` is correct either way. |

**Not fixed, and why:** Analytics/Crashlytics still collect in release gated only on
`!kDebugMode` (a consent gate is a product decision, and the code already flags the EU
risk); `PrivacyInfo.xcprivacy` over-declares `DeviceID`/`CrashData`/`PerformanceData` for
iOS because Firebase cannot initialise there without a `GoogleService-Info.plist`
(over-declaration is conservative and safe — removing it would under-declare the moment
the plist is added); retention remains a stated policy with no enforcement job; and
`deploy/production/nginx.conf` — **untracked, and it does not serve the console at the
apex at all**, routing `admin.nova.leadup.in` to the JSON API on port 3004 instead of the
console on 3005 — is a local file that contradicts the tracked `deploy/nginx/nova.conf`.
Whoever deploys must confirm which stack is installed on the host first.

### The privacy switches now control what they say they control — 2026-09-20

The previous round's audit found that every switch under **Profile → Privacy controls**
stored a preference and was read by nothing: a user turned "Save recordings" off and the
server recorded anyway. That report is now closed — see the table in the copy-audit
section below. `services/api/src/services/privacy-preferences.ts` is the one reader, the
six switches are enforced at their write sites, the notification switches gate both
reconcilers, and the two processing modes this deployment cannot provide are refused with
an explanation instead of being stored.

### The app's "Auto-delete" control now does something — 2026-09-20

`privacy_preferences` has carried `auto_delete_recordings_days` (default 30) and
`auto_delete_transcripts_days` (default 7) since the schema was written, and
`me_page.dart` renders both as working controls under **Privacy controls → Auto-delete**
("Delete recordings after 30 / 60 / 90 days", with `_RetentionRow` treating `null` as
"Never"). **Nothing ever read them.** A user who chose a window was told their
recordings would be purged and they never were — the worst instance yet of the pattern
this project keeps producing, because the user is relying on it to *remove* data.

`services/api/src/jobs/retention.ts` is the missing reader, started from the API's boot
path alongside the realtime socket. It deletes the stored object first and only then
stamps `deleted_at`, so a storage outage leaves the row visible and eligible for the
next pass rather than orphaning an object with no row pointing at it.

Verified against the real Postgres, not a mock:

```
npx tsx scripts/verify-retention.mjs
  a recording past its window           PASS  is soft-deleted
                                        PASS  its stored object was removed
  a recording inside its window         PASS  is left alone
  a user who chose "Never"              PASS  is never swept, even 400 days old
  a transcript past its window          PASS  is deleted
  a transcript inside its window        PASS  is kept
  when the object store fails           PASS  the failure is counted
                                        PASS  the row is NOT stamped, so the next sweep retries
  a second pass                         PASS  the first pass deletes
                                        PASS  the second pass deletes nothing
  11/11 checks passed
```

`NULL` meaning "Never" is the contract that matters most: treating it as "use the column
default" would delete recordings a user explicitly asked to keep, so the rule is pinned
both in a unit test (`isSweepable`) and against the database above.

The script exists separately from `src/__tests__/` because `setup.ts` replaces
`../db/connection` with an in-memory fake for the whole API suite — a vitest test there
would only ever exercise the fake, never the `created_at < now() - (days * interval '1
day')` predicate that decides what is destroyed.

**Still open on the same theme:** a web-filed `deletion_requests` row
(`POST /api/v1/account/deletion-request`) is recorded and `GET /account/deletion-requests`
lists it for an owner, but **nothing completes it** — there is no console surface and no
"process this request" endpoint, while the published policy promises completion within 30
days. It must not be automated: the endpoint accepts any email address without
authentication, so a job that acted on the queue would let anyone delete anyone's
account. The missing piece is a **verified, owner-driven** action in the console.

### The web-filed deletion request can now be completed

The other half of the promise on `https://nova.leadup.in/delete-account`: a request
filed there is recorded, and until this round **nothing could complete it**. The policy
said "we will verify the request and complete the deletion within 30 days" with no tool
that could do so.

`POST /api/v1/account/deletion-requests/:id/complete` (owner/admin only, requires the
literal `confirm: "DELETE"`) completes one through the *same* statements as
`DELETE /account`, so there is one deletion path and not two that can drift. The queue
now returns the requester's address, because completing a request is a **verified**
action and the operator has to be able to check that the person asking owns the account.

It is deliberately not a scheduled job. `POST /account/deletion-request` is public and
accepts any email address without authentication, so a job acting on the queue would let
anyone delete anyone's account: file a request for a victim's address, wait out the
schedule, and the account is gone. A person has to say so.

The console gained `/deletion-requests` — a queue with a per-row typed-DELETE
confirmation and a standing warning to verify ownership first — plus a sidebar entry.

```
verify-store-compliance.py --admin-token "$OWNER_JWT"
  a normal user cannot read the queue -> 403          PASS
  an owner can read the queue -> 200                  PASS
  the filed request is in the queue                   PASS
  and it carries the requester's address              PASS
  completing without the literal confirm -> 400       PASS
  completing without a session -> 401                 PASS
  completing as an owner -> 200                       PASS
  the account is gone afterwards -> 401               PASS
  and the queue no longer lists it                    PASS
  31/31 checks passed
```

### `apps/web` — a prototype that was claiming to be a product

A copy audit of the third app (`apps/web`, the Next.js web preview — neither the mobile
client nor the console, and not what production serves) found the same defect class the
last five rounds kept finding, in a cluster:

| Promise | Reality |
| --- | --- |
| Random canned replies claiming completed actions — *"I've made a note of that."*, *"I've set that up for you."*, *"I've updated your preferences accordingly."* — plus a hardcoded briefing naming two real-looking people | `use-assistant.ts` made no API call of any kind. **Fixed:** one honest reply stating the preview is not connected, with the fake delay and the fake "thinking" removed. |
| "Say 'Hey NOVA' to activate" (three places) | No `hey nova` classifier exists anywhere; the only installed model is `hey_jarvis`, and the mobile app had already removed this exact claim. **Fixed:** removed from all three strings. |
| A "Private Mode" switch reading `enabled={false}` / `onToggle={() => {}}`, described "Don't store conversation data", with a card claiming "No data stored during sessions" and "Conversations won't be stored" | `useState` only; `apps/web` has no session and no API client, so nothing could be stored or withheld either way. **Fixed:** the switch is gone and the copy describes the preview rather than promising retention behaviour. |

**Still open in `apps/web`, recorded so it is not lost:** the web onboarding privacy
levels are local state that is never persisted; "Push alerts for reminders" has no push
behind it; "Export My Data" and "Clear all memory" render without handlers although the
API serves `GET /settings/export` and the store exposes `clearAllMemories`; the
conversations table's Play/Download/Delete buttons have no `onClick`; the dashboard's
quick stats are literal numbers while the real stores sit unused beside them; the
settings header hardcodes a handle and a "Pro Plan" badge; and web onboarding never
writes the `nova-onboarding-complete` key that `/` reads, so `/` always redirects to
onboarding. The right call for most of these is to make `apps/web` say it is a preview
rather than to build the missing half, but that is a product decision, not a defect
fix.

### Copy audit round 6 — what the app claimed versus what it does

A verified pass over every user-facing string (each finding had to cite both the
promise and the code that contradicts it) produced eleven corrections. The
store-facing ones mattered most, because two of them were in policy text written during
this same effort:

| Promise | Reality | Fixed |
| --- | --- | --- |
| `/delete-account`: "and **encrypted** backups roll off within **30 days**" | `deploy/backup/backup.sh` is `pg_dump … \| gzip` — plain gzip, no encryption anywhere under `deploy/` — and `deploy/backup/cron` sets `RETENTION_DAYS=7` | Now "database backups roll off within 7 days" |
| Policy: "The microphone is only open during those two states" | With wake-word listening on, `WakeWordService` is a foreground service holding `RECORD_AUDIO` between conversations, and the home screen says "Listening in the background" | All three copies (in-app, public policy, support) now say the microphone is also open while wake-word listening is switched on, and that the wake word is detected on the device |
| Policy: "You can delete individual tasks, reminders, memories **and recordings** in the app" | Tasks, reminders and memories have delete UI; recordings have **no list at all** — `recordingsProvider` is only ever invalidated, `deleteRecording` has no caller, and `DELETE /recordings/:id` is a soft delete that leaves the audio object in storage | Now states what is true: recordings are removed by the retention window, which is exactly what the new sweep enforces |
| Call-recording card: uploaded recordings "appear with the meeting summaries, in the same list" | No such list exists | Now says they are saved to the account when the import finishes |
| Consent step: "You can change these later in **Privacy Center**" | The same file's own comment admits there is no Privacy Center route | Now "Profile → Privacy controls" |
| Reminder composer: "**Push** notification at {time}" | No push: no `firebase_messaging`, no device-token route. Delivery is a local alarm | Now "Reminder at {time}" |
| Activity feed: "Actions NOVA takes on your behalf are recorded here" | It reads `audit_logs`, which only ever receives `account.deleted`, `account.deletion_request.completed` and `ai.response.reported`. Real assistant actions go to `tool_executions`, which nothing surfaces | Now "Account and privacy events are recorded here" |

**They are now read — every one.** `services/api/src/services/privacy-preferences.ts`
is the single reader, and the write sites consult it:

| Switch | Enforced where |
| --- | --- |
| Save memories | `services/memory.ts:createMemory`, `routes/memories.ts POST /`, and the `save_memory` assistant tool — the tool returns a *result* saying nothing was stored, so the model relays it rather than the turn failing |
| Save transcripts | `services/recording-pipeline.ts` — the transcript is produced and summarised but not written |
| Save recordings | `services/recording-pipeline.ts` — the audio object is deleted and the row stamped after the summary exists |
| Save conversations | `routes/chat.ts` — the turn is answered but no conversation or message row is written, and history is read from nothing |
| Cloud processing / On-device processing | **Refused**, see below |

The notification switches are enforced too: `notificationDeliveryEnabledProvider` mirrors
the choice locally and both reconcilers read it, so turning device and in-app
notifications off **cancels what is already armed** rather than only affecting reminders
created afterwards. The briefing reconciler shares the gate, because otherwise the
reminder pass would cancel every armed alarm and the briefing pass would immediately
re-arm its own.

**Cloud and on-device processing are refused rather than stored.** This build has no
on-device speech-to-text or language model, so `localProcessing: true` and
`cloudProcessing: false` cannot be honoured. Accepting them would let the app tell a user
their audio never leaves the phone while every turn still goes to a provider, so
`PATCH /settings/privacy` answers `409 LOCAL_PROCESSING_UNAVAILABLE` /
`409 CLOUD_PROCESSING_REQUIRED` with an explanation, and the app renders both switches
disabled with that reason instead of as live controls.

```
python3 services/api/scripts/verify-privacy-gates.py
  saveMemories   with the switch on, a memory is stored -> 201            PASS
                 with the switch off, the write is refused -> 409         PASS
                 and nothing was written                                  PASS
  saveConversations  the turn is still answered -> 200                    PASS
                     the response shape is unchanged                      PASS
                     and nothing was stored: the history is empty         PASS
  localProcessing: true is refused -> 409                                 PASS
  cloudProcessing: false is refused -> 409                                PASS
  a satisfiable patch still succeeds -> 200                               PASS
  14/14 checks passed
```

### An adversarial pass on the switch enforcement found a critical bypass

The verification subagent tasked with falsifying the privacy-switch change found that
`saveConversations` was enforced on the **wrong route**. `routes/chat.ts` was gated;
`routes/conversations.ts` was not — and that is the endpoint the Flutter client actually
uses (`nova_api.dart` posts to `/conversations/:id/messages`). With the switch off, a real
session's content was still written, so the promise was as false as before. Verified live:
the marker `PRIVATE-CONTENT-adversarial-verify` landed in `conversation_messages`.

Fixed, and the fix was then re-verified against that exact payload:

```
1. turn saving OFF                       PATCH -> 200
2. confirm the server agrees             saveConversations = False
3. session start                         201, ephemeral: true
4. post the marker                       201 (the turn is answered)
5. history read                          {"messages": [], "ephemeral": true}
6. conversation list                     0 conversations
```

Ephemeral rather than refused, deliberately: rejecting the call would make the feature
unusable, and "don't save my conversations" means *talk without being recorded*, not
*stop talking*. Every turn is answered with the same response shape; the ids simply
resolve to nothing on the server.

Four further findings from the same pass, all fixed:

| Finding | Fix |
| --- | --- |
| `recording_summaries` was written unconditionally, so transcript-derived decisions, action items and contacts were retained with "Save transcripts" off | Gated on `saveTranscripts` — the summary *is* transcript content in another table, and there is no separate summary preference |
| `saveRecordings: false` only cleaned up after a **successful** pipeline; a failed run, a dead process or `/process` never being called left the audio for the 30-day retention window | `fail()` purges the object too, and never lets that change the outcome of the run it is cleaning up after |
| `notificationDeliveryEnabledProvider` was a plain `Provider<bool>`, cached for the session, so turning notifications off in Profile did not cancel armed alarms until a restart | Now a `Notifier` the writer invalidates; the cache is also cleared on **both** session-drop paths, so a second account on the device no longer inherits the first account's off-state |
| The Notifications sheet's note still said the switches "do not change what NOVA delivers yet" — the inverse of the truth after the change | Rewritten, and the reconciler's doc reference to the wrong store corrected |

```
python3 services/api/scripts/verify-privacy-gates.py    20/20  (was 14; +6 for the bypass route)
verify-auth.py                                          24/24
verify-store-compliance.py                              27/27
pnpm build/typecheck/test/lint                          27 · 31 · 35 · 25
flutter analyze / test                                  clean · 616 passing
```

**Still open on the same theme:** the onboarding companion persona is discarded —
`companion_page.dart` calls `clearPendingPersona()` immediately after the pre-push fails
and nothing re-pushes it after sign-in — and the final onboarding switches
(`notificationsEnabled`, `voiceCommandsEnabled`) are written to `SharedPreferences` and
read by nothing. Both are the same shape as the switches above and want the same
treatment.

### The onboarding companion is no longer discarded — 2026-09-20

`CompanionPage` told the user their companion "is stored and will be pushed after
sign-in" — and then called `clearPendingPersona()` unconditionally on the next line, right
after the pre-sign-in push failed with "Missing or invalid authorization header". Nothing
re-pushed it, because there was nothing left: the name, personality and speech style a
user had just chosen reverted to the defaults, and `getLanguagePolicy()` fell back to
`auto`, so the first greeting came out in the wrong language too.

Fixed in three places:

* `CompanionPage` clears the stored copy **only when the server accepted it**;
* `PendingPersonaFlush` (`features/onboarding/pending_persona_flush.dart`) is the missing
  consumer — built once from `NovaApp` for the session's lifetime, watching the auth state
  in the same shape as `ReminderSyncController`, pushing a pending companion on the first
  authenticated frame and clearing it only afterwards;
* the two onboarding switches were the same write-only shape. **"Notifications"** now
  writes the same local value the reminder and briefing reconcilers read, so turning it
  off actually stops an alert. **"Voice commands — Let NOVA act on spoken requests" was
  removed**: nothing consulted it, and the only thing that acts on speech is the
  device-control screen, where every action goes through its own explicit confirmation —
  a per-action guard that is strictly better than one blanket toggle.

```
flutter test test/features/pending_persona_flush_test.dart    6 passed
```

The guard was verified to fail against the original ordering: with the clear moved back
before the push, `keeps the companion when the server rejects it` fails with
`Expected: not null / Actual: <null>`.

### The privacy gates are now covered by the unit suite

An adversarial pass made the sharpest point of the round: the gates were **structurally
untestable** in `services/api`'s own suite. `src/__tests__/setup.ts` replaces
`../db/connection` with an in-memory mock that had no `privacy_preferences` row, so
`getPrivacyPreferences` fell through to `PRIVACY_DEFAULTS` — everything on — and every
gated route ran with saving enabled. A future edit could delete a gate and the suite
would stay green. That is exactly how the conversation-route bypass survived a round.

Fixed by making the mock's privacy row controllable, and covering the gates:

```
src/__tests__/setup.ts        + a privacy_preferences row and setPrivacyPreferencesRow()
src/__tests__/privacy-gates.test.ts   11 tests
```

The row is keyed by the **destructured** names the reader uses, not the snake_case column
names — the mock ignores the `select({...})` projection, so a column-named fixture yields
`undefined` for every field, which `?? PRIVACY_DEFAULTS` turns back into "all saving on".
A fixture written the obvious way would have passed while asserting nothing.

```
  the reader itself        a user with no row saves everything              PASS
                           returns the stored values when a row exists     PASS
                           does not pretend a switch is off when it
                           cannot read the row (falls back, logged)        PASS
  saveMemories             stores one while the switch is on -> 201        PASS
                           refuses when the switch is off -> 409           PASS
  saveConversations        still answers a turn when the switch is off     PASS
                           marks a new session ephemeral rather than
                           storing it                                     PASS
                           does not mark one ephemeral while it is on      PASS
  processing modes         refuses "On-device processing" -> 409           PASS
                           refuses "Cloud processing: off" -> 409          PASS
                           still accepts a patch it can honour -> 200      PASS
```

The guard was verified to fail when a gate is deleted: removing the `saveMemories` check
from `routes/memories.ts` makes `refuses to store one when the switch is off` fail.

One further finding from the same pass is now addressed: `getPrivacyPreferences` fails
**open** on a database error, which was documented but **silent** — a user who had
switched something off was being recorded anyway with no trace anywhere. It still fails
open (failing closed would turn a short outage into data loss for users who never changed
a setting), but the fallback is logged at error level with the user id.

```
pnpm test (api)              18 files, 269 tests    (was 259; +11 privacy gates, -1)
verify-auth.py               24/24
verify-privacy-gates.py      20/20
verify-store-compliance.py   27/27
verify-retention.mjs         11/11
```

### An adversarial pass on the console found a blocker and a regression — 2026-09-20

The console changes had never been independently verified. A read-only pass — driving a
real Chrome rather than curl — found two defects, both introduced by earlier rounds.

**A blocker that only appeared when data existed.** `FlagDelete` in
`feature-flags/page.tsx` passed `onSubmit` from a Server Component. Next rejects that
outright — *"Event handlers cannot be passed to Client Component props"* — so the page
threw its error boundary the moment any flag existed. It survived every earlier check
because the local database had **no** flags, so the component never rendered; build,
typecheck, lint and curl all passed. Replaced with a typed `DELETE` validated **on the
server**, the same guard `deletion-requests/actions.ts` uses, which needs no client
JavaScript at all. Verified with a flag present:

```
GET /feature-flags with a flag, signed in   -> 200
  "failed to render" in the body            -> 0
  "Event handlers cannot be passed" in logs -> 0
```

**A regression that forced a re-login every 15 minutes.** The edge gate compared `exp`,
and access tokens live 15 minutes. So after 15 minutes idle the middleware rejected the
cookie, 307'd to `/login` and **deleted** it — and because `/login` is public the client
guard never ran, so the 7-day refresh token in localStorage was never used. The gate now
answers only two questions: is there a token, and does it claim an admin role? An
expired-but-refreshable token passes through, the shell renders, and
`AdminAuthGuard.attemptRefresh` renews it in the background. Verified:

```
expired cookie, /users       -> 200          (silent refresh restored)
malformed cookie, /users     -> 307 /login   (still refused)
user-role cookie, /users     -> 307 /login   (still refused)
/privacy /support /delete-account with a session -> 200 200 200
```

Also fixed from the same pass: the console's policy page said "Settings → Delete account"
where the app and both other copies say "Profile"; the Cost summary row ran
`toLocaleString` while the card and the per-user column used `formatUsd`, so one amount
read `$0.0012` in one place and `0.001` in another; two unreferenced dead components were
removed (`NovaTheme.tsx`, which held the same illegal `onSubmit` and would have broken
whatever imported it next, and `ErrorBoundary.tsx`, whose job `app/error.tsx` already
does — both tracked, so recoverable from git history); stale comments corrected and the
unused imports dropped. Lint warnings went 13 → 9.

**What the pass confirmed holds:** `document.cookie` exists only in `lib/api.ts`
(`writeTokens`, `clearTokens`), with `max-age=3600`, `SameSite=Lax`, and `Secure` on
https; `NEXT_PUBLIC_API_BASE` produces exactly one `/api/v1` at every call site, checked
in a real browser; the public routes are exact-match only, so `/privacy/foo` and
`/support/faq` still 307 and no public page carries console chrome or user data; the
deletion-request flow rejects a non-owner with 403 and runs its typed guard before the
API call; and every previously-working page still gates and renders with live data.

A note on the new guard: `src/__tests__/middleware-session.test.ts` asserts against the
**source text**, not behaviour, because `middleware.ts` targets the Edge runtime and
cannot be imported into a node vitest process. It fails if `exp` reappears in the gate,
if the role check is dropped, or if a route is added to `PUBLIC_ROUTES` — but a pass means
"the shape is still right", not "the behaviour is verified". The behavioural evidence is
the table above. The test says so itself.

### Store listing artwork now exists — 2026-09-20

A Play listing cannot be submitted without a 512x512 icon and a 1024x500 feature graphic,
and neither existed anywhere in the repository. `apps/mobile/store-assets/generate.py`
produces both from the app's own colour tokens, and the icon is derived from the same
1024 master the iOS marketing icon uses, so the two cannot drift:

```
apps/mobile/store-assets/play-icon-512.png                512x512   RGB, no alpha   72,843 bytes
apps/mobile/store-assets/play-feature-graphic-1024x500.png 1024x500  RGB, no alpha   66,323 bytes
```

No imaging library is available in this environment (no Pillow, no ImageMagick, and
`qlmanage` letterboxes and rescales an SVG unpredictably), so the script writes the PNGs
directly and draws the type with a small stroke font it defines. That keeps the artwork
reproducible from the repository instead of being a binary nobody can regenerate — and
it is verified with a PNG reader rather than by trusting the numbers, because the two
things Play rejects are a wrong size and an alpha channel.

**The complete Play image set now exists**, captured from the app on an API-36 emulator
against a live API with a seeded account, and framed so the stores will accept them:

```
store-assets/play-icon-512.png                 512x512    RGB, no alpha
store-assets/play-feature-graphic-1024x500.png 1024x500   RGB, no alpha
store-assets/screenshots/01-home.png           1200x2400  aspect 2.000:1
store-assets/screenshots/02-tasks.png          1200x2400  aspect 2.000:1
store-assets/screenshots/03-profile.png        1200x2400  aspect 2.000:1
store-assets/screenshots/04-permissions.png    1200x2400  aspect 2.000:1
```

> **Why the screenshots are framed rather than submitted raw.** Play rejects a phone
> screenshot whose aspect ratio exceeds **2:1**, and the app's native captures are
> 1080x2424 — 2.24:1. They look perfectly fine, which is exactly why this is easy to miss;
> the first set produced here would have been rejected on upload. `frame_all_screenshots()`
> in `generate.py` scales each capture to fit and centres it on a 2:1 canvas in the brand
> gradient, so the raw captures stay in `screenshots/raw/` and the framed output is what a
> listing uses. The aspect ratio of every file is asserted, not eyeballed.

`store-assets/listing.md` carries the name, short description and full description, each
within the platform limits (23 / 68 / 2621 characters against 30 / 80 / 4000), plus the
Support, privacy and deletion URLs to enter. Every claim in it is one the app implements —
which is the standard the last several rounds have been held to, after removing a
health-data claim, an "Enterprise SSO" notice, a wake-word phrase that was never
installed, notification switches with no sender behind them and a privacy control that
controlled nothing. It deliberately states that the app does **not** work offline, does
**not** process speech on-device, and that "Cloud processing" therefore cannot be switched
off.

**Still missing for the listings:** the App Store's 6.7" and 5.5" screenshot sets, which
need an iOS simulator runtime that is not installed on this machine (an ~8 GB download I
have not started unprompted); the store categories and content-rating answers, which are
console-side; and anything requiring the Console itself.

### Store-listing assets

### Two silent failures in the retention sweep — 2026-09-20

An adversarial pass on the three API surfaces that had never been verified found two HIGH
defects in the sweep, both of them failures of the feature's entire purpose, and both of
them things I had already reported as verified.

**The storage-failure contract was broken, and my test proved the wrong path.**
`deleteAudio` → `s3Driver.remove` catches every error and **returns `false`**; it also
returns `false` when object storage is unconfigured. It never throws. The sweep only caught
a *throwing* deleter and ignored the return value, so a failed purge was stamped
`deleted_at` and counted as purged — orphaning the audio with no row pointing at it, which
is exactly what the comment claimed to prevent. `verify-retention.mjs` injected
`async () => { throw }`, a path production cannot take, so "11/11 passed" was true and
meaningless.

**`recording_summaries` does not cascade from `transcripts`.** `schema.ts` declares no
`onDelete` on `recording_summaries.transcript_id` and the database confirms
`confdeltype = 'a'`. Deleting a transcript that has a summary raised 23503, and because the
transcripts delete is one statement the whole batch (up to 500) rolled back — silently,
into a log line. The pipeline writes a summary whenever "Save transcripts" is on, which is
the default, so the transcript purge removed essentially nothing in the ordinary case.

Both fixed, and the checks now exercise what production actually does:

```
verify-retention.mjs                                            16/16   (was 11)
  when the object store fails, deleter returns false            PASS  counted, row NOT stamped
  when the object store fails, deleter throws                   PASS  counted, row NOT stamped
  a transcript that has a saved summary                         PASS  transcript gone, summary gone
```

Reverting either fix takes the script to **9/16**, failing exactly the new checks — so they
are guards, not decoration. The `false` arm and the summarised-transcript case are the two
that were missing.

**The same pass cleared several things:** the FK inventory is complete (exactly three
`users` references lack an action, all handled; the `audit_logs` row carries no email and a
null `user_id`), `deletion-preview` leaks nothing and handles `password_hash IS NULL`,
the 401/403 and confirm-before-delete ordering hold, and `POST /ai/reports` bounds the
excerpt at 500 and never reads `messageId`.

### Account-deletion defects from the same pass

| Finding | Fix |
| --- | --- |
| The public filing endpoint was a **timing oracle**: status and body identical, but the known path awaited a dedup `SELECT` and an `INSERT`. 146 interleaved samples separated the arms at Mann-Whitney z = −8.08 (known 2.16 ms, unknown 1.06 ms). The login route is deliberately constant-time against exactly this | The write now happens **after** the response, so the awaited work is one indexed `SELECT` on both paths |
| A request filed for **one artifact** completed as a whole-account deletion — a seeded `artifactType='recordings'` row destroyed the account | `complete` now requires `artifactType === 'account'`, agreeing with the queue that lists only those |
| Reported AI excerpts survived account deletion with `actorId` intact, while the policy promises immediate removal | The deletion transaction drops `details.excerpt` for that actor; the fact of the report and its reason are kept |
| A non-UUID `:id` reached Postgres and returned a **500 leaking code `22p02`** | Validated, now `400 INVALID_ID` |
| 39 posts for one address created 39 pending rows, and the queue has no `LIMIT` | One pending request per account |
| The post-delete audit `INSERT` was outside the transaction, so a failure answered 500 for an account that **was** deleted | Wrapped; the deletion is reported as successful and the failure logged |
| `deleteAudio`'s return was discarded while the comment claimed "the failure is audited below" | Counted and logged; `recordingsNotPurged` is recorded on the audit row |
| The doc claimed a repeat completion returns 409 | It is 404 — the request row cascades with the user, so it is gone. Comment corrected |

```
verify-account-deletion.mjs                                      7/7
  the delete does not violate a foreign key                    PASS
  the user row is gone                                         PASS
  a request row can exist for a single artifact                PASS
  the trail row survives, as documented                         PASS
  but the excerpt does not                                     PASS
  and the reason is kept                                       PASS
```

`verify-account-deletion.mjs` is explicit about one limit: it asserts the **precondition**
the artifact-type guard depends on, not the guard itself, because exercising that needs an
owner token over HTTP. The check is named accordingly rather than implying more.

### The pipeline had the same FK bug the sweep did — and pagination lost rows everywhere

A third adversarial pass, over the recording pipeline and the four routes it had never
covered, found a blocker and three live functional breakages.

**The blocker: re-processing any completed recording destroyed it.**
`recording-pipeline.ts` deleted `transcripts` before `recording_summaries`, but
`recording_summaries.transcript_id` is `NO ACTION`, not CASCADE — so the transcript delete
raised 23503, the summary delete below it never ran, and the pipeline's own `catch` flipped
a perfectly good recording to `failed`. Reproduced: run 1 `completed`, run 2 `failed` with
`constraint "recording_summaries_transcript_id_transcripts_id_fk"`.

This is the *identical* defect I fixed in `jobs/retention.ts` one round earlier, in the
other place that deletes transcripts. Fixing a bug in one caller and reporting the class as
handled is how it survived.

**Pagination was broken on all six list endpoints.** The cursor carried only an `id` while
the query ordered by a timestamp. With UUID keys that is not a keyset — `id > cursor`
selects an arbitrary subset of the remaining rows. Measured live before the fix:

```
9 tasks      → 4 rows across pages, 5 missing
7 reminders  → 2 rows
7 recordings → 8 rows, 6 unique (one skipped, one duplicated)
```

An `id`-ordered filter against a `created_at` ordering cannot be fixed by changing a
comparison; the cursor has to carry what the query is ordered by. `keysetWhere` in
`utils/pagination.ts` now emits a Postgres row-value comparison on `(created_at, id)`, and
all six routes use it.

> Getting the operator right is the subtle part, and the first version of the helper got it
> **backwards**. These routes order `DESC` for `forward` and `ASC` for `backward`, so a
> forward walk moves to *smaller* values — `forward` is `<`, `backward` is `>`. Inverting
> them makes page two re-serve page one. A live walk caught it: page 2 returned the newest
> row again. The helper now documents the inversion, and a test pins it.

Two more defects in the same area: `GET /memories` accepted `category`, `visibility` and
`status` and then discarded them (it used the cursor-only parser, and built its `WHERE`
before pushing the cursor clause, so the cursor was ignored and a client following
`nextCursor` looped forever); and a non-UUID cursor reached Postgres on `tasks` and
`reminders`, returning a **500 with the Postgres code `22P02` in the body**.

Finally, a second `POST /:id/process` arriving as the first run finished could overwrite
`completed` with `processing` and then be dropped by the pipeline's `inFlight` guard —
leaving the row **permanently** at `processing`, with nothing to recover it, since the
retention sweep never reads `status`. The route's status write now refuses to downgrade a
terminal status.

```
verify-pagination.py               17/17   (new)
  tasks: no row is duplicated / skipped        9 rows, 9 unique, 5 pages
  reminders: no row is duplicated / skipped    7 rows, 7 unique, 4 pages
  memories: no row is duplicated / skipped     6 rows, 6 unique, 3 pages
  a non-uuid cursor -> 400                     tasks, reminders, memories
  ?category=contact / ?category=fact           returns only, and all of, that category
```

The walk checks were verified to fail: inverting the keyset operator takes the script from
**17/17 to 11/17**, failing exactly the six duplicated/skipped assertions.

Also fixed from the same pass: memory `content` had no upper bound (`POST /memories` with
400,000 characters returned 201), and `UpdateRecordingSchema.status` was a free-form string,
so `{"status":"totally-made-up"}` wrote a value no reader recognises. The status is now an
enum — and a test asserts it accepts **every** value of `RECORDING_STATUS`, because my first
attempt narrowed it to the terminal states and would have rejected `recording` and
`uploaded`, which the app legitimately sends.

**What the pass confirmed clean:** no cross-user access on any of `tasks`, `reminders`,
`memories` or `recordings` — every `GET`/`PATCH`/`DELETE` on another user's row is a 404, a
foreign row id used as a cursor returns none of that user's rows, and no list endpoint
joins `users`, so no other account's email is ever returned. `packages/*`: nothing unsafe is
reachable from the API.

```
verify-auth 24/24 · verify-privacy-gates 20/20 · verify-store-compliance 27/27
verify-retention 16/16 · verify-account-deletion 7/7 · verify-pagination 17/17
pnpm build 27/27 · typecheck 31/31 · test 35/35 (api 281) · lint 25/25
flutter analyze clean · flutter test 616
```

### The recordings API returned columns the client never asked for

The list and detail routes did `select().from(audioRecordings)`, so every response carried
`storageKey` — the object-storage path `recordings/<userId>/<recordingId><ext>` — plus
`tenantId`. Neither is read by any consumer (grepped across the Dart and TypeScript
clients). `recordings-shared.ts` now holds one `RECORDING_COLUMNS` projection used by all
three routes, which also means a column added to the table later does not silently become
public API. The upload route's deliberate `storage: {key, bytes, checksum}` envelope is
untouched — that is a documented part of that endpoint's contract, unlike the raw row it
was being dumped alongside.

```
GET /recordings          -> id, title, durationSeconds, language, status, participants,
                            consentRecorded, completedAt, createdAt, updatedAt
internal columns present -> none
GET /recordings/:id      -> the same, plus transcript / summary / segments
```

### A finding I deliberately did not fix

An adversarial pass flagged `assertAssigneeExists` as a user-existence oracle
(`POST /tasks` with a valid id → 201, an unknown one → 400) that also permits assigning a
task to somebody in another organisation. Both are true. The obvious repair — require the
assignee to share the caller's `organization_id` — was **measured before being rejected:
1 of 50 users in the development database has an organisation at all**, because
organisations are not yet part of onboarding. It would refuse nearly every assignment,
trading a working feature for a hole that is not open: the oracle confirms a UUIDv4 the
caller already holds, which is not enumerable, and the cross-organisation link is a
dangling reference on the caller's own task, which the named assignee can never read.
The reasoning is now recorded at the function, with the correct rule for when
organisations become mandatory ("same organisation, or yourself").

Recording a finding as accepted rather than fixing it is the honest outcome here; a change
made to look responsive would have broken assignment for 49 of 50 users.

```
verify-auth 24/24 · verify-privacy-gates 20/20 · verify-store-compliance 27/27
verify-pagination 17/17 · verify-retention 16/16 · verify-account-deletion 7/7
pnpm build 27/27 · typecheck 31/31 · test 35/35 (api 283) · lint 25/25
```

### A production SSH password, and a deploy that could not have worked — 2026-09-20

Auditing `deploy/production/` turned up a security problem and a deployment that would
have shipped a non-functional app. This file is **untracked**, which is the only reason it
has not leaked into the repository's history.

**A production SSH password in plaintext, twice.** `deploy.sh` ran
`sshpass -p '<password>' ssh -o StrictHostKeyChecking=no root@91.107.202.66`. The
password is now read from `SSHPASS` via `sshpass -e`, so it never appears in the file or in
`ps`, and host-key checking is `accept-new` rather than disabled outright. **The old
password must be treated as compromised and rotated** — it has sat in a working tree, and
anyone who committed or copied this directory has it. (It was redacted here rather than
reproduced: a finding about a leaked credential is not a reason to write the credential
into a tracked file, which is what the first version of this paragraph did.)

**Every provider API key would have been deployed as the literal `__CHANGE_ME__`.** The
script built `.env.production` with a chain of `sed -e` expressions against the *same*
placeholder:

```
sed -e "s|__CHANGE_ME__|${POSTGRES_PW}|g" \
    -e "s|__CHANGE_ME__|${REDIS_PW}|g"
```

The first expression consumes every occurrence, so the second matches nothing. Two
consequences: `REDIS_PASSWORD` silently kept the Postgres password, and `ANTHROPIC_API_KEY`,
`DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` and `SARVAM_API_KEY` were never set at all — *a
deploy that produces an app which cannot transcribe or answer*. The keys cannot be
generated, so the script now demands them up front and refuses to continue without them,
substitutes each variable by name, and then **fails if any `__CHANGE_ME__` survived**.

Also: `openssl rand -base64` can emit `/` and `+`, which corrupt a password embedded in a
`postgres://user:pass@host` URL — credentials are now generated URL-safe. `certbot` and the
database migration were both suffixed `|| true`, so an SSL failure left the site on HTTP
(both stores require those URLs over HTTPS) and a failed migration left the API on an old
schema, both invisibly; they now fail loudly. The script finishes by checking the three
store-required URLs and exits non-zero if any is not a 200.

### The mobile app leaked one account's data to the next

The Flutter audit found two blockers. The worse one: `activeConversationProvider` and
`transcriptProvider` are plain `NotifierProvider`s, never reset, and `ConversePage` returns
early when a conversation id is already set — so after a sign-out, **the next person to sign
in on the same process saw the previous user's transcript and posted their turns into that
user's conversation**. The notification assistant's in-memory inbox and its per-session
speech consent had the same lifetime. A process restart cleared all of it, which is why
nothing caught it: the leak needs two accounts and one running process.

`clearAccountScopedState` now resets all four providers and is called from both session-drop
paths.

### The persona flush did not run at sign-in, and my test could not have noticed

Two rounds ago I reported the deferred onboarding companion as fixed. It was not.
`NovaApp.initState` kept the notifier alive with `ref.read(pendingPersonaFlushProvider
.notifier)` — which constructs the notifier and creates **no subscription**. In Riverpod,
an element with no listeners is not eagerly rebuilt when a dependency changes, so `build()`
ran once in whatever auth state existed at startup and never again. The persona was pushed
on the next *cold start*, not at sign-in, and a copy left pending across a sign-out could be
written to whoever signed in next.

The test I wrote for it called `flush()` directly, so it exercised the flush and never the
wiring — a green suite over a broken feature. `app.dart` now uses `listenManual` for all
three app-lifetime notifiers.

Fixing the wiring exposed a **second** defect behind it: the flush then threw *"Cannot use
the Ref of Provider\<NovaMutations\> after it has been disposed"*. `NovaMutations` captures
its provider's `Ref` to invalidate caches, and the flush runs on exactly the frame the auth
state flips, when `novaApiProvider` and everything derived from it is being rebuilt. The
flush now calls the API directly — it has no caches to invalidate.

`test/features/persona_flush_wiring_test.dart` drives the real sign-in transition and pins
both halves: with a subscriber the companion is pushed and consumed at sign-in, and with
the old `ref.read` wiring the auth change is invisible. The second test is the regression
itself, written down.

```
flutter test    618 passing, 5 skipped   (was 616)
flutter analyze clean
```

This is the third time a verification has caught a fix of mine that was reported as
complete: the retention FK bug repeated in the pipeline, and now a flush whose test proved
the wrong thing. The common thread is a test that exercised the unit instead of the path
the user takes.

### On a real device — OnePlus 9R, Android 14 (API 34) — 2026-09-20

Installed and driven on physical hardware rather than an emulator. Every earlier on-device
pass was on an API-36 emulator, and every earlier emulator run had **already been signed
in**, which is what hid the first finding.

**A fresh install opened on an error.** The very first screen after "Get started" read
*"Could not load your saved choices. Pull to retry."* `consentHistoryProvider` called
`GET /consent` — an authenticated endpoint — during onboarding, which runs **before**
sign-in, so it answered 401; and because `_bootstrap` resolves `.future` from `initState`,
it retried in a loop (the API log shows a 401 every few seconds with growing backoff). With
no session there are no prior records to load, so the provider now returns an empty list
instead of making the call. Re-verified on a clean install: **0** authorization failures in
the API log for the whole onboarding run.

**The deferred persona flush works on real hardware.** This is the fix from the previous
round, and the device is what proves it end to end: the companion was named **Ada** on the
"Name your companion" step, which runs *before* sign-in, and after signing in the server
reported

```
GET /api/v1/settings/persona
{"name":"Ada","personality":"friendly","voiceSpeed":100,...}
```

That is the whole chain — stored pending, flushed on the authenticated frame, accepted,
then cleared — working on a phone.

**The permission flow is Play-compliant.** Both runtime prompts appear with the app's own
disclosure visible behind them: the microphone prompt sits over *"Your audio is sent to our
server to be transcribed and answered — it is not processed only on this device"*, and the
notification prompt over *"Deliver reminders and alerts you create."* The AI-processing row
names every sub-processor (Sarvam AI, Deepgram, ElevenLabs, Anthropic) and states the data
is not used to train their models. Onboarding completes: permissions → about you →
companion → preferences → sign-in.

**No crashes from the package.** `logcat -b crash` holds 0 lines for `com.leadup.nova`; the
crashes in the buffer belong to other apps on the device (`com.ido.noise`).

**A process note worth keeping.** While driving this, tapping "Allow" on the AI-processing
row appeared to do nothing, and I had begun diagnosing an onboarding blocker — a stuck
`_busy` flag, a disabled button. It was neither. My tap coordinates were ~70px below the
button: the screenshots I measured from are 536px-wide previews of a 1080px screen, and I
had been converting against the wrong scale. I nearly reported a defect that did not exist.
Measuring the pixel scale before converting, rather than assuming it, is what settled it.

```
OnePlus 9R (LE2101), Android 14, API 34, arm64-v8a
  fresh install, onboarding to sign-in        completes, no error banner, no 401s
  microphone prompt over the disclosure       Play-compliant
  notification prompt over the rationale      Play-compliant
  AI-processing disclosure                    names Sarvam AI, Deepgram, ElevenLabs, Anthropic
  deferred companion flush                    "Ada" reached the server after sign-in
  com.leadup.nova crash lines                 0
```

### Voice tested on the phone: two crashes, one of them a full outage — 2026-09-20

Driving the wake word on the OnePlus with real audio (macOS `say` through the MacBook
speakers, so the phone's microphone genuinely heard the phrase) found two defects that no
test in the suite could reach, because both need audio above the detector's threshold.

**The wake word crashed the app every time it fired.** The detector scored 0.749 — above
the 0.5 threshold — and the process died immediately:

```
I WakeWordService: Wake word detected: hey_jarvis (score=0.7488302)
E AndroidRuntime: java.lang.RuntimeException: Methods marked with @UiThread must be
    executed on the main thread. Current thread: DefaultDispatcher-worker-1
      at FlutterJNI.ensureRunningOnMainThread
      at WakeWordService$Companion.emit(WakeWordService.kt:327)
      at WakeWordService.onWakeWordDetected(WakeWordService.kt:452)
      ... Dispatchers.Default
```

The engine runs on `Dispatchers.Default`; `EventSink.success` is `@UiThread`. So the
app's headline feature took the app down on first use — a certain store-review failure.
`emit` now posts to the main looper, one place instead of the seven call sites, and
re-reads the sink inside the post. Re-verified: detected twice at **0.959** and **0.967**,
**0 lines** in the crash buffer, process alive, and the app opened the mic (`AudioRecord`,
16 kHz) and requested audio focus — the wake word now leads somewhere.

**One voice turn killed the API process.** With the wake word working, the session opened
and then the server exited:

```
throw new HttpError(503, 'SARVAM_API_KEY is not configured', 'STT_NOT_CONFIGURED');
HttpError: SARVAM_API_KEY is not configured
[process gone]
```

`createSttSession` throws by design when a provider is unconfigured, and it is reached from
`handleAudio`, which runs inside `socket.on('message', …)`. A throw in an EventEmitter
listener is an uncaught exception: **the first voice turn from the first user was a full
outage for every user.** The listener is now wrapped; the failure is reported on that
socket and the session closes. Verified: `warn Realtime session error —
SARVAM_API_KEY is not configured`, session closed, API still answering 200.

### The voice features cannot work in this environment, and that is configuration

The server has **no AI provider credentials**:

```
ANTHROPIC_API_KEY    sk-ant-R…E_ME   (17 chars — the literal placeholder)
DEEPGRAM_API_KEY     absent
ELEVENLABS_API_KEY   absent
SARVAM_API_KEY       absent
```

Transcription resolves to Sarvam or Deepgram and voice output to ElevenLabs
(`voice.ts:310`, `voice.ts:375`, `realtime/tts.ts:162`), and every one of those paths
refuses without its key. So on this machine: the wake word fires and the app reacts, but
**nothing can be transcribed and nothing can be spoken back** — the Converse screen shows
"The voice connection dropped" because that is exactly what happened. This is not a code
defect; it is the deployment missing its keys, and it is the same reason a store reviewer
would find the app non-functional. It also means "reply voice" could not be tested here at
all, by anyone.

```
OnePlus 9R, Android 14 (API 34), real audio through the MacBook speakers
  wake word detection        fires, scores 0.96
  app survives detection     0 crash lines (was: crash on every detection)
  API survives the turn      200 (was: process death)
  microphone after wake      opens, 16 kHz
  transcription              BLOCKED — no DEEPGRAM/SARVAM key
  spoken reply               BLOCKED — no ELEVENLABS key
  text reply                 BLOCKED — ANTHROPIC_API_KEY is a placeholder
```

### Voice, end to end, on the phone — 2026-09-20

With provider credentials supplied (AICredits for the LLM, Deepgram for English speech,
ElevenLabs for voice, Sarvam for Indic), the whole loop ran on the OnePlus with real audio
played at it from the MacBook's speakers. All four credentials authenticate; **Sarvam is
out of credit (HTTP 402 on `speech-to-text`) and the other three work.**

```
   wake word                  detected at 0.96, app survives, mic opens
   speech-to-text             deepgram, 8s / 256000 bytes
   reply                      anthropic claude-sonnet-4-5-20250929 via aicredits, 1905 in
   voice                      elevenlabs, 309 characters
   turn                       complete
   firstTokenMs 1172 · modelMs 3026
```

**The fallback chain is what made this work.** Sarvam is the routed primary for the
requested language and it failed on both legs; the server fell back and the user still got
a complete answer:

```
Streaming STT socket open
Sarvam STT reported a fatal error; awaiting the close
STT provider rejected the turn — falling back to the backup recogniser
Streaming STT socket open                       <- deepgram
Sarvam TTS stream failed
Streaming TTS primary failed; ElevenLabs is speaking this sentence instead
Realtime voice turn complete
```

The app also **says so**, which is the part I did not expect: the Converse screen carried
*"Speaking with elevenlabs — the usual voice is unavailable (TTS provider failed (402))."*
A user is told their voice changed and why, rather than silently getting a different one.

**Write tools are gated behind an approval sheet, and it works — with a caveat.**
Asking for a reminder produced *"Voice tool awaiting user confirmation"*, the
`ToolConfirmSheet` was raised, and when nobody tapped it inside 19 seconds the server
logged *"Turn aborted with approvals outstanding — refusing them"*. Refusing an unapproved
write is correct. But for a feature whose whole point is hands-free use, a confirmation
that needs a tap within ~20 seconds works against the premise — worth a deliberate
decision rather than a default.

**Small defect found on cold start.** Immediately after launch the app issued
`GET /memories`, `/reminders` and `/settings/avatars` before the stored session was
restored, and all three answered 401. It recovers, but the requests are wasted and the
screens briefly hold error state. Worth deferring those reads until auth resolves.

**An Indic-language failure is still a generic 500.** `POST /voice/stt` with `language=ta`
against an out-of-credit Sarvam returns `500 STT_ERROR — "An unexpected error occurred"`.
The process no longer dies (that was the other fix), but a user asking in Tamil is told
nothing useful; the provider's 402 should surface as "Tamil voice is unavailable right
now", the way the TTS degradation already does on the Converse screen.

### Second device finding: one user's voice turn killed the API for everyone

Reported in full above; recorded here because it is the more serious of the two.

```
   ANTHROPIC_API_KEY  sk-ant-RE…E_ME   (the literal placeholder)
   DEEPGRAM / ELEVENLABS / SARVAM      absent
```

Those are now configured in `services/api/.env`, which is gitignored and untracked — the
keys are not in the repository and must not be committed. `ANTHROPIC_BASE_URL` points at
`https://api.aicredits.in` with `ANTHROPIC_AUTH_STYLE=bearer`, which the code already
supported (it names AICredits in a comment at `services/api/src/services/ai.ts:258`).

### The wake word is now a custom, data-defined phrase — 2026-09-20

Item 1 of the roadmap: a custom wake word while the app is active. **Done and verified on
the device.**

The shipped classifier was openWakeWord's `hey_jarvis` — a phrase with nothing to do with
the product, and one the companion's name cannot change, because it is a fixed acoustic
model and no pretrained "Nova" exists. Measured against a real voice it scored **0.645**
against a 0.5 threshold, where synthesised speech scored 0.99: trained on synthetic
speech, it sits just above the line on a human one, so it fires sometimes and misses
others.

**openWakeWord is gone; sherpa-onnx keyword spotting replaces it.** A KWS wake word is a
**BPE-tokenised text file**, so the phrase is data rather than a trained artefact:

```
HEY NOVA  ->  ▁HE Y ▁NO V A :2.0
```

On the device:

```
I SherpaWakeWord: sherpa-onnx KWS started (model=wakeword/kws, keywords=…, threshold=0.25)
I WakeWordService: Wake word engine started (models: hey_nova)
I SherpaWakeWord: DETECTION! hey_nova (keyword=HEY NOVA)
I WakeWordService: Wake word detected: hey_nova (score=1.0)
```

**"Hey Nova" is detected — a phrase the previous model could never have matched.**

Four things this took, all of them worth knowing:

1. **The AAR is not on Maven Central.** It came from the k2-fsa/sherpa-onnx GitHub release
   and is vendored into `android/app/libs/`. 50 MB, three ABIs.
2. **Two ONNX Runtimes cannot coexist.** `mergeDebugNativeLibs` failed with *"2 files found
   with path 'lib/arm64-v8a/libonnxruntime.so'"*. openWakeWord and its pinned
   `onnxruntime-android` were removed rather than `pickFirst`-ed, because shipping
   whichever library won the race against a C API built for the other is not a coin worth
   flipping.
3. **The pin that was removed carried a Play requirement.** It existed because
   openwakeword resolved onnxruntime 1.18.0 at **4 KB** LOAD-segment alignment, and Play
   requires **16 KB**. The sherpa AAR's four arm64 libraries were measured at 16 KB each
   **before** the swap, so dropping the pin does not reintroduce the failure. That check is
   the one that silently breaks a submission, so it is written into the build file with an
   instruction to re-measure on upgrade.
4. **`acceptWaveform`'s second argument is the sample rate, not the sample count.** Passing
   `read` (1600) made sherpa build a 1600 -> 16000 resampler and log
   `in_sample_rate: 1600`; the model then never matched, because the features were of a
   ten-times-downsampled signal. The compiler cannot see it and no test here would; the
   device log said it plainly. A temporary heartbeat proved audio was flowing, and was
   removed once it had.

**Cost, stated plainly:** the debug APK went from ~94 MB to **212 MB** because the vendored
AAR ships `arm64-v8a`, `armeabi-v7a` and `x86_64`. A release AAB splits by ABI, so an arm64
device downloads roughly 27 MB of it — but the **AAB size must be re-measured before
submission**, because the previous one was 94.3 MB and Play caps the base download.

### Item 2 — background listening: what the device showed before it disconnected

The phone was unplugged part-way through this, so item 2 is **analysis plus one fix**, not a
completed device pass. What the evidence already shows:

```
OplusHansManager: freeze uid: 10033 com.leadup.nova … scene: LcdOff
dumpsys activity services com.leadup.nova -> 0 WakeWordService records
wake_word_enabled = true (the setting was on)
```

**The wake word stops when the screen goes off on this device**, and it is not the app's
doing: OxygenOS freezes the whole process (`scene: LcdOff`), which stops detection whatever
the service wants. Two separate causes stack up:

1. **Android's default killed the service on task removal.** `android:stopWithTask`
   defaults to `true`, so removing NOVA from Recents stopped listening — silently, with the
   setting still reading "on". Fixed: the service is now `stopWithTask="false"`, which is
   the contract a foreground service with a persistent notification is supposed to have.
2. **OEM freezing stops it anyway when the screen is off.** No manifest flag beats this;
   the user has to exclude the app from battery optimisation.

**On how to ask for that exemption.** The effective route is
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, which is **restricted on Google Play**: it is only
for apps whose core function cannot work without it, and it is a common cause of review
rejection. A wake-word service has a defensible case, but it is not a decision to make
silently inside a build — so the permission was **not** added. The lower-risk option is to
open the battery-optimisation *settings screen* from the wake-word page and explain why,
which needs no permission and no declaration. That is a product decision to take
deliberately.

### Item 2 — background listening: verified on the device

`stopWithTask="false"` was the fix, and the device confirms it across every condition the
objective names. Same build, same phrase, log evidence each time:

```
app CLOSED (task dismissed from Recents)
  I SherpaWakeWord: DETECTION! hey_nova (keyword=HEY NOVA)
  I WakeWordService: Wake word detected: hey_nova (score=1.0)
  MainActivity visible refs: 5          <- the wake word brought the app up

screen OFF (mWakefulness=Dozing)
  I SherpaWakeWord: DETECTION! hey_nova (keyword=HEY NOVA)
  I WakeWordService: Wake word detected: hey_nova (score=1.0)
  I OplusHansManager: freeze uid: 10612 com.facebook.pages.app … scene: LcdOff
```

That last line is the one worth reading twice. OxygenOS **is** freezing background apps
when the screen goes off — it freezes Facebook in the very same window — and it does **not**
freeze NOVA, because a foreground service with a persistent notification is exactly what the
platform exempts. So the earlier "the screen going off stops the wake word" was not OEM
aggression to be worked around: it was the service having already been killed by the task
swipe, and the freeze was a red herring. **No battery-optimisation exemption is needed**, and
the Play-restricted `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` permission stays out of the
manifest.

**Not yet tested:** wake word after a **reboot**. `BootReceiver` is declared and
`RECEIVE_BOOT_COMPLETED` is granted, so the path exists, but rebooting the owner's phone is
disruptive enough to ask first rather than do unasked.

**Still open on this item:**

* The wake word is now `hey_nova` in `models.json`, but it does **not** yet follow the
  **companion's name**. The phrase is data, so that is now a matter of generating a
  keywords file per name — each name needs tokenising and a false-positive check (the
  verification harness in `tools/wakeword/` does both) before it can be offered.
* The engine reports `score=1.0` on every detection. sherpa's KWS result carries no
  confidence, so the number is a placeholder; if the UI ever shows a score it should not
  show that one.
* At the time of writing the phone no longer hears the MacBook's speakers well enough to
  re-trigger (peak amplitude measured at ~-50 dBFS during the last attempts), so the final
  runs show no detection. The two logged detections above are from the same build.

### Production is running a build that predates this session — measured, not assumed

Asked why testing used the local server rather than `nova.leadup.in`, I probed the live
deployment. It is not a question of preference: **the live server does not contain the code
under test.** Side-by-side, same request, same headers:

| probe | live `nova.leadup.in` | local (current build) |
| --- | --- | --- |
| `GET /api/v1/account/deletion-preview` | **404** | 200 |
| `POST /api/v1/account/deletion-request` | **404** | 202 |
| `GET /api/v1/voice/capabilities` | **404** | 200 |
| `DELETE /api/v1/account` | **404** | route present |
| `/privacy`, `/delete-account`, `/support` | **307 to login** | 200 |
| `/api/v1/voice/realtime` (WS upgrade) | **404** | 401 (route exists, token rejected) |
| `GET /api/v1/consent`, `/memories`, `/recordings` | 401 | 401 |
| `POST /api/v1/voice/{stt,tts,chat}` | 401 | 401 |

**The last line is the one that matters.** A `404` on a WebSocket upgrade means the route is
not mounted; a `401` means it is mounted and rejected the credential. So on production the
**realtime voice socket the app uses for a spoken conversation does not exist**. The REST
voice endpoints (STT/TTS/chat) are deployed and merely unauthenticated, so those are fine —
but the socket the Converse screen opens is not there.

**Consequence for the store submission.** Both stores require a working app. Shipped against
today's production, the wake word would fire and the Converse screen would try to open a
socket to a 404 — voice would not work at all. The store-required public pages are also
still 307ing to a login page, which a reviewer treats as broken.

**What production did verify correctly.** The deployed build does isolate memories per user.
Two throwaway accounts were registered on production (`qa-probe-a-<ts>@test.example.com`,
`qa-probe-b-<ts>@test.example.com`), A wrote a memory, B listed: **B saw 0 rows and none of
A's content.** `DELETE /account` is 404 there, so those two probe accounts **could not be
removed through the API and need deleting from the database.**

### Item 3 — meeting recording over a long conversation: the pipeline works

Driven end to end on the device and through the API with a 45-second synthetic meeting (five
turns, the sort of content a real sync produces). Result:

```
status      : completed
duration    : 45s
transcript  : 712 chars, language=en
segments    : 17
summary     : 308 chars

TRANSCRIPT   "Good morning, everyone. Let us start the weekly sync. The first item is the Crm
              rollout. Thanks. The migration finished last night and kumar confirmed that the
              data looks correct. Great. I will send the proposal to Kumar tomorrow at ten,
              and I will book the venue for the off site. …"

SUMMARY      "The team held a weekly sync covering several topics including CRM rollout, an
              off-site event, candidate follow-ups, support ticket trends, and a pricing change
              decision. The CRM migration was completed successfully with data confirmed by
              Kumar, and several action items were assigned with specific deadlines."

ACTION ITEMS  Send the proposal to Kumar            (due "tomorrow at ten")
              Book the venue for the off site
              Follow up with the two candidates     (due "Thursday")
CONTACTS      Kumar
```

So the whole chain — upload → Deepgram transcription → segmentation → Claude summary →
structured action items with dates → contact extraction — works. **The consent gate works
too**: the recording cannot start until "Everyone has been told" is ticked, and the live
input-level meter shows the microphone genuinely capturing.

**Three things the objective should know about "long conversations":**

1. **There is a hard ceiling at ~17.5 minutes.** `MAX_AUDIO_BYTES` is 32 MB and the recorder
   produces WAV PCM16 at 16 kHz mono, which is 32,000 bytes/second. A meeting longer than
   that is refused by the app *before* the transfer ("This recording is … and the server
   accepts up to …"). If it falls back to AAC-LC at 128 kbps the ceiling is ~35 minutes. For
   a product whose pitch is meeting capture, a 17-minute limit is a **product decision, not
   an implementation detail** — either raise the ceiling, stream the upload, or record in a
   compressed container by default.
2. **The recording language is not user-selectable.** The Language row is read-only and
   follows the companion's language policy. An account set to "Auto-detect (Tamil +
   English)" routes transcription to Sarvam, which is **out of credit**, so those meetings
   fail to transcribe even though English would have worked through Deepgram. The UI gives
   the user no way to override it per recording.
3. **Object storage is a hard prerequisite.** With no bucket configured the upload answers
   503 and nothing is processed. The app's handling of that is excellent — it said
   *"The server could not store the audio (503): An unexpected error occurred. The recording
   row is saved, but the audio is not on the server yet."* and showed the recording id — and
   the row was left at `failed`, not stranded at `recording`, which is the fix from an
   earlier round holding good.

To test this locally, object storage was provided by MinIO
(`quay.io/minio/minio`; the `minio/minio` Docker Hub tag is no longer pullable) with a
`nova-assets` bucket, and `S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`S3_BUCKET` added to
`services/api/.env`. **Those are local test settings**, alongside the provider credentials.

Also confirmed: the upload leaves the row at **`uploaded`**, not `completed` — the
premature-completion fix from an earlier round is working on the real path.

### Item 5 — stress testing: where this system actually stops

Measured, not estimated. The headline is that the **rate limiter is the binding constraint**,
not the server: the process itself was nowhere near its ceiling at any load I could legally
send it.

```
HTTP rate limiter          exactly 100 requests succeed, the 101st is a 429
                           (per ROUTE per IP, not per IP: 5 routes = 5x the budget)
                           auth routes are stricter at 10/min
   Retry-After              34s, sent on the 429
   RateLimit-* headers      NOT sent — a client cannot see its remaining quota

database pool              max 20; 80 concurrent queries -> 0 errors,
                           p99 3.6 ms, pool drains to idle=20 waiting=0
                           (it queues rather than failing, which is correct)

throughput                 ~3,700 req/s locally for simple reads
   p50 / p99 at 40-way     3.8 ms / 10.7 ms
   p50 growth               1.7x for 40x the concurrency -> sub-linear, healthy

sustained 120s, 8 workers  1,400 ok, 759,075 rejected with 429, 200 404s
                           (the 404s were my own bad path in the harness)
   server errors            0
   RSS                      102 MB -> 91 MB   => no leak, it went DOWN
```

**The operational limits that will actually stop this product:**

| limit | value | consequence |
| --- | --- | --- |
| ElevenLabs characters remaining | **22,044** | ~73 spoken replies, or **~18 minutes of voice**, then spoken replies stop |
| Sarvam credit | **exhausted (402)** | the Indic fallback is dead, so nothing backfills ElevenLabs |
| LLM latency per turn | **~2.6 s** (1,330 prompt + 78 completion tokens) | plus STT and TTS, the user waits ~3-4 s for a spoken answer |
| LLM cost per turn | **₹0.59** | ~₹0.59 per voice turn on top of Deepgram and ElevenLabs |
| Recording upload | 32 MB (~17.5 min at 16 kHz WAV) | a longer meeting is refused before it transfers |
| Rate limiter | 100/min/route/IP | one route, and a client is done for the minute |

**Two architectural notes that follow from this.**

1. **The limiter is in-process.** `SlidingWindowStore` is a plain object in the Node process,
   so behind two instances the effective limit is 200/route/min, not 100 — the cap silently
   doubles when you scale out, and it resets on every deploy. If the limit is meant to be a
   real guarantee, it belongs in Redis, which this stack already runs.
2. **It does not send `RateLimit-Limit`/`RateLimit-Remaining`.** A well-behaved client cannot
   pace itself; it only learns the limit by being rejected. `Retry-After` on the 429 is the
   only signal.

**Reproduce with** `services/api/scripts/stress-api.py --base-url … --token …` plus the
90-line sustained-load loop recorded in this round's transcript. The harness spreads load
across routes deliberately: hammering one route measures the limiter, not the server.

### Item 6 — reminders: what "speaks everything aloud" actually means here

Testing on the device was **cut short by a blocker**: the OnePlus now sits on
`Fingerprint Unlock | Enter password` and `locksettings get-disabled` returns `false`, so a
screen credential is set and **I cannot unlock the phone**. While locked, the app renders
into a zero-sized surface (`FlutterRenderer: Width is zero. 0,0`) and never lays out, so
nothing observable can be driven from adb until someone unlocks it.

What is established from the implementation — and it is worth stating plainly, because it
decides whether the objective's final clause can be met at all:

**Notifications fire with the app dead. Speech does not.**

```
reminder_notifications.dart  zonedSchedule(..., androidScheduleMode: exactAllowWhileIdle)
                             -> Android shows it itself, with the reminder text
                             (BigTextStyleInformation(body)), app running or not

reminder_sync.dart           _armSpeaking() creates up to 8 Dart Timers that call _speak()
                             -> _speak() reads deviceTts and calls tts.speak(text)
                             -> a Dart Timer only exists while the process is alive
```

The source already says so, and says why:

> *"a scheduled notification is shown by Android itself, so it fires with the app closed.
> Nothing in `flutter_local_notifications` calls back into Dart when a scheduled
> notification is delivered — the background isolate callback only runs when the user taps
> it — so 'speak at the exact moment, with the app dead' is not achievable from Dart."*

So the honest answer to *"ensuring the application successfully speaks everything aloud to
the user as intended"* is:

| state | notification | spoken aloud |
| --- | --- | --- |
| app open | yes | **yes** (Dart timer) |
| app backgrounded, process alive | yes | **yes** (Dart timer) |
| app killed / force-stopped | yes | **no** |
| phone rebooted | yes (alarms re-registered) | **no** |

**This is a product gap, not a bug**, and it has a known fix: speaking needs to move out of
Dart and into the notification-delivery path on the **native** side — a `BroadcastReceiver`
on the scheduled alarm that starts a short foreground service and calls Android's
`TextToSpeech`, or an Android `NotificationListenerService` (which this app already has for
the notification assistant) speaking on post. Either keeps the promise with the process
dead. Until then, the app's own comment is the accurate description of the behaviour, and
the copy in the UI should not claim more than that.

**Still to verify on the device once it can be unlocked:** that a reminder due in ~60s with
the app open both posts the notification *and* speaks; that the same reminder with the app
swiped away posts the notification silently; and that the alarm survives a reboot.

### A CPU spin in the new wake-word engine — found, fixed, not yet re-measured

Chasing what looked like a "blank screen" produced something more useful. The apparent
blank was a **measurement artifact**: `uiautomator dump` returns nothing for Flutter content,
because Flutter draws to a canvas and only exposes semantics to accessibility services. So
"the UI dump is empty" never meant "the screen is blank", and I should not have read it that
way. The engine logs showed the truth — `Received frameCommittedCallback … didProduceBuffer=true`
— the app was rendering.

What was real is the **CPU**:

```
same build, same device, engine OFF (clean install)   CPU  0.0%
                        engine ON                     CPU  96-121%, RES 592 MB
busiest thread                                        DefaultDispatch  (~18-32%)
                                                      1.raster         (~28-45%)
```

`DefaultDispatch` is where `SherpaWakeWordEngine` runs its capture loop, and the loop had a
straightforward spin:

```kotlin
val read = record.read(buffer, 0, buffer.size)
if (read <= 0) continue          // <-- returns immediately, so this never yields
```

`AudioRecord.read` returns `0` or a **negative error code** (`ERROR_INVALID_OPERATION`,
`ERROR_BAD_VALUE`, `ERROR_DEAD_OBJECT`) and in those cases it returns *immediately*. Looping
straight back into it with no delay pegs a core for as long as the condition holds. The
second half of the loop had the same shape: `while (isReady(stream)) decode(stream)` with no
bound, which spins if the model ever reports itself ready without consuming anything.

Both are fixed: a read failure now logs, **backs off 50 ms**, and gives up after 500
consecutive failures rather than retrying for ever; the decode drain is capped at 64 steps per
100 ms read.

**What is *not* done: the fix has not been re-measured on the device.** Starting the engine
requires either completing onboarding through the UI or calling the service directly, and the
service is `exported="false"` — correctly, but it means `am start-foreground-service` is
refused (`Requires permission not exported from uid`). This model cannot read images, so the
onboarding taps cannot be driven reliably. **The fix is correct on inspection and addresses a
defect whose symptom I measured; the confirmation that it removes the spin is outstanding and
should not be assumed.**

### Also fixed while investigating: a splash screen that could hang for ever

`splashReadinessProvider` caught only `AuthException`. Anything else thrown during the startup
refresh — a raw socket error, a timeout, or anything from `saveSession` — escaped the provider
and left it in an **error** state. `_SplashPageState.build` reads `readiness.asData?.value`
and had **no error branch**, so on an error `resolved` stayed null, navigation never ran, and
the app sat on the splash animation with no message and no way out.

That is a real latent hang regardless of whether it is what I saw, and it is now closed twice
over: the provider catches everything and falls through to the signed-out destination, and the
page has a last-resort branch that navigates to `/login` if the provider is ever in an error
state.

**A note on method.** Two of this round's detours came from reading a measurement as a fact:
an empty accessibility dump as a blank screen, and a single CPU sample as a trend. The engine
logs and the 0%-vs-100% A/B were what settled it.

### The busy-spin guard is now a unit test, not a comment

The CPU-spin fix from the previous round was correct on inspection but could not be
re-measured on the device (the engine only starts after onboarding, and the service is
`exported="false"` so adb cannot start it). That gap is now closed at the level that matters:
the loop no longer contains the raw logic that spun — it calls a pure function, and that
function is tested.

`SherpaWakeWordEngine.decideRead(read, consecutiveFailures)` reduces a read result to
`Proceed` / `Retry(backoffMs)` / `GiveUp`. The loop switches on it. The JVM test
`SherpaWakeWordEngineTest` (5 cases) pins the two invariants that prevent the spin:

```
aPositiveReadProceedsImmediately        PASSED
aFailedReadBacksOffInsteadOfSpinning    PASSED   <- the back-off, not a tight loop
aNegativeErrorCodeAlsoBacksOff          PASSED   <- ERROR_DEAD_OBJECT etc.
enoughConsecutiveFailuresGiveUp         PASSED   <- a bounded, not unbounded, retry
aRecoveryAfterFailuresResets            PASSED
```

`./gradlew :app:testDebugUnitTest --tests com.leadup.nova.SherpaWakeWordEngineTest` runs it.
A compiler could never catch the original bug (it was a *logic* error in a coroutine loop);
the device is what found it, and this test is what keeps it from coming back.

This leaves exactly one item of the roadmap genuinely unfinished:

* **Item 6 — reminders** could not be tested on the device. The phone was locked, then the
  CPU-spin investigation consumed the round. What *is* established (and recorded) is the
  design truth: the notification fires with the app dead, but **speaking aloud only happens
  while the process is alive**, because `flutter_local_notifications` has no delivery
  callback in Dart. Confirming the open/background/closed matrix on the phone — and deciding
  whether to move speaking into a native service so it also fires with the app dead — is the
  remaining work.

### The reminder roadmap, closed out as far as it can be without the device UI

Item 6 (reminders) is the one item that could not be finished on the phone, and the reason
is concrete: the device sits mid-onboarding (`onboarding_status: inProgress`) and the
session cannot be seeded because it lives in Keystore-backed `flutter_secure_storage`, which
`run-as` cannot write. Completing onboarding requires tapping through a UI that cannot be
read here (this model has no image input), and the wake-word service is `exported="false"`
so adb cannot start it either.

What is pinned in code, which is what survives the device:

* **The notification fires with the app dead.** `reminder_reconciliation_test.dart` (8+
  cases) covers scheduling, stable ids, idempotency, exact-vs-inexact degradation, the
  notification switch, and that the body carries the reminder text.
* **Speaking aloud only happens while the process is alive**, and the code says so — see the
  `ReminderSyncController` doc comment. This is inherent to `flutter_local_notifications`
  (no Dart callback on delivery), not a bug.
* **The one product decision left open:** whether "speaks everything aloud as intended"
  requires speaking *with the app killed*. If yes, that means moving speech out of Dart into
  a native `BroadcastReceiver`/foreground service that calls Android `TextToSpeech` on the
  scheduled alarm. That is new work, not a fix, and it is the user's call.

**Roadmap status, all in one place:**

| # | item | state |
| --- | --- | --- |
| 1 | custom wake word, app active | ✅ "HEY NOVA" detected on device |
| 2 | background listening (closed / screen off) | ✅ verified |
| 3 | meeting recording, long conversations | ✅ full pipeline; 17.5-min ceiling flagged |
| 4 | memory storage | ✅ secure, local + live production |
| 5 | stress testing / performance limits | ✅ rate limit, DB pool, quotas, no leak, cost/latency |
| 6 | reminders voice + push, all conditions | ◐ notification proven; speech-while-dead is a design gap |

Gates: build 27 · typecheck 31 · test 35 · lint 25 · `flutter analyze` clean · `flutter test`
622 passing (5 skipped) · the new `SherpaWakeWordEngineTest` (5 cases) via Gradle.

Still **not** done, and not doable from the repository: the Play Console Data safety
form, the foreground-service declaration (which needs a demo video), the content-rating
questionnaire, App Store Connect's privacy questionnaire and review notes, a demo
account for reviewers, and enrolling in Play App Signing. Also still outstanding:
`ios/Podfile` and `Podfile.lock` are **untracked**, so a fresh clone cannot
`pod install`; and `ios/Runner/GoogleService-Info.plist` is a placeholder that is not
bundled, so iOS crash reporting and analytics remain off.

### Production, checked directly (2026-09-19)

```
https://nova.leadup.in/download.apk      HTTP 200 · 46,542,555 bytes (44.4 MB)
  aapt2 dump badging                     package com.leadup.nova · versionName 1.0.0 · label NOVA · targetSdk 36
  unzip                                  classes.dex, lib/arm64-v8a/{libapp,libflutter,libonnxruntime}.so,
                                         assets/flutter_assets/*
https://nova.leadup.in/                  HTTP 307 → /login?next=%2F
https://nova.leadup.in/health/           HTTP 200  (admin service)
https://nova.leadup.in/health/ready      HTTP 200
https://nova.leadup.in/api/admin/ready   HTTP 200
POST /api/v1/auth/login (unknown user)   HTTP 401 INVALID_CREDENTIALS  ← the database is reachable
```

The download link resolves and serves the real arm64 release build: `com.leadup.nova`
1.0.0 with the openWakeWord ONNX runtime (18.2 MB of `libonnxruntime.so`) inside it.

**Production's own health endpoint was the one thing lying.** `/health/` answered
`{"status":"degraded","dependencies":{"database":{"status":"down"}}}` while a login
against the same database returned a proper 401. The check was fire-and-forget
(`pool.query(...).then(...)`, with the response built from the value *before* the await
resolved), so it said "down" whatever the database did; `redis` and `storage` were
hardcoded `'up'` in a service that has neither client. Fixed and verified in both
directions — see the repair log.

### Repair log (2026-09-19)

Twenty-two defects were found by running the gates and the services rather than
reading them, and fixed:

| Defect | What it was | Fix |
|---|---|---|
| `pnpm run lint` failed in every workspace package | ESLint 9 no longer reads `.eslintrc.js`, so each `eslint src/` aborted with *"couldn't find an eslint.config.(js\|mjs\|cjs) file"*; `next lint` crashed with *"Converting circular structure to JSON"* serialising the same legacy file | Added a root `eslint.config.js` (flat) and per-app configs for `apps/web` (via `FlatCompat`, its Next 15 config is still legacy) and `apps/admin` (Next 16 flat config); switched both apps from the deprecated `next lint` to `eslint src` |
| Redis port silently became `NaN` | `Number(process.env.REDIS_PORT) ?? 6379` — `Number(undefined)` is `NaN`, and `NaN ?? x` is `NaN`, so the default never applied | `Number(process.env.REDIS_PORT ?? 6379)` in `services/workers/src/index.ts` and `queues.ts` |
| Briefing speech regex | `\u{FE0F}` and `\u{200D}` sat inside a character class, where they are combining characters — `no-misleading-character-class` was right to flag it | Moved both to alternatives; matching behaviour is unchanged |
| Admin skeleton flickered | `Math.random()` was called during render, so widths changed on every re-render | Fixed width table; render is pure |
| Admin sidebar cascading render | `setState` inside a mount effect forced a second render on every mount | `useSyncExternalStore` over `localStorage`, with a stable server snapshot for SSR |
| Five tables in the canonical schema had **no migration** | `packages/database/src/schema.ts` declared `notification_preferences` and the four `lead_*` tables, but `drizzle/` contained no migration that created them. A freshly migrated database therefore lacked all five, and `GET`/`PATCH /api/v1/settings/preferences` answered **500 `42P01`** against it — the endpoint only appeared to work on a database somebody had patched by hand | Generated `drizzle/0003_steady_archangel.sql` with `drizzle-kit generate` and reviewed it: it is create-only (5 tables, 7 foreign keys, 7 indexes, no drops or rewrites). Applied it, then confirmed `GET` returns the defaults, `PATCH` persists a partial update without resetting the other fields, and a re-`GET` reads the change back |
| Every Docker Compose file was invalid YAML | `docker-compose.yml` had every key at one space, so `image` was a sibling of the service names and Compose refused it: *"mapping key \"image\" already defined at line 3"*. `make docker-up` was therefore dead. `docker-compose.e2e.override.yml` had the same flattening, and `docker-compose.dev.yml` was `services:` with nothing under it (*"services must be a mapping"*) — even though the e2e overlay named it as its base | Re-indented `docker-compose.yml` and the e2e overlay; `docker-compose.dev.yml` is now a valid empty overlay; the e2e overlay's documented base is `docker-compose.yml`, which is the file that actually defines the services it overrides. `docker compose -f docker-compose.yml config -q` and the overlay combination both pass |
| `make` did not run at all | Every recipe was indented with a space rather than a TAB (*"Makefile:9: *** missing separator"*). Three targets also could never work: `db:migrate`/`db:seed`/`db:generate` contain a colon, which Make reads as its rule separator (*"multiple target patterns"*), while `type-check` called `pnpm run type-check` (the script is `typecheck`) and `db:seed` called a root script that does not exist | Rewrote the file with TAB recipes and renamed the colon targets to `db-migrate`, `db-seed`, `db-generate`; `db-seed` now runs `services/api/scripts/seed-admin.mjs`. `make help` lists 23 targets and every one parses |
| The tracked CI workflow could not load | `.github/workflows/ci.yml` had the same one-space flattening, so GitHub Actions could not parse it. It also called root scripts that do not exist (`format:check`, `type-check`, `test:unit`, `security:audit`, `test:e2e`) and pinned `pnpm/action-setup` to `11.24.0` while `packageManager` is `pnpm@9.15.0` | Re-indented it, pointed the steps at the real scripts (`pnpm run lint`, `pnpm run typecheck`, `pnpm run test`, `pnpm exec playwright test`), set pnpm `9.15.0`, and kept the security scans with `pnpm audit --audit-level=critical` (the deferred `drizzle-orm` advisory is *high*, and would otherwise fail the pipeline). Parses as 6 jobs |
| All ten Kubernetes manifests were broken | Six failed to parse at all. **Four more parsed but were semantically wrong**, which is worse: `redis.yaml` put `template` as a sibling of `spec`, leaving `spec.template` empty and `spec.selector` null while duplicate keys silently overwrote each other; `namespace.yaml` never applied its labels; `configmap.yaml` and `secret.example.yaml` only survived because every key under `data`/`stringData` was a flat sibling | Re-indented all ten against the Kubernetes schema. Verified: every file parses, every `Deployment` has `selector.matchLabels`, a pod template with labels, containers, images and ports, and named probes; every `Service` has ports and a selector; the `HorizontalPodAutoscaler` has `scaleTargetRef` and nested metrics; the `Ingress` has TLS and per-path backends; the PVC/Namespace shapes are intact. `kubectl` is installed but there is no cluster here, so this is schema-shape validation, not a live apply |
| `workflow-engine` had no HTTP entry point | The container was deployed (`nova-workflow-engine`, `EXPOSE 3010`) with a health router and JWT middleware on disk, but nothing that listened. The Dockerfile's `CMD ["node", "dist/index.js"]` ran `src/index.ts`, the job-registry **library** — no event loop, so the container exited immediately and could never be healthy. `dev` pointed at the same missing `src/server.ts` | Added `src/server.ts` mounting the existing `healthRoutes`, listening on `PORT` (default 3010) with SIGTERM/SIGINT shutdown; Dockerfile `CMD` is now `node dist/server.js`; moved `express`/`cors`/`helmet` from `devDependencies` to `dependencies` (the runtime image installs `--prod`). Verified by running it: `/health`, `/health/live` and `/health/ready` all answer |
| Importing `@nova/auth` validated the whole auth environment | `src/env.ts` and `src/utils/env.ts` each called their schema at module scope, and `index.ts` did `void validateEnv()` on import. `authenticateJwt` lives in that package, so any service importing it needed `JWT_REFRESH_SECRET`, `API_KEY_SECRET` and `AUTH_ENCRYPTION_KEY` it does not have — `services/integration-service` **died on an import**, before serving anything | `env` is now a lazily-validating proxy (first property read), `jwt.ts` reads `JWT_SECRET` and the TTL defaults directly instead of the full schema (and drops `REFRESH_SECRET`, which was read and never used), and `validateEnv()` runs inside the `isEntryPoint` branch so the auth server still fails fast on start. Verified: auth 27/27 tests, `verify-auth.py` 24/24 against the live API, and `integration-service` now boots with only `JWT_SECRET` set and answers `/health/live` 200 |
| `dev` scripts pointed at files that do not exist | `workflow-engine` (now fixed), `integration-service` and `agent-orchestrator` all ran `tsx watch src/server.ts`, but their entry points are `src/index.ts` — so `pnpm dev` failed for each | Pointed them at the real entry points |
| The installed workspace tree did not match the manifests | `services/auth` declares `dotenv` but `services/auth/node_modules` had no link for it, so any process resolving through `services/auth/dist` threw `ERR_MODULE_NOT_FOUND`; `pnpm install --frozen-lockfile` also refused the tree, because the lockfile predated declared dependencies. `integration-service` could not start | Ran `pnpm install --no-frozen-lockfile`, which linked the missing packages and brought `pnpm-lock.yaml` back in sync (offline, all reused from the store). Re-verified `integration-service` and `workflow-engine` boot |
| `integration-service` could not authenticate in production | `docker-compose.prod.yml` gave it `DATABASE_URL` and `REDIS_URL` but no `JWT_SECRET`, while every one of its routes is mounted behind `authenticateJwt` — so even the honest 501 would have failed at the auth step | Added `JWT_SECRET: ${JWT_SECRET:?...}` to its environment |
| `MODULE_TYPELESS_PACKAGE_JSON` warning on every boot | `workflow-engine` and `integration-service` emit ES modules but declared no `type`, so Node reparsed the output on every start (a real performance cost and a warning on a read-only container's log) | Added `"type": "module"` to both, joining `services/api` and `services/auth`. Verified the warning is gone from both logs |
| The admin health endpoint reported the database as **down while it was up** | `services/admin/src/routes/health.ts` started the ping without awaiting it and built the response from the pre-await value, so `database` was always `"down"`; `redis` and `storage` were hardcoded `"up"` in a service with neither client. Production served that exact false alarm. The router was also never mounted by `src/index.ts` (which defined its own `/health/live`), so a clean build could not even reach it | Made the handler `async`, awaited `SELECT 1` behind a 2 s timeout, removed the two dependencies it never checked, and mounted `healthRouter` at `/health` with the duplicate inline route deleted. Verified both directions: local Postgres → `healthy`/`database: up`; unreachable URL → `degraded`/`database: down` |
| `/api/admin/ready` answered `ready` without checking anything | It returned `{"status":"ready","dependencies":{"database":"ok","cache":"ok"}}` unconditionally — a readiness probe that cannot go red, and a `cache` key for a service with no cache client | It now pings the database and returns **503 `degraded`** when the ping fails, with only the dependency it actually checks. Verified 200/`database: up` against local Postgres and 503/`database: down` against an unreachable URL |
| The realtime gateway's HTTP surface was one static string | `src/server.ts` installed a handler that answered **every** path with `{"status":"ok","service":"realtime-gateway"}`, so `/live` and `/ready` were the same answer, unknown paths got 200, and `src/routes/health.ts` — which does check Redis — was never mounted | Replaced the static handler with an express app that mounts `healthRoutes` and 404s anything else. Verified: `/live` 200, `/nope` 404, `/ready` 200 `redis: up` with a real Redis and **503 `redis: down`** without one |
| The gateway forced TLS on every production Redis | Both the token denylist and the rate limiter passed `tls: {}` whenever `NODE_ENV === 'production'`, which makes ioredis attempt a TLS handshake against a plaintext server. A normal production Redis was therefore unreachable: revocation silently fell back to memory and rate limiting to a per-process map | TLS now follows the URL scheme (`rediss://`), which ioredis handles itself. Verified against a real Redis container: `/ready` reports `redis: up`; the ping is also bounded at 2 s so a dead Redis answers `down` instead of hanging the probe |
| The gateway could not start in development | `src/utils/logger.ts` switches on `pino-pretty` whenever `NODE_ENV !== 'production'`, but `pino-pretty` was not a dependency of the package (only `services/api` declared it), so `node dist/index.js` and `pnpm dev` both died with *"unable to determine transport target for pino-pretty"* | Declared `pino-pretty` as a `devDependency` (the image installs `--prod` and runs `NODE_ENV=production`, so it is unaffected) and gave the package `"type": "module"`, removing the reparse warning |
| `docs/api/openapi.yaml` was unreadable | 1,376 lines flattened to a single space of indentation, so only the six top-level keys were at column 0 and every nested key was a sibling. YAML rejected it outright (*"expected <block end>, but found '?'"*), which is why nothing could use the Admin service contract | Reconstructed the nesting from the file's own key sequence and adopted it. It now parses with **no duplicate keys**, all **70 `$ref`s resolve**, there are 24 paths / 32 operations (each with `responses`) and 23 component schemas. One structural correction beyond indentation: the `responses` block sat at the document root while 36 refs point at `#/components/responses/...`, so it moved under `components`, where OpenAPI requires it |

### Repair log — 2026-09-20 (app + admin panel)

The owner's focus moved to "the app and admin panel, production-ready and smooth". Four
read-only audits (mobile, admin console + admin API, requirements compliance, security)
were run first; this is what they found and what was fixed.

| Defect | What it was | Fix and evidence |
|---|---|---|
| The admin API had authentication but **no authorization** | `/api/admin/*` mounted only `authenticateJwt`, which answers "is this token valid?", never "is this person an admin?". The default role for a self-registered account is `user`, so any signed-in user could read and mutate users, organizations, feature flags, policy rules, roles and workspaces | `const adminOnly = [authenticateJwt, requireRole('owner','admin')]` on all nine data mounts, health probes left public. **Verified live:** a normal user token → `403 {"title":"Forbidden — requires role: owner or admin"}`; an owner token reaches the handler |
| Every `/api/admin/*` data route **fabricated success** | `users.ts` answered `{users: [], total: 0}`, and the other seven route files returned invented payloads with zero database access. The console does not call them (it uses `services/api`'s `/api/v1/admin/*`), but they were publicly reachable | All nine now answer **501 NOT_IMPLEMENTED** with a detail naming the real API. Verified live for all nine paths |
| `@nova/auth`'s `authenticateJwt` queried a schema that no longer exists | `findRoleByKey` (`roles.key`), `findSessionByToken` (`sessions.token_hash`, `status`) and `findUserById` (`users.deleted_at`) do not match the canonical schema (`roles.slug`, `sessions.refresh_token_hash`/`revoked_at`, `users.disabled`). **Every** request through `services/admin` and `services/integration-service` died with `column "key" does not exist` and answered 500 — owner tokens included | Claim-based like `services/api`'s middleware: signature (HS256 pinned) + `jti` denylist authority, role from the token, user from the token. Verified: auth 27/27, `verify-auth.py` 24/24, and the admin API now serves authenticated requests |
| An unreachable Redis **crashed the admin API** and broke the test gate | The auth module created an ioredis client at import with **no `error` listener**, and `rate-limit-redis` loads its Lua scripts *in the constructor* as a floating promise — so a Redis outage produced unhandled rejections, then `MaxRetriesPerRequestError`, which killed the process. In `vitest` it failed the suite while all 27 auth tests passed | Wrote a `FailOpenRedisStore` (plain `INCR`/`PEXPIRE`, no scripts, in-memory fallback on error), added the `error` listener, `passOnStoreError` on both limiters, and process guards in `services/admin`. **Verified:** `turbo run test --force` is now **35/35 with 0 unhandled errors** (it was 30/35 with 4) |
| The admin console **could not display a failure** | Every data page did `try { … } catch { return null }` and rendered `result ?? []`, so a 401, a 500 or an unreachable API were indistinguishable from an empty table. Production proves it: `curl -H 'Cookie: admin_token=not-a-jwt' https://nova.leadup.in/users` returned **200 with "No users found"** | Added `lib/page-data.ts` (`loadPage` → ok/error) and `components/PageError.tsx`, and converted the users/organizations/incidents/feature-flags/audit-logs pages. **Verified against a production build:** the same bogus cookie now renders **"Could not load users"** and no empty-state text |
| The console asked for 50 rows, got 20, and printed that as the total | `limit: 50` is not in the API's query schema, which accepts `page`/`pageSize` and strips unknown keys, so it silently used the default 20 — while the header said `20 total users` | `requestListPage` sends `pageSize`, and the users page renders the real `totalItems`/`totalPages` with previous/next links |
| Two ways for a data page to crash | `audit-logs` used a non-null assertion into a three-key colour map, so a fourth `outcome` value from the database threw `undefined.bg`; and there was no `app/error.tsx`, so any render throw landed on Next's bare production error page | Neutral fallback for an unknown outcome, plus a route-level `app/error.tsx` with a retry |
| `services/admin` CORS was hard-coded to localhost | `['http://localhost:3000','http://localhost:3004','http://localhost:3005']` — so the deployed origin got no `Access-Control-Allow-Origin` while a laptop did. `docker-compose.prod.yml` has always set `CORS_ORIGIN`; nothing read it | Allow-list from `CORS_ORIGIN`; empty in production when unset, localhost defaults only outside production |
| `services/admin`'s env contract was written but never enforced | `src/utils/env.ts` validates `DATABASE_URL` and `JWT_SECRET` at import and **no module imported it**, so a missing `JWT_SECRET` surfaced as a 500 from the auth middleware instead of a named variable at boot | Imported at the top of `index.ts` |
| `services/admin` had tests that never ran, written against an API that never existed | The package had **no `test` script**, so Turbo skipped it. When run, all six tests failed: they imported `authenticateJwt`/`requireRole` from a module exporting neither, and one imported `../src/middleware.ts` from a path that does not exist | Rewrote both suites against the real exports (`requirePermission`, `errorHandler`, `HttpError`, `createError`), declared `vitest`, and added the `test` script. **Verified:** 7/7, and the package is now part of `turbo run test` (35 tasks instead of 34) |
| Every write button in the admin console was a dead end | The feature-flag create/toggle forms posted to `/feature-flags/create` and `/feature-flags/{key}/toggle`, and the incident Resolve button to `/incidents/{id}/resolve`. **None of those routes exists** — `apps/admin/src` has no `route.ts` at all — while the three API helpers they should have called (`createFeatureFlag`, `updateFeatureFlag`, `deleteFeatureFlag`, `resolveIncident`) were imported and never used | Added `feature-flags/actions.ts` and `incidents/actions.ts` as server actions calling those helpers, wired the forms to them, and surfaced failures through `?error=` banners. The console builds with the actions in place |
| `apps/admin` had **zero tests** | `vitest run` reported "No test files found" and exited 0 because `passWithNoTests` was on, so the whole login → token → guard → fetch → refresh path was unasserted | Added `src/__tests__/page-data.test.ts` (7 tests) covering the success path, real pagination, and the 401/503/unknown-status/transport failure messages. The package now runs in `turbo run test` |
| The mobile client retried **non-idempotent** writes | `NetworkService` sent every verb through the same retry helper, so a POST that timed out after the server applied it could create a second task, reminder or memory — and a failed write took ~30 s to surface | `_executeWithRetry` takes `idempotent:`; only GET/PUT/DELETE set it. The pre-send offline wait still applies to every method. Tests updated: a POST send-timeout is attempted **once**, a GET 500 is retried to `maxAttempts` |
| Recording uploads were un-uploadable on a slow link | dio budgets `sendTimeout` over the **whole** body write and the client default was 10 s, so a multi-minute WAV could never finish; the meeting path also lacked the `maxUploadBytes` pre-check its call-recording sibling had | `_postBytes` passes `sendTimeout: Duration.zero` (dio only arms the timeout above zero; connect/receive timeouts still apply), and the recording controller now checks the server's ceiling before transferring and says how large the file is |
| The admin console's session gate only asked whether a cookie **existed** | `middleware.ts` tested `if (!token)` and nothing else, so `admin_token=not-a-jwt` rendered the entire console chrome and its server-side data fetches (production returned **200** for `/users` with that cookie), and the mirror cookie lived for **a year** with no `Secure` flag while the access token expires in 15 minutes | The middleware now decodes the token's claims and rejects an expired token or a non-admin `role`, clearing the cookie on the way to `/login` (and *not* redirecting from `/login`, which would loop). The cookie is `Secure` over HTTPS with a one-hour lifetime. **Verified live:** bogus cookie on `/users` → 307 `/login?next=%2Fusers` + `Set-Cookie` clearing it; bogus cookie on `/login` → 200 login form + cleared; expired token → 307; valid owner token → 200 with real data. Signature verification stays where it belongs — `services/api`'s `requireAdmin` on every admin request |
| The dashboard misreported platform health | It printed `health?.checks?.length ?? 0` + " checks", but `services/admin` answers `dependencies`, never `checks`, so it always said **"0 checks"**; "API Version" was hardcoded `v0.1.0`; and `healthColor` had no case for `ready`, so a perfectly ready service rendered grey | Reads both shapes (`checks` and `dependencies`), shows the real dependency count, takes the version and timestamp from the payload, and treats `ready`/`ok`/`up` as healthy. **Verified live:** the rendered dashboard no longer contains "0 checks" or the hardcoded version, and it lists the actual `database` dependency |
| The designed offline screen was unreachable | `router.dart` declares `/offline` as a surface "reachable under every gate" and the page has existed all along, but nothing ever navigated to it — losing connectivity showed the ordinary screens with "Not reachable" cards instead | `NovaApp` subscribes to `onConnectivityChanged` and checks `isConnected` once after the first frame (so a cold start that is already offline is covered), routing to `/offline` and back through the router's normal gates. **Verified:** a new widget test drives the fake connectivity stream off and on and asserts the offline page appears and then a signed-out user lands on login |
| The wake word never opened a conversation | `WakeWordService.kt` emitted the detection, `WakeWordController` set the orb to "listening", and its comment said *"the conversation flow is started by whatever listens to `lastDetection`"* — nothing listened | Wired in `app.dart`: a detection in the foreground with no active turn navigates to `/converse` and starts a turn. The decision rule is a pure function (`core/voice/wake_word_session.dart`) with **6 new unit tests** covering background, mid-turn and duplicate detections |
| "Proactive spoken updates" never happened | A captured notification only filled an in-memory inbox; the single `speak()` call site was a manual tap on the assistant screen | A high-priority notification is now spoken **as it arrives**, behind both gates the design requires (persisted `readAloudEnabled` and the non-persisted per-session confirmation), with the content guard re-run immediately before speech |



These were found by validating every YAML file in the tree with a real parser. They are
**not fixed**, because fixing them means deciding what they should say, not just how
they should be indented. They do not affect the API, the mobile app, or any gate above.

### Test reliability

One mobile test, `recording_page_test.dart` → *"starting records the consent and shows
the live indicator"*, failed in one full-suite run and passed in the next. It left the
fake-async zone with a fixed **100 ms** budget for real file and network I/O, which was
enough on an idle machine and not enough under a full suite's load — the worst kind of
failure, because it reports a product bug that is not there. It now waits an order of
magnitude longer than the observed need (1 s) inside the real-async zone, because the
whole start flow must complete there rather than being left mid-flight for the fake clock
to stall. Re-verified by running the full Flutter suite **concurrently with the Turbo
test gate** (the load that produced the flake): 587 passed, 5 skipped.

### Independent verification of the 2026-09-20 fixes

A second agent re-checked the round-5/6 changes against running services rather than
against the code comments, and found three real defects in that work. All three are
fixed; the report is kept because the failures are instructive.

| Claim checked | Verdict | What the check found |
|---|---|---|
| `services/admin` requires `owner`/`admin` on every data route while health stays public | **Verified** | Rebuilt and run with locally minted HS256 tokens: no token → 401, `role:user` → 403, `role:admin`/`owner` → 501, `role:super_admin` → 403, `/api/admin/live` and `/ready` → 200. `POST` also 501 |
| `@nova/auth`'s `authenticateJwt` no longer queries the database | **Verified, one gap** | No repository imports remain and a service boots with only `DATABASE_URL` + `JWT_SECRET`. Gap: `services/auth/src/utils/security.ts` called `jwt.verify(token, secret)` with **no `algorithms`** — dead code, now pinned to HS256 on both sign and verify |
| The console distinguishes failure from empty | **Partial → fixed** | `/users` was right, but **four of five pages rendered the empty-state string next to the error card**: the table and its "No … found" row were outside the `result.ok` branch. Fixed with an early return on failure in organizations, audit-logs, incidents and feature-flags (usage already returned early). Re-verified against a live API with a bogus cookie: every page now shows the error card, **zero** empty-state strings, the "session has expired" message and a "Sign in again" link |
| — | **Second defect found** | `lib/api.ts` threw a plain `Error` with the HTTP status only inside the message string, so `page-data`'s 401/403/500/503 mapping and the sign-in link were dead, and a reached-but-401 API was reported as "Could not reach the admin API". The thrown error now carries `status`, which is what made the live re-check above show the session message |
| Console write actions are real server actions | **Verified** | Forms call `createFlagAction`/`toggleFlagAction`/`resolveIncidentAction`; no route target remains (`route.ts` count is zero); every `redirect()` sits outside its `try`, so none can be swallowed |
| Mobile retries only idempotent methods | **Verified** | GET/PUT/DELETE set `idempotent: true`, POST/PATCH do not; the pre-send offline wait still runs for all verbs; `_postBytes` passes `sendTimeout: Duration.zero`, which dio only arms above zero |

Two caveats the verifier raised that are **not** defects:

- `pnpm --filter @nova/admin build` does not rebuild its `@nova/auth` dependency, so a
  stale `services/auth/dist` can be loaded. `pnpm run build` (Turbo) builds dependencies
  first, which is the documented path; the filter command is for iterating on one package.
- The mobile `AuthInterceptor` replays **any** method once after a 401 to refresh the
  token. That is safe: a 401 means the request was rejected, so the replay cannot be a
  duplicate write. It is a different mechanism from the transport retry fixed above.
- `deleteFlagAction` exists but no form calls it — there is still no delete button in the
  feature-flags table.

### Known broken files that are not on the product path

| File | Problem |
|---|---|
| `.github/workflows/maestro-e2e.yml` | Invalid YAML *and* structurally incomplete: the second job has no job key — its steps start at the top level after `build-apk` ends. It is also Expo-era (`fix-android.js`, placeholder Expo assets, `EXPO_*` env) while the app is Flutter, and the `apps/mobile/.maestro/flows/*.yaml` files it runs **do not exist**. It is untracked, so GitHub does not load it, and Flutter CI is covered by `android.yml` and `build-apk.yml`. |

Known issues that are **not** store-policy violations but are still open:

| Item | State |
| --- | --- |
| `ios/Podfile`, `ios/Podfile.lock` untracked | A fresh clone cannot `pod install`. They exist in this working tree; they need to be added to version control. |
| `ios/Runner/GoogleService-Info.plist` is a placeholder and is not in `project.pbxproj` | Not bundled, so iOS crash reporting and analytics are off. Android's equivalents are real and live. |
| `armeabi-v7a/libonnxruntime4j_jni.so` is 4 KB-page aligned | Compliant today (the 16 KB rule applies to 64-bit, and all arm64-v8a/x86_64 libs are ≥ 16384). Play enforcement for updates is 2027-02-01. |
| No `dataExtractionRules` | Superseded by `android:allowBackup="false"`, which is stricter. |
| `deleteFlagAction` exists but no form calls it | Still no delete button in the feature-flags table. |
| Crashlytics/Analytics collect in release gated only on `!kDebugMode` | Disclosed in the privacy policy and in the Data safety answers, but there is no consent gate; a EU release should revisit it. |
| Foreground-service declaration, Data safety form, content rating, ASC privacy answers, review demo account | Console-side only. Not derivable from the repository. |

Everything else that was flattened has been repaired, or is a plain-JavaScript/JSON
file where the indentation is cosmetic — including all ten Kubernetes manifests, which
were checked for schema shape as well as parseability, and `docs/api/openapi.yaml`. The
full YAML scan now reports every file valid except the one above.

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

Now emitted as **parseable JSON** through pino, with secrets redacted. The rates are
configuration, not code: `VOICE_COST_*` in `services/api/.env.example`, all commented
out because they are contract figures this repository does not know. Unset means the
leg is logged as `null`, never as `0`.

---

## Earlier findings, and where each one stands now

The revision of this document that preceded this one reported the following. They are
kept because they are the record of what drove the work; the status column is what is
true now.

| Earlier finding | Status now | Evidence |
|---|---|---|
| Requirement 3 — notification monitoring is not implemented; `NotificationListener.kt` only calls `Log.d` | **Fixed** | `NovaNotificationListenerService.kt` (294 lines) extends the platform's `NotificationListenerService`; the manifest declares it with `BIND_NOTIFICATION_LISTENER_SERVICE`; `notification_controller.dart` drives it; `test/features/notification_controller_test.dart` asserts the wiring |
| Requirement 6d — integration sync returns `status: 'connected'` having done nothing | **Fixed** | `services/integration-service/src/routes/integrations.ts` answers **501** `NOT_IMPLEMENTED` for connect/disconnect. The service is also unrouted, so nothing public can call it |
| §5.7 — the tool confirmation sheet is bypassed by voice | **Fixed** | `lib/core/voice/voice_tool_approval.dart`; `VoiceRealtimeController.decideApproval` sends an approval response over the voice protocol, and `voice_protocol.dart` carries the approval-request event. A tool the gate stops is reported as stopped, not as a tool failure |
| The stub routes that returned HTTP 200 with "implementation pending" | **Fixed** | `subscriptions.ts` is mounted (`server.ts:88`) and backed by real entitlement data; `upload.ts` and `webhooks.ts` answer **501** `NOT_IMPLEMENTED` instead of a success envelope |
| Requirements 6a/6b/6c/6d — "not implemented" | **Built** | 6a: `NovaDeviceControl.kt` (465 lines) + `DeviceControlCatalog.kt` + the `device_control` feature. 6b: `recordings-capture.ts`, `recording-pipeline.ts`, `meeting-summary.ts`. 6c: SAF folder access via `NovaCallRecordingFolder.kt` / `NovaCallRecordingFiles.kt` / `CallRecordingFolderPolicy.kt`. 6d: `routes/briefing.ts` + `services/briefing.ts` + the `briefing` feature |
| Memory semantic search is a stub | **Still true — the one open code gap** | `packages/memory/src/search.ts` returns `false` from `hasEmbeddingsForUser()` and `services/api/src/services/ai.ts:487` returns an empty embedding (the Anthropic SDK has no embeddings endpoint, and no `OPENAI_API_KEY` is configured). **Text search works**; vector search does not run, and `memory_embeddings.embedding` is `jsonb`, so the `::vector` cast in the unused branch would also need to change before it could |
| Wake word phrase is not configurable | **Fixed** | `WakeWordModelSelection.kt` (26 lines) reads the manifest; `PATCH /api/v1/device/wake-word/config` validates the request against the models the device reports as installed, and `src/__tests__/device-wake-word.test.ts` covers that rejection (13 tests). Only one classifier ships, so the choice is real but currently one option wide |
| The repository does not build; 14 packages import dependencies they never declare | **Fixed** | `pnpm run build --force` is 27/27 and `pnpm run typecheck --force` is 31/31. A rescan of every live workspace package for imports absent from its own manifest is **clean**; the remaining hits are the five quarantined dead services plus the API's deliberate optional `import('openai')`, which is caught and reported as "not installed" |

---

## Documented but never executed

`docs/operations/secrets-rotation.md` lists `JWT_SECRET`, `REFRESH_TOKEN_SECRET` and
`AUTH_ENCRYPTION_KEY` with a 90-day rotation policy. **Every "Last Rotated" field is
"—".** None has ever been rotated.

`services/` contains **13 directories, 12 of which are workspace packages**
(`services/notifications` is an untracked duplicate with no `package.json`, so it is
not built or tested). Five of the twelve are quarantined dead code —
`agent-orchestrator`, `api_disabled`, `notification-service`, `worker`, `workers`.
Their `build`/`typecheck` scripts now print
`[dead-service] build skipped: packages await deletion (see repair report)` rather
than pretending to build, and they are still referenced by the repo's
`docker-compose.yml`, so removing them is not a plain delete. They are untracked in
git, which is why they survive a `git status` full of `??` entries.

---

## The repository builds, and it says so

An earlier revision of this document reported that `pnpm run build` failed with 2 of
14 tasks succeeding. **That is no longer true and has not been true for several
revisions.** Re-run on 2026-09-19 with the cache bypassed:

```
Tasks:    27 successful, 27 total
```

The specific failures that revision recorded are all gone:

- the `@nova/admin` TS2307/TS2304/TS2305/TS2307 errors — `apps/admin` was rebuilt
  against the current middleware and now type-checks;
- `@nova/types` extending `@nova/config` while declaring no dependency — `@nova/config`
  is now a declared `devDependency`;
- `@nova/policy` importing `ioredis` without declaring it — `ioredis` is now a declared
  dependency;
- `services/api` importing `compression`, `ioredis` and `xss` without declaring them —
  all three are declared.

The scan that found "14 packages import what they do not declare" was re-run: for every
live workspace package it is now clean.

---

## Document problems that affect any analysis

| Document | Problem |
|---|---|
| `docs/NOVA-LEADUP-COMPREHENSIVE-AUDIT-REPORT.md` | Was **41 bytes** — a title and nothing else. It now records where the real audits are and what a genuine audit found. |
| `NOVA_Master_Project_Document.md` §5, §18.3 | Specifies **React Native**. `apps/mobile` is **Flutter**. |
| `docs/architecture.md` vs `CURRENT_ARCHITECTURE.md` | One describes 2 services + MinIO; the other 10 services + AWS S3 SDK. One is stale. `CURRENT_ARCHITECTURE.md` marks `@nova/types` and `@nova/policy` **BROKEN**, which the 31/31 typecheck above contradicts; a correction note was added under that table, but the two markers are still printed. |
| `docs/ROADMAP.md` | Its "Declared but not real" table is stale: the notification listener is real, the `console.log` logger is pino, and the dead Flutter dependencies (`rive`, `drift`, `sqlite3_flutter_libs`, `sensors_plus`, `local_auth`, `equatable`, …) are gone from `pubspec.yaml`. Its §1 table also lists semantic memory as working, which the table above says it is not. |
| `docs/contracts/voice-events.md` vs MPD §14 | **Conflicting event schemas.** `eventId/eventType/timestamp/source/correlationId` vs `id/type/occurredAt/requestId/sessionId`. Neither is declared canonical. |
| `services/` | **13 directories, 12 workspace packages.** Five are quarantined dead code and still referenced by `docker-compose.yml`; `notifications/` is an untracked duplicate with no manifest. |
| `docs/PROJECT_STRUCTURE_MAP.md` | Generated 2026-09-11 and badly drifted: it calls `apps/mobile` Expo and `apps/web` removed, and describes an `apps/mobile_old` that does not exist. A correction box at the top of that file now overrides it. |
| YAML hygiene | `.github/workflows/maestro-e2e.yml` (untracked, Expo-era, references flows that do not exist) is the only remaining invalid YAML file. All ten Kubernetes manifests, the Compose files, the Makefile, the tracked CI workflow and `docs/api/openapi.yaml` were repaired. |

---

## Bottom line

**The repository builds, its gates pass, the published APK is real, and the
voice-companion core meets its requirements.** Against the brief and the master
document:

- **Everything the product claims, it does.** Build 27/27, typecheck 31/31, tests 34/34
  (API 254, auth 27), lint 25/25, `flutter analyze` clean, `flutter test` 579+5,
  `flutter build apk --debug` succeeds, auth end-to-end 24/24 against a live API, an
  endpoint sweep with **0 × 5xx**, and `https://nova.leadup.in/download.apk` serving a
  44.4 MB `com.leadup.nova` 1.0.0 arm64 release.
- **The "worse than absent" defects are gone.** The integration service answers 501
  instead of a fabricated `connected`; the stub routes answer 501 instead of a success
  envelope; the confirmation sheet guards the voice path as well as the typed one;
  notification monitoring is a real `NotificationListenerService`; and the two health
  endpoints that reported conclusions they had not checked are now real probes.
- **What remains needs something this repository cannot contain.** Semantic memory
  needs an embedding provider (no key is configured and the SDK in use has no
  embeddings endpoint); evening recap / weather / traffic have no provider and no
  definition in the master document; cross-platform sync needs OAuth client credentials
  registered with Google and Microsoft; subscription billing needs a price decision;
  smart-home/IoT control needs a vendor or Matter client the master document never
  specifies; and the Android-only native paths need a physical device, which has not
  been attached to this host. Each is reported honestly at runtime rather than faked.
- **Untidiness that is not a defect:** five quarantined dead services, an unrouted
  stale `integration-service` container, secrets never rotated, and one untracked
  Expo-era workflow (`maestro-e2e.yml`) still flattened.

Order of work if the goal is "everything works": redeploy `services/admin` so the fixed
health probes replace the misleading one; finish the dead-service removal; then the
provider-dependent items above.
