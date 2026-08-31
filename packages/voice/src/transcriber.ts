/**
 * LEA-010 — Sarvam STT transcription adapter.
 *
 * Transcribes audio files via Sarvam AI's speech-to-text API,
 * supporting English, Tamil, and Tanglish.
 *
 * Per Section 18.2: SARVAM_API_KEY must be set in production.
 * Falls back to a stub transcript when the key is absent.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { TranscriptSegment, TranscriptionResult } from '@nova/shared-types';

// ─── Configuration ─────────────────────────────────────────────────────────────

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const SARVAM_API_URL = process.env.SARVAM_API_URL ?? 'https://api.sarvam.ai';

const OBJECT_STORAGE_BUCKET = process.env.OBJECT_STORAGE_BUCKET ?? 'recordings';

// SLA: <30 min recordings should complete within 5 minutes
const TRANSCRIPTION_SLA_MS = 5 * 60 * 1000;

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TranscribeInput {
 readonly audioBuffer: Buffer;
 readonly contentType: string;
 readonly language: 'en' | 'ta' | 'tanglish';
 readonly userId: string;
 readonly tenantId: string;
 readonly recordingId: string;
}

// ─── Transcriber ───────────────────────────────────────────────────────────────

export class Transcriber {
 private readonly s3Client: S3Client | null;
 private readonly isProduction: boolean;

 constructor() {
 this.isProduction = Boolean(process.env.SARVAM_API_KEY);

 if (process.env.OBJECT_STORAGE_ENDPOINT && process.env.OBJECT_STORAGE_ACCESS_KEY && process.env.OBJECT_STORAGE_SECRET_KEY) {
 this.s3Client = new S3Client({
 endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
 region: process.env.OBJECT_STORAGE_REGION ?? 'us-east-1',
 credentials: {
 accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
 secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
 },
 forcePathStyle: true,
 });
 } else {
 this.s3Client = null;
 }
 }

 /**
 * Check whether this transcriber is configured for production use.
 */
 isConfigured(): boolean {
 return this.isProduction && this.s3Client !== null;
 }

 /**
 * Main entry point: upload audio to object storage, then transcribe.
 *
 * Flow:
 * 1. Upload audio to tenant-scoped S3 key
 * 2. Call Sarvam STT API (or return stub if not configured)
 * 3. Return structured transcript with segments, speaker labels, timestamps
 */
 async transcribe(input: TranscribeInput): Promise<TranscriptionResult> {
 const startedAt = Date.now();

 // Step 1: Upload audio to object storage
 const storageKey = this.buildStorageKey(input.tenantId, input.userId, input.recordingId);
 await this.uploadAudio(storageKey, input.audioBuffer, input.contentType);

 // Step 2: Transcribe
 let transcriptText: string;
 let segments: TranscriptSegment[];
 let detectedLanguage: string;

 if (this.isProduction) {
 const result = await this.callSarvamStt(input);
 transcriptText = result.transcript;
 segments = result.segments;
 detectedLanguage = result.language;
 } else {
 const stub = this.stubTranscript(input);
 transcriptText = stub.transcript;
 segments = stub.segments;
 detectedLanguage = input.language;
 }

 const latencyMs = Date.now() - startedAt;
 const withinSla = latencyMs <= TRANSCRIPTION_SLA_MS;

 return {
 recordingId: input.recordingId,
 fullText: transcriptText,
 language: detectedLanguage,
 segments,
 storageKey,
 latencyMs,
 withinSla,
 provider: this.isProduction ? 'sarvam' : 'stub',
 };
 }

 // ─── Object Storage ──────────────────────────────────────────────────────────

 /**
 * Upload audio buffer to S3-compatible object storage.
 */
 private async uploadAudio(key: string, buffer: Buffer, contentType: string): Promise<void> {
 if (!this.s3Client) {
 console.warn('[transcriber] No S3 client configured — audio upload skipped');
 return;
 }

 try {
 await this.s3Client.send(new PutObjectCommand({
 Bucket: OBJECT_STORAGE_BUCKET,
 Key: key,
 Body: new Uint8Array(buffer),
 ContentType: contentType,
 Metadata: {
 'transcribed': 'false',
 },
 }));
 } catch (error) {
 console.error('[transcriber] Audio upload failed:', error);
 throw new Error(`Audio upload failed: ${error instanceof Error ? error.message : 'unknown'}`);
 }
 }

 /**
 * Verify an object exists in storage.
 */
 private async objectExists(key: string): Promise<boolean> {
 if (!this.s3Client) return false;

 try {
 await this.s3Client.send(new HeadObjectCommand({
 Bucket: OBJECT_STORAGE_BUCKET,
 Key: key,
 }));
 return true;
 } catch {
 return false;
 }
 }

 // ─── Sarvam STT ──────────────────────────────────────────────────────────────

 /**
 * Call Sarvam speech-to-text API.
 *
 * API reference: https://docs.sarvam.ai/api-reference
 */
 private async callSarvamStt(input: TranscribeInput): Promise<{
 transcript: string;
 segments: TranscriptSegment[];
 language: string;
 }> {
 if (!SARVAM_API_KEY) {
 throw new Error('SARVAM_API_KEY is not configured');
 }

 const languageMap: Record<string, string> = {
 'en': 'en-IN',
 'ta': 'ta-IN',
 'tanglish': 'ta-IN',
 };
 const sarvamLanguage = languageMap[input.language] ?? 'en-IN';

 try {
 const formData = new FormData();
		formData.append('file', new Blob([new Uint8Array(input.audioBuffer)]), 'audio.webm');
 formData.append('language_code', sarvamLanguage);
 formData.append('model', 'saarika:v2.5');

 const response = await fetch(`${SARVAM_API_URL}/speech-to-text`, {
 method: 'POST',
 headers: {
 'Authorization': `Bearer ${SARVAM_API_KEY}`,
 'Accept': 'application/json',
 },
 body: formData,
 });

 if (!response.ok) {
 const errorBody = await response.text();
 throw new Error(`Sarvam STT error ${response.status}: ${errorBody}`);
 }

 const result = await response.json();

 const transcriptText = result.transcript ?? '';
 const segments: TranscriptSegment[] = this.buildSegments(result);

 return {
 transcript: transcriptText,
 segments,
 language: result.language_code ?? sarvamLanguage,
 };
 } catch (error) {
 console.error('[transcriber] Sarvam STT call failed:', error);
 if (error instanceof Error && error.message.includes('Sarvam STT error')) {
 throw error;
 }
 throw new Error(`Transcription failed: ${error instanceof Error ? error.message : 'unknown'}`);
 }
 }

 /**
 * Build transcript segments from Sarvam API response.
 * Sarvam may return diarization data (speaker labels + timestamps).
 */
 private buildSegments(result: Record<string, unknown>): TranscriptSegment[] {
 // Sarvam v2.5 response shape:
 // { transcript, language_code, diarized_transcript: [{speaker, start, end, text, confidence}] }
 const diarized = (result as Record<string, unknown>).diarized_transcript as
 | Array<{ speaker?: string | number; start?: number; end?: number; text?: string; confidence?: number }>
 | undefined;

 if (diarized && diarized.length > 0) {
 return diarized.map((seg, index) => ({
 speakerIndex: this.resolveSpeakerIndex(seg.speaker),
 startMs: Math.round((seg.start ?? 0) * 1000),
 endMs: Math.round((seg.end ?? 0) * 1000),
 text: seg.text ?? '',
 confidence: seg.confidence !== undefined ? Math.round(seg.confidence * 100) : null,
 segmentIndex: index,
 }));
 }

 // Fallback: single segment for the full transcript
 return [{
 speakerIndex: 0,
 startMs: 0,
 endMs: 0,
 text: (result as Record<string, string>).transcript ?? '',
 confidence: null,
 segmentIndex: 0,
 }];
 }

 private resolveSpeakerIndex(speaker: string | number | undefined): number {
 if (speaker === undefined || speaker === null) return 0;
 const num = typeof speaker === 'string' ? parseInt(speaker, 10) : speaker;
 return Number.isNaN(num) ? 0 : num;
 }

 // ─── Stub Transcript ─────────────────────────────────────────────────────────

 /**
 * Generate a stub transcript for testing without API keys.
 */
 private stubTranscript(input: TranscribeInput): { transcript: string; segments: TranscriptSegment[] } {
 const langLabel = input.language === 'ta' ? 'Tamil' : input.language === 'tanglish' ? 'Tanglish' : 'English';
 const transcript = `[stub ${langLabel} transcript for recording ${input.recordingId}]`;

 const segments: TranscriptSegment[] = [{
 speakerIndex: 0,
 startMs: 0,
 endMs: 0,
 text: transcript,
 confidence: 85,
 segmentIndex: 0,
 }];

 return { transcript, segments };
 }

 // ─── Helpers ─────────────────────────────────────────────────────────────────

 /**
 * Build a tenant-scoped S3 storage key.
 * Format: recordings/{tenantId}/{userId}/{recordingId}.{ext}
 */
 private buildStorageKey(tenantId: string, userId: string, recordingId: string): string {
 return `recordings/${tenantId}/${userId}/${recordingId}.webm`;
 }
}

export default Transcriber;
