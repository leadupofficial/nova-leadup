#!/usr/bin/env bash
#
# Activate Firebase (project nova-leadup-stagging) for the NOVA mobile app.
#
# Why this script exists: activating Firebase requires an authenticated Google account,
# and two of the steps are destructive to hand-maintained Gradle files —
# `flutterfire configure` rewrites android/app/build.gradle.kts and settings.gradle.kts,
# which also contain NOVA's custom release-signing block and the Flutter Gradle plugin
# wiring. This script backs those up and shows the diff so a clobbered signing config
# cannot slip through unnoticed.
#
# Prerequisites:
#   1. npx --yes firebase-tools@latest login        # interactive, browser-based
#   2. That account must have access to project nova-leadup-stagging
#
# Usage:
#   bash apps/mobile/tools/firebase/activate.sh            # configure + add SDKs + verify
#   bash apps/mobile/tools/firebase/activate.sh --check    # preflight only, change nothing
#
# iOS is intentionally not configured (out of scope for now).
set -euo pipefail

PROJECT_ID="nova-leadup-stagging"
MOBILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GRADLE_FILES=(
  "android/app/build.gradle.kts"
  "android/settings.gradle.kts"
)
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

cd "$MOBILE_DIR"
say "Firebase activation for $PROJECT_ID  (${MOBILE_DIR})"

# --- preflight ---------------------------------------------------------------
say "1. Preflight"

command -v flutter >/dev/null || fail "flutter not found on PATH"
command -v dart    >/dev/null || fail "dart not found on PATH"
echo "  flutter: $(flutter --version 2>/dev/null | head -1)"

# Authenticated? `projects:list` is the cheapest call that proves it.
if ! npx --yes firebase-tools@latest projects:list >/tmp/nova-fb-projects.txt 2>/tmp/nova-fb-err.txt; then
  sed 's/^/  /' /tmp/nova-fb-err.txt >&2 || true
  fail "Not authenticated with Firebase. Run this first, then re-run:

    npx --yes firebase-tools@latest login"
fi

if ! grep -q "$PROJECT_ID" /tmp/nova-fb-projects.txt; then
  echo "  Projects visible to this account:"
  sed 's/^/    /' /tmp/nova-fb-projects.txt
  fail "Project '$PROJECT_ID' is not in the list above.
  Either log in with an account that has access, or confirm the project id."
fi
echo "  authenticated and '$PROJECT_ID' is accessible"

# Refuse to run against placeholder config that a previous attempt left behind.
if grep -q "YOUR_FIREBASE_PROJECT_ID" android/app/google-services.json 2>/dev/null; then
  echo "  android/app/google-services.json currently holds PLACEHOLDER values; it will be replaced"
fi

if [[ $CHECK_ONLY -eq 1 ]]; then
  say "Preflight OK (--check: nothing was changed)"
  exit 0
fi

# --- back up hand-maintained Gradle files ------------------------------------
say "2. Backing up Gradle files that flutterfire will rewrite"
BACKUP_DIR=".firebase-activation-backup/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
for f in "${GRADLE_FILES[@]}"; do
  if [[ -f "$f" ]]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    cp "$f" "$BACKUP_DIR/$f"
    echo "  saved $f"
  fi
done
echo "  backups in $BACKUP_DIR"

# --- flutterfire configure ---------------------------------------------------
say "3. flutterfire configure (android only; iOS is out of scope)"

if [[ -f android/app/google-services.json ]] \
   && ! grep -q "YOUR_FIREBASE" android/app/google-services.json \
   && [[ "${FORCE:-0}" != "1" ]]; then
  # Android is already configured and committed. Re-running `flutterfire configure`
  # rewrites android/app/build.gradle.kts and settings.gradle.kts, which is exactly the
  # way the google-services plugin or the release-signing block gets clobbered. So skip
  # it unless explicitly forced.
  echo "  android/app/google-services.json is already a real config - skipping."
  echo "  Set FORCE=1 to regenerate (needed only when adding iOS/web)."
else
  if ! command -v flutterfire >/dev/null; then
    echo "  installing flutterfire_cli..."
    dart pub global activate flutterfire_cli
  fi
  # `dart pub global activate` installs into the pub cache bin, which may not be on PATH.
  FLUTTERFIRE="$(command -v flutterfire || echo "$HOME/.pub-cache/bin/flutterfire")"
  [[ -x "$FLUTTERFIRE" ]] || fail "flutterfire still not found; add \$HOME/.pub-cache/bin to PATH"

  "$FLUTTERFIRE" configure \
    --project="$PROJECT_ID" \
    --platforms=android \
    --yes

  for f in "${GRADLE_FILES[@]}"; do
    if [[ -f "$BACKUP_DIR/$f" ]] && ! diff -q "$BACKUP_DIR/$f" "$f" >/dev/null 2>&1; then
      echo
      echo "  --- flutterfire changed $f (review this!) ---"
      diff -u "$BACKUP_DIR/$f" "$f" | sed 's/^/  /' || true
    fi
  done
fi

# The signing block is the thing most likely to be damaged by a rewrite.
if ! grep -q "isReleaseSigningConfigured" android/app/build.gradle.kts; then
  fail "The release signing block is missing from android/app/build.gradle.kts after
  flutterfire configure. Restore it from $BACKUP_DIR/android/app/build.gradle.kts and
  re-apply the google-services plugin by hand."
fi
echo "  release signing block still present"

if ! grep -q "com.google.gms.google-services" android/app/build.gradle.kts; then
  fail "The com.google.gms.google-services plugin is not applied in
  android/app/build.gradle.kts. Without it Firebase.initializeApp() fails at runtime
  with 'Failed to load default options'."
fi
echo "  google-services plugin still applied"

# --- verify the config is real, not placeholder ------------------------------
say "4. Verifying the generated config is real"
grep -q "YOUR_FIREBASE" android/app/google-services.json 2>/dev/null && \
  fail "google-services.json still contains placeholder values"
python3 - <<'PY' || fail "google-services.json is not valid JSON"
import json, pathlib, sys
d = json.loads(pathlib.Path("android/app/google-services.json").read_text())
info = d.get("project_info", {})
client = (d.get("client") or [{}])[0]
print("  project_id     :", info.get("project_id"))
print("  project_number :", info.get("project_number"))
print("  package_name   :", client.get("client_info", {}).get("android_client_info", {}).get("package_name"))
if info.get("project_id") != "nova-leadup-stagging":
    sys.exit(1)
PY

# --- add the SDKs ------------------------------------------------------------
say "5. Adding the Firebase SDKs"
flutter pub add firebase_core firebase_crashlytics firebase_analytics

# --- verify the project still builds ----------------------------------------
say "6. Verifying analyze, tests, and a release build still succeed"
flutter analyze
flutter test
flutter build apk --release

say "Configuration and SDKs are in place."

cat <<EOF

What this script does NOT need to do:

  The Dart wiring is already committed. FirebaseActivation.initialize() in
  lib/services/firebase_backends.dart is called from main.dart and hands the concrete
  FirebaseCrashReporterBackend / FirebaseAnalyticsBackend to
  CrashReportingService.initialize(backend:) and AnalyticsService.initialize(backend:).
  It degrades to the console backends if Firebase is unavailable, so a build without
  google-services.json still runs.

Verified live on an Android 16 emulator (2026-09-18):

  FirebaseInitProvider: FirebaseApp initialization successful
  FirebaseCrashlytics: Initializing Firebase Crashlytics 20.1.1 for com.leadup.nova
  FA: App measurement initialized, version: 161000
  flutter : [Firebase] initialised (project nova-leadup-stagging)
  FirebaseSessions: Fetched settings from server -> "status":"activated"

Still worth checking in the Firebase console:

  The sessions settings response reported "firebase_crashlytics_enabled": false. That is
  a project-side setting, not something this repository controls. Open the Crashlytics
  tab for nova-leadup-stagging in the console once to provision it, then confirm that a
  test crash (or a non-fatal via CrashReportingService.recordError) appears.

EOF
