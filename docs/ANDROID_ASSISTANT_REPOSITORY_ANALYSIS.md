# Android Assistant Repository Analysis

NOVA's Android layer draws from these repositories.

---

## Repository Analysis

### AION / Jarvis-AI-Assistant
- **URL**: https://github.com/Manthan-13521/Jarvis-AI-Assistant
- **Owner**: Manthan Jaiswal (Manthan-13521)
- **Purpose**: "AION OS — Voice-First AI Companion." AI voice assistant for Android with memory, wake word detection, and smart device control. Kotlin multi-module project with Clean Architecture.
- **Technology**: Kotlin, Jetpack Compose, Room (SQLite), Android
- **Architecture**: Clean Architecture — multi-module structure with `core/src` domain layer, feature modules, `shared/kotlin/domain` for cross-cutting concerns. Uses a central Agent orchestrator with plugin/tool registry pattern.
- **Language**: Kotlin 99.9%, Shell 0.1%
- **Framework**: Android native (Jetpack Compose), Gradle build system
- **License**: All Rights Reserved — proprietary. Shared as a technical portfolio piece; requires permission for reuse, forking for redistribution, or production deployment.
- **Mobile compatibility**: Android only (native Android app)
- **Android compatibility**: Full — built specifically for Android with Jetpack Compose UI, foreground services, and native audio handling
- **Wake word**: Yes — custom implementation (details in ARCHITECTURE_REPORT.md)
- **Foreground service**: Yes — audio capture and wake word detection run in foreground service
- **Background execution**: Yes — background audio capture with wake word listening
- **Notification access**: Not documented in public README
- **Device control**: Yes — smart device control via plugin/tool registry with Action classes
- **NOVA compatibility**: High conceptually — Kotlin multi-module Clean Architecture aligns with NOVA's backend patterns. State machine for voice lifecycle maps to NOVA's Riverpod state machine. AudioFocusManager concept directly applicable. Proprietary license prevents direct code reuse.
- **Reusable ideas**:
 - Clean Architecture feature-first module structure for voice pipeline
 - Central Agent orchestrator with lifecycle management (maps to NOVA's AgentOrchestrator)
 - State machine for voice session lifecycle (idle → listening → processing → speaking)
 - AudioFocusManager for handling phone calls, Bluetooth, headphones
 - Plugin/tool registry pattern for device control actions
 - Result<T> sealed-class error strategy (maps to Freezed + Either in Dart)
 - Room DAO persistence pattern (maps to Drift in Flutter)
 - Encrypted storage for sensitive data
- **Recommended action**: REFERENCE ONLY — study the public ARCHITECTURE_REPORT.md for Clean Architecture patterns and state machine design. Adapt the AudioFocusManager concept using Hark's Apache 2.0 implementation. Do not copy code.

### DeVA
- **URL**: https://github.com/Devanshupardeshi/DeVA
- **Owner**: Devanshu Pardeshi (Devanshupardeshi)
- **Purpose**: "Your AI Phone Operator" — an AI agent that sees, speaks, and controls your Android phone through voice commands. Uses the Android Accessibility API for screen reading and UI automation.
- **Technology**: Kotlin, Gemini AI (Google), Android Accessibility API, Firebase, Google Cloud TTS, Porcupine wake word
- **Architecture**: Android native app with voice-first pipeline: Porcupine wake word → STT → Gemini AI NLU/decision making → Accessibility API action execution. Screen intelligence through real-time accessibility tree parsing.
- **Language**: Kotlin
- **Framework**: Android native (Gradle)
- **License**: Personal Use License — personal, educational, and research use permitted; commercial use requires separate license. See LICENSE in repo root.
- **Mobile compatibility**: Android only
- **Android compatibility**: Full — built specifically for Android with deep system integration (Accessibility Service, foreground services)
- **Wake word**: Yes — Picovoice Porcupine
- **Foreground service**: Yes — required for persistent wake word listening
- **Background execution**: Yes — background audio capture for wake word detection
- **Notification access**: Not documented in public README
- **Device control**: Yes — screen intelligence via Android Accessibility API; can read screen content, tap elements, type text, navigate UI
- **NOVA compatibility**: High for Android layer patterns — Porcupine wake word integration and Accessibility-based screen control directly applicable to NOVA's Kotlin layer. Screen intelligence concept valuable for NOVA's device control feature. Personal Use License limits commercial code reuse but patterns are well-documented.
- **Reusable ideas**:
 - Porcupine wake word integration pattern for Android foreground service
 - Android Accessibility Service for screen reading and UI automation
 - Screen capture + AI interpretation for context-aware device control
 - Voice command → Gemini AI → Accessibility action pipeline
 - App-specific learning automation (hints improve future runs)
 - Voice-first UX with minimal UI
- **Recommended action**: REFERENCE ONLY — study the Porcupine + Gemini + Accessibility API integration pattern. The Personal Use License prohibits commercial code reuse. Adapt the screen intelligence concept into NOVA's Android layer for Phase 3 device control features.

### Hark
- **URL**: https://github.com/OpenAppCapabilityProtocol/hark
- **Owner**: OpenAppCapabilityProtocol (community org, co-developed with Claude Opus/Sonnet 4.6)
- **Purpose**: Open-source voice assistant built on OACP (Open App Capability Protocol). Discovers and controls Android apps using on-device AI — no cloud, no account, no data collection. Features two-stage on-device AI (EmbeddingGemma 308M + 0.5B).
- **Technology**: Flutter, Dart, Kotlin (Android native), EmbeddingGemma 308M + 0.5B, openWakeWord, Riverpod, forui, OACP protocol, Pigeon (Flutter-Kotlin bridge)
- **Architecture**: Flutter app with Kotlin Android platform layer. OACP protocol for dynamic app capability discovery via ContentProvider. Intent dispatch (broadcast + activity) with async result handling. VoiceInteractionService for Android system assistant integration. Two-stage on-device AI: embedding model selects capabilities, small LLM generates actions.
- **Language**: Dart (Flutter UI + logic), Kotlin (Android platform services)
- **Framework**: Flutter, Riverpod (state management), forui (UI)
- **License**: Apache 2.0 — permissive, allows commercial use, modification, distribution
- **Mobile compatibility**: Android primary (iOS scaffold exists in `/ios` directory but not the focus)
- **Android compatibility**: Full — foreground service, wake word, VoiceInteractionService, OACP ContentProvider discovery
- **Wake word**: Yes — openWakeWord (on-device, Apache 2.0), with planned sensitivity slider and barge-in support
- **Foreground service**: Yes — WakeWordForegroundService for persistent microphone access and wake word detection
- **Background execution**: Yes — foreground service with persistent notification for background listening
- **Notification access**: Not the primary focus, but wake word toggle syncs with notification action buttons (Stop/Start from notification)
- **Device control**: Yes — via OACP protocol: discovers app capabilities through ContentProvider, dispatches intents (broadcast + activity) with async result handling. No cloud, fully on-device.
- **NOVA compatibility**: Highest — Flutter/Dart codebase directly portable to NOVA. Apache 2.0 license. OACP protocol design informs NOVA's tool-calling runtime. Foreground service + Flutter bridge pattern already implemented in NOVA. Active development with 80+ commits.
- **Reusable ideas**:
 - Foreground service + Flutter EventChannel bridge pattern (already ported to NOVA)
 - OACP protocol — dynamic app capability discovery via ContentProvider
 - Two-stage on-device AI: embedding model (308M) + small LLM (0.5B) for tool selection
 - VoiceInteractionService integration for Android system assistant
 - Riverpod-based state management for voice pipeline
 - Broadcast + activity intent dispatch with async result handling
 - Wake word toggle sync with SharedPreferences + Settings UI
 - Persistent notification with start/stop controls
- **Recommended action**: USE SDK — Hark's Flutter/Kotlin bridge code is already ported into NOVA. Continue tracking OACP protocol evolution and on-device LLM patterns. Replace openWakeWord with Porcupine (already planned).

### SannaBot
- **URL**: https://github.com/sannabotdev/sannabotapp
- **Owner**: sannabotdev (individual developer)
- **Purpose**: Open-source voice-first AI assistant for Android that controls your phone. Features agent loop with tool use, multi-step reasoning, markdown-based skill extension (SKILL.md), editable personality (SOUL), personal memory, and sub-agents.
- **Technology**: React Native + native Kotlin, OpenAI or Claude LLM, OAuth PKCE, on-device storage, sub-agents (scheduler, notifications, accessibility)
- **Architecture**: React Native cross-platform app with native Kotlin modules for Android-specific features (audio, accessibility). Agent loop: voice input → STT → LLM with tool use → action execution → TTS response. Sub-agents handle scheduler, notifications, accessibility tasks independently. SKILL.md files define extendable capabilities. SOUL file defines assistant personality. Context condensation for long conversations.
- **Language**: TypeScript (React Native), Kotlin (native Android modules)
- **Framework**: React Native, NativeWind, Kotlin native modules
- **License**: MIT — permissive, allows commercial use with attribution
- **Mobile compatibility**: Android + iOS (cross-platform)
- **Android compatibility**: Full — native Kotlin modules for audio, accessibility, notifications
- **Wake word**: Yes — native Kotlin module implementation
- **Foreground service**: Yes — for persistent voice listening
- **Background execution**: Yes — background audio capture, sub-agents for scheduled tasks
- **Notification access**: Yes — sub-agent for notification reading/classification
- **Device control**: Yes — Android Accessibility-based app control, tool use for app-specific actions (Gmail, Spotify, Slack, etc.)
- **NOVA compatibility**: High for agent architecture — SKILL.md system, sub-agent architecture, and tool-use patterns directly inform NOVA's backend agent orchestrator. React Native voice UX patterns useful for Flutter. MIT license allows code study and adaptation. Cross-platform approach aligns with NOVA's Flutter strategy.
- **Reusable ideas**:
 - Markdown-based SKILL.md system for extending assistant capabilities (port to NOVA's tool registry)
 - Sub-agent architecture — scheduler, notifications, accessibility as separate agents (maps to NOVA's microservices)
 - Agent loop with multi-step reasoning and tool use (maps to NOVA's AgentOrchestrator)
 - SOUL (editable assistant personality) pattern (maps to NOVA's personality configuration)
 - Personal memory injection into prompts (maps to NOVA's user profile system)
 - Context condensation for long conversation management
 - OAuth PKCE for secure API authentication without backend secrets
 - Debug logging system (sanna.txt debug file)
- **Recommended action**: ADAPT CONCEPT — MIT licensed, safe to study and adapt patterns. Port the SKILL.md system, agent loop architecture, sub-agent pattern, and memory injection into NOVA's backend. Use React Native voice UX patterns as reference for Flutter implementation.

---

## Android Permissions Required

```xml
<!-- Core voice permissions -->
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MICROPHONE" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />
<uses-permission android:name="android.permission.VIBRATE" />

<!-- Phase 3+ permissions -->
<uses-permission android:name="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE" />
<uses-permission android:name="android.permission.READ_NOTIFICATIONS" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
```

---

## Android Services Required

| Service | Purpose | Status |
|---------|---------|--------|
| WakeWordForegroundService | Always-on mic + wake word detection | ✅ Scaffold created |
| NotificationListenerService | Incoming notification classification | Phase 4 |
| AlarmReceiver | Reminder firing | Phase 4 |
| BootReceiver | Restart services on boot | Phase 4 |
| BiometricPrompt | Device authentication | Phase 3 |

---

## Code Reuse Summary

| Component | Source | License | Status |
|-----------|--------|---------|--------|
| Foreground service scaffold | Hark | Apache 2.0 | ✅ Ported to NOVA |
| Kotlin-Flutter bridge (MethodChannel + EventChannel) | Hark | Apache 2.0 | ✅ Ported to NOVA |
| Wake word toggle + SharedPreferences sync | Hark | Apache 2.0 | ✅ Ported to NOVA |
| Riverpod state sync from platform events | Hark | Apache 2.0 | ✅ Ported to NOVA |
| Audio focus concept | Hark + Jarvis | Apache 2.0 / Proprietary | Conceptual — use `audio_session` package |
| Agent orchestrator pattern | Jarvis | All Rights Reserved | REFERENCE ONLY |
| Clean Architecture structure | Jarvis | All Rights Reserved | REFERENCE ONLY |
| Porcupine + Accessibility API pattern | DeVA | Personal Use | REFERENCE ONLY |
| Agent loop + SKILL.md system | SannaBot | MIT | ADAPT — port to backend |
| Sub-agent architecture | SannaBot | MIT | ADAPT — port to backend |
| Memory injection + SOUL pattern | SannaBot | MIT | ADAPT — port to backend |
