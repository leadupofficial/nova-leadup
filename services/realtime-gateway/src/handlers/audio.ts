import type { WebSocket } from 'ws';
import type { VoiceSession } from '@nova/shared-types';
import { logger } from '../utils/logger.js';
import { addTranscript, updateAudioLevel, MAX_TRANSCRIPT_BUFFER_SIZE } from '../sessions.js';
import type { STTResponse, AudioLevelData } from '@nova/shared-types';

export interface AudioHandlerOptions {
 /** Overrides `MAX_TRANSCRIPT_BUFFER_SIZE` for this handler; the cap is enforced in `addTranscript`. */
 maxTranscriptBufferSize?: number;
 audioLevelUpdateIntervalMs?: number;
}

/**
 * Sets up audio message handling on a WebSocket connection.
 *
 * Expected binary message format (protobuf or raw PCM frames).
 * This handler extracts audio level data and forwards transcripts.
 */
export function setupAudioHandler(
 ws: WebSocket,
 session: VoiceSession,
 opts: AudioHandlerOptions = {}
): void {
 let audioLevelInterval: NodeJS.Timeout | null = null;

 // Read the declared option rather than ignoring it. The default comes from the
 // single named constant in `sessions.ts`, so this file cannot drift from the
 // bound the buffer actually enforces.
 const maxTranscriptBufferSize = opts.maxTranscriptBufferSize ?? MAX_TRANSCRIPT_BUFFER_SIZE;

 ws.on('message', (data: Buffer) => {
 if (!Buffer.isBuffer(data)) {
 logger.warn({ sessionId: session.sessionId }, 'Expected binary audio frame');
 return;
 }

 // Basic audio level detection from PCM amplitude
 const level = calculateAudioLevel(data);

 // Update session with latest audio level
 void updateAudioLevel(session.sessionId, level);

 // Emit audio level update to client (for UI visualization)
 const levelPayload: AudioLevelData = {
 level,
 peak: level,
 rms: level,
 timestamp: Date.now(),
 };

 ws.send(JSON.stringify({
 type: 'audio_level',
 data: levelPayload,
 }));
 });

 // Periodic transcript flush (in real implementation, this would come from STT service)
 audioLevelInterval = setInterval(() => {
 const currentLevel = session.audioLevel;
 if (currentLevel > 0.1) {
 // Simulate transcript detection (in production, this comes from the STT service via queue)
 // `STTResponse` requires `transcript` and `language`; the legacy `text` /
 // `timestamp` fields are kept so the stored buffer entry keeps its shape.
 const transcript = {
 transcript: '',
 text: '',
 isFinal: false,
 confidence: 0,
 language: session.config.language ?? 'en',
 timestamp: Date.now(),
 };
 void addTranscript(session.sessionId, transcript, maxTranscriptBufferSize);
 }
 }, 5000);

 ws.on('close', () => {
 if (audioLevelInterval) {
 clearInterval(audioLevelInterval);
 audioLevelInterval = null;
 }
 logger.info({ sessionId: session.sessionId }, 'Audio handler cleaned up');
 });
}

/**
 * Calculates a normalized audio level (0-1) from raw PCM buffer.
 * Assumes 16-bit PCM mono audio.
 */
function calculateAudioLevel(buffer: Buffer): number {
 if (buffer.length < 2) return 0;

 let sumSquares = 0;
 const sampleCount = Math.floor(buffer.length / 2);

 for (let i = 0; i < sampleCount; i++) {
 const sample = buffer.readInt16LE(i * 2);
 sumSquares += sample * sample;
 }

 const rms = Math.sqrt(sumSquares / sampleCount);
 // Normalize to 0-1 range (16-bit max is 32768)
 return Math.min(rms / 32768, 1);
}
