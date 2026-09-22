/**
 * NOVA Avatar Engine — 2D animated avatar with viseme-driven lip sync
 *
 * 17 viseme types, audio analysis, gesture system, AvatarController
 */

export type Viseme =
	| 'silence' | 'PP' | 'FF' | 'TH' | 'DD' | 'kk' | 'CH' | 'SS' | 'nn' | 'RR'
	| 'aa' | 'E' | 'I' | 'O' | 'U' | 'ae' | 'AH';

export interface VisemeFrame {
	readonly viseme: Viseme;
	readonly intensity: number;
	readonly durationMs: number;
	readonly timestamp: number;
}

export interface LipSyncConfig {
	readonly smoothingWindow: number;
	readonly visemeThreshold: number;
	readonly blendSpeed: number;
	readonly idleViseme: Viseme;
	readonly speakingVisemeTransitionMs: number;
}

export interface AvatarState {
	readonly currentViseme: Viseme;
	readonly visemeIntensity: number;
	readonly targetViseme: Viseme;
	readonly blendProgress: number;
	readonly mouthOpenness: number;
	readonly mouthWidth: number;
	readonly emotion: string;
	readonly isSpeaking: boolean;
	readonly isListening: boolean;
	readonly breathPhase: number;
}

export interface AudioFeatures {
	readonly rms: number;
	readonly spectralCentroid: number;
	readonly spectralFlatness: number;
	readonly formants: number[];
	readonly zeroCrossingRate: number;
	readonly bands: number[];
}

export interface AudioAnalyzerConfig {
	readonly fftSize: number;
	readonly smoothingTimeConstant: number;
	readonly minDecibels: number;
	readonly maxDecibels: number;
}

export class AudioAnalyzer {
	private config: AudioAnalyzerConfig;

	constructor(config: Partial<AudioAnalyzerConfig> = {}) {
		this.config = {
			fftSize: config.fftSize ?? 2048,
			smoothingTimeConstant: config.smoothingTimeConstant ?? 0.8,
			minDecibels: config.minDecibels ?? -90,
			maxDecibels: config.maxDecibels ?? -10,
		};
	}

	analyze(audioData: Float32Array): AudioFeatures {
		const rms = this.computeRMS(audioData);
		const bands = this.computeFrequencyBands(audioData);
		const spectralCentroid = this.computeSpectralCentroid(bands);
		const spectralFlatness = this.computeSpectralFlatness(bands);
		const zcr = this.computeZCR(audioData);
		const formants = this.estimateFormants(bands);

		return {
			rms: Math.min(1, rms * 3),
			spectralCentroid,
			spectralFlatness,
			formants,
			zeroCrossingRate: zcr,
			bands,
		};
	}

	featuresToVisemes(features: AudioFeatures): Array<{ viseme: Viseme; probability: number }> {
		const { rms, bands, formants, spectralCentroid, zeroCrossingRate, spectralFlatness } = features;

		if (rms < 0.05) {
			return [{ viseme: 'silence', probability: 1.0 }];
		}

		const visemes: Array<{ viseme: Viseme; probability: number }> = [];

		const lowEnergy = (bands[0] + bands[1] + bands[2]) / 3;
		const midEnergy = (bands[3] + bands[4] + bands[5]) / 3;
		const highEnergy = (bands[6] + bands[7]) / 2;

		if (formants.length >= 2) {
			const f1 = formants[0];
			const f2 = formants[1];

			if (f1 > 600 && f1 < 1200 && f2 > 800 && f2 < 1500) {
				visemes.push({ viseme: 'aa', probability: 0.7 + lowEnergy * 0.3 });
			} else if (f1 > 200 && f1 < 500 && f2 > 1800) {
				visemes.push({ viseme: 'I', probability: 0.6 + highEnergy * 0.3 });
			} else if (f1 > 200 && f1 < 500 && f2 > 800 && f2 < 1800) {
				visemes.push({ viseme: 'U', probability: 0.6 + lowEnergy * 0.3 });
			} else if (f1 > 400 && f1 < 800 && f2 > 1500) {
				visemes.push({ viseme: 'E', probability: 0.6 + midEnergy * 0.3 });
			} else if (f1 > 400 && f1 < 800 && f2 > 800 && f2 < 1500) {
				visemes.push({ viseme: 'O', probability: 0.6 + lowEnergy * 0.3 });
			} else if (f1 > 700) {
				visemes.push({ viseme: 'ae', probability: 0.5 + lowEnergy * 0.3 });
			} else if (f1 > 500 && f1 < 1000 && f2 > 1000 && f2 < 1800) {
				visemes.push({ viseme: 'AH', probability: 0.5 + lowEnergy * 0.3 });
			}
		}

		if (highEnergy > 0.3 && zeroCrossingRate > 0.3) {
			visemes.push({ viseme: 'SS', probability: highEnergy });
		}
		if (midEnergy > 0.3 && spectralCentroid > 3000 && spectralCentroid < 6000) {
			visemes.push({ viseme: 'TH', probability: midEnergy * 0.6 });
		}
		if (lowEnergy > 0.3 && spectralFlatness < 0.3) {
			visemes.push({ viseme: 'kk', probability: lowEnergy * 0.5 });
		}
		if (visemes.length === 0 && rms > 0.1) {
			visemes.push({ viseme: 'aa', probability: 0.4 });
		}

		const total = visemes.reduce((sum, v) => sum + v.probability, 0);
		return visemes.map((v) => ({
			...v,
			probability: total > 0 ? v.probability / total : 0,
		}));
	}

	private computeRMS(data: Float32Array): number {
		let sum = 0;
		for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
		return Math.sqrt(sum / data.length);
	}

	private computeFrequencyBands(data: Float32Array): number[] {
		const bands: number[] = [];
		const bandSize = Math.max(1, Math.floor(data.length / 8));
		for (let i = 0; i < 8; i++) {
			let sum = 0;
			const start = i * bandSize;
			const end = Math.min(start + bandSize, data.length);
			for (let j = start; j < end; j++) sum += Math.abs(data[j]);
			bands.push(sum / Math.max(1, end - start));
		}
		const max = Math.max(...bands, 0.01);
		return bands.map((b) => b / max);
	}

	private computeSpectralCentroid(bands: number[]): number {
		let weightedSum = 0, totalWeight = 0;
		for (let i = 0; i < bands.length; i++) {
			weightedSum += i * bands[i];
			totalWeight += bands[i];
		}
		return totalWeight > 0 ? (weightedSum / totalWeight) * 1000 : 0;
	}

	private computeSpectralFlatness(bands: number[]): number {
		const geoMean = bands.reduce((p, b) => p * Math.max(b, 0.001), 1) ** (1 / bands.length);
		const arithMean = bands.reduce((s, b) => s + b, 0) / bands.length;
		return arithMean > 0 ? geoMean / arithMean : 0;
	}

	private computeZCR(data: Float32Array): number {
		let crossings = 0;
		for (let i = 1; i < data.length; i++) {
			if ((data[i] >= 0) !== (data[i - 1] >= 0)) crossings++;
		}
		return crossings / data.length;
	}

	private estimateFormants(bands: number[]): number[] {
		return [
			300 + bands[1] * 800,
			800 + bands[3] * 2500,
			2000 + bands[5] * 2000,
		];
	}
}

export interface VisemeEngineConfig {
	readonly smoothingWindow: number;
	readonly visemeThreshold: number;
	readonly blendSpeed: number;
	readonly idleViseme: Viseme;
	readonly speakingVisemeTransitionMs: number;
}

export class VisemeEngine {
	private config: VisemeEngineConfig;
	private currentViseme: Viseme = 'silence';
	private targetViseme: Viseme = 'silence';
	private currentIntensity = 0;
	private lastVisemeChange = 0;
	private readonly VISEME_HOLD_MS = 60;
	private audioAnalyzer = new AudioAnalyzer();

	constructor(config: Partial<VisemeEngineConfig> = {}) {
		this.config = {
			smoothingWindow: config.smoothingWindow ?? 50,
			visemeThreshold: config.visemeThreshold ?? 0.15,
			blendSpeed: config.blendSpeed ?? 0.3,
			idleViseme: config.idleViseme ?? 'silence',
			speakingVisemeTransitionMs: config.speakingVisemeTransitionMs ?? 80,
		};
	}

	processAudio(audioData: Float32Array, timestamp: number): VisemeFrame[] {
		const features = this.audioAnalyzer.analyze(audioData);
		const visemeProbs = this.audioAnalyzer.featuresToVisemes(features);

		const frames: VisemeFrame[] = [];

		for (const { viseme, probability } of visemeProbs) {
			if (probability < this.config.visemeThreshold) continue;

			if (viseme !== this.currentViseme && (timestamp - this.lastVisemeChange) > this.VISEME_HOLD_MS) {
				this.targetViseme = viseme;
				this.currentViseme = viseme;
				this.lastVisemeChange = timestamp;
			}

			frames.push({
				viseme,
				intensity: probability * features.rms,
				durationMs: this.config.speakingVisemeTransitionMs,
				timestamp,
			});
		}

		this.currentIntensity = features.rms;

		return frames.length > 0 ? frames : [{
			viseme: features.rms < 0.05 ? 'silence' : this.currentViseme,
			intensity: features.rms,
			durationMs: this.config.smoothingWindow,
			timestamp,
		}];
	}

	getState(emotion: string = 'neutral'): AvatarState {
		return {
			currentViseme: this.currentViseme,
			visemeIntensity: this.currentIntensity,
			targetViseme: this.targetViseme,
			blendProgress: 0,
			mouthOpenness: this.getMouthOpenness(this.currentViseme),
			mouthWidth: this.getMouthWidth(this.currentViseme, emotion),
			emotion,
			isSpeaking: this.currentIntensity > 0.05,
			isListening: false,
			breathPhase: (Date.now() % 4000) / 4000,
		};
	}

	setViseme(viseme: Viseme, intensity: number = 1.0): void {
		if (viseme !== this.currentViseme) {
			this.targetViseme = viseme;
			this.currentViseme = viseme;
			this.lastVisemeChange = Date.now();
		}
		this.currentIntensity = intensity;
	}

	reset(): void {
		this.currentViseme = 'silence';
		this.targetViseme = 'silence';
		this.currentIntensity = 0;
	}

	private getMouthOpenness(viseme: Viseme): number {
		const map: Record<Viseme, number> = {
			silence: 0.05, PP: 0.0, FF: 0.1, TH: 0.2, DD: 0.1,
			kk: 0.15, CH: 0.2, SS: 0.15, nn: 0.1, RR: 0.1,
			aa: 0.8, E: 0.5, I: 0.4, O: 0.5, U: 0.4, ae: 0.7, AH: 0.5,
		};
		return map[viseme] ?? 0.2;
	}

	private getMouthWidth(viseme: Viseme, emotion: string): number {
		const base: Record<Viseme, number> = {
			silence: 0.3, PP: 0.2, FF: 0.3, TH: 0.4, DD: 0.3,
			kk: 0.3, CH: 0.2, SS: 0.5, nn: 0.3, RR: 0.3,
			aa: 0.6, E: 0.7, I: 0.8, O: 0.3, U: 0.2, ae: 0.6, AH: 0.4,
		};
		const mod: Record<string, number> = {
			happy: 0.15, excited: 0.2, warm: 0.1, playful: 0.15,
			concerned: -0.1, calm: -0.05, neutral: 0,
		};
		return Math.max(0.1, Math.min(1, (base[viseme] ?? 0.3) + (mod[emotion] ?? 0)));
	}
}

export type GestureType = 'idle' | 'talking' | 'listening' | 'thinking' | 'happy' | 'error';

export interface Gesture {
	readonly type: GestureType;
	readonly duration: number;
	readonly loop: boolean;
	readonly intensity: number;
}

export class GestureSystem {
	private current: Gesture | null = null;
	private queue: Gesture[] = [];
	private startTime = 0;

	play(gesture: Gesture): void {
		this.current = gesture;
		this.startTime = Date.now();
	}

	enqueue(gesture: Gesture): void {
		this.queue.push(gesture);
	}

	update(): { gesture: Gesture | null; progress: number } {
		if (!this.current && this.queue.length > 0) {
			this.current = this.queue.shift() ?? null;
			this.startTime = Date.now();
		}
		if (!this.current) return { gesture: null, progress: 0 };

		const elapsed = Date.now() - this.startTime;
		const progress = Math.min(1, elapsed / this.current.duration);

		if (progress >= 1 && !this.current.loop) {
			this.current = null;
			return { gesture: null, progress: 0 };
		}
		return { gesture: this.current, progress };
	}

	stop(): void {
		this.current = null;
		this.queue = [];
	}

	static IDLE: Gesture = { type: 'idle', duration: 4000, loop: true, intensity: 0.3 };
	static TALKING: Gesture = { type: 'talking', duration: 2000, loop: true, intensity: 0.8 };
	static LISTENING: Gesture = { type: 'listening', duration: 3000, loop: true, intensity: 0.5 };
	static THINKING: Gesture = { type: 'thinking', duration: 2000, loop: true, intensity: 0.4 };
	static HAPPY: Gesture = { type: 'happy', duration: 1000, loop: false, intensity: 1.0 };
	static ERROR: Gesture = { type: 'error', duration: 1500, loop: false, intensity: 0.6 };
}

export class AvatarController {
	private visemeEngine: VisemeEngine;
	private gestureSystem: GestureSystem;
	private state: AvatarState;
	private running = false;
	private listeners = new Set<(state: AvatarState) => void>();

	constructor() {
		this.visemeEngine = new VisemeEngine();
		this.gestureSystem = new GestureSystem();
		this.state = this.visemeEngine.getState('neutral');
	}

	start(): void {
		if (this.running) return;
		this.running = true;
		this.gestureSystem.play(GestureSystem.IDLE);
		this.tick();
	}

	stop(): void {
		this.running = false;
		this.visemeEngine.reset();
		this.gestureSystem.stop();
	}

	processAudio(audioData: Float32Array): VisemeFrame[] {
		const frames = this.visemeEngine.processAudio(audioData, Date.now());
		this.state = this.visemeEngine.getState(this.state.emotion);
		return frames;
	}

	setEmotion(emotion: string): void {
		this.state = { ...this.state, emotion };
		this.notify();
	}

	setSpeaking(speaking: boolean): void {
		this.gestureSystem.play(speaking ? GestureSystem.TALKING : GestureSystem.IDLE);
		this.notify();
	}

	setListening(listening: boolean): void {
		this.gestureSystem.play(listening ? GestureSystem.LISTENING : GestureSystem.IDLE);
		this.state = { ...this.state, isListening: listening };
		this.notify();
	}

	playGesture(type: 'happy' | 'error' | 'thinking'): void {
		const map: Record<string, Gesture> = {
			happy: GestureSystem.HAPPY,
			error: GestureSystem.ERROR,
			thinking: GestureSystem.THINKING,
		};
		this.gestureSystem.play(map[type]);
	}

	getState(): AvatarState {
		return { ...this.state };
	}

	subscribe(fn: (state: AvatarState) => void): () => void {
		this.listeners.add(fn);
		return () => { this.listeners.delete(fn); };
	}

	private tick = (): void => {
		if (!this.running) return;
		const { gesture, progress } = this.gestureSystem.update();
		if (gesture) {
			this.state = {
				...this.state,
				breathPhase: progress,
				isSpeaking: gesture.type === 'talking',
			};
		}
		this.notify();
		requestAnimationFrame(this.tick);
	};

	private notify(): void {
		const s = this.getState();
		this.listeners.forEach((fn) => fn(s));
	}
}

let avatarInstance: AvatarController | null = null;

export function getAvatarController(): AvatarController {
	if (!avatarInstance) avatarInstance = new AvatarController();
	return avatarInstance;
}

export function resetAvatarController(): void {
	avatarInstance = null;
}
