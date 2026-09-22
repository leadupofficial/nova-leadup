/**
 * NOVA API — an answer with no answer in it is a failure, not a blank success.
 *
 * Measured defect: the configured fallback model (`glm-5.3`) is a **reasoning**
 * model. It emits `reasoning_content` next to `content`, and its reasoning tokens
 * are billed against `max_tokens`. With the 1024-token budget the voice path
 * passed, a non-trivial turn spent the whole budget thinking:
 *
 *     direct probe:  content len 0   reasoning len 3931
 *                    usage completion_tokens 1024, reasoning_tokens 1023
 *                    finish_reason "length"
 *
 * `mapOpenAIResult` correctly kept only `message.content` — the reasoning trace
 * was never leaked into the reply — but it turned "the model was cut off before
 * it said anything" into `content: ''`, and every caller treated that as a
 * successful turn. `/voice/chat` answered **HTTP 200 with an empty `text`**, and
 * a multi-turn scenario produced three consecutive blank assistant replies.
 *
 * These tests pin the two behaviours that were missing:
 *
 *   1. no usable content ⇒ a real, named error (never a 200 with `text: ''`),
 *      with truncation told apart from a provider that simply returned nothing;
 *   2. `reasoning_content` is never the reply — the visible `content` is, and a
 *      deliberately short answer like "Ok" still passes untruncated.
 *
 * The provider boundary is faked (local HTTP servers) and the **real**
 * `chatCompletion` / `streamChatCompletion` / `runAssistantToolLoop` run, so the
 * wire translation and the truncation classification are what is under test.
 * `vi.importActual` is needed because `./setup.ts` replaces `services/ai.js` for
 * the route suites.
 */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import './setup.js';
import app from '../server.js';
import { assistantErrorStatus, toAssistantError } from '../services/assistant.js';
import { FALLBACK_PROVIDER_LABEL } from '../services/llm-fallback.js';
import type { ChatMessage } from '../services/ai.js';
import { streamChatCompletion } from '../realtime/llm.js';
import {
	FALLBACK_KEY,
	PRIMARY_KEY,
	startFakeProvider,
	type FakeProvider,
} from './helpers/fake-llm-providers.js';

/** A marker that must never reach the user: it stands in for a reasoning trace. */
const REASONING_MARKER = 'SECRET-REASONING-TRACE-MUST-NOT-BE-SHOWN';

const ask = (): ChatMessage[] => [
	{ role: 'user', content: 'I have three things tomorrow: finish a proposal, call a client, and review a contract.' },
];

/** One OpenAI-compatible non-streaming body, exactly as the fallback sends it. */
function openAIBody(options: {
	content: string | null;
	finishReason: string;
	reasoning?: string | null;
	completionTokens?: number;
	reasoningTokens?: number;
}): Record<string, unknown> {
	const message: Record<string, unknown> = { role: 'assistant', content: options.content };
	// Key order is what the provider really sends: content, then reasoning_content.
	if (options.reasoning !== undefined) message.reasoning_content = options.reasoning;
	return {
		id: 'cmpl_reasoning',
		model: 'fallback-reasoning-model',
		choices: [{ index: 0, message, finish_reason: options.finishReason }],
		usage: {
			prompt_tokens: 61,
			completion_tokens: options.completionTokens ?? 1024,
			completion_tokens_details: { reasoning_tokens: options.reasoningTokens ?? 1023 },
		},
	};
}

/** The same condition on the wire, streamed: reasoning only, then `length`. */
function openAIStreamThatOnlyReasons(): string[] {
	return [
		`data: ${JSON.stringify({
			model: 'fallback-reasoning-model',
			choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning_content: REASONING_MARKER } }],
		})}\n\n`,
		`data: ${JSON.stringify({
			model: 'fallback-reasoning-model',
			choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
			usage: { prompt_tokens: 61, completion_tokens: 1024 },
		})}\n\n`,
		'data: [DONE]\n\n',
	];
}

let primary: FakeProvider;
let fallback: FakeProvider;
let realAi: typeof import('../services/ai.js');

let openAIReply: Record<string, unknown> = openAIBody({ content: 'Fallback answer.', finishReason: 'stop' });
let openAIStream: string[] = openAIStreamThatOnlyReasons();
/** `credit` makes the fallback serve the turn; `empty` answers nothing itself. */
let primaryMode: 'credit' | 'empty' = 'credit';

const TOUCHED = [
	'BROCODE_API_KEY',
	'ANTHROPIC_BASE_URL',
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_STYLE',
	'ANTHROPIC_MODEL',
	'ANTHROPIC_REALTIME_MODEL',
	'LLM_FALLBACK_BASE_URL',
	'LLM_FALLBACK_API_KEY',
	'LLM_FALLBACK_MODEL',
	'LLM_FALLBACK_AUTH_STYLE',
	'LLM_FALLBACK_PROTOCOL',
] as const;
const originalEnv: Record<string, string | undefined> = Object.fromEntries(
	TOUCHED.map((key) => [key, process.env[key]]),
);

beforeAll(async () => {
	realAi = await vi.importActual<typeof import('../services/ai.js')>('../services/ai.js');

	// The primary is out of credit, so every turn in this file is served by the
	// fallback — the provider the live defect was measured against. `primaryMode`
	// switches it to the Anthropic-protocol empty answer for one test; the base
	// URL cannot be swapped instead because `services/ai.ts` caches its client.
	primary = await startFakeProvider(() =>
		primaryMode === 'empty'
			? {
					status: 200,
					json: {
						id: 'msg_empty',
						type: 'message',
						role: 'assistant',
						model: 'primary-test-model',
						content: [],
						stop_reason: 'max_tokens',
						usage: { input_tokens: 61, output_tokens: 1024 },
					},
				}
			: { status: 402, json: { error: { message: 'Insufficient Balance', type: 'billing_error' } } },
	);
	fallback = await startFakeProvider((body) =>
		body?.stream === true ? { status: 200, sse: openAIStream } : { status: 200, json: openAIReply },
	);

	process.env.BROCODE_API_KEY = PRIMARY_KEY;
	process.env.ANTHROPIC_BASE_URL = primary.url;
	process.env.ANTHROPIC_API_KEY = PRIMARY_KEY;
	process.env.ANTHROPIC_AUTH_STYLE = 'api-key';
	process.env.ANTHROPIC_MODEL = 'primary-test-model';
	process.env.ANTHROPIC_REALTIME_MODEL = 'primary-test-model';
	process.env.LLM_FALLBACK_BASE_URL = fallback.url;
	process.env.LLM_FALLBACK_API_KEY = FALLBACK_KEY;
	process.env.LLM_FALLBACK_MODEL = 'fallback-reasoning-model';
	process.env.LLM_FALLBACK_AUTH_STYLE = 'bearer';
	process.env.LLM_FALLBACK_PROTOCOL = 'openai';
});

afterAll(async () => {
	await primary?.close();
	await fallback?.close();
	for (const key of TOUCHED) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
});

beforeEach(() => {
	primaryMode = 'credit';
	openAIReply = openAIBody({ content: 'Fallback answer.', finishReason: 'stop' });
	openAIStream = openAIStreamThatOnlyReasons();
	primary.requests.length = 0;
	fallback.requests.length = 0;
	vi.restoreAllMocks();
});

/** Runs a turn and hands back either the answer or the rejection. */
async function attempt(): Promise<{ content: string; stopReason: string | null } | { err: any }> {
	const outcome = await realAi.chatCompletion(ask()).then(
		(result) => ({ content: result.content, stopReason: result.stopReason }),
		(err: unknown) => ({ err }),
	);
	return outcome;
}

describe('a provider answer with no content is never a successful blank reply', () => {
	it('fails the turn when the model was cut off before answering (finish_reason: length)', async () => {
		// The measured live response: reasoning ate the whole budget, so the
		// provider returned `content: ""` with `finish_reason: "length"`.
		openAIReply = openAIBody({
			content: '',
			finishReason: 'length',
			reasoning: 'x'.repeat(3931),
			completionTokens: 1024,
			reasoningTokens: 1023,
		});

		const outcome = await attempt();

		// Not a resolved blank: the caller must be able to tell the client.
		expect(outcome).not.toHaveProperty('content');
		const err = (outcome as { err: any }).err;
		expect(err).toBeInstanceOf(Error);
		// The truncation is reported as truncation, not as an anonymous failure.
		expect(err.truncated).toBe(true);
		expect(err.stopReason).toBe('max_tokens');
		// ...and the wording names the condition the user is in.
		expect(String(err.message)).toMatch(/cut off|ran out|budget|room/i);
		expect(String(err.message).trim().length).toBeGreaterThan(10);

		// What the REST/socket layer turns this into: a 5xx with a stable code,
		// never a 200 carrying `text: ""`.
		const mapped = toAssistantError(err);
		expect(mapped.code).toBe('AI_EMPTY_REPLY');
		expect(assistantErrorStatus(mapped.code)).toBeGreaterThanOrEqual(500);
		expect(mapped.message).not.toMatch(/unexpected error/i);
	});

	it('fails the turn when the model returned nothing but claimed it stopped normally (finish_reason: stop)', async () => {
		openAIReply = openAIBody({ content: '', finishReason: 'stop', reasoning: 'x'.repeat(200), reasoningTokens: 9 });

		const outcome = await attempt();

		expect(outcome).not.toHaveProperty('content');
		const err = (outcome as { err: any }).err;
		expect(err).toBeInstanceOf(Error);
		// A provider that answered nothing and said it was finished is still a
		// failed turn — just not a truncation.
		expect(err.truncated).toBe(false);
		expect(String(err.message)).toMatch(/empty/i);
		expect(toAssistantError(err).code).toBe('AI_EMPTY_REPLY');
	});

	it('fails the turn when the only content is whitespace', async () => {
		openAIReply = openAIBody({ content: '\n\n   ', finishReason: 'stop' });

		const outcome = await attempt();

		expect(outcome).not.toHaveProperty('content');
		expect(toAssistantError((outcome as { err: any }).err).code).toBe('AI_EMPTY_REPLY');
	});

	it('fails an empty answer on the streaming/voice path too', async () => {
		// The realtime path streams SSE; a reasoning-only stream hands TTS nothing
		// and `runReply` would resolve `text: ''` — the same silent blank.
		openAIStream = openAIStreamThatOnlyReasons();

		const err = await streamChatCompletion(ask(), { systemPrompt: 'NOVA' }, () => undefined).then(
			() => null,
			(e: any) => e,
		);

		expect(err).toBeInstanceOf(Error);
		expect(err.truncated).toBe(true);
		expect(toAssistantError(err).code).toBe('AI_EMPTY_REPLY');
	});

	it('fails an empty answer from the primary provider, not just the fallback', async () => {
		// The same defect class on the Anthropic-protocol path: a 200 whose
		// `content` is empty. With no fallback configured there is nothing to
		// absorb it, so it must fail rather than resolve blank.
		primaryMode = 'empty';
		const savedFallbackUrl = process.env.LLM_FALLBACK_BASE_URL;
		delete process.env.LLM_FALLBACK_BASE_URL;

		try {
			const outcome = await attempt();
			expect(outcome).not.toHaveProperty('content');
			const err = (outcome as { err: any }).err;
			expect(err).toBeInstanceOf(Error);
			expect(err.truncated).toBe(true);
			expect(toAssistantError(err).code).toBe('AI_EMPTY_REPLY');
		} finally {
			process.env.LLM_FALLBACK_BASE_URL = savedFallbackUrl;
		}
	});
});

describe('reasoning is never the reply, and a real answer still gets through', () => {
	it('shows the visible content when the provider also sent a reasoning trace', async () => {
		openAIReply = openAIBody({
			content: 'Tuesday: proposal first, then the client call, then the contract.',
			finishReason: 'stop',
			reasoning: REASONING_MARKER,
			completionTokens: 842,
			reasoningTokens: 506,
		});

		const outcome = await attempt();

		expect(outcome).toHaveProperty('content');
		const result = outcome as { content: string; stopReason: string | null };
		// The *visible* content is the reply.
		expect(result.content).toBe('Tuesday: proposal first, then the client call, then the contract.');
		// The flattened reply and the block list carry no reasoning.
		expect(result.content).not.toContain(REASONING_MARKER);
		expect(JSON.stringify(await realAi.chatCompletion(ask()))).not.toContain(REASONING_MARKER);
	});

	it('lets a deliberately short answer through — one word is not truncation', async () => {
		openAIReply = openAIBody({ content: 'Ok', finishReason: 'stop', reasoning: 'x'.repeat(50), reasoningTokens: 8 });

		const outcome = await attempt();

		expect(outcome).toHaveProperty('content');
		// A two-character answer is a legitimate reply: the check is on emptiness
		// and on the provider's own finish reason, never on length.
		expect((outcome as { content: string }).content).toBe('Ok');
	});

	it('keeps a truncated answer that did contain text, and reports the truncation', async () => {
		openAIReply = openAIBody({
			content: 'Tuesday: start with the proposal, then',
			finishReason: 'length',
			reasoning: 'x'.repeat(3000),
		});

		const outcome = await attempt();

		expect(outcome).toHaveProperty('content');
		const result = outcome as { content: string; stopReason: string | null };
		expect(result.content).toBe('Tuesday: start with the proposal, then');
		// `finish_reason: length` reaches the caller instead of being dropped.
		expect(result.stopReason).toBe('max_tokens');
	});

	it('reports a normal finish reason as end_turn, so truncation is distinguishable', async () => {
		openAIReply = openAIBody({ content: 'All done.', finishReason: 'stop' });

		const outcome = await attempt();

		expect((outcome as { stopReason: string | null }).stopReason).toBe('end_turn');
	});
});

describe('the reasoning budget is configured, not guessed per call site', () => {
	it('exposes one reasoning-sized ceiling that every chat path shares', () => {
		// `glm-5.3` spent 1023 of a 1024-token budget on `reasoning_content` and
		// was then cut off before writing a word. The ceiling must leave room for
		// both legs of the reply.
		const budget = (realAi as unknown as { defaultMaxOutputTokens?: () => number }).defaultMaxOutputTokens?.();

		expect(typeof budget).toBe('number');
		expect(budget).toBeGreaterThanOrEqual(2048);
		// Bounded on purpose: this is a cost/DoS ceiling, not "as much as you like".
		expect(budget).toBeLessThanOrEqual(32768);
	});

	it('sends that ceiling from the live /voice/chat route', async () => {
		const { chatCompletion } = await import('../services/ai.js');
		const mocked = vi.mocked(chatCompletion);
		mocked.mockClear();

		const token = jwt.sign(
			{ sub: 'user-empty-reply', email: 'empty@example.com', role: 'user' },
			process.env.JWT_SECRET!,
			{ expiresIn: '1h' },
		);
		const res = await request(app)
			.post('/api/v1/voice/chat')
			.set({ Authorization: `Bearer ${token}` })
			.send({ messages: [{ role: 'user', content: 'Plan my Tuesday.' }], language: 'en' });

		expect(res.status).toBe(200);
		// The route under test is the one the blank replies were measured on.
		const sent = mocked.mock.calls[0]?.[1] as { maxTokens?: number } | undefined;
		expect(sent?.maxTokens).toBeGreaterThanOrEqual(2048);
	});

	it('uses the same ceiling on the realtime/streaming path', async () => {
		openAIStream = [
			`data: ${JSON.stringify({ model: 'fallback-reasoning-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello ' } }] })}\n\n`,
			`data: ${JSON.stringify({ model: 'fallback-reasoning-model', choices: [{ index: 0, delta: { content: 'there.' }, finish_reason: 'stop' }] })}\n\n`,
			'data: [DONE]\n\n',
		];

		await streamChatCompletion(ask(), { systemPrompt: 'NOVA' }, () => undefined);

		const sent = fallback.requests.at(-1)?.body?.max_tokens;
		expect(typeof sent).toBe('number');
		expect(sent).toBeGreaterThanOrEqual(2048);
		expect(sent).toBeLessThanOrEqual(32768);
	});

	it('leaves no chat call site pinned to a sub-reasoning ceiling', async () => {
		// The defect was one hard-coded `maxTokens: 1024` in `routes/voice.ts`,
		// but the same literal sat on five more turn-producing call sites. This is
		// the check that the fix was consistent rather than a one-off.
		const callSites = [
			'routes/voice.ts',
			'routes/chat.ts',
			'routes/conversations.ts',
			'routes/streaming.ts',
			'routes/ai.ts',
			'realtime/reply.ts',
			'realtime/llm.ts',
		];
		const offenders: string[] = [];

		for (const file of callSites) {
			const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
			for (const match of source.matchAll(/maxTokens:\s*(\d[\d_]*)/g)) {
				const value = Number(match[1].replace(/_/g, ''));
				if (value < 2048) offenders.push(`${file}: maxTokens: ${value}`);
			}
		}

		expect(offenders).toEqual([]);
	});
});

describe('the fallback really served these turns', () => {
	it('routes them through the secondary provider, as the live defect did', async () => {
		openAIReply = openAIBody({ content: 'Fallback answer.', finishReason: 'stop' });

		const result = await realAi.chatCompletion(ask());

		expect(result.provider).toBe(FALLBACK_PROVIDER_LABEL);
		expect(result.fellBack).toBe(true);
		expect(fallback.requests.length).toBeGreaterThan(0);
	});
});
