/**
 * LEA-009 — Tamil/Tanglish language detection and policy.
 *
 * Language detection uses Unicode script analysis:
 * - Tamil: Unicode range U+0B80-U+0BFF
 * - English: ASCII A-Z, a-z
 * - Tanglish: Mix of Tamil + Latin scripts with common Tamil-English patterns
 */

export type LanguageCode = 'en' | 'ta' | 'tanglish';

export interface LanguageDetectionResult {
 readonly language: LanguageCode;
 readonly confidence: number;
 readonly tamilRatio: number;
 readonly latinRatio: number;
 readonly isTanglishMix: boolean;
}

export interface SpeechBenchmarkResult {
 readonly id: string;
 readonly provider: string;
 readonly language: LanguageCode;
 readonly sampleId: string;
 readonly audioDurationMs: number;
 readonly transcript: string;
 readonly expectedText: string;
 readonly wordErrorRate: number;
 readonly latencyMs: number;
 readonly confidence: number;
 readonly timestamp: string;
}

export interface BenchmarkRunSummary {
 readonly runId: string;
 readonly provider: string;
 readonly language: LanguageCode;
 readonly samples: number;
 readonly avgWordErrorRate: number;
 readonly avgLatencyMs: number;
 readonly avgConfidence: number;
 readonly passed: boolean;
}

// ─── Language Detection ──────────────────────────────────────────────────────

const TAMIL_SCRIPT_REGEX = /[஀-௿]/g;
const LATIN_SCRIPT_REGEX = /[A-Za-z]/g;
const TAMIL_GLYPHS = new Set([
 'ந','்','ை','ா','ி','ு','ே','ொ','்','க','த','ம','ய','ல','ர','ன','ப','வ','ட','ற','ச','ங','ஞ','ட','ண','த','ந','ப','ம','ய','ர','ல','வ','ழ','ள','ற','ன',
 'அ','ஆ','இ','ஈ','உ','ஊ','ஏ','ஐ','ஓ','ஔ','ஃ',
]);

// Common Tanglish word pairs (Tamil written in Latin script)
const TAMILISH_WORDS = new Set([
 'enna','epdi','eppo','eppadi','aama','illa','vanga','vandhurunga','paaru',
 'sollu','kelu','kandupidi','seri','nannai','romba','konjam','thinnu',
 'varuven','poren','kudukuren','keturen','sandhegam','thappu','nalla',
 'maga','akka','machan','thala','mame','patti','suruttu','kutty',
 'chennai','coimbatore','madurai','salem','erode','trichy','thanjavur',
 'kumar','murugan','vijay','arun','priya','lakshmi','raj','suresh',
 'CRM','ROI','KPI','FY','Q1','Q2','Q3','Q4',
]);

export function detectLanguage(text: string): LanguageDetectionResult {
 if (!text || text.trim().length === 0) {
 return { language: 'en', confidence: 1, tamilRatio: 0, latinRatio: 0, isTanglishMix: false };
 }

 const tamilMatches = text.match(TAMIL_SCRIPT_REGEX) ?? [];
 const latinMatches = text.match(LATIN_SCRIPT_REGEX) ?? [];
 const totalChars = text.replace(/\s/g, '').length;

 const tamilRatio = tamilMatches.length / totalChars;
 const latinRatio = latinMatches.length / totalChars;

 // Detect Tanglish: has both Tamil and Latin scripts
 const hasTamilScript = tamilRatio > 0.05;
 const hasLatinScript = latinRatio > 0.05;

 // Check for Tamil-written-in-Latin (Tanglish)
 const words = text.toLowerCase().split(/\s+/);
 const tanglishWordCount = words.filter((w) => TAMILISH_WORDS.has(w.replace(/[^a-z]/g, ''))).length;
 const hasTanglishWords = tanglishWordCount >= 1;

 if (hasTamilScript && hasLatinScript) {
 return {
 language: 'tanglish',
 confidence: Math.min(tamilRatio + latinRatio, 1),
 tamilRatio,
 latinRatio,
 isTanglishMix: true,
 };
 }

 if (hasTamilScript && hasTanglishWords) {
 return {
 language: 'tanglish',
 confidence: Math.max(tamilRatio, 0.7),
 tamilRatio,
 latinRatio,
 isTanglishMix: true,
 };
 }

 if (hasTamilScript) {
 return { language: 'ta', confidence: tamilRatio, tamilRatio, latinRatio, isTanglishMix: false };
 }

 return { language: 'en', confidence: 1, tamilRatio: 0, latinRatio, isTanglishMix: false };
}

// ─── Benchmark Runner ────────────────────────────────────────────────────────

export class SpeechBenchmarkRunner {
 private results: SpeechBenchmarkResult[] = [];

 constructor(private readonly providerName: string) {}

 /**
 * Run a benchmark against a transcript sample.
 */
 async runBenchmark(
 sampleId: string,
 expectedText: string,
 actualTranscript: string,
 language: LanguageCode,
 audioDurationMs: number,
 latencyMs: number,
 confidence: number,
 ): Promise<SpeechBenchmarkResult> {
 const wer = this.computeWordErrorRate(expectedText, actualTranscript);

 const result: SpeechBenchmarkResult = {
 id: `bench-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
 provider: this.providerName,
 language: sampleId.startsWith('ta') ? 'ta' : language,
 sampleId,
 transcript: actualTranscript,
 expectedText,
 wordErrorRate: wer,
 latencyMs,
 confidence,
 audioDurationMs,
 timestamp: new Date().toISOString(),
 };

 this.results.push(result);
 return result;
 }

 /**
* Compute Word Error Rate (WER).
*
* WER = (S + D + I) / N
* where S = substitutions, D = deletions, I = insertions, N = reference word count
*/
 private computeWordErrorRate(reference: string, hypothesis: string): number {
 const refWords = reference.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
 const hypWords = hypothesis.toLowerCase().split(/\s+/).filter((w) => w.length > 0);

 if (refWords.length === 0) return hypWords.length > 0 ? 1 : 0;

 // Simple character-level similarity (Levenshtein-based approximation)
 const levenshtein = this.levenshteinDistance(refWords.join(' '), hypWords.join(' '));
 const maxLen = Math.max(refWords.join(' ').length, hypWords.join(' ').length);
 if (maxLen === 0) return 0;

 return Math.min(levenshtein / maxLen, 1);
 }

 private levenshteinDistance(a: string, b: string): number {
 const m = a.length;
 const n = b.length;
 const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

 for (let i = 0; i <= m; i++) dp[i][0] = i;
 for (let j = 0; j <= n; j++) dp[0][j] = j;

 for (let i = 1; i <= m; i++) {
 for (let j = 1; j <= n; j++) {
 if (a[i - 1] === b[j - 1]) {
 dp[i]![j] = dp[i - 1]![j - 1];
 } else {
 dp[i]![j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
 }
 }
 }

 return Number(dp[m]?.[n]) || 0;;
 }

 /**
* Get summary statistics for all results.
*/
 getSummary(): BenchmarkRunSummary {
 if (this.results.length === 0) {
 return {
 runId: 'empty',
 provider: this.providerName,
 language: 'en',
 samples: 0,
 avgWordErrorRate: 0,
 avgLatencyMs: 0,
 avgConfidence: 0,
 passed: true,
 };
 }

 const avgWER = this.results.reduce((s, r) => s + r.wordErrorRate, 0) / this.results.length;
 const avgLatency = this.results.reduce((s, r) => s + r.latencyMs, 0) / this.results.length;
 const avgConf = this.results.reduce((s, r) => s + r.confidence, 0) / this.results.length;

 // Pass criteria: WER < 0.15, latency < 500ms, confidence > 0.7
 const passed = avgWER < 0.15 && avgLatency < 500 && avgConf > 0.7;

 return {
 runId: `run-${Date.now()}`,
 provider: this.providerName,
 language: this.results[0]!.language,
 samples: this.results.length,
 avgWordErrorRate: avgWER,
 avgLatencyMs: avgLatency,
 avgConfidence: avgConf,
 passed,
 };
 }

 getResults(): readonly SpeechBenchmarkResult[] {
 return [...this.results];
 }
}
