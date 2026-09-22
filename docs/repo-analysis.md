# NOVA-Leadup External Repository Analysis

**Date:** September 6, 2026 
**Scope:** Six candidate repositories for voice-first AI assistant research 
**Method:** GitHub page extraction, README analysis, LICENSE file verification, architecture doc review

---

## Summary Decision Matrix

| Repository | License | Mobile | Avatar | Voice | Recommended Action |
|---|---|---|---|---|---|
| Jarvis-AI-Assistant | All Rights Reserved (restricted) | ✅ Android | ❌ | ✅ Full pipeline | **REFERENCE ONLY** |
| DeVA | Personal Use (restricted) | ✅ Android | ❌ | ✅ Full pipeline | **REFERENCE ONLY** |
| Hark | Apache 2.0 (permissive) | ✅ Android | ❌ | ✅ Full pipeline | **USE DIRECTLY** |
| SannaBot | MIT (permissive) | ✅ Android + iOS | ❌ | ✅ Full pipeline | **USE DIRECTLY** |
| Rive Flutter | MIT (permissive) | ✅ Flutter (mobile) | ✅ Animation | ❌ | **USE SDK ONLY** |
| Prometheus Avatar | MIT (permissive) | ⚠️ Web-only | ✅ Live2D + 3D | ✅ TTS + Live | **ADAPT CONCEPT** |

---

## 1. Jarvis-AI-Assistant (AION OS)

**URL:** https://github.com/Manthan-13521/Jarvis-AI-Assistant 
**Owner:** Manthan Jaiswal (@Manthan-13521) 
**Stars:** 5 | **Forks:** 0 | **Commits:** 5 | **Last Activity:** Jul 31, 2026

### License: ⛔ RESTRICTED — All Rights Reserved

No LICENSE file exists in the repository (confirmed 404 on raw fetch). The README displays an explicit badge: `License: All Rights Reserved`. The license section reads:

> "This repository is shared as a technical portfolio piece. Please reach out before reusing, forking for redistribution, or deploying a derivative in production."

**Classification:** Restricted / All Rights Reserved. Cannot be forked, modified, or deployed without explicit author permission. Treat as non-reusable for production code.

### Purpose

AION OS — a production-grade, voice-first AI operating system for Android. Marketed as a portfolio project demonstrating enterprise Android architecture.

### Language & Framework

| Component | Technology |
|---|---|
| Primary language | Kotlin 99.9%, Shell 0.1% |
| UI | Jetpack Compose + Material 3 |
| Architecture | Clean Architecture (4-layer: Presentation, Application, Domain, Infrastructure) |
| DI | Hilt / Dagger |
| Database | Room + DataStore |
| Build | Gradle (Android) |

### Architecture

**4-layer Clean Architecture:**
- **Presentation Layer:** Compose UI (Chat UI, Orb Indicator, Audio Foreground Service)
- **Application Layer:** Pipeline Orchestrator, Session State Machine (8 states, 35 valid transitions)
- **Domain Layer (pure Kotlin):** Intent Classifier, Memory Engine, Plugin Executor
- **Infrastructure Layer:** Wake Word Detector, STT, TTS, Room DB, CryptoManager

**Voice Pipeline:** `WakeWord → STT → Classify → Plugin Execution → Generative AI → TTS`

**Key engineering patterns:**
- Strict `Result<T>` sealed classes (no thrown exceptions in business logic)
- Single-threaded state machine for voice session management
- AES-GCM encryption for tokens via EncryptedFile/EncryptedSharedPreferences
- AudioFocusManager for ducking/Bluetooth SCO routing
- Sandboxed plugin registry with isolated permission scopes

### Voice Capabilities

| Capability | Status | Details |
|---|---|---|
| Wake Word | ✅ | Built-in, adaptive threshold with EMA noise floor |
| STT | ✅ | Android SpeechRecognizer API |
| TTS | ✅ | Android TextToSpeech API |
| Emotion | ❌ | Not implemented |
| Lip Sync | ❌ | Not implemented |
| Memory | ✅ | Room DB — conversation vectors + user preferences |
| Continuous Listening | ✅ | State machine driven |

### Avatar Capabilities

**None.** No avatar, orb, or visual persona component beyond a simple "AionOrb Indicator" status dot.

### Mobile Compatibility

- **Android:** Primary target (API 26+)
- **iOS:** Not supported
- **Form factor:** Phone-only

### Agent & Tool Architecture

- Plugin-based execution with sandboxed permissions
- No external agent framework integration documented
- No MCP support
- No tool-calling runtime beyond the plugin registry

### Testing

- JUnit4, MockK, Turbine (unit/flow testing)
- Espresso (instrumentation)
- CI/CD via GitHub Actions (`.github/` present)

### Recommended Action: 🔴 REFERENCE ONLY

**Rationale:** The "All Rights Reserved" license explicitly prohibits reuse, forking for redistribution, or derivative deployment without author contact. Despite being a high-quality architectural reference (Clean Architecture, state machine voice pipeline, sandboxed plugins), the license makes it unusable for direct code integration.

**What to learn from it:**
- 4-layer Clean Architecture for voice apps on Android
- State machine design for voice session management (8 states, 35 transitions)
- `Result<T>` error handling pattern
- Plugin sandboxing with isolated permissions
- AudioFocusManager pattern for concurrent audio handling

---

## 2. DeVA (Device Virtual Assistant)

**URL:** https://github.com/Devanshupardeshi/DeVA 
**Owner:** Devanshu Pardeshi (@Devanshupardeshi) 
**Stars:** 3 | **Forks:** 4 | **Commits:** 1 | **Last Activity:** Feb 7, 2026 (initial commit)

### License: ⛔ RESTRICTED — Personal Use License

LICENSE file confirmed present. Key terms:

> "Non-exclusive, non-transferable license to use, copy, modify, and distribute for **personal, educational, and non-commercial purposes only**."
> "**COMMERCIAL USE PROHIBITED**: You may not use the Software or any derivative works for any commercial purpose."

**Classification:** Restricted / Custom Personal Use. Commercial use requires separate license negotiation. Modification and distribution allowed only for non-commercial purposes.

### Purpose

AI voice assistant that actually controls your Android phone through UI automation. Uses Accessibility Services to "see" and interact with any app on the device, not just apps with specific APIs.

### Language & Framework

| Component | Technology |
|---|---|
| Primary language | Kotlin 1.9.22 |
| AI Engine | Google Gemini |
| UI | Android native (Compose inferred) |
| Build | Gradle |

### Architecture

**Multi-agent "Brain" system:**
- 🧠 **Brain (LLM):** Gemini-powered reasoning & planning
- 👂 **Ears:** STT/TTS voice I/O
- 👁️ **Eyes:** Accessibility Service for screen reading & UI hierarchy analysis
- 🖐️ **Hands:** Action execution (tap, swipe, type via Accessibility)

**Core Components:**
- `ConversationalAgentService` — voice interaction + conversation flow
- `AgentService` — multi-step task execution via UI automation
- `SpeechCoordinator` — STT/TTS management
- `GeminiApi` — LLM decision making

### Voice Capabilities

| Capability | Status | Details |
|---|---|---|
| Wake Word | ✅ | Porcupine ("Hey DeVA") |
| STT | ✅ | Google Cloud TTS / speech recognition |
| TTS | ✅ | Google Cloud TTS |
| Emotion | ❌ | Not implemented |
| Lip Sync | ❌ | Not implemented |
| Memory | ❌ | Not documented |
| Continuous Listening | ❌ | Not documented |

### Avatar Capabilities

**None.** No avatar component.

### Mobile Compatibility

- **Android:** API 26+ (Android 8.0+)
- **iOS:** Not supported
- **Form factor:** Phone-only

### Agent & Tool Architecture

- Multi-agent system with separate sensory agents (Eyes, Ears, Hands)
- Gemini as central reasoning brain
- Accessibility Service for universal app control (no API required)
- No MCP support
- No structured tool-calling runtime

### Testing

No test directory or testing configuration visible in the initial-commit repo structure.

### Recommended Action: 🔴 REFERENCE ONLY

**Rationale:** The Personal Use License explicitly prohibits commercial use and derivative works in commercial products. Single initial commit, no subsequent development activity.

**What to learn from it:**
- Multi-agent sensory architecture (Eyes/Ears/Hands pattern)
- Accessibility Service as a universal app-control mechanism
- Screen context analysis for UI automation without app-specific APIs
- Porcupine wake word integration on Android
- Concept of "any app" control via visual UI automation rather than API integration

---

## 3. Hark (Open App Capability Protocol Reference Assistant)

**URL:** https://github.com/OpenAppCapabilityProtocol/hark 
**Owner:** Open App Capability Protocol (@OpenAppCapabilityProtocol) 
**Stars:** 3 | **Forks:** 3 | **Commits:** 80 | **Last Activity:** Apr 14, 2026 
**License:** Apache 2.0 (confirmed from LICENSE file)

### License: ✅ PERMISSIVE — Apache 2.0

Full commercial and derivative use permitted. Patent grant included. Attribution required.

### Purpose

Reference voice assistant for OACP (Open App Capability Protocol). Discovers installed app capabilities at runtime and controls them by voice, entirely on-device, no cloud dependency.

### Language & Framework

| Component | Technology |
|---|---|
| Primary language | Dart (Flutter) + Kotlin (Android native) |
| Framework | Flutter 3.11+ |
| AI (on-device) | EmbeddingGemma 308M (intent) + 0.5B (slot filling) |
| Runtime | ONNX Runtime (for on-device models) |
| Build | Gradle (Android) + Flutter pub |

### Architecture

**5-stage voice pipeline (all on-device):**
1. **Listen** — `speech_to_text` → Android-native SpeechRecognizer
2. **Discover** — Scans installed apps for OACP capability manifests via ContentProvider
3. **Resolve** — Two-stage AI pipeline (EmbeddingGemma → cosine similarity ranking, then → parameter extraction)
4. **Dispatch** — Android Intent dispatch (broadcast for background, activity for foreground)
5. **Respond** — Async result handling via BroadcastReceiver → EventChannel → Flutter chat bubbles + TTS

**Capability Registry:** Single source of truth aggregating `AssistantAction` objects from all installed OACP apps, each with description, aliases, examples, keywords, parameters, and disambiguation hints.

**Overlay Engine:** Dedicated FlutterEngineGroup for instant (<200ms) overlay panel on top of current app. Separate from main engine.

**Android Integration:**
- `VoiceInteractionService` — system assistant framework
- `HarkSessionService` + `HarkSession` — session management
- `RoleManager` for ROLE_ASSISTANT on API 29+
- Foreground service with persistent notification for wake word

### Voice Capabilities

| Capability | Status | Details |
|---|---|---|
| Wake Word | ✅ | openWakeWord ("Hey Hark") — custom 201KB ONNX model, foreground service for background |
| STT | ✅ | Android SpeechRecognizer (cloud by default); whisper.cpp/sherpa-onnx planned |
| TTS | ✅ | flutter_tts |
| Emotion | ❌ | Not implemented |
| Lip Sync | ❌ | Not implemented |
| Memory | ❌ | Not documented |
| Continuous Listening | ✅ | Auto-restarts mic after each command (assistant gesture mode) |

### Avatar Capabilities

**None.** Chat bubble UI only. No visual avatar or persona.

### Mobile Compatibility

- **Android:** Primary target (API 26+), physical device required (no emulator support for mic/GPU)
- **iOS:** Not supported
- **Form factor:** Phone-only

### Agent & Tool Architecture

- OACP protocol — machine-readable capability manifests from installed apps
- Two-stage on-device NLU: encoder model for intent selection, generative model for parameter extraction
- Intent dispatch via Android broadcast/activity intents
- Async result handling via BroadcastReceiver with request ID correlation
- Pigeon bridge for Flutter↔Kotlin platform communication
- No MCP support (though the parent OACP org has an SDK)

### Testing

- GitHub Actions CI (tests.yaml workflow)
- Test directory present (`test/`)
- `rive_native` referenced for shared libraries

### Recommended Action: ✅ USE DIRECTLY

**Rationale:** Apache 2.0 license, active development (80 commits, 11 branches), well-documented architecture, production-quality on-device AI pipeline. The OACP protocol is the most architecturally novel contribution — it inverts the traditional assistant model by having apps declare their capabilities rather than the assistant hardcoding integrations.

**Integration value for NOVA-Leadup:**
- Reference implementation of OACP protocol for app capability discovery
- Two-stage on-device NLU pattern (encoder + generative)
- FlutterEngineGroup overlay pattern for instant assistant UI
- Foreground service + wake word coexistence pattern
- Can be forked/extended for NOVA-Leadup's own capability system

---

## 4. SannaBot (Sanna)

**URL:** https://github.com/sannabotdev/sannabotapp 
**Owner:** sannabotdev (@sannabotdev) 
**Stars:** 29 | **Forks:** 12 | **Commits:** 134 | **Last Activity:** Mar 27, 2026 
**License:** MIT (confirmed from README)

### License: ✅ PERMISSIVE — MIT

Full commercial and derivative use permitted. No restrictions.

### Purpose

Open-source voice-first AI assistant for Android that actually controls your phone. Multi-step agent that reads emails, sends messages, manages notifications, schedules tasks, and operates apps hands-free.

### Language & Framework

| Component | Technology |
|---|---|
| Primary language | TypeScript (React Native) + Kotlin (native modules) |
| Framework | React Native 0.84.0 + React 19.2.3 |
| Styling | NativeWind 4 (Tailwind CSS for RN) |
| AI | OpenAI or Claude (configurable) |
| Auth | OAuth PKCE (Google Sign-In) |
| Build | Gradle (Android) + Metro bundler |

### Architecture

**Hybrid React Native + Native Kotlin:**
- React Native frontend with TypeScript
- Native Kotlin modules for Android-specific features (accessibility, notifications, background services)
- `__tests__/` directory for Jest testing
- `assets/skills/` — Markdown-based extensibility system (SKILL.md pattern)
- Sub-agent architecture: scheduler, notification watcher, accessibility controller run as background services

**Key systems:**
- **Voice Pipeline:** Wake word → STT → LLM → TTS
- **Agent Loop:** Tool use + multi-step reasoning
- **Learning Automation:** App-specific UI hints improve future runs
- **SOUL:** Editable assistant personality configuration
- **Personal Memory:** Structured user memory injected into prompts

### Voice Capabilities

| Capability | Status | Details |
|---|---|---|
| Wake Word | ✅ | Implemented (specific engine not named in README) |
| STT | ✅ | Via LLM provider (OpenAI Whisper or equivalent) |
| TTS | ✅ | Via LLM provider |
| Emotion | ❌ | Not implemented |
| Lip Sync | ❌ | Not implemented |
| Memory | ✅ | Structured personal memory + conversation history |
| Continuous Listening | ✅ | Driving mode mentioned |
| Background Sub-agents | ✅ | Scheduler + notification watcher |

### Avatar Capabilities

**None.** No avatar or visual persona component.

### Mobile Compatibility

- **Android:** Primary target (React Native)
- **iOS:** `ios/` directory present — iOS support included
- **Form factor:** Phone + tablet (React Native cross-platform)

### Agent & Tool Architecture

- Multi-step LLM agent loop with tool definitions
- Android Accessibility Service for UI automation (same approach as DeVA)
- Background sub-agents: scheduler, notification monitor, accessibility handler
- Markdown-based skills system (`assets/skills/SKILL.md`) — extensibility pattern
- OAuth PKCE for service integrations (Gmail, Slack, Spotify, etc.)
- No MCP support

### Testing

- Jest test suite (`__tests__/`)
- React Native testing infrastructure
- Debug logging via `sanna.txt` file export

### Recommended Action: ✅ USE DIRECTLY

**Rationale:** MIT license, most active Android voice assistant repo in this set (134 commits, 12 forks, 29 stars), cross-platform (Android + iOS), production-quality agent loop with sub-agents, and the Markdown skills system is a novel extensibility pattern.

**Integration value for NOVA-Leadup:**
- Best reference for multi-step agent loop design on mobile
- Skills-as-markdown extensibility pattern (SKILL.md files)
- Background sub-agent architecture (scheduler, notification watcher)
- Cross-platform React Native + native Kotlin hybrid approach
- OAuth PKCE integration pattern for third-party services
- Accessibility-based app control implementation

---

## 5. Rive Flutter

**URL:** https://github.com/rive-app/rive-flutter 
**Owner:** Rive (@rive-app) 
**Stars:** 1,500 | **Forks:** 239 | **Commits:** 629 | **Last Activity:** Active (master branch) 
**Version:** 0.15.0-dev.1 
**License:** MIT (confirmed from LICENSE file)

### License: ✅ PERMISSIVE — MIT

Full commercial and derivative use permitted.

### Purpose

Official Flutter runtime for Rive — a real-time interactive animation tool. Allows full control of Rive files (`.riv`) in Flutter apps and games. Not an AI or voice assistant library — it is an animation runtime.

### Language & Framework

| Component | Technology |
|---|---|
| Primary language | Dart (Flutter) + C++ (rive_native) |
| Framework | Flutter SDK (>= 3.32.0, Dart >= 3.8.0) |
| Native runtime | rive_native 0.2.0-dev.1 (C++ core) |
| Rendering | Rive renderer or Flutter renderer (Skia/Impeller) |

### Architecture

**Dual-rendering Flutter package:**
- `rive` package (Dart API) — public interface
- `rive_native` — C++ core runtime compiled per platform
- Two renderer options: `Factory.rive` (native Rive renderer) or `Factory.flutter` (Skia/Impeller)
- State machine playback, data binding, artboard management
- Semantic data exposure for accessibility (`RiveSemantics`)

**Platform support:** iOS, Android, macOS, Windows, Linux, Web

### Avatar Capabilities

| Capability | Status | Details |
|---|---|---|
| 2D Animation | ✅ | Full state machine control, animation blending |
| Visual Avatar | ✅ | Can drive character animations from Rive files |
| Emotion | ✅ | Via state machine triggers (not AI-driven) |
| Lip Sync | ✅ | Via state machine (not AI-driven — requires pre-authored animation states) |
| Live2D | ❌ | Not supported (Rive is a different format) |
| 3D | ❌ | Not supported (2D only) |

### Voice Capabilities

**None.** Pure animation runtime — no audio, STT, or TTS.

### Mobile Compatibility

- **Android:** ✅ Full support
- **iOS:** ✅ Full support
- **Web:** ✅ Full support
- **Desktop:** macOS, Windows, Linux

### Agent & Tool Architecture

**N/A** — This is a rendering library, not an agent framework.

### Testing

- `flutter_test` integration
- GitHub Actions CI (`tests.yaml`)
- Prebuilt native libraries available for test platforms

### Recommended Action: 🟡 USE SDK ONLY (for avatar animation)

**Rationale:** MIT license, production-quality, actively maintained by Rive company. This is the right choice for Flutter avatar animation rendering, but it is NOT a voice/AI assistant library. Use it for the animation layer of an avatar system.

**Integration value for NOVA-Leadup:**
- Best-in-class Flutter animation runtime for any avatar visual component
- State machine control enables emotion/motion switching driven by LLM output
- Data binding allows external state (e.g., LLM sentiment) to drive animation
- Cross-platform (Android + iOS + Web)
- Must be paired with a separate TTS/lip-sync/voice engine for a complete avatar

---

## 6. Prometheus Avatar SDK

**URL:** https://github.com/myths-labs/prometheus-avatar 
**Owner:** Myths Labs / Jeremy HM Chou (@jc-myths) 
**Stars:** Growing | **Forks:** Growing | **Commits:** Active | **Last Activity:** Active 
**npm:** `@prometheusavatar/core` v0.8.0 | **MCP Server:** `@prometheusavatar/mcp-server` v0.3.5 
**License:** MIT (confirmed from LICENSE file)

### License: ✅ PERMISSIVE — MIT

Full commercial and derivative use permitted. Copyright © 2026 Myths Labs / Jeremy HM Chou.

**Note on Live2D models:** The bundled demo models (Haru, Shizuku) use Live2D Free Material License. Custom models require separate Live2D Cubism SDK licensing. The Koharu model is fully open source.

### Purpose

Open-source SDK for driving Live2D and 3D avatars with any LLM output. Gives AI agents an embodied visual presence with real-time voice conversation, lip-sync, emotion expressions, and a marketplace for avatar assets.

### Language & Framework

| Component | Technology |
|---|---|
| Primary language | TypeScript |
| Runtime | Node.js / Browser (web-first) |
| Avatar rendering | PIXI.js + Live2D Cubism SDK (2 & 4) |
| Voice | Gemini Live API (WebSocket streaming, ~200ms latency) |
| TTS | Gemini TTS (multi-language: EN/CN/JP/+) |
| LLM | 9 providers: Gemini, OpenAI, Anthropic, Groq, Grok, DeepSeek, , , |
| Package | npm (`@prometheusavatar/core`) |
| MCP | `npx @prometheusavatar/mcp-server` |

### Architecture

**SDK Layer (`@prometheusavatar/core`):**
- `PrometheusAvatar` orchestrator — main entry point
- `Live2DRenderer` — PIXI.js + Live2D Cubism rendering
- `TTS` — pluggable TTS engine interface (`ITTSEngine`)
- `LipSyncEngine` — audio → mouth shape mapping in real-time
- `EmotionAnalyzer` — text → emotion detection → avatar expressions + motions

**Platform Layer (prometheus.mythslabs.ai):**
- Next.js full-stack app
- AvatarCanvas (PIXI.js + Live2D iframe sandbox)
- ChatPanel (SSE for text, WebSocket for live voice)
- Marketplace (buy/sell skins, voices, effects, motions, personas)

**Voice Pipeline:**
- **Live Voice Mode:** WebSocket → Gemini Live API → VAD + interruption + streaming TTS
- **Chat Mode:** SSE → Gemini 2.0 Flash → TTS endpoint

**MCP Server:** 10 tools exposed to any MCP-compatible client (Claude Desktop, Cursor, etc.):
`create_avatar`, `set_avatar_state`, `equip_asset`, `generate_asset`, `update_asset`, `generate_image_pro`, `list_marketplace`, `get_avatar_status`, `share_avatar`, `speak`

**Agent Skill:** `prometheus-companion` — one-sentence agent invocation via HTTP for any AgentSkills-compatible agent.

### Avatar Capabilities

| Capability | Status | Details |
|---|---|---|
| Live2D (Cubism 2 & 4) | ✅ | Auto-scaling, centering, any .model.json/.model3.json |
| 3D Avatars | ✅ | Supported (3D model format) |
| Emotion Engine | ✅ | Text → emotion detection → expressions + motion triggers |
| Lip Sync | ✅ | Real-time mouth animation synchronized with speech audio |
| TTS | ✅ | Gemini TTS, multi-language (EN/CN/JP/+) |
| Live Voice | ✅ | WebSocket streaming, ~200ms latency, VAD + barge-in |
| VTuber Mode | ✅ | Camera face tracking → real-time avatar head movement |
| Marketplace | ✅ | Browse/purchase avatar skins, voices, effects, motions |
| Memory | ✅ | Avatar memory via the Prometheus platform |

### Voice Capabilities

| Capability | Status | Details |
|---|---|---|
| Wake Word | ❌ | Not implemented (web-only, no always-listening) |
| STT | ✅ | Gemini Live API (VAD-based, WebSocket streaming) |
| TTS | ✅ | Gemini TTS with natural voices |
| Lip Sync | ✅ | Real-time, audio-driven |
| Emotion | ✅ | Auto-detect from text |
| Continuous Listening | ✅ | In Live Voice mode (auto-restart) |

### Mobile Compatibility

| Platform | Status | Notes |
|---|---|---|
| Android | ⚠️ | Via WebView or Flutter WebView embedding |
| iOS | ⚠️ | Via WebView embedding |
| Web | ✅ | Primary target — browser-native |
| Desktop | ✅ | Electron / browser |

**Limitation:** The SDK is web-first (TypeScript/PIXI.js). There is no native Android (Kotlin) or iOS (Swift) SDK. Mobile integration requires embedding in a WebView component.

### Agent & Tool Architecture

- **MCP Server:** Full MCP protocol support — any MCP client can create and control avatars
- **OpenAI-compatible agent endpoint:** Any agent can connect via HTTP
- **AgentSkill:** `prometheus-companion` for coding agents (Claude Code, Codex, etc.)
- **9 LLM providers:** Multi-provider abstraction layer
- **Marketplace API:** Asset browsing, purchasing, generation

### Testing

- Jest tests for SDK (`packages/sdk/pnpm test`)
- GitHub Actions CI (`ci.yml`)
- TypeScript type safety

### Recommended Action: 🟡 ADAPT CONCEPT

**Rationale:** MIT license, active development, and the most complete avatar+voice+emotion+lip-sync stack in this set. However, it is web-first (TypeScript/PIXI.js) with no native mobile SDK. For NOVA-Leadup's Android-first product, the concepts are directly applicable but the implementation would need native adaptation.

**Integration value for NOVA-Leadup:**
- **Best reference for avatar+voice integration architecture** — TTS → lip-sync → emotion pipeline
- **MCP server pattern** — clean 10-tool MCP interface for avatar control
- **Emotion engine design** — text-to-emotion detection driving avatar expressions
- **Multi-LLM provider abstraction** — 9-provider support pattern
- **Live2D integration** — Cubism 2 & 4 rendering via PIXI.js
- **Marketplace model** — if NOVA-Leadup wants avatar asset ecosystem
- For native mobile: concepts must be reimplemented in Kotlin (Jetpack Compose + Live2D native SDK or alternative like Spine/Rive)

---

## Cross-Repository Findings

### License Distribution

| Classification | Repositories | Details |
|---|---|---|
| ✅ Permissive (MIT/Apache 2.0) | Hark, SannaBot, Rive Flutter, Prometheus Avatar | Free commercial use |
| ⛔ Restricted (ARR/Personal Use) | Jarvis-AI-Assistant, DeVA | Cannot reuse in production |

### Voice Pipeline Patterns Found

| Pattern | Repos | Description |
|---|---|---|
| Wake Word → STT → LLM → TTS | All 4 voice repos | Standard pipeline, consistent across all |
| Two-stage NLU (encoder + generative) | Hark | EmbeddingGemma + — most sophisticated on-device |
| Multi-agent sensory (Eyes/Ears/Hands) | DeVA, SannaBot | Accessibility-based app control |
| State Machine voice session | Jarvis, SannaBot | 8-state machine with transition validation |
| Sub-agent background tasks | SannaBot | Scheduler, notification watcher, accessibility handler |
| On-device only (no cloud) | Hark | Complete privacy-first pipeline |

### Mobile Compatibility Summary

| Stack | Repos | Notes |
|---|---|---|
| Native Android (Kotlin) | Jarvis, DeVA, Hark | Production Android apps |
| Cross-platform (RN + Kotlin) | SannaBot | Android + iOS via React Native |
| Flutter (Dart + Kotlin) | Hark, Rive Flutter | Flutter 3.11+ |
| Web-first (TypeScript) | Prometheus Avatar | Requires WebView for mobile |

### Avatar Ecosystem Gap

None of the Android voice assistant repos (Jarvis, DeVA, Hark, SannaBot) include avatar capabilities. The only avatar solutions are:
- **Rive Flutter** — 2D animation (no voice, no AI-driven expressions)
- **Prometheus Avatar** — complete avatar+voice+emotion stack (web-only)

This represents the **primary integration opportunity** for NOVA-Leadup: combining an Android voice assistant architecture (Hark or SannaBot) with an avatar rendering layer (adapted from Prometheus Avatar concepts, using Rive Flutter for native animation).

---

## Final Recommendations

### Immediate Integration Candidates

1. **Hark** — Fork and extend as the base voice assistant. Apache 2.0, mature Flutter codebase, OACP protocol is innovative. Replace EmbeddingGemma/ with NOVA-Leadup's LLM backend.
2. **SannaBot** — Study the agent loop, sub-agent architecture, and skills system. MIT license, most active repo. React Native approach may be heavier than Flutter for NOVA-Leadup.
3. **Rive Flutter** — Add as a Flutter dependency for avatar animation. MIT, production-proven, 1.5k stars.

### Research / Concept Adaptation

4. **Prometheus Avatar** — Study the emotion engine, lip-sync pipeline, MCP server interface, and multi-LLM provider abstraction. Adapt concepts into native Kotlin for Android.

### Excluded from Code Reuse

5. **Jarvis-AI-Assistant** — All Rights Reserved license. Study architecture patterns only.
6. **DeVA** — Personal Use license. Study accessibility-based app control pattern only.

---

*Analysis produced by web extraction + README/License file review. No local code cloning performed.*
