# NOVA Repository Decisions

## Summary

| Repository | URL | License | Recommendation |
|------------|-----|---------|----------------|
| AION / Jarvis-AI-Assistant | https://github.com/Manthan-13521/Jarvis-AI-Assistant | Unknown — needs verification | REFERENCE ONLY |
| DeVA | https://github.com/Devanshupardeshi/DeVA | MIT | ADAPT CONCEPT |
| Hark | https://github.com/OpenAppCapabilityProtocol/hark | Apache-2.0 | ADAPT CONCEPT |
| SannaBot | https://github.com/sannabotdev/sannabotapp | MIT | REFERENCE ONLY |
| Rive Flutter | https://github.com/rive-app/rive-flutter | MIT | USE SDK |
| Prometheus Avatar | https://github.com/myths-labs/prometheus-avatar | Unknown — needs verification | REFERENCE ONLY |

## Rationale

### AION / Jarvis
- No visible LICENSE file in repo root from available metadata.
- Treated as reference-only until license is confirmed.
- Strong architectural value: Kotlin voice pipeline, state machine, clean architecture.

### DeVA
- MIT licensed — permissive.
- Value: Android AI assistant architecture, screen intelligence, multimodal interactions.
- Action: Adapt concepts, do not copy code verbatim.

### Hark
- Apache-2.0 licensed — permissive.
- Value: OACP protocol, wake word, Android assistant, foreground/background behavior.
- Action: Adapt protocol concepts and assistant patterns.

### SannaBot
- MIT licensed — permissive.
- Value: AI companion UX, memory patterns, tasks, assistant behavior.
- Action: Reference for UX and interaction patterns.

### Rive Flutter
- MIT licensed — permissive.
- Value: Production Flutter avatar runtime, state machines, expressive animation.
- Action: Use as the primary avatar SDK in Flutter.

### Prometheus Avatar
- License unclear from metadata.
- Value: Embodied AI concepts, Live2D/3D avatar, lip sync, emotion.
- Action: Reference for design inspiration only until license verified.

## License Verification Required

The following repositories do not show an explicit LICENSE file in the extracted metadata and require manual verification before any code reuse:

- AION / Jarvis-AI-Assistant
- Prometheus Avatar

## Action Items

1. Verify licenses for AION and Prometheus Avatar by checking LICENSE files in the repository roots.
2. If either repository is not permissively licensed, keep them in REFERENCE ONLY status.
3. Proceed with Rive Flutter integration as the primary avatar technology.
