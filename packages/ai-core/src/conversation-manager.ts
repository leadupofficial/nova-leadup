/**
 * NOVA Conversation Manager
 *
 * Orchestrates the full conversation pipeline:
 * 1. Receives user message
 * 2. Retrieves relevant memories
 * 3. Detects emotion
 * 4. Builds personality-aware 
 * 5. Calls AI (Claude via BroCode)
 * 6. Generates response with emotion + voice adaptation
 * 7. Stores conversation in memory
 * 8. Extracts tasks/facts
 */

import type {
	ClaudeMessage,
	ClaudeCompletionRequest,
	ClaudeCompletionResponse,
} from './types.js';
import type { MemoryQuery, MemorySearchResult, PersonalFact } from './memory-core.js';
import { MemoryCore, getMemoryCore } from './memory-core.js';
import { PersonalityEngine, getPersonalityEngine } from './personality.js';
import { EmotionEngine, getEmotionEngine } from './emotion-engine.js';
import type { EmotionState, VADScore } from './emotion-engine.js';

export interface ConversationTurn {
	readonly role: 'user' | 'assistant';
	readonly content: string;
	readonly timestamp: Date;
	readonly emotion?: EmotionState;
	readonly vad?: VADScore;
}

export interface ConversationContext {
	readonly userId: string;
	readonly conversationId: string;
	readonly turns: ConversationTurn[];
	readonly userName?: string;
	readonly language: 'auto' | 'en' | 'ta' | 'hinglish' | 'tanglish';
	readonly personalityPreset: 'friendly' | 'professional' | 'companion' | 'executive';
}

export interface ConversationResponse {
	readonly message: string;
	readonly emotion: EmotionState;
	readonly vad: VADScore;
	readonly voiceSettings: { speed: number; pitch: number; emotion: boolean };
	readonly proactiveSuggestion?: string;
	readonly extractedTasks?: Array<{ title: string; priority: 'low' | 'medium' | 'high' }>;
	readonly memoriesUsed: number;
	readonly processingMs: number;
}

export interface ConversationManagerConfig {
	readonly maxContextTurns: number;
	readonly memoryRetrievalLimit: number;
	readonly memoryRelevanceThreshold: number;
	readonly enableProactiveMessages: boolean;
	readonly enableTaskExtraction: boolean;
	readonly apiKey: string;
	readonly baseUrl?: string;
	readonly model?: string;
}

export class ConversationManager {
	private personality: PersonalityEngine;
	private emotionEngine: EmotionEngine;
	private memoryCore: MemoryCore;
	private config: ConversationManagerConfig;
	private conversationCache = new Map<string, ConversationContext>();

	constructor(config: ConversationManagerConfig) {
		this.config = config;
		this.personality = getPersonalityEngine();
		this.emotionEngine = getEmotionEngine();
		this.memoryCore = getMemoryCore();
	}

	async processTurn(context: ConversationContext): Promise<ConversationResponse> {
		const startTime = Date.now();
		const userMessage = context.turns[context.turns.length - 1]?.content ?? '';

		this.personality.updateContext({
			userName: context.userName,
			conversationLength: context.turns.length,
			isFirstMessage: context.turns.length <= 1,
			hasPersonalContext: context.turns.length > 3,
		});

		const emotionResult = this.emotionEngine.analyze(userMessage, {
			conversationLength: context.turns.length,
			timeOfDay: this.getTimeOfDay(),
		});

		this.personality.updateContext({ userMood: emotionResult.primary });

		const memories = await this.memoryCore.searchMemories({
			userId: context.userId,
			query: userMessage,
			limit: this.config.memoryRetrievalLimit,
			threshold: this.config.memoryRelevanceThreshold,
			userMood: emotionResult.primary,
		});

		const personalFacts = this.memoryCore.getPersonalFacts(context.userId);
		const systemPrompt = this.buildSystemPrompt(context, memories, personalFacts, emotionResult);
		const messages = this.buildMessages(context);
		const response = await this.callAI({
			model: (this.config.model as any) ?? 'claude-sonnet-4-20250514',
			max_tokens: 1024,
			messages,
			system: systemPrompt,
		});

		const assistantMessage = this.extractText(response);

		const emotionStr = emotionResult.primary as unknown as string;
		await this.memoryCore.storeMemory({
			userId: context.userId,
			type: 'conversation',
			content: `User: ${userMessage}\nNOVA: ${assistantMessage}`,
			importance: emotionResult.confidence > 0.7 ? 'high' : 'medium',
			emotionalTag: {
				valence: emotionResult.vad.valence,
				arousal: emotionResult.vad.arousal,
				emotion: emotionStr,
			},
		});

		let extractedTasks: Array<{ title: string; priority: 'low' | 'medium' | 'high' }> | undefined;
		if (this.config.enableTaskExtraction && this.looksLikeTask(userMessage)) {
			extractedTasks = await this.extractTasks(userMessage, assistantMessage);
		}

		const proactiveSuggestion = this.config.enableProactiveMessages
			? this.emotionEngine.getProactiveMessage() ?? undefined
			: undefined;

		this.personality.adaptFromHistory(context.turns);

		return {
			message: assistantMessage,
			emotion: emotionResult.primary,
			vad: emotionResult.vad,
			voiceSettings: this.personality.getAdaptedVoice(),
			proactiveSuggestion,
			extractedTasks,
			memoriesUsed: memories.length,
			processingMs: Date.now() - startTime,
		};
	}

	private buildSystemPrompt(
		context: ConversationContext,
		memories: MemorySearchResult[],
		facts: PersonalFact[],
		emotion: { primary: EmotionState; suggestedResponse: any },
	): string {
		const parts: string[] = [];
		parts.push(this.personality.buildSystemPrompt());

		if (facts.length > 0) {
			const factSummary = facts.slice(0, 10).map((f) => `${f.type}: ${f.value}`).join('\n');
			parts.push(`\n\nWHAT YOU KNOW ABOUT ${context.userName ?? 'THE USER'}:\n${factSummary}`);
		}

		if (memories.length > 0) {
			const memorySummary = memories
				.slice(0, 5)
				.map((m, i) => `[${i + 1}] ${m.memory.content}`)
				.join('\n');
			parts.push(`\n\nRELEVANT MEMORIES (use naturally, don't quote):\n${memorySummary}`);
		}

		parts.push(`\n\nCURRENT MOMENT: User seems ${emotion.primary}. ${emotion.suggestedResponse.tone}.`);

		if (context.language === 'auto') {
			parts.push('\n\nLANGUAGE: Match user. Tamil → Tamil, Tanglish → Tanglish, English → English.');
		}

		return parts.join('\n');
	}

	private buildMessages(context: ConversationContext): ClaudeMessage[] {
		const maxTurns = this.config.maxContextTurns;
		const recentTurns = context.turns.slice(-maxTurns * 2);
		return recentTurns.map((turn) => ({
			role: turn.role,
			content: turn.content,
		}));
	}

	private async callAI(request: ClaudeCompletionRequest): Promise<ClaudeCompletionResponse> {
		const url = `${this.config.baseUrl ?? 'https://api.brocode.live'}/v1/messages`;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'x-api-key': this.config.apiKey,
			'anthropic-version': '2023-06-01',
			'anthropic-dangerous-direct-browser-access': 'true',
		};

		const body = {
			model: request.model,
			max_tokens: request.max_tokens,
			messages: request.messages,
			...(request.system ? { system: request.system } : {}),
		};

		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`AI API error ${response.status}: ${text}`);
		}

		return response.json() as Promise<ClaudeCompletionResponse>;
	}

	private extractText(response: ClaudeCompletionResponse): string {
		return response.content
			.filter((block: any) => block.type === 'text')
			.map((block: any) => block.text)
			.join('\n');
	}

	private looksLikeTask(message: string): boolean {
		const taskIndicators = [
			'remind me', 'set a reminder', 'don\'t forget', 'i need to',
			'schedule', 'plan', 'todo', 'to-do', 'task', 'deadline',
			'by tomorrow', 'by next week', 'i have to', 'must do',
		];
		const lower = message.toLowerCase();
		return taskIndicators.some((ind) => lower.includes(ind));
	}

	private async extractTasks(
		userMessage: string,
		assistantMessage: string,
	): Promise<Array<{ title: string; priority: 'low' | 'medium' | 'high' }>> {
		try {
			const prompt = `Extract any actionable tasks from this conversation. Return JSON array of {title, priority}.

User: ${userMessage}
Assistant: ${assistantMessage}

Tasks (JSON array):`;

			const response = await this.callAI({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 256,
				messages: [{ role: 'user', content: prompt }],
			});

			const text = this.extractText(response);
			const match = text.match(/\[.*\]/s);
			if (!match) return [];

			const tasks = JSON.parse(match[0]);
			return Array.isArray(tasks) ? tasks.slice(0, 3) : [];
		} catch {
			return [];
		}
	}

	getOrCreateContext(userId: string, conversationId: string, userName?: string): ConversationContext {
		const key = `${userId}:${conversationId}`;
		const existing = this.conversationCache.get(key);
		if (existing) return existing;

		const ctx: ConversationContext = {
			userId,
			conversationId,
			turns: [],
			userName,
			language: 'auto',
			personalityPreset: 'companion',
		};
		this.conversationCache.set(key, ctx);
		return ctx;
	}

	clearCache(userId?: string): void {
		if (userId) {
			for (const key of this.conversationCache.keys()) {
				if (key.startsWith(userId + ':')) this.conversationCache.delete(key);
			}
		} else {
			this.conversationCache.clear();
		}
	}

	private getTimeOfDay(): string {
		const hour = new Date().getHours();
		if (hour < 12) return 'morning';
		if (hour < 17) return 'afternoon';
		if (hour < 21) return 'evening';
		return 'night';
	}
}

let conversationManagerInstance: ConversationManager | null = null;

export function getConversationManager(config?: ConversationManagerConfig): ConversationManager {
	if (!conversationManagerInstance) {
		if (!config?.apiKey) {
			throw new Error('ConversationManager requires apiKey on first initialization');
		}
		conversationManagerInstance = new ConversationManager(config);
	}
	return conversationManagerInstance;
}

export function resetConversationManager(): void {
	conversationManagerInstance = null;
}
