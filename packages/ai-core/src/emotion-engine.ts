/**
 * NOVA Emotion Engine v2 — LLM-driven emotional intelligence
 *
 * VAD (Valence-Arousal-Dominance) continuous model
 * Context-aware emotion detection
 * Proactive emotional responses
 * Conversation mood tracking
 */

export type EmotionDimension = 'valence' | 'arousal' | 'dominance';
export type EmotionState =
	| 'neutral'
	| 'happy'
	| 'calm'
	| 'excited'
	| 'concerned'
	| 'thinking'
	| 'warm'
	| 'playful'
	| 'empathetic'
	| 'curious';

export interface VADScore {
	readonly valence: number; // -1 to +1
	readonly arousal: number; // 0 to 1
	readonly dominance: number; // 0 to 1
}

export interface EmotionResult {
	readonly primary: EmotionState;
	readonly secondary?: EmotionState;
	readonly vad: VADScore;
	readonly confidence: number;
	readonly reason: string;
	readonly suggestedResponse: ResponseStyle;
}

export interface ResponseStyle {
	readonly tone: string;
	readonly speed: 'slow' | 'normal' | 'fast';
	readonly warmth: number;
	readonly energy: number;
	readonly emojiLevel: 'none' | 'light' | 'moderate';
}

export interface MoodTracker {
	readonly currentMood: EmotionState;
	readonly moodHistory: Array<{ timestamp: Date; mood: EmotionState; trigger: string }>;
	readonly avgValence: number;
	readonly avgArousal: number;
	readonly trend: 'improving' | 'stable' | 'declining';
}

const POSITIVE_WORDS = [
	'happy', 'great', 'awesome', 'amazing', 'wonderful', 'love', 'excited',
	'fantastic', 'good', 'nice', 'beautiful', 'thank', 'thanks', 'perfect',
	'best', 'yeah', 'yes', 'yay', 'celebrate', 'proud', 'grateful',
	'mass', 'mass ah', 'super', 'nice da', 'masta', 'semma', 'nalla',
];

const NEGATIVE_WORDS = [
	'sad', 'angry', 'frustrated', 'annoyed', 'hate', 'terrible', 'awful',
	'bad', 'worst', 'horrible', 'depressed', 'anxious', 'worried',
	'stress', 'stressed', 'tired', 'exhausted', 'fail', 'sorry',
	'ennai', 'kosham', 'siricha', 'thavarana',
];

const EMOTION_VALUES: Record<EmotionState, number> = {
	happy: 0.8, excited: 0.7, warm: 0.6, playful: 0.5, neutral: 0,
	concerned: -0.6, calm: -0.2, thinking: 0, empathetic: -0.1, curious: 0.3,
};

const RESPONSE_STYLES: Record<EmotionState, ResponseStyle> = {
	neutral: { tone: 'friendly and steady', speed: 'normal', warmth: 0.6, energy: 0.5, emojiLevel: 'light' },
	happy: { tone: 'celebratory and warm', speed: 'normal', warmth: 0.8, energy: 0.8, emojiLevel: 'moderate' },
	calm: { tone: 'soothing and reassuring', speed: 'slow', warmth: 0.9, energy: 0.3, emojiLevel: 'light' },
	excited: { tone: 'energetic and engaging', speed: 'fast', warmth: 0.7, energy: 0.9, emojiLevel: 'moderate' },
	concerned: { tone: 'gentle and supportive', speed: 'slow', warmth: 0.9, energy: 0.4, emojiLevel: 'none' },
	thinking: { tone: 'thoughtful and measured', speed: 'normal', warmth: 0.5, energy: 0.4, emojiLevel: 'none' },
	warm: { tone: 'caring and affectionate', speed: 'normal', warmth: 0.95, energy: 0.6, emojiLevel: 'light' },
	playful: { tone: 'light and fun', speed: 'fast', warmth: 0.7, energy: 0.8, emojiLevel: 'moderate' },
	empathetic: { tone: 'deeply understanding', speed: 'slow', warmth: 0.95, energy: 0.3, emojiLevel: 'none' },
	curious: { tone: 'inquisitive and engaging', speed: 'normal', warmth: 0.6, energy: 0.7, emojiLevel: 'light' },
};

const HIGH_AROUSAL = ['!', '!!', '!!!', 'wow', 'omg', 'oh my', "can't believe", 'so', 'really'];
const LOW_AROUSAL = ['tired', 'sleepy', 'bored', 'meh', 'whatever', 'dunno', 'idk'];

export class EmotionEngine {
	private moodHistory: Array<{ timestamp: Date; mood: EmotionState; trigger: string }> = [];
	private currentVAD: VADScore = { valence: 0, arousal: 0.3, dominance: 0.5 };
	private readonly MAX_HISTORY = 50;

	analyze(text: string, context: {
		conversationLength: number;
		lastUserMood?: EmotionState;
		hasRecentNegativeInteraction?: boolean;
		timeOfDay: string;
	}): EmotionResult {
		const lower = text.toLowerCase();
		const words = lower.split(/\s+/);

		// Valence
		const positiveCount = words.filter((w) => POSITIVE_WORDS.some((pw) => w.includes(pw))).length;
		const negativeCount = words.filter((w) => NEGATIVE_WORDS.some((nw) => w.includes(nw))).length;
		let valence = (positiveCount - negativeCount) / Math.max(words.length * 0.3, 1);
		valence = Math.max(-1, Math.min(1, valence));

		// Arousal
		const highArousal = words.some((w) => HIGH_AROUSAL.some((hw) => w.includes(hw)));
		const lowArousal = words.some((w) => LOW_AROUSAL.some((lw) => w.includes(lw)));
		let arousal = 0.3;
		if (highArousal) arousal += 0.4;
		if (lowArousal) arousal -= 0.3;
		if (/\?{2,}/.test(text)) arousal += 0.2;
		arousal = Math.max(0, Math.min(1, arousal));

		// Dominance
		let dominance = 0.5;
		if (text.includes('please') || text.includes('can you')) dominance -= 0.2;
		if (text.includes('i want') || text.includes('i need')) dominance += 0.2;
		if (text.includes('?') && text.length < 20) dominance -= 0.1;
		dominance = Math.max(0, Math.min(1, dominance));

		const vad: VADScore = { valence, arousal, dominance };
		this.currentVAD = vad;

		// Classify emotion
		let primary: EmotionState;
		let secondary: EmotionState | undefined;
		let confidence: number;
		let reason: string;

		if (text.includes('?') && text.length > 30) {
			primary = valence > 0 ? 'curious' : 'concerned';
			secondary = 'thinking';
			confidence = 0.7;
			reason = 'User is asking a thoughtful question';
		} else if (positiveCount > 2 && arousal > 0.6) {
			primary = 'excited';
			confidence = 0.8;
			reason = 'Strong positive sentiment with high energy';
		} else if (negativeCount > 1 && valence < -0.3) {
			primary = 'concerned';
			confidence = 0.75;
			reason = 'Negative sentiment detected';
		} else if (lowArousal && valence < 0) {
			primary = 'calm';
			confidence = 0.6;
			reason = 'Low energy with negative lean';
		} else if (highArousal && valence > 0) {
			primary = 'excited';
			confidence = 0.7;
			reason = 'High energy positive sentiment';
		} else if (context.conversationLength > 10 && valence > 0.2) {
			primary = 'warm';
			confidence = 0.5;
			reason = 'Established positive conversation';
		} else if (context.hasRecentNegativeInteraction) {
			primary = 'empathetic';
			confidence = 0.6;
			reason = 'Following up on negative interaction';
		} else {
			primary = valence > 0.1 ? 'happy' : valence < -0.1 ? 'concerned' : 'neutral';
			confidence = 0.5;
			reason = 'Neutral baseline with slight sentiment';
		}

		// Track mood
		this.moodHistory.push({ timestamp: new Date(), mood: primary, trigger: text.slice(0, 50) });
		if (this.moodHistory.length > this.MAX_HISTORY) this.moodHistory.shift();

		return { primary, secondary, vad, confidence, reason, suggestedResponse: RESPONSE_STYLES[primary] };
	}

	getResponseStyle(emotion: EmotionState): ResponseStyle {
		return RESPONSE_STYLES[emotion] ?? RESPONSE_STYLES.neutral;
	}

	getMoodTracker(): MoodTracker {
		if (this.moodHistory.length === 0) {
			return { currentMood: 'neutral', moodHistory: [], avgValence: 0, avgArousal: 0, trend: 'stable' };
		}

		const recent = this.moodHistory.slice(-10);
		const avgValence = recent.reduce((sum, m) => sum + (EMOTION_VALUES[m.mood] ?? 0), 0) / recent.length;

		const currentMood = recent[recent.length - 1]?.mood ?? 'neutral';
		const older = this.moodHistory.slice(-20, -10);
		const olderValence = older.reduce((sum, m) => sum + (EMOTION_VALUES[m.mood] ?? 0), 0) / Math.max(older.length, 1);

		let trend: 'improving' | 'stable' | 'declining' = 'stable';
		if (avgValence - olderValence > 0.3) trend = 'improving';
		else if (avgValence - olderValence < -0.3) trend = 'declining';

		return { currentMood, moodHistory: this.moodHistory, avgValence, avgArousal: this.currentVAD.arousal, trend };
	}

	getProactiveMessage(): string | null {
		const tracker = this.getMoodTracker();
		const hour = new Date().getHours();

		if (tracker.trend === 'declining' && tracker.avgValence < -0.3) {
			return "I've noticed you've been feeling a bit low lately. Want to talk about it? I'm here 💙";
		}

		if (hour >= 6 && hour < 9 && tracker.currentMood !== 'neutral') {
			return `Good morning! ${tracker.currentMood === 'excited' ? 'You seem energized today — let\'s make it great!' : 'Hope you slept well'}`;
		}

		if (tracker.currentMood === 'happy') {
			return "You seem happy today! That's wonderful — want to tell me what's going well?";
		}

		return null;
	}

	getCurrentVAD(): VADScore {
		return { ...this.currentVAD };
	}

	reset(): void {
		this.moodHistory = [];
		this.currentVAD = { valence: 0, arousal: 0.3, dominance: 0.5 };
	}
}

// Singleton instance
let emotionEngineInstance: EmotionEngine | null = null;

export function getEmotionEngine(): EmotionEngine {
	if (!emotionEngineInstance) {
		emotionEngineInstance = new EmotionEngine();
	}
	return emotionEngineInstance;
}

export function resetEmotionEngine(): void {
	emotionEngineInstance = null;
}
