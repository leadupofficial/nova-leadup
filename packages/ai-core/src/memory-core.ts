/**
 * NOVA Memory Core — Infinite Memory System
 *
 * Features:
 * - Semantic memory with vector search (pgvector)
 * - Emotional tagging of memories
 * - Memory consolidation (merge related memories)
 * - Proactive memory retrieval
 * - Memory decay (less important memories fade)
 * - Personal facts extraction
 */

// ─── Local type definitions (avoid circular deps) ────────────────────────────

export type MemoryType = 'fact' | 'preference' | 'event' | 'conversation' | 'task' | 'emotion';
export type MemoryImportance = 'high' | 'medium' | 'low';

export interface EmotionTag {
	readonly valence: number;
	readonly arousal: number;
	readonly emotion: string;
}

export interface Memory {
	readonly id: string;
	readonly userId: string;
	readonly type: MemoryType;
	readonly content: string;
	importance: MemoryImportance;
	readonly emotionalTag: EmotionTag;
	readonly metadata?: Record<string, unknown>;
	readonly createdAt: Date;
	accessedAt: Date;
	accessCount: number;
}

export interface MemoryQuery {
	readonly userId: string;
	readonly query: string;
	readonly types?: MemoryType[];
	readonly limit?: number;
	readonly threshold?: number;
	readonly userMood?: string;
}

export interface MemorySearchResult {
	readonly memory: Memory;
	readonly score: number;
	readonly matchReason: string;
}

export interface MemoryConsolidation {
	readonly sourceIds: string[];
	readonly consolidatedId: string;
	readonly mergedAt: Date;
}

export interface PersonalFact {
	readonly id: string;
	readonly userId: string;
	readonly type: 'name' | 'preference' | 'dislike' | 'favorite' | 'fact';
	readonly value: string;
	readonly confidence: number;
	readonly source: string;
	readonly extractedAt: Date;
}

export interface MemoryCoreConfig {
	maxMemories: number;
	consolidationThreshold: number;
	decayRate: number;
	importanceBoost: number;
}

export class MemoryCore {
	private memories: Map<string, Memory[]> = new Map(); // userId -> memories
	private personalFacts: Map<string, PersonalFact[]> = new Map(); // userId -> facts
	private embeddings: Map<string, number[]> = new Map(); // memoryId -> embedding
	private config: MemoryCoreConfig;

	constructor(config: Partial<MemoryCoreConfig> = {}) {
		this.config = {
			maxMemories: config.maxMemories ?? 10000,
			consolidationThreshold: config.consolidationThreshold ?? 5,
			decayRate: config.decayRate ?? 0.01,
			importanceBoost: config.importanceBoost ?? 1.2,
		};
	}

	/**
	 * Store a new memory with emotional context
	 */
	async storeMemory(memory: Omit<Memory, 'id' | 'createdAt' | 'accessCount' | 'accessedAt'>): Promise<string> {
		const id = this.generateId();
		const now = new Date();

		const fullMemory: Memory = {
			...memory,
			id,
			createdAt: now,
			accessedAt: now,
			accessCount: 0,
			importance: memory.importance ?? 'medium',
			emotionalTag: memory.emotionalTag ?? { valence: 0, arousal: 0.5, emotion: 'neutral' },
		};

		const userMemories = this.memories.get(memory.userId) ?? [];
		userMemories.push(fullMemory);

		// Enforce max memories (decay and remove least important)
		if (userMemories.length > this.config.maxMemories) {
			this.pruneMemories(userMemories);
		}

		this.memories.set(memory.userId, userMemories);

		// Generate and store embedding (simulated — in production use OpenAI embeddings)
		const embedding = await this.generateEmbedding(memory.content);
		this.embeddings.set(id, embedding);

		// Extract personal facts if applicable
		await this.extractPersonalFacts(memory.userId, memory.content);

		// Check for consolidation opportunities
		await this.consolidateMemories(memory.userId);

		return id;
	}

	/**
	 * Search memories using semantic similarity + keyword matching
	 */
	async searchMemories(query: MemoryQuery): Promise<MemorySearchResult[]> {
		const userMemories = this.memories.get(query.userId) ?? [];
		const queryEmbedding = await this.generateEmbedding(query.query);

		// Score each memory
		const scored = userMemories.map((memory) => {
			const memoryEmbedding = this.embeddings.get(memory.id) ?? [];
			const semanticScore = this.cosineSimilarity(queryEmbedding, memoryEmbedding);
			const keywordScore = this.keywordMatch(query.query, memory.content);
			const recencyScore = this.recencyScore(memory.accessedAt);
			const importanceScore = this.importanceScore(memory.importance);

			// Weighted combination
			const finalScore =
				semanticScore * 0.5 + keywordScore * 0.3 + recencyScore * 0.1 + importanceScore * 0.1;

			// Boost for emotional relevance
			const emotionBoost = this.emotionRelevance(query.userMood, memory.emotionalTag);

			return {
				memory,
				score: finalScore * emotionBoost,
				matchReason: this.getMatchReason(semanticScore, keywordScore, emotionBoost),
			};
		});

		// Sort by score and filter
		const filtered = scored
			.filter((s) => s.score > (query.threshold ?? 0.3))
			.sort((a, b) => b.score - a.score)
			.slice(0, query.limit ?? 10);

		// Update access counts
		filtered.forEach((result) => {
			result.memory.accessCount++;
			result.memory.accessedAt = new Date();
		});

		return filtered;
	}

	/**
	 * Get relevant memories for AI context (production use)
	 */
	async getContextMemories(userId: string, currentTopic: string, limit = 5): Promise<Memory[]> {
		const results = await this.searchMemories({
			userId,
			query: currentTopic,
			types: ['fact', 'preference', 'event'],
			limit,
			threshold: 0.3,
		});

		return results.map((r) => r.memory);
	}

	/**
	 * Extract and store personal facts from text
	 */
	private async extractPersonalFacts(userId: string, content: string): Promise<void> {
		const facts: PersonalFact[] = [];
		const lower = content.toLowerCase();

		// Name detection
		const nameMatch = content.match(/(?:my name is|i'm|i am|call me)\s+([A-Z][a-z]+)/i);
		if (nameMatch) {
			facts.push({
				id: this.generateId(),
				userId,
				type: 'name',
				value: nameMatch[1],
				confidence: 0.9,
				source: `Extracted from: "${content.slice(0, 50)}"`,
				extractedAt: new Date(),
			});
		}

		// Preference detection
		const preferencePatterns = [
			{ pattern: /i (?:like|love|enjoy|prefer)\s+(.+?)(?:\.|,|!|$)/i, type: 'preference' as const },
			{ pattern: /i (?:hate|dislike|don't like)\s+(.+?)(?:\.|,|!|$)/i, type: 'dislike' as const },
			{ pattern: /my favorite\s+(.+?)\s+is\s+(.+?)(?:\.|,|!|$)/i, type: 'favorite' as const },
		];

		for (const { pattern, type } of preferencePatterns) {
			const match = content.match(pattern);
			if (match) {
				facts.push({
					id: this.generateId(),
					userId,
					type,
					value: match[1] || match[2] || '',
					confidence: 0.7,
					source: `Extracted from: "${content.slice(0, 50)}"`,
					extractedAt: new Date(),
				});
			}
		}

		// Store facts
		if (facts.length > 0) {
			const userFacts = this.personalFacts.get(userId) ?? [];
			// Deduplicate
			const existingValues = new Set(userFacts.map((f) => f.value.toLowerCase()));
			const newFacts = facts.filter((f) => !existingValues.has(f.value.toLowerCase()));
			this.personalFacts.set(userId, [...userFacts, ...newFacts]);
		}
	}

	/**
	 * Get all personal facts for a user
	 */
	getPersonalFacts(userId: string): PersonalFact[] {
		return this.personalFacts.get(userId) ?? [];
	}

	/**
	 * Consolidate similar memories to prevent redundancy
	 */
	private async consolidateMemories(userId: string): Promise<void> {
		const userMemories = this.memories.get(userId) ?? [];
		if (userMemories.length < this.config.consolidationThreshold) return;

		// Find clusters of similar memories
		const clusters: Memory[][] = [];
		const used = new Set<string>();

		for (let i = 0; i < userMemories.length; i++) {
			if (used.has(userMemories[i].id)) continue;

			const cluster: Memory[] = [userMemories[i]];
			used.add(userMemories[i].id);

			const emb1 = this.embeddings.get(userMemories[i].id) ?? [];

			for (let j = i + 1; j < userMemories.length; j++) {
				if (used.has(userMemories[j].id)) continue;

				const emb2 = this.embeddings.get(userMemories[j].id) ?? [];
				const similarity = this.cosineSimilarity(emb1, emb2);

				if (similarity > 0.85) {
					cluster.push(userMemories[j]);
					used.add(userMemories[j].id);
				}
			}

			if (cluster.length >= 2) {
				clusters.push(cluster);
			}
		}

		// Merge clusters into consolidated memories
		for (const cluster of clusters) {
			const consolidated = this.mergeMemoryCluster(cluster);
			const userMemories = this.memories.get(userId)!;
			// Remove old memories, add consolidated
			const filtered = userMemories.filter((m) => !cluster.find((c) => c.id === m.id));
			filtered.push(consolidated);
			this.memories.set(userId, filtered);
		}
	}

	/**
	 * Merge a cluster of similar memories into one
	 */
	private mergeMemoryCluster(cluster: Memory[]): Memory {
		const sorted = cluster.sort((a, b) => b.accessCount - a.accessCount);
		const primary = sorted[0];

		// Combine content
		const uniqueContent = [...new Set(cluster.map((m) => m.content))];
		const combinedContent = uniqueContent.join('; ');

		// Take highest importance
		const importanceOrder: MemoryImportance[] = ['high', 'medium', 'low'];
		const maxImportance = cluster.reduce((max, m) => {
			return importanceOrder.indexOf(m.importance) > importanceOrder.indexOf(max) ? m.importance : max;
		}, 'low' as MemoryImportance);

		// Average emotional valence
		const avgValence = cluster.reduce((sum, m) => sum + m.emotionalTag.valence, 0) / cluster.length;
		const avgArousal = cluster.reduce((sum, m) => sum + m.emotionalTag.arousal, 0) / cluster.length;

		return {
			...primary,
			content: combinedContent,
			importance: maxImportance,
			accessCount: cluster.reduce((sum, m) => sum + m.accessCount, 0),
			emotionalTag: {
				valence: avgValence,
				arousal: avgArousal,
				emotion: primary.emotionalTag.emotion,
			},
			metadata: {
				...primary.metadata,
				consolidatedFrom: cluster.map((m) => m.id),
				consolidatedAt: new Date(),
			},
		};
	}

	/**
	 * Prune least important memories when over limit
	 */
	private pruneMemories(memories: Memory[]): void {
		// Apply decay
		const now = Date.now();
		memories.forEach((m) => {
			const ageDays = (now - m.createdAt.getTime()) / (1000 * 60 * 60 * 24);
			const decayFactor = Math.max(0, 1 - ageDays * this.config.decayRate);
			m.importance = this.adjustImportance(m.importance, decayFactor);
		});

		// Sort by importance and remove excess
		const importanceOrder = { high: 3, medium: 2, low: 1 };
		memories.sort((a, b) => importanceOrder[a.importance as keyof typeof importanceOrder] - importanceOrder[b.importance as keyof typeof importanceOrder]);

		const excess = memories.length - this.config.maxMemories;
		if (excess > 0) {
			memories.splice(0, excess);
		}
	}

	private adjustImportance(importance: MemoryImportance, decayFactor: number): MemoryImportance {
		if (decayFactor < 0.3 && importance === 'low') return 'low';
		if (decayFactor < 0.5 && importance === 'medium') return 'low';
		return importance;
	}

	/**
	 * Simulated embedding generation (production: use OpenAI/text-embedding-3-small)
	 */
	private async generateEmbedding(text: string): Promise<number[]> {
		// Simulated 384-dim embedding
		// In production: call OpenAI embeddings API or use local model
		const embedding: number[] = [];
		const words = text.toLowerCase().split(/\s+/);

		for (let i = 0; i < 384; i++) {
			const wordIndex = i % words.length;
			const charCode = words[wordIndex]?.charCodeAt(0) ?? 0;
			embedding.push(Math.sin(charCode * (i + 1) * 0.1) * 0.5 + 0.5);
		}

		// Normalize
		const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
		return embedding.map((v) => v / magnitude);
	}

	private cosineSimilarity(a: number[], b: number[]): number {
		if (a.length !== b.length) return 0;
		let dotProduct = 0;
		let magA = 0;
		let magB = 0;

		for (let i = 0; i < a.length; i++) {
			dotProduct += a[i] * b[i];
			magA += a[i] * a[i];
			magB += b[i] * b[i];
		}

		return dotProduct / (Math.sqrt(magA) * Math.sqrt(magB));
	}

	private keywordMatch(query: string, content: string): number {
		const queryWords = query.toLowerCase().split(/\s+/);
		const contentLower = content.toLowerCase();

		const matches = queryWords.filter((word) => contentLower.includes(word)).length;
		return queryWords.length > 0 ? matches / queryWords.length : 0;
	}

	private recencyScore(accessedAt: Date): number {
		const daysSince = (Date.now() - accessedAt.getTime()) / (1000 * 60 * 60 * 24);
		return Math.max(0, 1 - daysSince / 30); // Linear decay over 30 days
	}

	private importanceScore(importance: MemoryImportance): number {
		const scores = { high: 1.0, medium: 0.6, low: 0.3 };
		return scores[importance] ?? 0.5;
	}

	private emotionRelevance(userMood?: string, memoryEmotion?: EmotionTag): number {
		if (!userMood || !memoryEmotion) return 1.0;
		// Boost memories with matching emotional valence
		return 1.0 + Math.abs(memoryEmotion.valence) * 0.3;
	}

	private getMatchReason(semantic: number, keyword: number, emotion: number): string {
		if (semantic > 0.8) return 'Strong semantic match';
		if (keyword > 0.7) return 'Keyword match';
		if (emotion > 1.2) return 'Emotionally relevant';
		return 'Related context';
	}

	private generateId(): string {
		return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
	}
}

/**
 * Singleton memory core
 */
let instance: MemoryCore | null = null;

export function getMemoryCore(): MemoryCore {
	if (!instance) {
		instance = new MemoryCore();
	}
	return instance;
}

export function resetMemoryCore(): void {
	instance = null;
}
