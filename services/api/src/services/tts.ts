/**
 * NOVA API — Text-to-speech integration (ElevenLabs / Sarvam).
 */
import { synthesizeSpeech, translateText } from './ai.js';

export { synthesizeSpeech, translateText };

export async function speakText(text: string, voiceId: string, options?: { speed?: number }): Promise<{ audioBuffer: Buffer; contentType: string; durationMs: number }> {
 return synthesizeSpeech(text, voiceId, options);
}
