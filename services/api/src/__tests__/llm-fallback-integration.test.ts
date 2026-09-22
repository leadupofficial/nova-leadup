/**
 * NOVA API — the secondary LLM provider, end to end through both entry points.
 *
 * `./llm-fallback.test.ts` covers the policy. This file covers the behaviour the
 * outage actually needs: the **real** `chatCompletion` (REST) and the **real**
 * `streamChatCompletion` (voice) transparently served by a second provider when
 * the primary is unusable — and *not* served by it when the failure is the
 * request's fault or when a side effect has already been committed.
 *
 * `vi.importActual` is used for `services/ai.js` because `./setup.ts` replaces
 * that module for the route suites; the retry decision lives inside
 * `chatCompletion`, so the real one is what has to run. Both providers are local
 * HTTP servers (`./helpers/fake-llm-providers.ts`), so nothing leaves the
 * machine and no model is called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../utils/logger.js';
import { toAssistantError } from '../services/assistant.js';
import { FALLBACK_PROVIDER_LABEL } from '../services/llm-fallback.js';
import type { ChatMessage } from '../services/ai.js';
import { streamChatCompletion } from '../realtime/llm.js';
import {
	FALLBACK_KEY,
	PRIMARY_KEY,
	fallbackReply,
	primaryReply,
	startFakeProvider,
	type FallbackPlan,
	type FakeProvider,
	type PrimaryPlan,
} from './helpers/fake-llm-providers.js';

let primaryPlan: PrimaryPlan = 'completion';
let fallbackPlan: FallbackPlan = 'openai-completion';
let primary: FakeProvider;
let fallback: FakeProvider;
let realAi: typeof import('../services/ai.js');

/**
 * Every name this file points at a fake provider, captured before any of them is
 * changed. Restoring them matters even though each file gets an isolated module
 * registry: a worker is reused across files, so a leaked `ANTHROPIC_BASE_URL`
 * would send a later suite's provider call to a server this file has closed.
 */
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

const ask = (): ChatMessage[] => [{ role: 'user', content: 'remind me to call the bank' }];

beforeAll(async () => {
	realAi = await vi.importActual<typeof import('../services/ai.js')>('../services/ai.js');

	primary = await startFakeProvider((body) => primaryReply(primaryPlan, body));
	fallback = await startFakeProvider((body, path) => fallbackReply(fallbackPlan, body, path));

	// `BROCODE_API_KEY` takes precedence over `ANTHROPIC_API_KEY` in
	// `getAnthropicHttpConfig()` and is read straight from `process.env`, so this
	// is what pins the credential the SDK actually sends — which lets the secret
	// assertions below name a value that really travelled.
	process.env.BROCODE_API_KEY = PRIMARY_KEY;
	process.env.ANTHROPIC_BASE_URL = primary.url;
	process.env.ANTHROPIC_API_KEY = PRIMARY_KEY;
	process.env.ANTHROPIC_AUTH_STYLE = 'api-key';
	process.env.ANTHROPIC_MODEL = 'primary-test-model';
	process.env.ANTHROPIC_REALTIME_MODEL = 'primary-test-model';
	process.env.LLM_FALLBACK_BASE_URL = fallback.url;
	process.env.LLM_FALLBACK_API_KEY = FALLBACK_KEY;
	process.env.LLM_FALLBACK_MODEL = 'fallback-model';
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
	primaryPlan = 'completion';
	fallbackPlan = 'openai-completion';
	primary.requests.length = 0;
	fallback.requests.length = 0;
	process.env.LLM_FALLBACK_PROTOCOL = 'openai';
	process.env.LLM_FALLBACK_AUTH_STYLE = 'bearer';
	vi.restoreAllMocks();
});

// ─── The REST path ──────────────────────────────────────────────────

describe('chatCompletion falls back only when the provider is unusable', () => {
	it('serves the turn from the fallback when the primary is out of credit', async () => {
		primaryPlan = 'credit';

		const result = await realAi.chatCompletion(ask());

		expect(result.content).toBe('Fallback answer.');
		expect(result.provider).toBe(FALLBACK_PROVIDER_LABEL);
		expect(result.fellBack).toBe(true);
		expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });

		// The primary was asked once, with the pinned credential; the fallback once,
		// with a Bearer credential and the OpenAI-compatible path.
		expect(primary.requests).toHaveLength(1);
		expect(primary.requests[0].headers['x-api-key']).toBe(PRIMARY_KEY);
		expect(fallback.requests).toHaveLength(1);
		expect(fallback.requests[0].path).toBe('/chat/completions');
		expect(fallback.requests[0].headers.authorization).toBe(`Bearer ${FALLBACK_KEY}`);
		expect(fallback.requests[0].body.model).toBe('fallback-model');
		// The system prompt moves into a leading system message, which is what an
		// OpenAI-compatible endpoint requires.
		expect(fallback.requests[0].body.messages[0].role).toBe('system');
	});

	it('serves the turn from the fallback when the primary answers 5xx', async () => {
		primaryPlan = 'server-error';

		const result = await realAi.chatCompletion(ask());

		expect(result.content).toBe('Fallback answer.');
		expect(result.fellBack).toBe(true);
		expect(fallback.requests.length).toBeGreaterThan(0);
	});

	it('does NOT fall back on a 400 — that is the request, not the provider', async () => {
		primaryPlan = 'bad-request';

		await expect(realAi.chatCompletion(ask())).rejects.toMatchObject({ status: 400 });
		expect(fallback.requests).toHaveLength(0);
	});

	it('surfaces the original error unchanged when no fallback is configured', async () => {
		primaryPlan = 'credit';
		const savedUrl = process.env.LLM_FALLBACK_BASE_URL;
		delete process.env.LLM_FALLBACK_BASE_URL;

		try {
			const err = await realAi.chatCompletion(ask()).catch((e) => e);
			expect(err).toBeInstanceOf(Error);
			expect(err.status).toBe(402);
			// Byte-for-byte the provider's own condition, and still classified as the
			// credit condition by the existing mapper — not a new crash shape.
			expect(String(err.message)).toContain('Insufficient Balance');
			expect(toAssistantError(err).code).toBe('AI_CREDIT_EXHAUSTED');
			expect(fallback.requests).toHaveLength(0);
		} finally {
			process.env.LLM_FALLBACK_BASE_URL = savedUrl;
		}
	});

	it('reports the primary provider when nothing failed', async () => {
		primaryPlan = 'completion';

		const result = await realAi.chatCompletion(ask());

		expect(result.content).toBe('Primary answer.');
		expect(result.provider).toBe('anthropic');
		expect(result.fellBack).toBe(false);
		expect(fallback.requests).toHaveLength(0);
	});

	it('speaks the Anthropic protocol, in /v1/messages, when the fallback is configured that way', async () => {
		primaryPlan = 'credit';
		process.env.LLM_FALLBACK_PROTOCOL = 'anthropic';
		process.env.LLM_FALLBACK_AUTH_STYLE = 'api-key';
		fallbackPlan = 'anthropic-completion';

		const result = await realAi.chatCompletion(ask());

		expect(result.content).toBe('Fallback answer.');
		expect(fallback.requests[0].path).toBe('/v1/messages');
		expect(fallback.requests[0].headers['x-api-key']).toBe(FALLBACK_KEY);
		expect(Array.isArray(fallback.requests[0].body.system)).toBe(true);
	});
});

// ─── The streaming (voice) path ─────────────────────────────────────

describe('streamChatCompletion and the first-token commit point', () => {
	it('retries on the fallback when the primary fails before any delta', async () => {
		primaryPlan = 'sse-error-before-delta';

		const deltas: string[] = [];
		const result = await streamChatCompletion(ask(), {}, (t) => deltas.push(t));

		expect(result.content).toBe('Fallback answer.');
		expect(result.provider).toBe(FALLBACK_PROVIDER_LABEL);
		expect(result.fellBack).toBe(true);
		expect(deltas.join('')).toBe('Fallback answer.');
		expect(fallback.requests).toHaveLength(1);
		expect(fallback.requests[0].body.stream).toBe(true);
	});

	it('retries on the fallback when the primary answers 402 before any delta', async () => {
		primaryPlan = 'credit';

		const result = await streamChatCompletion(ask(), {}, () => {});

		expect(result.content).toBe('Fallback answer.');
		expect(result.fellBack).toBe(true);
	});

	it('does NOT retry once a delta has been spoken, even though the provider failed', async () => {
		primaryPlan = 'sse-error-after-delta';

		const deltas: string[] = [];
		const err = await streamChatCompletion(ask(), {}, (t) => deltas.push(t)).catch((e) => e);

		// The user heard exactly the half sentence that was produced, once.
		expect(deltas).toEqual(['Half a sentence']);
		expect(fallback.requests).toHaveLength(0);
		expect(err.statusCode ?? err.status).toBe(502);
		expect(String(err.message)).toContain('relay died mid-stream');
	});

	it('streams from the primary when nothing fails', async () => {
		primaryPlan = 'sse-text';

		const deltas: string[] = [];
		const result = await streamChatCompletion(ask(), {}, (t) => deltas.push(t));

		expect(deltas).toEqual(['Hello from the primary.']);
		expect(result.provider).toBe('anthropic');
		expect(result.fellBack).toBe(false);
		expect(fallback.requests).toHaveLength(0);
	});
});

// ─── Secrets and observability ──────────────────────────────────────

describe('a credential never reaches a log line or an error body', () => {
	it('scrubs the credential out of a provider error body that echoes it', async () => {
		primaryPlan = 'credit';
		fallbackPlan = 'echo-credential-error';

		const err = await realAi.chatCompletion(ask()).catch((e) => e);
		expect(String(err.message)).toContain('Insufficient Balance');
		expect(String(err.message)).not.toContain(FALLBACK_KEY);
		// The credential really was on the wire, so the assertion above is about a
		// value that genuinely travelled rather than one that was never sent.
		expect(fallback.requests[0].headers.authorization).toBe(`Bearer ${FALLBACK_KEY}`);
	});

	it('logs which provider served the request, never the credential', async () => {
		const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
		primaryPlan = 'credit';

		await realAi.chatCompletion(ask());

		const lines = [...info.mock.calls, ...warn.mock.calls].map((call) => JSON.stringify(call[0] ?? {}));
		expect(lines.some((line) => line.includes(FALLBACK_PROVIDER_LABEL))).toBe(true);
		expect(lines.some((line) => line.includes('"fellBack":true'))).toBe(true);
		for (const line of lines) {
			expect(line).not.toContain(PRIMARY_KEY);
			expect(line).not.toContain(FALLBACK_KEY);
		}
	});
});
