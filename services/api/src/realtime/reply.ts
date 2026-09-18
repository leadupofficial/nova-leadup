/**
 * NOVA API — one spoken reply: LLM tokens → sentences → streamed speech.
 *
 * Extracted from `session.ts` so the socket/session state machine and the reply
 * pipeline stay readable. The session owns the connection and the STT socket;
 * this module owns everything between "the user said something" and "the reply
 * has been spoken".
 *
 * Grounding is identical to the REST voice route — `buildUserContext` +
 * `composeSystemPrompt` + `runStreamingAssistantLoop` — so a spoken
 * "remind me to…" still creates a reminder.
 *
 * Latency trick: the model's tokens are buffered by `SentenceChunker` and each
 * completed sentence goes straight to streaming TTS while the model keeps
 * generating. Sentence audio is emitted strictly in order through one promise
 * chain, so playback order always matches text order.
 */
import { getLanguageByCode } from '@nova/shared-types';
import { buildUserContext, composeSystemPrompt } from '../services/user-context.js';
import { logger } from '../utils/logger.js';
import { ASSISTANT_TOOLS_PROMPT } from '../services/assistant-tools.js';
import { buildSystemPromptForLanguage } from '../routes/voice.js';
import type { ChatMessage } from '../services/ai.js';
import type { ExecutedToolCall } from '../services/assistant-tool-executor.js';
import { SentenceChunker } from './sentence-chunker.js';
import { openSpeechStream, toSpeakableText } from './tts.js';
import { isAbortError } from './llm.js';
import { runStreamingAssistantLoop } from './tool-loop.js';

export interface ReplyHandlers {
	/** A model delta. */
	onToken(text: string): void;
	/** A sentence being handed to TTS (already stripped of Markdown). */
	onSentence(text: string, index: number): void;
	/** One MP3 chunk. Awaited, so the caller can apply socket backpressure. */
	onAudio(chunk: Uint8Array): Promise<void>;
	/** Called once per reply if a sentence could not be synthesised. */
	onTtsError(err: unknown): void;
	/**
	 * Called at most once per reply when the primary TTS provider refused the
	 * turn and the Deepgram cloud voice is speaking it instead. Absent for
	 * languages Deepgram does not cover (it ships no Indic voices), where the
	 * client's device voice is the only remaining option.
	 */
	onTtsFallback?(info: { from: string; to: string; reason: string }): void;
	/** True once the caller has cancelled this reply. */
	isCancelled(): boolean;
}

export interface ReplyOptions {
	userId: string;
	/** Bare language code (`en`, `ta`, …) or `auto`. */
	language: string;
	/** Conversation so far, oldest first. */
	history: ChatMessage[];
	userText: string;
	signal: AbortSignal;
	handlers: ReplyHandlers;
}

export interface ReplyResult {
	text: string;
	model: string;
	usage: { inputTokens: number; outputTokens: number };
	toolCalls: ExecutedToolCall[];
	iterations: number;
	capped: boolean;
}

function abortError(): Error {
	const err = new Error('reply cancelled');
	err.name = 'AbortError';
	return err;
}

/**
 * Runs one complete reply and resolves once every sentence's audio has been
 * forwarded. Throws an `AbortError` if the signal is aborted at any await point,
 * which the session treats as a barge-in/cancel rather than a failure.
 */
export async function runReply(options: ReplyOptions): Promise<ReplyResult> {
	const { handlers, signal } = options;

	const chunker = new SentenceChunker();
	let streamed = '';
	let sentenceIndex = 0;
	let ttsErrorReported = false;
	/** Mirror of `ttsErrorReported` for the Deepgram-fallback notice. */
	let ttsFallbackReported = false;
	/** Serialises sentence synthesis so audio is emitted in text order. */
	let ttsChain: Promise<void> = Promise.resolve();

	const check = (): void => {
		if (signal.aborted) throw abortError();
	};

	const enqueue = (sentence: string): void => {
		// Nothing speakable (emoji-only, or gone after stripping Markdown):
		// skip it without consuming a sentence index or calling the provider.
		const speakable = toSpeakableText(sentence);
		if (!speakable) return;

		const index = sentenceIndex++;
		ttsChain = ttsChain.then(async () => {
			if (signal.aborted) return;
			handlers.onSentence(speakable, index);
			try {
				const body = await openSpeechStream({
					text: speakable,
					language: options.language,
					signal,
					onFallback: (info) => {
						// The primary fails on every sentence while it is down, so
						// report the switch once rather than once per sentence.
						if (ttsFallbackReported) return;
						ttsFallbackReported = true;
						handlers.onTtsFallback?.(info);
					},
				});
				const reader = body.getReader();
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						if (!value?.length) continue;
						if (signal.aborted) return;
						await handlers.onAudio(value);
					}
				} finally {
					// Releasing the reader lets the upstream fetch unwind promptly
					// when the turn was cancelled mid-sentence.
					reader.cancel().catch(() => undefined);
				}
			} catch (err) {
				// A single failed sentence must not silence the rest of the
				// reply: report it once and carry on with the next one.
				if (isAbortError(err) || signal.aborted) return;
				if (!ttsErrorReported) {
					ttsErrorReported = true;
					handlers.onTtsError(err);
				}
			}
		});
	};

	check();

	// Timed because this sits in front of the model on every spoken turn, so its
	// cost is added directly to how long the user waits for a reply.
	const contextStartedAt = Date.now();
	const context = await buildUserContext(options.userId);
	const contextMs = Date.now() - contextStartedAt;
	check();

	const languageInfo = getLanguageByCode(options.language);
	const systemPrompt = composeSystemPrompt({
		basePrompt: buildSystemPromptForLanguage(options.language),
		context: context.text,
		capabilities: ASSISTANT_TOOLS_PROMPT,
		language: options.language,
		languageName: languageInfo?.name,
		languageNative: languageInfo?.native,
	});

	const messages: ChatMessage[] = [...options.history, { role: 'user', content: options.userText }];
	const modelStartedAt = Date.now();
	let firstTokenMs: number | null = null;
	const result = await runStreamingAssistantLoop(
		options.userId,
		messages,
		{ systemPrompt, maxTokens: 1024, temperature: 0.7, signal },
		(delta) => {
			if (firstTokenMs === null) firstTokenMs = Date.now() - modelStartedAt;
			streamed += delta;
			handlers.onToken(delta);
			for (const sentence of chunker.push(delta)) enqueue(sentence);
		},
	);

	check();
	logger.info(
		{
			userId: options.userId,
			contextMs,
			groundedChars: context.text.length,
			firstTokenMs,
			modelMs: Date.now() - modelStartedAt,
		},
		'Realtime turn timings',
	);
	const tail = chunker.flush();
	if (tail) enqueue(tail);
	await ttsChain;
	check();

	return {
		text: streamed || result.content,
		model: result.model,
		usage: result.usage,
		toolCalls: result.toolCalls,
		iterations: result.iterations,
		capped: result.capped,
	};
}
