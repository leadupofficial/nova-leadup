# NOVA Avatar Repository Analysis

## Executive Summary

This document analyzes avatar-related repositories for NOVA's avatar system.

## Repository Analysis

### Rive Flutter
- **URL**: https://github.com/rive-app/rive-flutter
- **License**: MIT (permissive)
- **Purpose**: Production Flutter runtime for Rive animations
- **Technology**: Flutter, Dart, C++, OpenGL/Vulkan/Metal
- **Framework**: Flutter runtime/plugin
- **License**: MIT
- **Avatar capability**: Excellent — state machines, animation triggers, real-time control
- **Recommended action**: USE SDK — Primary avatar technology for NOVA V1

### Prometheus Avatar
- **URL**: https://github.com/myths-labs/prometheus-avatar
- **License**: Unknown — needs verification
- **Purpose**: Embodied AI avatar SDK for Live2D and 3D avatars
- **Technology**: TypeScript, Live2D, 3D rendering
- **Framework**: Web/Node.js
- **Avatar capability**: Advanced — lip sync, emotion, speech-driven animation
- **Recommended action**: REFERENCE ONLY — architecture and algorithm research only until license verified

## NOVA Avatar Decision

**Primary V1**: Rive Flutter
- Reasons:
 - MIT licensed, permissive
 - Production-proven runtime for Flutter
 - State machine architecture aligns with NOVA's AvatarState model
 - Supports all required states: idle, listening, thinking, speaking, success, warning, error, offline, sleeping
 - Real-time animation control
 - No external runtime dependencies
 - Active maintenance (1.5k stars, 239 forks)

**Secondary research**: Prometheus Avatar concepts
- Reasons:
 - Emotion architecture and lip-sync techniques can inform NOVA's design
 - Speech-driven animation concepts applicable
 - But license must be verified before any code reuse

## Implementation Plan

1. Create NovaAvatarController wrapping Rive runtime
2. Map AvatarState enum to Rive state machines
3. Implement emotion metadata flow from Claude (semantic only, not arbitrary animation selection)
4. Design Rive files for each avatar state
5. Integrate with voice pipeline for lip-sync during TTS playback
