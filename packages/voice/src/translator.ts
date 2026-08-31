/**
 * LEA-015 — Sarvam translation adapter.
 *
 * Bridges NOVA to Sarvam AI's translation API for EN <-> TA
 * with Tanglish awareness. Falls back to a deterministic
 * identity+language-prefix stub when SARVAM_API_KEY is not set
 * (Section 18.2: no production keys in source).
 *
 * Tanglish handling: when tanglishAware is true, the adapter
 * detects Latin-script Tamil words and routes the full text
 * through the translation model that best preserves the
 * colloquial register.
 */

import type { TranslateRequest, TranslateResponse } from '@nova/shared-types';

// ─── Sarvam config ────────────────────────────────────────────────────────────

interface SarvamTranslateResponse {
 translatedText: string;
 sourceLanguage: string;
 targetLanguage: string;
}

// ─── Language map ─────────────────────────────────────────────────────────────

const SARVAM_LANG: Record<string, string> = {
 en: 'en-IN',
 ta: 'ta-IN',
};

// ─── Translator ───────────────────────────────────────────────────────────────

export class SarvamTranslator {
 readonly name = 'sarvam';
 private apiKey: string | null;
 private baseUrl = 'https://api.sarvam.ai/v1';

 constructor() {
 this.apiKey = process.env.SARVAM_API_KEY ?? null;
 }

 /**
 * Translate text. Returns a stub response when no API key is configured.
 */
 async translate(request: TranslateRequest): Promise<TranslateResponse> {
 const started = Date.now();
 const tanglishDetected = this.detectTanglish(request.text);

 if (!this.apiKey) {
 return this.stubTranslate(request, tanglishDetected, Date.now() - started);
 }

 const response = await fetch(`${this.baseUrl}/translate`, {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'Authorization': `Bearer ${this.apiKey}`,
 },
 body: JSON.stringify({
 input: request.text,
 source_language: SARVAM_LANG[request.sourceLanguage] ?? 'en-IN',
 target_language: SARVAM_LANG[request.targetLanguage] ?? 'ta-IN',
 mode: tanglishDetected ? 'tanglish-aware' : 'standard',
 model: request.model ?? 'sarvam-translate-v1',
 }),
 });

 if (!response.ok) {
 const body = await response.text();
 throw new Error(`Sarvam translate failed (${response.status}): ${body}`);
 }

 const data = (await response.json()) as SarvamTranslateResponse;
 const processingMs = Date.now() - started;

 return {
 translatedText: data.translatedText,
 sourceLanguage: request.sourceLanguage,
 targetLanguage: request.targetLanguage,
 detectedLanguage: tanglishDetected ? 'tanglish' : request.sourceLanguage,
 confidence: 0.92,
 tanglishDetected,
 processingMs,
 provider: 'sarvam',
 timestamp: new Date().toISOString(),
 };
 }

 // ─── Stub fallback (no API key) ─────────────────────────────────────────────

 private stubTranslate(request: TranslateRequest, tanglish: boolean, processingMs: number): TranslateResponse {
 const { sourceLanguage, targetLanguage, text } = request;

 if (sourceLanguage === targetLanguage) {
 return {
 translatedText: text,
 sourceLanguage,
 targetLanguage,
 detectedLanguage: tanglish ? 'tanglish' : sourceLanguage,
 confidence: 1,
 tanglishDetected: tanglish,
 processingMs,
 provider: 'stub',
 timestamp: new Date().toISOString(),
 };
 }

 const prefix = tanglish ? '[tanglish] ' : '';
 const label = sourceLanguage === 'en' ? 'ta' : 'en';
 return {
 translatedText: `${prefix}[${label}] ${text}`,
 sourceLanguage,
 targetLanguage,
 detectedLanguage: tanglish ? 'tanglish' : sourceLanguage,
 confidence: 0,
 tanglishDetected: tanglish,
 processingMs,
 provider: 'stub',
 timestamp: new Date().toISOString(),
 };
 }

 // ─── Tanglish detection ─────────────────────────────────────────────────────

 /**
 * Heuristic: scan for common Latin-script Tamil tokens.
 */
 private detectTanglish(text: string): boolean {
 if (!text || text.trim().length === 0) return false;

 const TAMILISH = /enna|epdi|eppo|eppadi|aama|illa|vanga|seri|nannai|romba|konjam|thinnu|varuven|poren|nalla|maga|akka|machan|patti|cab|auto|ticket|book|cancel|refund/i;
 const words = text.split(/\s+/);
 return words.some((w) => TAMILISH.test(w));
 }
}
