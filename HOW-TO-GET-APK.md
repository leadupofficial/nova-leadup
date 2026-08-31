# Getting the NOVA Android APK

## Prerequisites
- Physical Android device (or emulator)
- Expo account (free at expo.dev)

## Quick Start (3 Steps)

### 1. Authenticate
```bash
eas login
```
Opens browser → sign in with Expo account (or create one free)

### 2. Trigger Build
```bash
bash build-apk.sh
```
This runs the full build pipeline automatically:
- Authenticates with Expo
- Links your project to EAS
- Uploads code and builds APK in the cloud

### 3. Download & Install
After ~5-10 minutes:
- **Option A:** Check your email for the download link
- **Option B:** Run `eas build:list` to see build status and download
- **Option C:** Visit https://expo.dev/accounts/leadup/projects/nova/builds

Install the APK:
```bash
# Enable "Install from Unknown Sources" on your device first
adb install nova-android-preview.apk
```

## Manual Build (if script fails)

```bash
# 1. Login
eas login

# 2. Navigate to mobile app
cd apps/mobile

# 3. Build
eas build --platform android --profile preview

# 4. Monitor
eas build:list
```

## What to Expect

**Build Profile:** `preview` (internal distribution)
**Target:** Android APK (not AAB)
**Size:** ~50-80MB
**Time:** 5-10 minutes first build, 2-3 minutes subsequent

## Troubleshooting

**"Not logged in"**
→ Run `eas login` first

**"Project not found"**
→ Run `eas init` to create EAS project

**"Build failed"**
→ Check build logs at https://expo.dev/accounts/leadup/projects/nova/builds
→ Common issues: missing assets, TypeScript errors

**"Cannot install APK"**
→ Enable "Install from Unknown Sources" in Android Settings
→ Or use `adb install` command

## Project Info
- **App Name:** NOVA
- **Package:** com.leadup.nova
- **EAS Project ID:** eacfbae2-27cf-4dc4-b817-809bab3b5206
- **Owner:** leadup
