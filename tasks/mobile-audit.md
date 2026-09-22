# NOVA Mobile App Audit

**Audited:** 2026-09-15
**App:** NOVA — Voice-first personal AI companion
**Platform:** Flutter (cross-platform: Android + iOS)
**Package:** `com.leadup.nova`

---

## 1. Framework and Architecture

- **Framework:** Flutter (Dart)
- **State Management:** Riverpod (`flutter_riverpod`)
- **Architecture Pattern:** Feature-first layering (`lib/features/*`) with a `core/` shared layer
- **Navigation:** `go_router` (declarative routing via `app_router.dart`)
- **Local Storage:** Hive (`hive_flutter`)
- **AI/LLM Integration:** Nova AI SDK (`nova_ai_sdk.dart`) — proprietary backend
- **Voice Synthesis:** `flutter_tts`
- **Audio Recording:** `record` package (AAC-LC / .m4a)
- **Audio Playback:** `just_audio`
- **Avatar Rendering:** `rive_common` — Rive animations for avatar
- **Push Notifications:** `firebase_messaging`
- **Crash Reporting:** `firebase_crashlytics`
- **Analytics:** `firebase_analytics` + custom `AnalyticsService`
- **Deep Links:** Custom `DeepLinkHandler` with Riverpod
- **Environment Config:** `flutter_dotenv` (`.env` file)
- **Haptics:** Custom `HapticFeedbackHelper`

---

## 2. Navigation Structure

**Router:** `lib/core/router/app_router.dart`

| Route | Feature | Description |
|-------|---------|-------------|
| `/` | auth | Splash / auth gate |
| `/login` | auth | Login screen |
| `/signup` | auth | Sign-up screen |
| `/forgot-password` | auth | Password reset |
| `/onboarding` | onboarding | Onboarding flow |
| `/home` | home | Main home screen |
| `/chat` | chat | AI conversation screen |
| `/tasks` | tasks | Task management |
| `/reminders` | reminders | Reminder list |
| `/memory` | memory | Memory/journal view |
| `/settings` | settings | App settings |
| `/notifications` | notifications | Notification center |

**Auth gating:** `AuthGate` widget wraps the app and redirects unauthenticated users to `/login`.

**Deep links:** Handled via `DeepLinkHandler` (MethodChannel bridge to native). Links are resolved on app startup and via a continuous stream.

---

## 3. All Screens and Implementations

| Screen | File | Purpose |
|--------|------|---------|
| SplashScreen | `loading_states.dart` | Loading while app initializes |
| LoginScreen | `features/auth/login_screen.dart` | Email/password login |
| SignupScreen | `features/auth/signup_screen.dart` | Account creation |
| ForgotPasswordScreen | `features/auth/forgot_password_screen.dart` | Password reset flow |
| OnboardingScreen | `features/onboarding/onboarding_screen.dart` | First-run experience |
| HomeScreen | `features/home/home_screen.dart` | Main dashboard |
| ChatScreen | `features/chat/chat_screen.dart` | AI conversation |
| TasksScreen | `features/tasks/tasks_screen.dart` | Task management |
| RemindersScreen | `features/reminders/reminders_screen.dart` | Reminders |
| MemoryScreen | `features/memory/memory_screen.dart` | Memory/journal |
| SettingsScreen | `features/settings/settings_screen.dart` | Settings |
| NotificationsScreen | `features/notifications/notifications_screen.dart` | Notification center |

**Widgets:**
- `VoiceWaveform` (`features/voice/voice_waveform.dart`) — animated waveform for voice UI
- `AvatarWidget` (`features/avatar_mode/avatar_widget.dart`) — Rive avatar renderer
- `ChatMessageBubble` (`features/chat/chat_message_bubble.dart`) — message UI component
- `PermissionRequestDialog` (`core/permissions/permission_dialog.dart`) — runtime permission prompts

---

## 4. Voice / Audio Features

### Recording
- Uses `record` package with AAC-LC encoder (`.m4a` output)
- Permissions requested via `permission_handler` (microphone)
- Temp files stored in system temp directory

### Playback
- Uses `just_audio` for audio playback
- Supports file-path-based playback

### Text-to-Speech
- Uses `flutter_tts`
- Configured for English (en-US), rate 0.5, volume 1.0, pitch 1.0
- State tracked via `TtsState` enum (playing, stopped, paused, none)

### Wake Word (Always-Listening)
- Native Android foreground service: `WakeWordForegroundService` (Java)
- Flutter bridge: `WakeWordBridge` via MethodChannel + EventChannel
- Event types: `listening` (RMS amplitude), `detected` (keyword hit), `error`
- Kotlin bridge service: `NovaWakeService`
- Boot receiver: `BootReceiver` starts service after device boot
- Channel names: `nova.ai/wake_word` (control), `nova.ai/wake_word/events` (events)

### Audio Session
- Configured via `audio_session` package with `AudioSessionConfiguration.speech()`

---

## 5. AI Chat / Conversation Features

- `NovaAIClient` (`services/nova_ai_sdk.dart`) — main SDK wrapper for AI API calls
- Chat screens with `ChatMessageBubble` widget
- Avatar widget (`AvatarWidget`) renders alongside chat
- Messages stored locally via `LocalStorageService` (Hive)
- `VoiceService` handles TTS for AI responses
- `WakeWordBridge` enables hands-free conversation initiation

---

## 6. Avatar Display and Animation

- **Technology:** Rive (`rive_common` package)
- **Widget:** `AvatarWidget` in `features/avatar_mode/avatar_widget.dart`
- Three avatar modes: `IdleMode`, `ListeningMode`, `SpeakingMode`
- Mode switching controlled by `AvatarModeProvider`
- Avatar animates based on:
 - Voice amplitude (from `WakeWordBridge.amplitude` stream)
 - TTS state (playing/stopped)
 - Wake word detection events

---

## 7. User Authentication Flows

### Login
- Email + password form (`LoginForm.tsx` — note: this appears to be a web component, see issues)
- Firebase Authentication (`firebase_auth`)
- Error handling with user-friendly messages
- Biometric option (USE_BIOMETRICS permission declared)

### Sign Up
- Email, password, name fields
- Firebase Auth integration

### Password Reset
- Email-based reset via Firebase

### Session Management
- `AuthStateProvider` / `AuthNotifier` (Riverpod)
- `authStateChanges` from Firebase listened for session persistence
- Token stored in Hive (`LocalStorageService`)

---

## 8. Push Notifications

- **Firebase Cloud Messaging** (`firebase_messaging`)
- Foreground notification handling via `NotificationService`
- Background message handler registered
- `NotificationListener` broadcast receiver for relaying notifications to agent
- Android permissions: `POST_NOTIFICATIONS`, `RECEIVE_NOTIFICATION_LISTENER`
- iOS: APNs configured via Firebase (`firebase_options.dart`)

---

## 9. Offline Capabilities

- **Hive** for local persistence:
 - Chat messages
 - User preferences
 - Session/token data
- `LocalStorageService` initialized at app startup (in `main.dart`)
- Offline queue for failed API calls — **NOT YET IMPLEMENTED**
- No explicit offline indicator or retry UI in current screens

---

## 10. Third-Party SDK Integrations

| SDK | Package | Purpose |
|-----|---------|---------|
| Flutter TTS | `flutter_tts` | Text-to-speech |
| Audio Recorder | `record` | Audio recording |
| Just Audio | `just_audio` | Audio playback |
| Audio Session | `audio_session` | Audio session management |
| Rive | `rive_common` | Avatar animations |
| Firebase Core | `firebase_core` | Firebase initialization |
| Firebase Auth | `firebase_auth` | Authentication |
| Firebase Messaging | `firebase_messaging` | Push notifications |
| Firebase Analytics | `firebase_analytics` | Analytics |
| Firebase Crashlytics | `firebase_crashlytics` | Crash reporting |
| Hive | `hive_flutter` | Local storage |
| Riverpod | `flutter_riverpod` | State management |
| Go Router | `go_router` | Navigation |
| Permission Handler | `permission_handler` | Runtime permissions |
| Flutter Dotenv | `flutter_dotenv` | Environment config |
| Nova AI SDK | `nova_ai_sdk` (internal) | AI/LLM backend |

---

## 11. Platform Permissions

### Android (`AndroidManifest.xml`)
- `INTERNET`
- `RECORD_AUDIO` — voice recording
- `POST_NOTIFICATIONS` — push notifications
- `FOREGROUND_SERVICE` — background services
- `FOREGROUND_SERVICE_MICROPHONE` — wake word background mic
- `SYSTEM_ALERT_WINDOW` — overlay (likely for wake-word UI)
- `USE_BIOMETRICS` — biometric auth
- `SCHEDULE_EXACT_ALARM` — reminder alarms
- `RECEIVE_BOOT_COMPLETED` — auto-start after boot
- `RECEIVE_NOTIFICATION_LISTENER` — notification access

### iOS (expected, not fully audited)
- Microphone usage description required (NSSpeechRecognitionUsageDescription, NSMicrophoneUsageDescription)
- Push notification capabilities
- Background modes: audio, voice processing

---

## 12. Build and Deployment Configuration

### Android
- Package: `com.leadup.nova`
- Min SDK: Not confirmed (check `android/build.gradle`)
- Target SDK: Not confirmed
- Signing config: Not found in audited files
- Build types: debug/release (standard Flutter)
- Services:
 - `WakeWordService` (Java foreground service)
 - `NovaWakeService` (Kotlin bridge)
 - `BootReceiver`
 - `NotificationListener`
- Missing: `build.gradle` review, signing config, ProGuard/R8 rules

### iOS
- `ios/` directory exists but not fully audited
- `Info.plist` not confirmed
- Capabilities: push notifications, background audio likely needed

### Environment
- `.env` file loaded at startup
- Firebase config auto-generated (`firebase_options.dart`)
- No `app.json` (Expo) — pure Flutter project

---

## 13. Error Handling and Crash Reporting

- **Crashlytics:** Integrated via `firebase_crashlytics`
- **Error Boundary:** Custom `ErrorBoundary` widget wraps MaterialApp
 - Shows error UI with restart button
 - Catches build-time errors
- **Voice Service:** Try-catch in `main.dart` initialization with `debugPrint`
- **Firebase Init:** Gracefully handled — app continues even if Firebase fails
- **Wake Word:** Error events emitted on EventChannel (`WakeWordEventType.error`)

---

## 14. Bugs, Missing Features, and Security Issues

### Bugs / Inconsistencies
1. **LoginForm.tsx in mobile audit:** `/Volumes/External/github-projects/NOVA-Leadup/apps/mobile/src/app/login/LoginForm.tsx` is a React/TSX file, not a Dart widget. The Flutter login screen should be at `features/auth/login_screen.dart`. This suggests the file listing from git status may include stale web paths, or there is a cross-platform web directory incorrectly nested.

2. **VoiceService singleton + Riverpod:** `VoiceService` is both a singleton (`_instance`) and exposed via Riverpod `Provider`. The provider creates a new instance each time (`VoiceService()`), but the singleton pattern means `_instance` is separate. This creates two independent instances — the one in Riverpod and the singleton. Initialize and stop calls may target different instances.

3. **Temp file cleanup:** `VoiceService.startRecording()` writes to temp directory but `stopRecording()` returns the path without deleting. Repeated recordings accumulate temp files with no cleanup.

### Missing Features
4. **Offline queue:** No retry queue for failed API calls. If Nova AI SDK calls fail offline, messages are lost.

5. **Offline indicator:** No UI state showing "offline" or "reconnecting".

6. **Biometric auth UI not confirmed:** `USE_BIOMETRICS` permission exists, but biometric login UI was not found in audited screens.

7. **Settings not fully audited:** Settings screen implementation not fully reviewed — dark mode provider exists, but other settings (notifications, voice, account) not confirmed.

### Security Issues
8. **No certificate pinning:** API calls through `NovaAIClient` have no certificate pinning configuration.

9. **Token storage:** Auth tokens stored in Hive (plaintext). No evidence of secure storage (`flutter_secure_storage`) for sensitive tokens.

10. **Broad export flags:** `MainActivity` has `android:exported="true"` with no intent filters — low risk but could be tightened.

11. **Notification listener exported false but no permission check:** `NotificationListener` receiver is `exported="false"` but requires `android.permission.BIND_NOTIFICATION_LISTENER_SERVICE` to function properly on Android.

12. **Wake word foreground service:** Runs continuously in background with microphone access. Battery impact and privacy implications should be documented in privacy policy.

### Recommendations
13. Use `flutter_secure_storage` for auth tokens and sensitive data.
14. Implement offline queue with retry logic for AI API calls.
15. Fix VoiceService singleton/provider inconsistency.
16. Add temp file cleanup after audio processing.
17. Add network status indicator in UI.
18. Review `build.gradle` for signing configs, min SDK, and ProGuard rules.
19. Add iOS `Info.plist` usage descriptions for microphone and speech recognition.
20. Implement certificate pinning for API endpoints.

---

## Summary

| Area | Status | Notes |
|------|--------|-------|
| Framework | Flutter + Riverpod | Clean feature-based architecture |
| Navigation | GoRouter | 12 routes, auth gated |
| Voice | Implemented | TTS, recording, playback, wake word |
| AI Chat | Implemented | Nova AI SDK, Hive persistence |
| Avatar | Implemented | Rive animations with 3 modes |
| Auth | Implemented | Firebase Auth, email/password, biometrics perm |
| Push Notifications | Implemented | Firebase FCM + notification listener |
| Offline | Partial | Hive storage only, no queue |
| Security | Needs work | Plaintext tokens, no cert pinning |
| Build | Partial | Android manifest reviewed, gradle not confirmed |
| Error Handling | Good | Crashlytics + ErrorBoundary widget |

**Overall:** The mobile app has a solid Flutter + Riverpod foundation with voice-first features well-implemented. Primary concerns are token storage security, offline resilience, and the VoiceService singleton inconsistency.
