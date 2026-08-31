/**
 * @nova/voice — Voice providers (ElevenLabs + Sarvam), session manager,
 * audio level detector for avatar sync, and provider factory.
 *
 * Per blueprint Section 8 (Voice & Language Architecture).
 *
 * Providers:
 * - ElevenLabs: English expressive TTS + realtime conversation
 * - Sarvam: Tamil/Tanglish STT+TTS + batch transcription
 *
 * Exports:
 * - VoiceProvider interface and implementations (ElevenLabsProvider, SarvamProvider)
 * - VoiceSessionManager: session state with transcript buffer and audio level
 * - AudioLevelDetector: realtime RMS/peak analyzer for avatar sync
 * - Transcriber: Sarvam batch transcription adapter
 * - SarvamTranslator: EN <-> TA translation adapter
 * - VoiceProviderFactory: provider resolution and registration
 */

import type {
	VoiceProvider,
	VoiceProviderConfig,
	STTRequest,
	STTResponse,
	TTSRequest,
	TTSResponse,
	RealtimeVoiceSession,
	VoiceSession,
	AudioLevelData,
} from '@nova/shared-types';

// ─── Re-export shared types ───────────────────────────────────────────────────

export type {
	VoiceProviderConfig,
	STTRequest,
	STTResponse,
	TTSRequest,
	TTSResponse,
	RealtimeVoiceSession,
	VoiceSession,
	AudioLevelData,
} from '@nova/shared-types';

// ─── Voice Provider interfaces and implementations ────────────────────────────

export {
	ElevenLabsProvider,
	SarvamProvider,
	VoiceProviderFactory,
	VoiceSessionManager,
	AudioLevelDetector,
} from './engine';

export type { IVoiceProvider, ElevenLabsConfig, SarvamConfig, VoiceSessionOptions, AudioLevelDetectorOptions } from './engine';

// ─── Transcription ────────────────────────────────────────────────────────────

export { Transcriber } from './transcriber';
export type { TranscribeInput } from './transcriber';

// ─── Translation ──────────────────────────────────────────────────────────────

export { SarvamTranslator } from './translator';
