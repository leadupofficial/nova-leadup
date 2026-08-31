/**
 * LEA-008 — Voice Provider Engine
 *
 * Interfaces and implementations for voice providers (ElevenLabs, Sarvam),
 * session management, and audio level detection for avatar sync.
 *
 * Per blueprint Section 8 (Voice & Language Architecture).
 */

import type {
	VoiceProvider,
	VoiceProviderConfig,
	STTRequest,
	STTResponse,
	TTSRequest,
	TTSResponse,
	RealtimeVoiceSession,
	VoiceSession,
	AudioLevelData,
} from '@nova/shared-types';

// ─── VoiceProvider base interface ─────────────────────────────────────────────

export interface IVoiceProvider {
	readonly name: string;
	readonly provider: VoiceProvider;
	isConfigured(): boolean;
	transcribe(request: STTRequest): Promise<STTResponse>;
	synthesize(request: TTSRequest): Promise<TTSResponse>;
	healthCheck(): Promise<{ status: 'ok' | 'error'; detail?: string }>;
}

// ─── ElevenLabs Provider ──────────────────────────────────────────────────────

const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

export interface ElevenLabsConfig extends VoiceProviderConfig {
	readonly modelId?: string;
}

export class ElevenLabsProvider implements IVoiceProvider {
	readonly name = 'elevenlabs';
	readonly provider: VoiceProvider = 'elevenlabs';
	private apiKey: string;
	private baseUrl: string;
	private voiceId: string;
	private modelId: string;

	constructor(config: ElevenLabsConfig) {
		this.apiKey = config.apiKey;
		this.baseUrl = config.baseUrl ?? ELEVENLABS_API_URL;
		this.voiceId = config.voiceId ?? 'default';
		this.modelId = config.modelId ?? 'eleven_multilingual_v2';
	}

	isConfigured(): boolean {
		return Boolean(this.apiKey);
	}

	async transcribe(_request: STTRequest): Promise<STTResponse> {
		// ElevenLabs STT via their speech-to-text API
		// MVP: stub — production: POST /v1/speech-to-text
		if (!this.isConfigured()) {
			throw new Error('ElevenLabs API key not configured');
		}

		throw new Error('ElevenLabs STT not yet implemented — use Sarvam for STT');
	}

	async synthesize(request: TTSRequest): Promise<TTSResponse> {
		if (!this.isConfigured()) {
			return this.stubSynthesize(request);
		}

		try {
			const response = await fetch(`${this.baseUrl}/text-to-speech/${request.voiceId}`, {
				method: 'POST',
				headers: {
					'Accept': 'audio/mpeg',
					'Content-Type': 'application/json',
					'xi-api-key': this.apiKey,
				},
				body: JSON.stringify({
					text: request.text,
					model_id: request.language === 'ta' ? 'eleven_multilingual_v2' : this.modelId,
					voice_settings: {
						stability: request.stability ?? 0.5,
						speed: request.speed ?? 1.0,
					},
				}),
			});

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`ElevenLabs TTS error ${response.status}: ${body}`);
			}

			const buffer = Buffer.from(await response.arrayBuffer());
			return {
				audioBuffer: buffer,
				contentType: 'audio/mpeg',
				durationMs: Math.round(buffer.length / 16), // rough estimate for mp3
				provider: 'elevenlabs',
			};
		} catch (error) {
			console.error('[elevenlabs] TTS failed, falling back to stub:', error);
			return this.stubSynthesize(request);
		}
	}

	async healthCheck(): Promise<{ status: 'ok' | 'error'; detail?: string }> {
		if (!this.isConfigured()) {
			return { status: 'error', detail: 'API key not configured' };
		}
		try {
			const response = await fetch(`${this.baseUrl}/voices`, {
				headers: { 'xi-api-key': this.apiKey },
			});
			return response.ok ? { status: 'ok' } : { status: 'error', detail: `HTTP ${response.status}` };
		} catch (error) {
			return { status: 'error', detail: error instanceof Error ? error.message : 'unknown' };
		}
	}

	private stubSynthesize(_request: TTSRequest): TTSResponse {
		const silentBuffer = Buffer.alloc(1024, 0);
		return {
			audioBuffer: silentBuffer,
			contentType: 'audio/mpeg',
			durationMs: 500,
			provider: 'elevenlabs-stub',
		};
	}
}

// ─── Sarvam Provider ──────────────────────────────────────────────────────────

const SARVAM_API_URL = 'https://api.sarvam.ai/v1';

export interface SarvamConfig extends VoiceProviderConfig {
	readonly sttModel?: string;
	readonly ttsModel?: string;
}

export class SarvamProvider implements IVoiceProvider {
	readonly name = 'sarvam';
	readonly provider: VoiceProvider = 'sarvam';
	private apiKey: string;
	private baseUrl: string;
	private sttModel: string;
	private ttsModel: string;

	constructor(config: SarvamConfig) {
		this.apiKey = config.apiKey;
		this.baseUrl = config.baseUrl ?? SARVAM_API_URL;
		this.sttModel = config.sttModel ?? 'saarika:v2.5';
		this.ttsModel = config.ttsModel ?? 'bulbul:v2';
	}

	isConfigured(): boolean {
		return Boolean(this.apiKey);
	}

	async transcribe(request: STTRequest): Promise<STTResponse> {
		if (!this.isConfigured()) {
			return this.stubTranscribe(request);
		}

		const languageMap: Record<string, string> = {
			en: 'en-IN',
			ta: 'ta-IN',
			tanglish: 'ta-IN',
		};
		const sarvamLang = languageMap[request.language] ?? 'en-IN';

		try {
			const audioBlob = new Blob([new Uint8Array(request.audioBuffer)]);
			const formData = new FormData();
			formData.append('file', audioBlob, 'audio.webm');
			formData.append('language_code', sarvamLang);
			formData.append('model', this.sttModel);

			const response = await fetch(`${this.baseUrl}/speech-to-text`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.apiKey}`,
					'Accept': 'application/json',
				},
				body: formData,
			});

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`Sarvam STT error ${response.status}: ${body}`);
			}

			const data = await response.json();
			return {
				transcript: data.transcript ?? '',
				isFinal: true,
				confidence: data.confidence ?? 0.8,
				language: data.language_code ?? sarvamLang,
			};
		} catch (error) {
			console.error('[sarvam] STT failed, falling back to stub:', error);
			return this.stubTranscribe(request);
		}
	}

	async synthesize(request: TTSRequest): Promise<TTSResponse> {
		if (!this.isConfigured()) {
			return this.stubSynthesize(request);
		}

		const languageMap: Record<string, string> = {
			en: 'en-IN',
			ta: 'ta-IN',
		};
		const sarvamLang = languageMap[request.language ?? 'en'] ?? 'en-IN';

		try {
			const response = await fetch(`${this.baseUrl}/text-to-speech`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.apiKey}`,
				},
				body: JSON.stringify({
					inputs: [request.text],
					target_language_code: sarvamLang,
					model: this.ttsModel,
					speaker: 'meera',
					speed: request.speed ?? 1.0,
				}),
			});

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`Sarvam TTS error ${response.status}: ${body}`);
			}

			const data = await response.json();
			const audioBase64 = data.audios?.[0] ?? data.audio;
			const buffer = audioBase64 ? Buffer.from(audioBase64, 'base64') : Buffer.alloc(1024, 0);

			return {
				audioBuffer: buffer,
				contentType: 'audio/wav',
				durationMs: data.duration ?? 1000,
				provider: 'sarvam',
			};
		} catch (error) {
			console.error('[sarvam] TTS failed, falling back to stub:', error);
			return this.stubSynthesize(request);
		}
	}

	async healthCheck(): Promise<{ status: 'ok' | 'error'; detail?: string }> {
		if (!this.isConfigured()) {
			return { status: 'error', detail: 'API key not configured' };
		}
		try {
			const response = await fetch(`${this.baseUrl}/models`, {
				headers: { 'Authorization': `Bearer ${this.apiKey}` },
			});
			return response.ok ? { status: 'ok' } : { status: 'error', detail: `HTTP ${response.status}` };
		} catch (error) {
			return { status: 'error', detail: error instanceof Error ? error.message : 'unknown' };
		}
	}

	private stubTranscribe(request: STTRequest): STTResponse {
		const label = request.language === 'ta' ? '[Tamil]' : request.language === 'tanglish' ? '[Tanglish]' : '[English]';
		return {
			transcript: `${label} [stub transcript for session ${request.sessionId}]`,
			isFinal: true,
			confidence: 0.7,
			language: request.language,
		};
	}

	private stubSynthesize(_request: TTSRequest): TTSResponse {
		return {
			audioBuffer: Buffer.alloc(1024, 0),
			contentType: 'audio/wav',
			durationMs: 500,
			provider: 'sarvam-stub',
		};
	}
}

// ─── VoiceProviderFactory ─────────────────────────────────────────────────────

export interface VoiceProviderFactoryOptions {
	readonly elevenlabsApiKey?: string;
	readonly sarvamApiKey?: string;
	readonly defaultProvider?: VoiceProvider;
}

export class VoiceProviderFactory {
	private readonly providers = new Map<VoiceProvider, IVoiceProvider>();

	constructor(options: VoiceProviderFactoryOptions = {}) {
		if (options.elevenlabsApiKey) {
			this.providers.set('elevenlabs', new ElevenLabsProvider({ apiKey: options.elevenlabsApiKey, provider: "elevenlabs" }));
		}
		if (options.sarvamApiKey) {
			this.providers.set('sarvam', new SarvamProvider({ apiKey: options.sarvamApiKey, provider: "sarvam" }));
		}
	}

	getProvider(name: VoiceProvider): IVoiceProvider | undefined {
		return this.providers.get(name);
	}

	getDefaultProvider(): IVoiceProvider | undefined {
		return this.providers.get('sarvam') ?? this.providers.get('elevenlabs');
	}

	registerProvider(provider: IVoiceProvider): void {
		this.providers.set(provider.provider, provider);
	}
}

// ─── VoiceSession ─────────────────────────────────────────────────────────────

export interface VoiceSessionOptions {
	readonly userId: string;
	readonly provider: VoiceProvider;
	readonly config: VoiceProviderConfig;
}

/**
 * VoiceSessionManager manages a single voice conversation session.
 *
 * Tracks transcript buffer, audio level, and session lifecycle.
 */
export class VoiceSessionManager {
	private readonly sessionId: string;
	private readonly userId: string;
	private readonly provider: VoiceProvider;
	private readonly config: VoiceProviderConfig;
	private status: VoiceSession['status'] = 'connecting';
	private transcriptBuffer: STTResponse[] = [];
	private audioLevel: number = 0;
	private readonly startedAt: Date;
	private endedAt: Date | null = null;
	private readonly maxTranscriptBuffer = 200;

	constructor(options: VoiceSessionOptions) {
		this.sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.userId = options.userId;
		this.provider = options.provider;
		this.config = options.config;
		this.startedAt = new Date();
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getStatus(): VoiceSession['status'] {
		return this.status;
	}

	getTranscriptBuffer(): readonly STTResponse[] {
		return [...this.transcriptBuffer];
	}

	getAudioLevel(): number {
		return this.audioLevel;
	}

	getDurationMs(): number {
		const end = this.endedAt ?? new Date();
		return end.getTime() - this.startedAt.getTime();
	}

	start(): void {
		this.status = 'active';
	}

	addTranscript(response: STTResponse): void {
		this.transcriptBuffer.push(response);
		if (this.transcriptBuffer.length > this.maxTranscriptBuffer) {
			this.transcriptBuffer = this.transcriptBuffer.slice(-this.maxTranscriptBuffer);
		}
	}

	updateAudioLevel(level: number): void {
		this.audioLevel = Math.max(0, Math.min(1, level));
	}

	end(): void {
		this.status = 'ended';
		this.endedAt = new Date();
	}

	error(message?: string): void {
		this.status = 'error';
		this.endedAt = new Date();
		if (message) {
			console.error(`[voice:${this.sessionId}] Session error: ${message}`);
		}
	}

	getFullTranscript(): string {
		return this.transcriptBuffer.map((t) => t.transcript).join(' ');
	}

	snapshot(): VoiceSession {
		return {
			sessionId: this.sessionId,
			userId: this.userId,
			provider: this.provider,
			config: this.config,
			status: this.status,
			transcriptBuffer: [...this.transcriptBuffer],
			audioLevel: this.audioLevel,
			startedAt: this.startedAt,
			endedAt: this.endedAt ?? undefined,
		};
	}
}

// ─── AudioLevelDetector ───────────────────────────────────────────────────────

export interface AudioLevelDetectorOptions {
	readonly smoothing?: number;
	readonly minThreshold?: number;
	readonly maxLevel?: number;
}

/**
 * Realtime audio level detector for avatar synchronization.
 *
 * Computes RMS amplitude from PCM samples, applies smoothing for natural
 * avatar animation, and emits level updates suitable for driving the
 * avatar's setAudioLevel().
 */
export class AudioLevelDetector {
	private readonly smoothing: number;
	private readonly minThreshold: number;
	private readonly maxLevel: number;
	private smoothedLevel: number = 0;
	private peakLevel: number = 0;
	private sampleBuffer: number[] = [];
	private readonly maxBufferSize = 1024;

	constructor(options: AudioLevelDetectorOptions = {}) {
		this.smoothing = options.smoothing ?? 0.8;
		this.minThreshold = options.minThreshold ?? 0.01;
		this.maxLevel = options.maxLevel ?? 1.0;
	}

	/**
	 * Feed audio samples (PCM float32, -1.0 to 1.0) into the detector.
	 */
	feed(samples: Float32Array | number[]): AudioLevelData {
		this.sampleBuffer.push(...samples);
		while (this.sampleBuffer.length > this.maxBufferSize) {
			this.sampleBuffer.shift();
		}

		const rms = this.computeRMS(this.sampleBuffer);
		const peak = this.computePeak(this.sampleBuffer);

		this.smoothedLevel = this.smoothedLevel * this.smoothing + rms * (1 - this.smoothing);
		const level = Math.max(this.minThreshold, Math.min(this.maxLevel, this.smoothedLevel));

		if (peak > this.peakLevel) {
			this.peakLevel = peak;
		} else {
			this.peakLevel = this.peakLevel * 0.995;
		}

		return {
			level,
			peak: this.peakLevel,
			rms,
			timestamp: Date.now(),
		};
	}

	reset(): void {
		this.smoothedLevel = 0;
		this.peakLevel = 0;
		this.sampleBuffer = [];
	}

	getCurrentLevel(): number {
		return this.smoothedLevel;
	}

	getPeakLevel(): number {
		return this.peakLevel;
	}

	private computeRMS(samples: number[]): number {
		if (samples.length === 0) return 0;
		let sum = 0;
		for (let i = 0; i < samples.length; i++) {
			sum += samples[i]! * samples[i]!;
		}
		return Math.sqrt(sum / samples.length);
	}

	private computePeak(samples: number[]): number {
		if (samples.length === 0) return 0;
		let max = 0;
		for (let i = 0; i < samples.length; i++) {
			const abs = Math.abs(samples[i]!);
			if (abs > max) max = abs;
		}
		return max;
	}
}
