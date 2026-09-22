# Mobile App — Production Readiness Report

**Date:** 2026-09-17
**App:** NOVA — voice-first personal AI companion (Flutter)
**Platform:** Android (iOS parallel-track)

---

## Verdict: ❌ NOT production-ready. 6 blockers + 8 issues must be resolved.

The codebase is **structurally sound** — onboarding, networking, native services, and
the permissions flow are all implemented correctly. What's missing are the
**release-engineering plumbing**: signing, secrets, CI, and tests. None of the
blockers are design problems; they're either config files or one-time setup steps.

---

## Blockers (must fix before Play Store submission)

### B1. No Android keystore file on disk
**Status:** Fixed in code (`gradle.properties` + `keystore.properties` aligned), keystore itself still needs generation.
**Action:**
```bash
cd apps/mobile/android
keytool -genkeypair -v \
  -keystore nova-release-key.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias nova \
  -storepass <CHOSEN_PASSWORD> \
  -keypass  <CHOSEN_PASSWORD> \
  -dname    "CN=NOVA, O=Leadup Technologies, L=City, ST=State, C=US"
# Then back up the .jks + password out-of-band (1Password / Google Cloud Secret Manager)
```
The `build.gradle.kts` signing config now **throws** instead of silently skipping if
the keystore is missing. Locally you can put a real path/password into
`android/keystore.properties`; in CI inject via GitHub secrets (see
`.github/workflows/android.yml`).

### B2. No CI workflow for Android
**Status:** Fixed — `.github/workflows/android.yml` exists.
**Required GitHub repository secrets:**
| Secret | Purpose |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Base64 of the `.jks` file (so CI can `base64 -d` it) |
| `ANDROID_KEYSTORE_PASSWORD` | Same value used for `storepass` + `keypass` |
| `EXPO_PUBLIC_API_URL` | Production API URL (defaults to `https://api.nova.leadup.tech`) |

### B3. `keystore.properties` mismatch (was a silent skip)
**Status:** Fixed — file now uses `storeFile`/`keyAlias`/`storePassword`/`keyPassword`
keys that match `build.gradle.kts`'s `findProperty(...)` calls. **Commit-update
required**: if a team member already pasted old keys, overwrite.

### B4. Hardcoded localhost URL in `api.ts`
**File:** `apps/mobile/lib/config/api.ts`
The `baseUrl` falls back to `http://localhost:3000` if `EXPO_PUBLIC_API_URL` is
unset. On a real device that's never reachable. **Fix:** ship `.env.production`
(check it in or inject via EAS Build secret) and add a runtime check that fails
loudly if the URL looks like localhost in a release build.

### B5. No Play Store listing / metadata
Requires: app icon (1024×1024), feature graphic (1024×500), 4 screenshots, short
description (80 char) and full description (4000 char), privacy policy URL,
content rating questionnaire.

### B6. Crashlytics / Sentry not wired
No telemetry path visible. Production releases without a crash reporter are
inoperable — you cannot diagnose field failures. Add Firebase Crashlytics
(preferred) or Sentry.

---

## Issues that won't block submission but must be addressed promptly

| # | Severity | Issue |
|---|---|---|
| I1 | **High** | `build_runner` background task was killed — generated code may be out of sync. Run `flutter pub run build_runner build --delete-conflicting-outputs` and commit the regenerated files. |
| I2 | **High** | No widget tests (`test/widget/` empty). Onboarding's `_continueToHome` has no test coverage, so a regression in the permission flow would ship unnoticed. |
| I3 | **High** | No integration tests. Wake-word + notification services have no end-to-end proof of behavior on a real device. |
| I4 | **Medium** | `BootReceiver` registered in **two** namespaces (`com.leadup.mobile` and `com.leadup.nova`) — duplicate boot path, could double-fire. Pick one. |
| I5 | **Medium** | iOS Info.plist not reviewed — App Store submission will fail without `NSMicrophoneUsageDescription` and `NSBluetoothAlwaysUsageDescription`. |
| I6 | **Medium** | EAS Build profiles (`eas.json`) not present — needed for `eas submit -p android` and `eas submit -p ios`. |
| I7 | **Medium** | `package.json` has no `lint` script — PRs land without analyzer enforcement. |
| I8 | **Low** | `permissions_page.dart` allows skipping all permissions — onboarding silently walks away from gating them. |

---

## What IS working

- ✅ Android build config (compileSdk 37, NDK from Flutter, minSdk reasonable)
- ✅ All native services wired: `WakeWordService`, `BootReceiver`, `NotificationListener`
- ✅ AndroidManifest declares every required permission + foreground service type `microphone`
- ✅ Network service has retry/backoff with circuit-breaker
- ✅ Logger service covers init + lifecycle events
- ✅ Health service pings backend
- ✅ Code-path: onboarding → permissions → home → settings → logout (all wired)
- ✅ Gradle signing config now **fails loud** if config missing

---

## Recommended path to launch

1. **Generate keystore** (B1) and back up the password.
2. **Commit** the regenerated `*.g.dart` files (I1).
3. **Set the 3 GitHub secrets** (B2).
4. **Add Crashlytics** (B6) — 30 minutes of work.
5. **Run** `./scripts/manual-qa.sh` (or equivalent) on a real device end-to-end.
6. **Fix `api.ts` URL fallback** (B4) — guard against `localhost` in release mode.
7. **Add EAS configs** (I6) + Play Store metadata (B5).
8. Submit for internal testing → closed beta → open release (3-track Play rollout).

Estimated effort: **2–3 engineer-days** to clear all blockers and High-severity issues.
