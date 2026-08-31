/**
 * LEA-011 — @nova/memory — Memory extraction using Claude.
 *
 * Extracts candidate memories from conversation transcripts using Claude Haiku.
 * Classifies each candidate by category, sensitivity, and confidence.
 *
 * Per blueprint Section 11.2 (Creation Pipeline) and Section 11.3 (Memory Record Schema).
 */

import type {
	MemoryCategory,
	MemorySensitivity,
	MemorySourceType,
	MemoryVisibility,
} from '@nova/shared-types';

export interface MemoryExtractionOptions {
	readonly transcriptText: string;
	readonly language?: string;
	readonly userId: string;
	readonly tenantId?: string;
	readonly sourceId?: string;
}

export interface ExtractedMemoryCandidate {
	readonly content: string;
	readonly category: MemoryCategory;
	readonly sensitivity: MemorySensitivity;
	readonly confidence: number;
	readonly importance: number;
	readonly normalizedFacts: Record<string, unknown>;
	readonly suggestedVisibility: MemoryVisibility;
	readonly sourceSpan?: { readonly start: number; readonly end: number };
}

export interface MemoryExtractionResult {
	readonly candidates: readonly ExtractedMemoryCandidate[];
	readonly processingMs: number;
	readonly model: string;
}

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant. Analyze the provided transcript and extract candidate memories.

For each candidate, provide:
1. content: the exact memory content (short, factual)
2. category: one of: fact, preference, event, contact, decision
3. sensitivity: one of: normal, sensitive, confidential
4. confidence: 0-100 (how certain you are this is accurate)
5. importance: 0-100 (how useful this memory would be)
6. normalizedFacts: structured data extracted (e.g., { name: "...", budget: "..." })
7. suggestedVisibility: private or shared

Rules:
- Never extract: passwords, OTPs, tokens, API keys, payment card numbers
- Prefer short, specific facts over long paraphrases
- Confidence should be lower for inferred vs explicitly stated information
- Group related facts into single memories when they share a subject`;

/**
 * MemoryExtractor uses Claude to extract candidate memories from transcripts.
 *
 * Server-side only. Requires ANTHROPIC_API_KEY.
 */
export class MemoryExtractor {
	private readonly apiKey: string;
	private readonly baseUrl: string;

	constructor(apiKey?: string) {
		this.apiKey = apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
		if (!this.apiKey) {
			throw new Error('ANTHROPIC_API_KEY is required for memory extraction');
		}
		this.baseUrl = 'https://api.anthropic.com/v1';
	}

	/**
	 * Extract memory candidates from a transcript.
	 */
	async extract(options: MemoryExtractionOptions): Promise<MemoryExtractionResult> {
		const start = Date.now();

		const response = await this.callClaude(options.transcriptText, options.language);

		const processingMs = Date.now() - start;
		const candidates = this.parseCandidates(response, options);

		return {
			candidates,
			processingMs,
			model: 'haiku', // Per blueprint Section 7.2: memory extraction uses Haiku
		};
	}

	/**
	 * Extract memories from a conversation (messages array).
	 */
	async extractFromMessages(
		messages: readonly { readonly role: string; readonly content: string }[],
		userId: string,
		tenantId?: string,
	): Promise<MemoryExtractionResult> {
		const transcript = messages
			.map((m) => `${m.role === 'user' ? 'User' : 'NOVA'}: ${m.content}`)
			.join('\n');

		return this.extract({
			transcriptText: transcript,
			userId,
			tenantId,
		});
	}

	private async callClaude(transcript: string, language?: string): Promise<unknown> {
		const langHint = language ? `\n\nNote: the transcript is in ${language}. Preserve the original language in extracted memories.` : '';

		const response = await fetch(`${this.baseUrl}/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this.apiKey,
				'anthropic-version': '2023-06-01',
				'anthropic-dangerous-direct-browser-access': 'true',
			},
			body: JSON.stringify({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 2048,
				system: EXTRACTION_SYSTEM_PROMPT + langHint,
				messages: [
					{
						role: 'user',
						content: `Extract memory candidates from this transcript:\n\n${transcript}\n\nReturn ONLY a JSON array of candidates. Each candidate must have: content, category, sensitivity, confidence (0-100), importance (0-100), normalizedFacts (object), suggestedVisibility.`,
					},
				],
			}),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Claude memory extraction error ${response.status}: ${text}`);
		}

		return response.json();
	}

	private parseCandidates(
		response: unknown,
		_options: MemoryExtractionOptions,
	): ExtractedMemoryCandidate[] {
		try {
			const data = response as { content?: readonly { type: string; text?: string }[] };
			const textBlock = data.content?.find((b) => b.type === 'text');
			const text = textBlock?.text ?? '';

			// Try to parse JSON array from the response
			const jsonMatch = text.match(/\[[\s\S]*\]/);
			if (!jsonMatch) return [];

			const parsed = JSON.parse(jsonMatch[0]);

			if (!Array.isArray(parsed)) return [];

			return parsed
				.filter((c: unknown) => c && typeof c === 'object' && 'content' in (c as Record<string, unknown>))
				.map((c: Record<string, unknown>): ExtractedMemoryCandidate => ({
					content: String(c.content ?? ''),
					category: this.normalizeCategory(c.category),
					sensitivity: this.normalizeSensitivity(c.sensitivity),
					confidence: this.clamp(Number(c.confidence ?? 50), 0, 100),
					importance: this.clamp(Number(c.importance ?? 50), 0, 100),
					normalizedFacts: (c.normalizedFacts as Record<string, unknown>) ?? {},
					suggestedVisibility: c.suggestedVisibility === 'shared' ? 'shared' : 'private',
				}))
				.filter((c: ExtractedMemoryCandidate) => c.content.length > 0 && c.confidence > 30);
		} catch {
			return [];
		}
	}

	private normalizeCategory(cat: unknown): MemoryCategory {
		const valid: MemoryCategory[] = ['fact', 'preference', 'event', 'contact', 'decision'];
		const str = String(cat ?? 'fact').toLowerCase();
		return valid.find((v) => v === str) ?? 'fact';
	}

	private normalizeSensitivity(sens: unknown): MemorySensitivity {
		const valid: MemorySensitivity[] = ['normal', 'sensitive', 'confidential'];
		const str = String(sens ?? 'normal').toLowerCase();
		return valid.find((v) => v === str) ?? 'normal';
	}

	private clamp(value: number, min: number, max: number): number {
		return Math.max(min, Math.min(max, value));
	}
}

// ─── MemoryClassifier ─────────────────────────────────────────────────────────

/**
 * Classifies a memory candidate by category, sensitivity, and confidence.
 * Used for post-extraction classification and re-classification of existing memories.
 */
export class MemoryClassifier {
	/**
	 * Classify a memory content string.
	 */
	classify(content: string): {
		category: MemoryCategory;
		sensitivity: MemorySensitivity;
		confidence: number;
	} {
		const lowerContent = content.toLowerCase();

		// Sensitivity heuristics
		const sensitiveKeywords = /\b(password|otp|token|secret|key|ssn|aadhaar|pan|bank|account|pin)\b/i;
		const confidentialKeywords = /\b(medical|health|salary|income|private|personal)\b/i;

		let sensitivity: MemorySensitivity = 'normal';
		if (sensitiveKeywords.test(content)) {
			sensitivity = 'sensitive';
		} else if (confidentialKeywords.test(content)) {
			sensitivity = 'sensitive';
		}

		// Category heuristics
		const category = this.detectCategory(lowerContent);

		// Confidence based on specificity
		const confidence = this.estimateConfidence(content, category);

		return { category, sensitivity, confidence };
	}

	private detectCategory(content: string): MemoryCategory {
		// Contact patterns
		if (/\b(phone|email|contact|call|reach|number)\b/i.test(content) && /\b[A-Z][a-z]+\b/.test(content)) {
			return 'contact';
		}
		// Event patterns
		if (/\b(meeting|tomorrow|today|next week|monday|tuesday|wednesday|thursday|friday|schedule)\b/i.test(content)) {
			return 'event';
		}
		// Decision patterns
		if (/\b(decided|agreed|approved|rejected|choice|going with)\b/i.test(content)) {
			return 'decision';
		}
		// Preference patterns
		if (/\b(prefers|prefer|likes|doesn't like|hate|love|wants|doesn't want)\b/i.test(content)) {
			return 'preference';
		}
		// Default
		return 'fact';
	}

	private estimateConfidence(content: string, _category: MemoryCategory): number {
		let confidence = 70; // baseline

		// Boost for specific data
		if (/\d{2,}/.test(content)) confidence += 10; // numbers
		if (/@/.test(content)) confidence += 10; // email
		if (/\+91\s?\d{5}/.test(content)) confidence += 10; // Indian phone
		if (/rs\.?\s*\d/i.test(content)) confidence += 5; // currency

		// Reduce for uncertainty markers
		if (/\b(maybe|might|possibly|perhaps|not sure|i think)\b/i.test(content)) {
			confidence -= 20;
		}
		if (/\b(probably|likely|seems|appears)\b/i.test(content)) {
			confidence -= 10;
		}

		return Math.max(0, Math.min(100, confidence));
	}
}
