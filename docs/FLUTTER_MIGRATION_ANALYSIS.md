# Flutter Migration Analysis

**Date**: 2026-09-06 
**Status**: DRAFT 
**Purpose**: Analyze the feasibility, approach, and risks of migrating NOVA-Leadup's mobile app from Expo/React Native to Flutter

---

## Executive Summary

Migrating NOVA-Leadup's mobile app from Expo/React Native to Flutter is architecturally sound and aligns with the product's voice-first, avatar-based AI companion vision. Flutter provides superior animation performance for avatar rendering, better native Android integration for wake-word services, and a more mature ecosystem for premium UI.

**Recommendation**: Proceed with a phased migration. Do NOT rip and replace. Build Flutter alongside Expo, migrate feature-by-feature, and deprecate Expo only after Flutter achieves parity.

---

## 1. Why Flutter?

### Technical Advantages

**Avatar Rendering**:
- Rive Flutter runtime is production-ready (1.5k stars, MIT license)
- 60fps vector animations with state machines
- Native performance for complex avatar states
- Better than React Native alternatives (react-native-rive is less maintained)

**Native Android Integration**:
- MethodChannel/EventChannel for Kotlin communication
- Foreground services for wake-word detection
- Audio focus management
- AlarmManager/NotificationListenerService access
- Biometric authentication

**UI Consistency**:
- Single rendering engine (Skia/Impeller)
- Pixel-perfect design system implementation
- Glassmorphism, blur, gradients work reliably
- No bridge overhead

**Performance**:
- No JavaScript bridge
- AOT compilation for release builds
- Smaller app size vs Expo+React Native
- Faster cold start

**Voice Pipeline**:
- Low-latency audio playback
- Smooth avatar lip-sync synchronization
- Background execution reliability

### Business Advantages

- **Tamil/Indian market**: Flutter has strong adoption in India
- **Premium feel**: Flutter apps can achieve iOS/Android parity more easily
- **Long-term maintenance**: Single codebase, no bridge debugging
- **Talent pool**: Large Flutter developer community

---

## 2. Why Not Stay on Expo/React Native?

### Current Limitations

**Avatar Performance**:
- react-native-rive is less mature than rive-flutter
- Animation performance degrades with complex state machines
- No native Impeller rendering

**Native Services**:
- Expo has limited support for foreground services
- Wake-word detection requires custom native modules
- Audio focus management is fragmented

**Bridge Overhead**:
- JS bridge adds latency to voice pipeline
- Memory pressure from dual runtimes (JS + native)
- Debugging native issues requires native expertise anyway

**Ecosystem Drift**:
- Expo Router is still evolving
- NativeWind has compatibility issues
- Voice-specific packages are immature

### Migration Justification

The voice-first, avatar-based UX demands:
1. **Smooth 60fps avatar animations** — Flutter wins
2. **Reliable wake-word detection** — Native Kotlin + Flutter bridge wins
3. **Low-latency voice pipeline** — No JS bridge wins
4. **Premium glassmorphism UI** — Flutter's rendering wins
5. **Long-term maintainability** — Single framework wins

---

## 3. Migration Strategy

### Phase 0: Audit (✅ Current Phase)
- [x] Document current state
- [x] Identify reusable components
- [x] Assess backend stability
- [x] Plan migration sequence

### Phase 1: Stabilize Backend
**Duration**: 1-2 weeks 
**Goal**: Fix all typecheck/lint failures, ensure CI passes

**Tasks**:
1. Fix @nova/auth exports
2. Fix TypeScript errors in agent-orchestrator
3. Fix TypeScript errors in integration-service
4. Migrate ESLint to flat config
5. Run full test suite
6. Verify all services build

**Deliverable**: Green CI pipeline

### Phase 2: Flutter Foundation
**Duration**: 1 week 
**Goal**: Set up Flutter project with core infrastructure

**Tasks**:
1. Create `apps/mobile-flutter/` directory
2. Initialize Flutter project
3. Configure Riverpod state management
4. Configure GoRouter navigation
5. Set up Dio for API calls
6. Set up Drift for local database
7. Set up flutter_secure_storage
8. Configure build flavors (dev/staging/prod)

**Deliverable**: Flutter app builds and runs on Android

### Phase 3: Design System
**Duration**: 1 week 
**Goal**: Implement NOVA design tokens and core components

**Tasks**:
1. Create `lib/design/` package
2. Define color tokens (dark theme, blue/cyan/purple gradients)
3. Define typography tokens
4. Define spacing/radii/elevation tokens
5. Create glassmorphism components (NovaGlassCard)
6. Create core widgets (NovaButton, NovaTextField, NovaCard)
7. Implement dark theme

**Deliverable**: Design system library with widget tests

### Phase 4: Rive Avatar
**Duration**: 2 weeks 
**Goal**: Integrate Rive avatar with state machine

**Tasks**:
1. Add `rive` package
2. Create `lib/avatar/` package
3. Design avatar state machine (IDLE, LISTENING, THINKING, SPEAKING, etc.)
4. Create avatar controller
5. Implement state transitions
6. Add audio-level lip animation
7. Create emotion mapping (Claude → avatar states)
8. Design/create Rive assets (or use placeholders)

**Deliverable**: Avatar renders and responds to state changes

### Phase 5: Chat
**Duration**: 1 week 
**Goal**: Implement streaming chat with backend

**Tasks**:
1. Create chat feature module
2. Connect to NOVA API
3. Implement streaming responses
4. Display message history
5. Show tool action cards
6. Handle errors/retry

**Deliverable**: Functional chat with backend

### Phase 6: Voice Pipeline
**Duration**: 2 weeks 
**Goal**: Implement voice interaction

**Tasks**:
1. Create `lib/voice/` package
2. Implement microphone lifecycle
3. Integrate Sarvam STT (via backend)
4. Implement partial transcript UI
5. Implement TTS playback (via backend)
6. Synchronize avatar with TTS
7. Handle audio interruptions

**Deliverable**: Voice-first chat working

### Phase 7: Wake Word
**Duration**: 1 week 
**Goal**: Implement "Hey NOVA" wake-word detection

**Tasks**:
1. Create native Kotlin wake-word service
2. Implement foreground service
3. Integrate Porcupine or openWakeWord
4. Set up MethodChannel/EventChannel
5. Handle wake-word events in Flutter
6. Test screen on/off, background, device restart

**Deliverable**: "Hey NOVA" triggers listening state

### Phase 8-13: Remaining Features
Follow the master prompt's phase plan for reminders, device control, notifications, memory, E2E testing, and production hardening.

---

## 4. Flutter Project Structure

```
apps/mobile-flutter/
├── lib/
│ ├── app/
│ │ ├── app.dart # Root widget, providers
│ │ └── routes.dart # GoRouter configuration
│ ├── core/
│ │ ├── api/ # Dio clients, interceptors
│ │ ├── auth/ # Auth state, token management
│ │ ├── database/ # Drift setup, migrations
│ │ ├── logging/ # Logger setup
│ │ ├── permissions/ # Permission handlers
│ │ └── platform/ # MethodChannel wrappers
│ ├── design/ # Design system
│ │ ├── tokens/ # Colors, typography, spacing
│ │ ├── components/ # Reusable widgets
│ │ └── theme/ # Theme data
│ ├── avatar/ # Rive avatar integration
│ │ ├── controller.dart # Avatar state controller
│ │ ├── states.dart # AvatarState enum
│ │ └── widget.dart # NovaAvatar widget
│ ├── voice/ # Voice pipeline
│ │ ├── controller.dart # Voice state controller
│ │ ├── stt.dart # Speech-to-text
│ │ ├── tts.dart # Text-to-speech
│ │ └── audio_manager.dart # Audio focus, lifecycle
│ ├── features/
│ │ ├── onboarding/ # Onboarding flow
│ │ ├── home/ # Home screen
│ │ ├── chat/ # Chat interface
│ │ ├── tasks/ # Tasks/reminders
│ │ ├── memory/ # Memory UI
│ │ ├── notifications/ # Notification insights
│ │ ├── device/ # Device dashboard
│ │ └── settings/ # Settings
│ └── main.dart # Entry point
├── android/ # Native Android
│ └── app/src/main/kotlin/com/leadup/nova/
│ ├── MainActivity.kt
│ ├── NovaWakeService.kt
│ ├── WakeWordManager.kt
│ ├── NovaAudioManager.kt
│ ├── NotificationListener.kt
│ ├── ReminderReceiver.kt
│ ├── BootReceiver.kt
│ └── DeviceBridge.kt
├── ios/ # iOS support (future)
├── assets/
│ ├── rive/ # Avatar animations
│ ├── images/ # App images
│ └── fonts/ # Custom fonts
├── pubspec.yaml
└── README.md
```

---

## 5. Key Dependencies

### Core
- `flutter_riverpod` — State management
- `go_router` — Navigation
- `freezed` + `json_serializable` — Immutable models
- `dio` — HTTP client
- `drift` + `sqlite3_flutter_libs` — Local database
- `flutter_secure_storage` — Secure storage

### Avatar
- `rive` — Avatar animation runtime

### Voice
- `permission_handler` — Microphone permissions
- `audio_session` — Audio focus management
- `just_audio` — Audio playback

### Native
- `flutter_local_notifications` — Local notifications
- `android_alarm_manager_plus` — Alarm scheduling
- `local_auth` — Biometric authentication
- `sensors_plus` — Device sensors
- `haptic_feedback` — Haptics

### UI
- `flutter_screenutil` — Responsive sizing
- `cached_network_image` — Image caching

---

## 6. Platform Bridge Design

### MethodChannel Methods

```dart
// Native → Flutter (EventChannel)
- wakeWordDetected
- notificationReceived
- reminderTriggered
- audioInterrupted
- deviceStateChanged
- serviceStateChanged

// Flutter → Native (MethodChannel)
- startWakeWord()
- stopWakeWord()
- getWakeStatus()
- checkNotificationAccess()
- openNotificationAccess()
- scheduleReminder()
- cancelReminder()
- getDeviceInfo()
- getBatteryInfo()
- triggerHaptic()
- requestBiometric()
- isAssistantDefault()
- requestAssistantRole()
```

---

## 7. State Management Architecture

### Providers

```dart
// Core
- authProvider — User authentication state
- connectivityProvider — Network status

// Voice
- voiceProvider — Voice pipeline state (idle, listening, thinking, speaking)
- audioProvider — Audio playback state

// Avatar
- avatarProvider — Avatar state (idle, listening, thinking, speaking, etc.)

// Features
- chatProvider — Conversation state
- reminderProvider — Reminders state
- memoryProvider — Memory/context state
- notificationProvider — Notification insights
- deviceProvider — Device information
- permissionProvider — Permission status
- settingsProvider — User preferences
```

---

## 8. Migration Risks

### High Risk
1. **Parallel maintenance burden** — Running Expo + Flutter simultaneously doubles mobile maintenance
2. **Native Kotlin expertise required** — Wake-word service, audio focus, foreground services need Android expertise
3. **Rive asset creation** — Custom avatar animations need design resources
4. **Backend API changes** — Flutter app may expose API design gaps

### Medium Risk
1. **State management migration** — Expo Context API → Riverpod requires rewrites
2. **Navigation migration** — Expo Router → GoRouter requires rewrites
3. **Testing gaps** — Need to rebuild E2E tests for Flutter
4. **Platform-specific bugs** — Android/iOS behavior differences

### Low Risk
1. **Build configuration** — Standard Flutter setup
2. **CI/CD updates** — Add Flutter build steps
3. **Dependency updates** — Most packages have Flutter equivalents

---

## 9. Backend Compatibility

### APIs to Maintain
- `/api/v1/chat` — Streaming chat
- `/api/v1/voice/stt` — Speech-to-text
- `/api/v1/voice/tts` — Text-to-speech
- `/api/v1/reminders` — CRUD reminders
- `/api/v1/memory` — Memory operations
- `/api/v1/notifications` — Notification insights
- `/api/v1/device` — Device info (future)

### APIs to Add
- `/api/v1/voice/stream` — WebSocket for real-time voice
- `/api/v1/avatar/state` — Avatar state synchronization (if needed)
- `/api/v1/tools/execute` — Tool execution endpoint

### Backend Changes Needed
1. **WebSocket support** — For real-time voice streaming
2. **CORS allowlist** — Add Flutter app origin
3. **Rate limiting** — Verify limits are appropriate for mobile
4. **API versioning** — Ensure versioned endpoints are stable

---

## 10. Testing Strategy

### Flutter Tests
- Unit tests for business logic
- Widget tests for UI components
- Integration tests for full flows

### E2E Tests
- Migrate Playwright tests to Patrol or integration_test
- Test companion loop (wake → listen → think → speak)
- Test reminders, notifications, device control

### Backend Tests
- Continue existing test suite
- Add WebSocket integration tests
- Add voice pipeline integration tests

---

## 11. CI/CD Updates

### Flutter Pipeline
```yaml
# .github/workflows/flutter.yml
- flutter pub get
- dart format --set-exit-if-changed .
- flutter analyze
- flutter test
- flutter build apk --debug
# Eventually: flutter build appbundle --release
```

### Backend Pipeline (Existing)
- Keep existing pnpm/Turbo pipeline
- Add Flutter build steps
- Update deployment scripts

---

## 12. Timeline Comparison

### Option A: Phased Migration (Recommended)
- **Backend stabilization**: 1-2 weeks
- **Flutter foundation**: 1 week
- **Feature-by-feature migration**: 12-16 weeks
- **Total**: 14-19 weeks
- **Risk**: Low (parallel operation, gradual migration)

### Option B: Big Bang Migration
- **Flutter full rebuild**: 16-20 weeks
- **Expo deprecation**: 1 week
- **Total**: 17-21 weeks
- **Risk**: High (no fallback, feature gaps)

### Option C: Hybrid (Recommended for V1)
- **Keep Expo for admin/web**: No change
- **Build Flutter for mobile**: 14-19 weeks
- **Deprecate Expo mobile**: After Flutter parity
- **Total**: 14-19 weeks + 1 week deprecation
- **Risk**: Low (gradual, testable)

---

## 13. Cost-Benefit Analysis

### Costs
- **Development time**: 14-19 weeks of engineering
- **Dual maintenance**: 2-4 weeks of parallel operation
- **Testing effort**: Rebuild E2E tests
- **Design work**: Custom Rive avatar assets

### Benefits
- **Performance**: 60fps avatar, no JS bridge
- **Reliability**: Better native Android integration
- **Maintainability**: Single framework, no bridge
- **UX**: Premium feel, smooth animations
- **Scalability**: Easier to add features long-term

### ROI
- **Short-term**: Higher cost, slower feature delivery
- **Long-term**: Lower maintenance, better UX, faster iteration
- **Break-even**: ~6 months after Flutter parity

---

## 14. Decision Matrix

| Factor | Expo/RN | Flutter | Winner |
|--------|---------|---------|--------|
| Avatar performance | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Flutter |
| Native Android integration | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Flutter |
| UI consistency | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Flutter |
| Development speed (V1) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | Expo |
| Ecosystem maturity | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Expo |
| Long-term maintainability | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Flutter |
| Voice pipeline latency | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Flutter |
| Testing infrastructure | ⭐⭐⭐⭐ | ⭐⭐⭐ | Expo |

**Overall**: Flutter wins for long-term vision, Expo wins for short-term speed.

---

## 15. Recommendation

**Proceed with phased migration**:

1. **Week 1-2**: Stabilize backend (fix typecheck/lint)
2. **Week 3**: Set up Flutter foundation
3. **Week 4**: Implement design system
4. **Week 5-6**: Integrate Rive avatar
5. **Week 7**: Implement chat
6. **Week 8-9**: Implement voice pipeline
7. **Week 10**: Implement wake word
8. **Week 11-13**: Implement reminders, device control, notifications, memory
9. **Week 14-15**: E2E testing
10. **Week 16-19**: Production hardening

**Keep Expo running in parallel** until Flutter achieves feature parity. Deprecate Expo only after Flutter passes all acceptance tests.

**Do NOT**:
- Rip and replace Expo
- Rewrite backend
- Skip backend stabilization
- Promise features before they're tested
