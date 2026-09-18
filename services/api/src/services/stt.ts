/**
 * NOVA API — Speech-to-text integration (Deepgram).
 */
import { transcribeAudio } from './ai.js';

export { transcribeAudio };

export async function transcribeStream(
 audioChunks: Buffer[],
 language: string = 'en'
): Promise<{ transcript: string; confidence: number; language: string }> {
 const combined = Buffer.concat(audioChunks);
 return transcribeAudio(combined, language);
}
