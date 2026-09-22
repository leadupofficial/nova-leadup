# NOVA-Leadup Integration Plan

## Phase Summary

| Phase | Name | Status |
|-------|------|--------|
| 0 | Architecture Audit & Repository Research | ✅ Complete |
| 1 | Backend Stabilization | ✅ Complete |
| 2 | Flutter Foundation | 🟡 In Progress |
| 3 | Voice Pipeline | Pending |
| 4 | Wake Word Integration | Pending |
| 5 | Tools + Memory UI | Pending |
| 6 | Testing + CI | Pending |
| 7 | Production Hardening | Pending |

---

## Phase 2 — Flutter Foundation (Current)

### Completed
- [x] `pubspec.yaml` with all dependencies
- [x] `lib/main.dart` — app entry, GoRouter, ProviderScope
- [x] `core/theme/nova_theme.dart` — dark theme, glassmorphism, color tokens
- [x] `core/design/widgets/nova_avatar.dart` — Avatar widget with 10 states
- [x] `core/design/widgets/nova_voice_button.dart` — press-and-hold voice button
- [x] `core/avatar/avatar_provider.dart` — Riverpod avatar state provider
- [x] `core/voice/voice_provider.dart` — Riverpod voice state provider
- [x] `core/api/api_client.dart` — Dio client with auth interceptor
- [x] `core/auth/auth_provider.dart` — Auth Riverpod provider
- [x] `core/auth/auth_token_provider.dart` — Secure token storage
- [x] `core/database/app_database.dart` — Drift schema (messages, reminders, pending tools)
- [x] `core/database/database_provider.dart` — Drift provider
- [x] `core/platform/nova_platform_bridge.dart` — MethodChannel + EventChannel
- [x] Android: `NovaWakeService.kt`, `WakeWordForegroundService.kt`, `NovaEventBridge.kt`, `NovaApplication.kt`
- [x] Android: `AndroidManifest.xml` with all permissions
- [x] `docs/REPOSITORY_DECISIONS.md`
- [x] `docs/AVATAR_REPOSITORY_ANALYSIS.md`
- [x] `docs/VOICE_REPOSITORY_ANALYSIS.md`
- [x] `docs/ANDROID_ASSISTANT_REPOSITORY_ANALYSIS.md`

### Remaining in Phase 2
- [ ] Wire Rive `.riv` asset files with state machine inputs
- [ ] Create `features/onboarding/` with permission flow
- [ ] Create `features/settings/` with real settings UI
- [ ] Add `flutter_launcher_icons` for Android launcher
- [ ] Create `analysis_options.yaml` with flutter_lints
- [ ] Create `lib/core/logging/` — Flutter-side logger

---

## Phase 3 — Voice Pipeline

### Tasks
- [ ] `NovaAudioController` — audio focus, mic lifecycle, TTS playback
- [ ] Sarvam WebSocket STT integration (via backend)
- [ ] TTS playback with `just_audio`
- [ ] Live transcript UI in chat
- [ ] Audio level → lip-sync binding in Rive
- [ ] Barge-in detection (Silero VAD during TTS)

### Dependencies
- Phase 2 complete
- Backend WebSocket endpoint (`@nova/api`) ready

---

## Phase 4 — Wake Word

### Tasks
- [ ] Add `picovoice` or custom Porcupine Kotlin SDK to `build.gradle`
- [ ] Wire Porcupine in `WakeWordForegroundService`
- [ ] Implement `EventChannel` bridge from service → Flutter
- [ ] Handle `LISTENING` state on wake detection
- [ ] Wake word toggle in Settings
- [ ] Handle Android battery optimizations

### Dependencies
- Phase 2 complete
- Porcupine SDK evaluated and licensed

---

## Phase 5 — Tools + Memory UI

### Tasks
- [ ] `features/chat/` — chat list + message bubbles
- [ ] `features/tasks/` — task list + creation
- [ ] `features/memory/` — memory browser
- [ ] `features/reminders/` — reminder list + AlarmManager integration
- [ ] `features/notifications/` — notification list
- [ ] Tool confirmation cards (adapt assistant-ui pattern)

### Dependencies
- Phase 3 complete

---

## Phase 6 — Testing + CI

### Tasks
- [ ] Unit tests for providers (Riverpod)
- [ ] Widget tests for `NovaAvatar`, `NovaVoiceButton`
- [ ] Integration test for onboarding flow
- [ ] Flutter CI in `.github/workflows/`

---

## Repository Integration Checklist

| Repo | Integration | Files Modified |
|------|------------|----------------|
| Rive Flutter | Add to `pubspec.yaml` | `pubspec.yaml` |
| Hark | Port Kotlin service + bridge | `android/.../*.kt`, `lib/core/platform/` |
| SannaBot | Adapt agent loop to Riverpod | `lib/features/chat/` |
| Prometheus Avatar | Adapt emotion mapper | `lib/avatar/` |
| Pipecat | Reference Sarvam API patterns | `lib/core/voice/`, backend |
| LiveKit Agents | Reference backend pipeline | `services/agent-orchestrator/` |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Flutter SDK not installed | High (current) | Blocks all mobile work | Install Flutter 3.22+ |
| Porcupine licensing | Medium | May need alternative | Have openWakeWord as fallback |
| Sarvam API changes | Medium | Breaks voice pipeline | Pin API version, add retry logic |
| Rive asset creation | Medium | No avatar animation | Create minimal `.riv` files |
| Android 15+ background restrictions | High | May block wake word | Foreground service + battery exemption |
| Drift schema migrations | Medium | Data loss | Write migration tests |
| `riverpod_annotation` build_runner | Medium | Build failures | Pin exact versions |

---

## Next Immediate Actions

1. **Install Flutter** — `brew install --cask flutter` (or download from flutter.dev)
2. **Run `flutter pub get`** in `apps/mobile/`
3. **Run `flutter analyze`** to verify no Dart errors
4. **Create Rive `.riv` files** for avatar states
5. **Install Porcupine SDK** in Android `build.gradle`
6. **Wire `NovaAvatar`** to actual Rive file
