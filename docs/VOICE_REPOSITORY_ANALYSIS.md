# Voice Repository Analysis

NOVA voice pipeline architecture draws from these repositories.

---

## Repository Analysis

### AION / Jarvis-AI-Assistant
- **URL**: https://github.com/Manthan-13521/Jarvis-AI-Assistant
- **Owner**: Manthan Jaiswal (Manthan-13521)
- **Purpose**: AI voice-first assistant for Android with memory, wake word detection, and smart device control. Positions itself as "AION OS — Voice-First AI Companion."
- **Technology**: Kotlin, Jetpack Compose, Room, Android
- **Language**: Kotlin 99.9%, Shell 0.1%
- **Framework**: Android (Jetpack Compose UI, Room persistence)
- **License**: All Rights Reserved — not open source. Shared as a technical portfolio piece; requires permission before reuse, forking for redistribution, or deployment.
- **Avatar capability**: None — voice-only, no avatar/visual component
- **Voice capability**: Full voice pipeline — wake word, STT, LLM reasoning, TTS, device control
- **Wake word**: Yes (implementation details not publicly documented in README)
- **STT**: Yes (provider not specified in public README)
- **TTS**: Yes (provider not specified in public README)
- **Lip sync**: No
- **Emotion**: No
- **NOVA compatibility**: Moderate — Clean Architecture + Kotlin multi-module structure aligns with NOVA's backend patterns; voice-first design philosophy matches. However, the proprietary license prevents direct code reuse.
- **Reusable ideas**:
 - Clean Architecture feature-first module structure for voice pipeline
 - State machine pattern for voice session lifecycle (idle → listening → processing → speaking)
 - AudioFocusManager concept for handling interruptions (phone calls, Bluetooth)
 - Result<T> sealed-class error strategy (maps to Freezed + Either in Dart)
 - Plugin/tool registry pattern for device control actions
- **Recommended action**: REFERENCE ONLY — study architecture and state machine patterns from the public ARCHITECTURE_REPORT.md. Do not copy code. Use concepts to inform NOVA's Riverpod state machine design.

### DeVA
- **URL**: https://github.com/Devanshupardeshi/DeVA
- **Owner**: Devanshu Pardeshi (Devanshupardeshi)
- **Purpose**: "AI Phone Operator" — an AI voice assistant that sees, speaks, and controls your Android phone through voice commands using the Android Accessibility API.
- **Technology**: Kotlin, Gemini AI, Android Accessibility API, Firebase, Google Cloud TTS, Porcupine wake word
- **Language**: Kotlin
- **Framework**: Android (Gradle, native Android SDK)
- **License**: Personal Use License — personal, educational, and research use permitted; commercial use requires separate license. See LICENSE file in repo root.
- **Avatar capability**: None — voice-only with screen-reading via Accessibility API
- **Voice capability**: Full voice pipeline — wake word (Porcupine), STT (not explicitly documented), LLM (Gemini AI), TTS (Google Cloud TTS), device control via Accessibility API
- **Wake word**: Yes — Picovoice Porcupine
- **STT**: Yes (provider not explicitly stated in README)
- **TTS**: Yes — Google Cloud Text-to-Speech
- **Lip sync**: No
- **Emotion**: No
- **NOVA compatibility**: High for voice patterns — Porcupine wake word integration and Android Accessibility-based screen control are directly applicable to NOVA's Android layer. The Personal Use License limits commercial reuse but the patterns are well-documented.
- **Reusable ideas**:
 - Porcupine wake word integration pattern for Android
 - Android Accessibility API usage for screen intelligence and device control
 - Gemini AI integration pattern for NLU + action planning
 - Voice command → action pipeline: STT → LLM reasoning → Accessibility action execution
 - Screen capture + AI interpretation for context-aware responses
- **Recommended action**: REFERENCE ONLY — study the Porcupine + Gemini + Accessibility API integration pattern. The Personal Use License prohibits code reuse in commercial products. Adapt the architectural concepts into NOVA's Flutter/Riverpod + Kotlin layer.

### SannaBot
- **URL**: https://github.com/sannabotdev/sannabotapp
- **Owner**: sannabotdev (individual developer)
- **Purpose**: Open-source voice-first AI assistant for Android that actually controls your phone. Features an agent loop with tool use, multi-step reasoning, and markdown-based skill extension.
- **Technology**: React Native + native Kotlin, OpenAI or Claude LLM, OAuth PKCE, on-device storage, sub-agents
- **Language**: TypeScript (React Native), Kotlin (native modules)
- **Framework**: React Native (cross-platform Android + iOS), NativeWind, Kotlin native modules
- **License**: MIT — permissive, allows commercial use with attribution
- **Avatar capability**: None — voice-first UX with no visual avatar component
- **Voice capability**: Full voice pipeline — wake word → STT → LLM → TTS, agent loop with tool use, multi-step reasoning
- **Wake word**: Yes (implementation details in SKILL.md / native modules)
- **STT**: Yes (provider not explicitly stated; OpenAI Whisper likely)
- **TTS**: Yes (provider not explicitly stated)
- **Lip sync**: No
- **Emotion**: No
- **NOVA compatibility**: High for agent loop design — the markdown-based SKILL.md system, sub-agent architecture, and tool-use patterns directly inform NOVA's backend agent orchestrator. React Native layer provides useful cross-platform voice UX patterns. MIT license allows code study and adaptation.
- **Reusable ideas**:
 - Markdown-based SKILL.md system for extending assistant capabilities
 - Sub-agent architecture (scheduler, notifications, accessibility as separate agents)
 - Agent loop with multi-step reasoning and tool use
 - SOUL (editable assistant personality) pattern
 - Personal memory injection into prompts (structured user memory)
 - Context condensation for long conversation management
 - OAuth PKCE for secure API authentication without backend secrets
- **Recommended action**: ADAPT CONCEPT — MIT licensed, safe to study and adapt patterns. Port the SKILL.md system, agent loop architecture, and memory injection patterns into NOVA's backend. Use React Native voice UX patterns as reference for Flutter implementation.

### Hark
- **URL**: https://github.com/OpenAppCapabilityProtocol/hark
- **Owner**: OpenAppCapabilityProtocol (community organization, co-authored with Claude Opus/Sonnet 4.6)
- **Purpose**: Open-source voice assistant built on OACP (Open App Capability Protocol). Discovers and controls Android apps using on-device AI — no cloud, no account, no data collection.
- **Technology**: Flutter, Dart, Kotlin (Android native), EmbeddingGemma 308M + 0.5B (on-device LLMs), openWakeWord, Riverpod, forui
- **Language**: Dart (Flutter), Kotlin (Android platform layer)
- **Framework**: Flutter (cross-platform), Riverpod (state management), forui (UI components), OACP protocol
- **License**: Apache 2.0 — permissive, allows commercial use, modification, and distribution
- **Avatar capability**: None — pure voice assistant
- **Voice capability**: Full voice pipeline — wake word (openWakeWord), on-device LLM (EmbeddingGemma + ), OACP-based app discovery and control, Android system assistant integration (VoiceInteractionService)
- **Wake word**: Yes — openWakeWord (on-device, Apache 2.0), with planned sensitivity slider and barge-in support
- **STT**: Yes — Whisper-style on-device STT planned (whisper.cpp / sherpa-onnx evaluation in roadmap)
- **TTS**: Yes (not fully documented in public README; on-device TTS likely)
- **Lip sync**: No
- **Emotion**: No
- **NOVA compatibility**: Highest among all voice repos — Flutter/Dart codebase directly portable to NOVA, Apache 2.0 license, OACP protocol design informs NOVA's tool-calling runtime, foreground service + Flutter bridge pattern already implemented. Active development (80+ commits, 11 branches).
- **Reusable ideas**:
 - Foreground service + Flutter EventChannel bridge pattern (already ported to NOVA)
 - OACP protocol concept — dynamic app capability discovery via ContentProvider
 - Two-stage on-device AI: embedding model (308M) + small LLM (0.5B) for tool selection
 - VoiceInteractionService integration for Android system assistant
 - Riverpod-based state management for voice pipeline
 - Broadcast + activity intent dispatch with async result handling
 - onWakeWord toggle sync with SharedPreferences + Settings UI
- **Recommended action**: USE SDK — Hark's Flutter/Kotlin bridge code is already ported into NOVA. Continue tracking the OACP protocol evolution and on-device LLM patterns. The openWakeWord → Porcupine swap is already planned in NOVA.

---

## Source Repositories (Summary)

| Repository | License | Primary Contribution |
|-----------|---------|---------------------|
| AION / Jarvis-AI-Assistant | All Rights Reserved | Clean Architecture pattern, state machine design (REFERENCE ONLY) |
| DeVA | Personal Use | Porcupine + Accessibility API integration (REFERENCE ONLY) |
| SannaBot | MIT | Agent loop, SKILL.md system, memory injection (ADAPT) |
| Hark | Apache 2.0 | Foreground service + Flutter bridge, OACP protocol (USE SDK) |

---

## Wake Word Architecture

### Source: Hark + DeVA

**Decision:** Use **Picovoice Porcupine** (Apache 2.0) — chosen for:
- Custom keyword training ("Hey NOVA")
- Low CPU/battery footprint
- Commercial license available
- React Native / Flutter / Android / iOS SDKs

**Hark implementation:** openWakeWord (Apache 2.0) — works but lacks Picovoice's accuracy and licensing clarity

**NOVA Flow:**
```
[Android foreground service]
Microphone → AudioRecord
↓
Porcupine Wake Word Detector
↓
"Hey NOVA" detected
↓
Broadcast intent
↓
[Flutter]
EventChannel receives "wake_detected"
↓
avatarStateProvider.setState(LISTENING)
voiceProvider.startListening()
↓
Backend STT (Sarvam)
```

---

## STT (Speech-to-Text)

### Source: Pipecat Sarvam integration

**Decision:** Use **Sarvam** via backend API (no Dart-native SDK)

**Pipecat pattern (BSD-2-Clause, can study):**
- Pipecat has `livekit-plugins-sarvam` — reference for the Sarvam API structure
- Sarvam STT endpoint: `https://api.sarvam.ai/speech-to-text`
- Supports Tamil, English, Tanglish, Hindi
- Streaming partial transcripts available

**NOVA Flow:**
```
Flutter → captures PCM audio
↓
Dio POST /api/v1/voice/stt (multipart/form-data)
↓
Backend (Node.js) → forwards to Sarvam
↓
Sarvam STT → returns transcript
↓
Backend → returns to Flutter
↓
voiceProvider.setState(PROCESSING)
```

---

## TTS (Text-to-Speech)

### Source: Pipecat Sarvam Bulbul

**Decision:** Use **Sarvam Bulbul** via backend API

**Pipecat pattern (BSD-2-Clause):**
- Sarvam Bulbul TTS endpoint: `https://api.sarvam.ai/text-to-speech`
- Voice model: `bulbul:v3` (Pipecat deprecated v2)
- Streaming audio chunks available
- Voice cloning support

**NOVA Flow:**
```
Claude returns response text
↓
Backend splits into sentences
↓
Sarvam Bulbul TTS per sentence
↓
Audio chunks streamed to Flutter via WebSocket
↓
just_audio plays chunks sequentially
↓
avatarStateProvider.setState(SPEAKING)
```

---

## VAD (Voice Activity Detection)

### Source: Pipecat + Hark

**Decision:** Server-side VAD via Pipecat-style frame pipeline

**Hark pattern (Apache 2.0, code reusable):**
- Use Silero VAD on Flutter side for low-latency end-pointing
- Send audio frames only when speech detected

**NOVA Flow:**
```
Microphone (continuous capture)
↓
Silero VAD (on-device, via sherpa-onnx)
↓
Speech detected → start recording
↓
Speech ends → stop recording, send to backend
↓
Backend STT → transcript
```

---

## Barge-In Architecture

### Source: LiveKit Agents + Pipecat

**Pattern (Apache 2.0 / BSD-2-Clause):**
```
NOVA is speaking (TTS playback)
↓
User starts speaking
↓
Silero VAD detects speech during playback
↓
Stop TTS playback (just_audio.stop())
↓
avatarStateProvider.setState(LISTENING)
↓
Start recording new audio
↓
Process as new request
```

**Status:** Phase 5 — implement after basic pipeline is stable

---

## Audio Focus Architecture

### Source: Jarvis-AI-Assistant (REFERENCE ONLY) + Hark (Apache 2.0)

**Concept (no code reuse from AION):**
- AudioFocusManager handles phone calls, Bluetooth, headphones
- Audio focus gain/loss events
- Pause TTS during phone calls
- Resume after focus returns

**Hark implementation (Apache 2.0, code reusable):**
- Use `audio_session` Flutter package
- Subscribe to `AudioSessionEvents`
- Handle interruption events
- Re-acquire focus after interruptions

**NOVA Implementation:**
```dart
// lib/core/voice/audio_focus.dart
class NovaAudioController {
 late final AudioSession _session;
 StreamSubscription<AudioSessionEvents>? _events;

 Future<void> initialize() async {
 _session = await AudioSession.instance;
 await _session.configure(const AudioSessionConfiguration(
 avAudioSessionCategory: AVAudioSessionCategory.playAndRecord,
 avAudioSessionMode: AVAudioSessionMode.spokenAudio,
 avAudioSessionRouteSharingPolicy: AVAudioSessionRouteSharingPolicy.defaultPolicy,
 avAudioSessionSetActiveOptions: AVAudioSessionSetActiveOptions.notifyOthersOnDeactivation,
 ));
 }

 void listenForInterruptions() {
 _events = _session.eventsStream.listen((event) {
 if (event is AudioSessionInterruptionEvent) {
 if (event.begin) {
 pauseTts();
 } else {
 resumeTts();
 }
 }
 });
 }
}
```

---

## Backend Voice Pipeline

### Source: LiveKit Agents (Apache 2.0) — pattern reference

**Don't vendor LiveKit Agents.** Pattern to adopt:

```typescript
// services/agent-orchestrator/src/pipeline.ts
class VoicePipeline {
 constructor() {
 this.stt = new SarvamStt();
 this.llm = new ClaudeLlm();
 this.tts = new SarvamTts();
 this.vad = new SileroVad();
 }

 async process(audioChunk: Buffer): Promise<VoiceResult> {
 const transcript = await this.stt.transcribe(audioChunk);
 const response = await this.llm.reason(transcript);
 const audioChunks = await this.tts.synthesize(response);
 return { transcript, response, audioChunks };
 }
}
```

---

## Code Reuse Summary

| Component | Source | Action |
|-----------|--------|--------|
| Foreground service + bridge | Hark (Apache 2.0) | USE SDK — port Kotlin code |
| Wake word SDK | Porcupine (Apache 2.0) | USE SDK — direct dependency |
| Sarvam API patterns | Pipecat (BSD-2-Clause) | ADAPT — reference Sarvam endpoints |
| VAD | Hark Silero pattern (Apache 2.0) | USE SDK — adapt pattern |
| Audio focus | Hark (Apache 2.0) | USE SDK — port audio_session usage |
| Agent loop | SannaBot (MIT) | ADAPT to Flutter/Riverpod |
| Backend pipeline structure | LiveKit Agents (Apache 2.0) | ADAPT concepts only |
| AudioFocusManager concept | Jarvis (All Rights Reserved) | REFERENCE ONLY — no code |
| Porcupine + Whisper pattern | DeVA (Personal Use) | REFERENCE ONLY — no code |
