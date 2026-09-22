# NOVA Research Matrix

**Date**: 2026-09-06 
**Status**: COMPLETE 
**Purpose**: Feature-by-feature comparison matrix for all six research repositories

---

## Matrix

| Feature | AION/Jarvis | DeVA | Hark | SannaBot | Rive Flutter | Prometheus | NOVA Decision |
|---------|-------------|------|------|----------|--------------|------------|---------------|
| **License** | All Rights Reserved | Personal Use | Apache 2.0 | MIT | MIT | MIT | — |
| **Wake Word** | ✅ Built-in | ✅ Porcupine | ✅ openWakeWord | ✅ Yes | ❌ No | ❌ No | Porcupine (commercial, Kotlin foreground service) |
| **Voice Pipeline** | ✅ Full | ✅ Full | ✅ Full (on-device) | ✅ Full | ❌ No | ✅ Full (web) | Sarvam STT/TTS via backend, Claude reasoning |
| **STT** | ✅ Android API | ✅ Gemini | ✅ whisper/sherpa | ✅ OpenAI/Claude | ❌ No | ✅ Gemini Live | Sarvam (Tamil/English/Tanglish) |
| **TTS** | ✅ Android API | ✅ Google Cloud | ✅ flutter_tts | ✅ LLM provider | ❌ No | ✅ Gemini TTS | Sarvam Bulbul via backend |
| **Lip Sync** | ❌ No | ❌ No | ❌ No | ❌ No | ✅ Via inputs | ✅ Audio-driven | Rive state machine + audio level binding |
| **Emotion** | ❌ No | ❌ No | ❌ No | ❌ No | ✅ Via states | ✅ Full engine | Simplified engine (positive/neutral/concerned/error) |
| **Avatar** | ❌ No | ❌ No | ❌ No | ❌ No | ✅ 2D animation | ✅ Live2D/3D | Rive Flutter (primary), Prometheus concepts |
| **Memory** | ✅ Room DB | ❓ Not doc'd | ❌ No | ✅ Personal | ❌ No | ✅ Platform | PostgreSQL + pgvector (server), Drift (mobile) |
| **Agent Architecture** | ✅ Plugin registry | ✅ Multi-agent | ✅ Two-stage NLU | ✅ Agent loop | ❌ No | ✅ MCP server | Claude tool use + NOVA Tool Router |
| **Tool Architecture** | ✅ Sandboxed plugins | ✅ Accessibility | ✅ OACP intents | ✅ Markdown skills | ❌ No | ✅ MCP tools | Schema validation + policy + permission check |
| **MCP** | ❌ No | ❌ No | ❌ No (OACP) | ❌ No | ❌ No | ✅ Yes | Backend MCP connectors with allowlists |
| **Android Controls** | ✅ Yes | ✅ Accessibility | ✅ OACP intents | ✅ Accessibility | ❌ No | ❌ No | Native Kotlin + MethodChannel |
| **Notification Listener** | ❓ | ✅ Accessibility | ❓ | ✅ Yes | ❌ No | ❌ No | NotificationListenerService |
| **Flutter** | ❌ No | ❌ No | ✅ Full | ❌ No | ✅ Full runtime | ❌ No | Primary mobile UI framework |
| **Production Readiness** | ⚠️ Portfolio | ⚠️ Early | ✅ Active | ✅ Active | ✅ Production | ⚠️ Beta | Backend stable, mobile in development |
| **Mobile Compatibility** | Android only | Android only | Android + iOS | Android + iOS | All platforms | Web only | Android first, iOS second |
| **Code Reuse** | ❌ None | ❌ None | ✅ Platform bridge, foreground service | ❌ Wrong framework | ✅ Add dependency | ❌ Wrong platform | Adapt concepts from all |

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Feature present and functional |
| ❌ | Feature not present |
| ❓ | Not documented/unknown |
| ⚠️ | Partial or experimental |

---

## Key Insights

### Voice Pipeline
- All four voice repos follow the same basic pattern: Wake Word → STT → LLM → TTS
- Hark is unique in being fully on-device (no cloud) — NOVA will use cloud (Sarvam + Claude) for better quality
- SannaBot has the most mature agent loop with sub-agents
- Prometheus has the most advanced emotion/lip-sync pipeline (but web-only)

### Avatar
- No Android voice assistant repo has avatar support
- Rive Flutter is the only production-ready Flutter avatar runtime
- Prometheus has the most complete avatar+voice+emotion stack (but web-only)
- NOVA must bridge these: Rive for rendering, Prometheus concepts for emotion/lip-sync

### Architecture
- Jarvis has the most sophisticated native Android architecture (Clean Architecture, state machine, plugin registry)
- Hark has the best Flutter + Kotlin integration pattern (Pigeon, foreground service)
- SannaBot has the best agent loop and skills system
- DeVA has the best Accessibility-based device control

### Licensing
- 4 repos are permissively licensed (MIT/Apache 2.0)
- 2 repos are restricted (All Rights Reserved, Personal Use)
- Only Hark's Flutter code can be directly reused (Apache 2.0)
- All others must be adapted conceptually

---

## Recommended Actions by Feature

| Feature | Primary Reference | Secondary Reference | Action |
|---------|-------------------|---------------------|--------|
| Wake Word | DeVA (Porcupine) | Hark (openWakeWord) | Use Porcupine, adapt Hark service pattern |
| STT/TTS | All voice repos | — | Use Sarvam via backend |
| Avatar Rendering | Rive Flutter | Prometheus (concepts) | USE DIRECTLY |
| Emotion Engine | Prometheus | — | ADAPT CONCEPT |
| Lip Sync | Prometheus | Rive inputs | ADAPT CONCEPT |
| Agent Loop | SannaBot | Jarvis (concepts) | ADAPT CONCEPT |
| Tool Architecture | Jarvis | SannaBot | ADAPT CONCEPT |
| Platform Bridge | Hark | — | ADAPT CONCEPT (code reuse with Apache 2.0) |
| Foreground Service | Hark | Jarvis (concepts) | ADAPT CONCEPT |
| State Machine | Jarvis | Hark | ADAPT CONCEPT |
| Memory | SannaBot | Jarvis (concepts) | Keep existing backend architecture |
| MCP | Prometheus | — | Backend integration |
| Device Control | DeVA | Jarvis | Native Kotlin implementation |

---

*Matrix derived from docs/NOVA_ARCHITECTURE_AUDIT.md, docs/REPOSITORY_DECISIONS.md, docs/AVATAR_REPOSITORY_ANALYSIS.md, docs/VOICE_REPOSITORY_ANALYSIS.md, docs/ANDROID_ASSISTANT_REPOSITORY_ANALYSIS.md, and docs/repo-analysis.md*
