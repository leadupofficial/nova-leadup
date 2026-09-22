# Mobile Production Launch Checklist

Follow this checklist end-to-end before submitting to app stores.

> **Corrected 2026-09-20.** The previous version of this file described an **Expo /
> EAS** app (`EXPO_PUBLIC_API_URL`, `app.json`, `eas.json`, EAS build profiles) and
> target API level 34. `apps/mobile` is a **Flutter** app; the Expo/React Native
> sources are dead weight that is not built. Following the old checklist would have
> sent you through build steps that do not exist. Commands below are the real ones.

---

## 1. Backend configuration

- [ ] `CORS_ORIGIN` in `services/api/.env` lists the production web origin(s).
      It is a comma-separated list, **not** an Expo origin.
- [ ] Backend URL is HTTPS with a valid certificate — the release client refuses
      plain HTTP (`lib/config/api_config.dart`).
- [ ] All provider keys are set: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`,
      `DEEPGRAM_API_KEY`, `SARVAM_API_KEY`, `GOOGLE_CLOUD_API_KEY`.
- [ ] `JWT_SECRET` and `JWT_REFRESH_SECRET` are strong random values (32+ chars)
      and **different** from each other.
- [ ] `GET /healthz` returns 200 **and** its dependency block reflects reality.
      A readiness probe that fabricates `{"database":"ok"}` while the API is
      returning 401s for real logins is worse than no probe.
- [ ] Postgres (with pgvector), Redis and object storage are reachable from the
      production container.
- [ ] Schema is current: `pnpm --filter @nova/database migrate`. Booting no
      longer migrates.

## 2. Mobile app configuration

- [ ] Version bumped in `apps/mobile/pubspec.yaml` (`version: 1.0.0+1`).
- [ ] Release builds point at the production API. Override per build with
      `--dart-define=API_URL=https://…` rather than editing source.
- [ ] Icons and splash are production assets; `Icon-App-1024x1024@1x.png` must
      have **no alpha channel** (App Store rejects alpha in the marketing icon).
- [ ] `flutter analyze` is clean and `flutter test` passes.

## 3. Android

- [ ] Release keystore generated and stored outside the repo. Signing reads
      `keystore.properties` (git-ignored) or the `ANDROID_KEYSTORE_*` env vars.
- [ ] `export JAVA_HOME=/opt/homebrew/opt/openjdk@21` before any Gradle build.
- [ ] `flutter build appbundle --release` produces
      `build/app/outputs/bundle/release/app-release.aab` (AAB, not APK, for Play).
- [ ] **Verify the merged release manifest, not the source manifest.** Third-party
      manifests merge permissions in, so the source file is not what ships:
      `build/app/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml`.
      It must contain **no** `AD_ID`, `BIND_GET_INSTALL_REFERRER_SERVICE`,
      `CAMERA`, `READ_MEDIA_*`, `READ_EXTERNAL_STORAGE`, `USE_BIOMETRIC` or
      `SYSTEM_ALERT_WINDOW`.
- [ ] The command exits 0. If it reports a crash in `apkanalyzer`, the bundle was
      still written — `chmod +x ~/Library/Android/sdk/cmdline-tools/latest/bin/apkanalyzer`.
- [ ] Install the signed APK on a clean device and confirm: it launches, the
      onboarding consent step records decisions, and the wake word starts a
      foreground service with a visible, persistent notification.
- [ ] Confirm the boot receiver behaves on **API 34 and 35+**. It deliberately
      does *not* start the microphone service after a reboot on 34+ (Android
      forbids background microphone FGS creation); the wake word re-arms on next
      launch. That is expected, not a bug.
- [ ] `targetSdk = 36`, `minSdk = 24`, `compileSdk = 37`.

## 4. iOS

- [ ] Bundle identifier `com.leadup.nova` matches the App Store Connect record.
- [ ] `ios/Podfile` and `ios/Podfile.lock` are **committed**. They are currently
      untracked, so a fresh clone cannot `pod install`.
- [ ] `ios/Flutter/Debug.xcconfig` and `Release.xcconfig` contain
      `#include "Generated.xcconfig"` — with no colon and no `Flutter/` prefix.
      Both were malformed until 2026-09-20, which meant `FLUTTER_ROOT` was never
      defined and **no iOS build ever succeeded**. Verify with:
      `xcodebuild -project ios/Runner.xcodeproj -scheme Runner -configuration Release -showBuildSettings | grep FLUTTER_ROOT`
- [ ] `Info.plist` usage descriptions name only permissions the app uses. Only
      `NSMicrophoneUsageDescription` should be present.
- [ ] `UIBackgroundModes` is `audio` only. `processing` and `remote-notification`
      were removed: neither has an implementation behind it.
- [ ] `ios/Runner/PrivacyInfo.xcprivacy` is valid and current. Run
      `plutil -lint ios/Runner/PrivacyInfo.xcprivacy`. It must stay in step with
      the App Store Connect privacy questionnaire **and** the Play Data safety
      form.
- [ ] `Runner.entitlements` declares no capabilities it cannot back. Push was
      removed because nothing registers for it; re-add
      `aps-environment` only together with `firebase_messaging`.
- [ ] `flutter build ipa --no-codesign --release` succeeds and writes
      `build/ios/ipa/Runner.ipa`. **Never use `--no-codesign` for the artifact you
      upload.**
- [ ] Export compliance answered in App Store Connect
      (`ITSAppUsesNonExemptEncryption` is already `false` in `Info.plist`).
- [ ] iPad screenshots prepared — `TARGETED_DEVICE_FAMILY = "1,2"`.

## 5. Store policy gates

Both stores block submission on these; they are not optional polish.

- [ ] **In-app account deletion works end to end.** App Review 5.1.1(v) and Play's
      account-deletion requirement. Path: Profile → Delete account →
      `DELETE /api/v1/account`. Create a throwaway account, delete it, and confirm
      the login that follows fails.
- [ ] **A public, non-geofenced privacy-policy URL is live** and readable without
      signing in: `https://nova.leadup.in/privacy`. It must also be reachable
      *inside* the app (Profile → Privacy policy).
- [ ] **A public account-deletion URL is live** for Play, without requiring the
      app: `https://nova.leadup.in/delete-account`.
- [ ] **AI reporting works in-app.** Play's AI-Generated Content policy requires
      reporting of offensive model output without leaving the app: the Report
      action under any NOVA reply posts to `POST /api/v1/ai/reports`.
- [ ] **Prominent disclosure precedes every restricted permission.** Microphone,
      notification access and exact alarms each have in-app copy before the system
      prompt; the exact-alarm request is user-initiated only.
- [ ] **Data safety / App Privacy answers match the code.** Voice audio and
      transcripts go to third-party AI providers; Crashlytics and Analytics are
      live on Android; nothing collects advertising IDs, contacts, calendar,
      location, photos, camera or health data.
- [ ] **Foreground-service declaration** completed in Play Console for the
      `microphone` type, including the required demo video.
- [ ] **Ads declaration: "No ads."**
- [ ] **No misleading capability claims.** The app must not advertise features it
      cannot deliver on the platform being reviewed (the Enterprise SSO notice and
      the iOS device-control console were removed for exactly this reason).

## 6. Store submission

- [ ] **Google Play Console**
  - Store listing completed (title, description, screenshots, feature graphic).
  - Content rating questionnaire filled, consistent with the AI answers.
  - Data safety form completed against §5.
  - Target API level 36 — mandatory from 31 August 2026.
  - Signed AAB uploaded; Play App Signing enrolled.
- [ ] **App Store Connect**
  - App information, screenshots and description completed.
  - Privacy policy URL set; App Privacy questionnaire completed.
  - Age rating and export compliance answered.
  - A **demo account** is supplied in review notes. The seeder only creates an
    admin; create a plain user for reviewers.
  - `flutter build ipa` (signed) uploaded with Transporter, or
    `fastlane deploy_testflight` (see `ios/fastlane/Fastfile`).

## 7. Post-launch

- [ ] Crashlytics and Analytics dashboards observed for the first days of release.
      Note that **iOS does not report yet** — `GoogleService-Info.plist` is still a
      placeholder that is not bundled. Run `flutterfire configure` for iOS before
      relying on crash data there.
- [ ] Backend logs, health endpoint, latency and error rates visible.
- [ ] Rollback plan documented for both stores (Play staged rollout halt; App Store
      previous-version re-submission).
- [ ] Support contact published in both listings and reachable from the app.
