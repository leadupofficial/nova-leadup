/**
 * NOVA API — the secondary LLM provider: policy and configuration.
 *
 * The configured relay answered `402 Insufficient Balance` for every request for
 * hours and every assistant turn failed, because nothing on the chat-model path
 * had a fallback. These tests pin *when* it may be used, and the two things it
 * must never do:
 *
 *   * retry a request the provider rejected as malformed (`400`), or one this
 *     service raised itself, because that wastes money and hides bugs;
 *   * retry anything once the turn has executed a tool or spoken a token,
 *     because `runAssistantToolLoop` writes reminders and tasks as it goes and a
 *     retry could write the same reminder twice.
 *
 * The end-to-end behaviour (both entry points against two local providers) lives
 * in `./llm-fallback-integration.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	FALLBACK_PROVIDER_LABEL,
	ProviderRequestError,
	getLlmFallbackConfig,
	isProviderUnusableFailure,
	redactSecret,
	shouldUseFallback,
} from '../services/llm-fallback.js';
import { toOpenAIMessages, toOpenAITools } from '../services/llm-transport.js';
import { chatCompletion, type ChatCompletionResult } from '../services/ai.js';
import { FALLBACK_KEY } from './helpers/fake-llm-providers.js';

// ─── When a provider failure may be retried on the fallback ─────────

describe('when a provider failure may be retried on the fallback', () => {
	it('treats the credit/billing condition as the provider being unusable', () => {
		expect(isProviderUnusableFailure({ status: 402, message: 'Payment Required' })).toBe(true);
		expect(isProviderUnusableFailure(new Error('Insufficient Balance'))).toBe(true);
		expect(isProviderUnusableFailure(new Error('{"type":"billing_error"}'))).toBe(true);
	});

	it('treats 5xx, timeouts, connection failures and a dead stream as the provider being unusable', () => {
		expect(isProviderUnusableFailure({ status: 500, message: 'boom' })).toBe(true);
		expect(isProviderUnusableFailure({ status: 503, message: 'unavailable' })).toBe(true);
		const abort = new Error('This operation was aborted');
		abort.name = 'AbortError';
		expect(isProviderUnusableFailure(abort)).toBe(true);
		expect(
			isProviderUnusableFailure(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })),
		).toBe(true);
		// The provider accepted the request, started streaming, then aborted it.
		expect(isProviderUnusableFailure(new ProviderRequestError('llm-fallback', 'stream', null, 'died'))).toBe(true);
	});

	it('refuses a request error, a provider auth failure, and anything our own code raised', () => {
		// The provider read the request and rejected it: retrying elsewhere would
		// fail identically and cost money.
		expect(isProviderUnusableFailure({ status: 400, message: 'max_tokens must be positive' })).toBe(false);
		expect(isProviderUnusableFailure({ status: 422, message: 'invalid tool schema' })).toBe(false);
		expect(isProviderUnusableFailure({ status: 404, message: 'model not found' })).toBe(false);
		// A credential or configuration problem for *that* provider: the operator
		// must see it rather than have it masked.
		expect(isProviderUnusableFailure({ status: 401, message: 'invalid x-api-key' })).toBe(false);
		expect(isProviderUnusableFailure({ status: 403, message: 'forbidden' })).toBe(false);
		// Raised by this service, before any provider call.
		expect(
			isProviderUnusableFailure(new Error('Neither BROCODE_API_KEY nor ANTHROPIC_API_KEY is configured')),
		).toBe(false);
		expect(isProviderUnusableFailure(new Error('Request contains a jailbreak attempt and was blocked'))).toBe(false);
	});

	it('refuses every retry once the turn has committed a side effect or emitted output', () => {
		// This is the duplicate-side-effect rule: `retrySafe` false means the turn
		// has already executed a tool or spoken a token.
		expect(shouldUseFallback(new Error('Insufficient Balance'), false)).toBe(false);
		expect(shouldUseFallback({ status: 500, message: 'boom' }, false)).toBe(false);
		// ...and the same failure is retryable before anything has been committed.
		expect(shouldUseFallback(new Error('Insufficient Balance'), true)).toBe(true);
		expect(shouldUseFallback({ status: 500, message: 'boom' }, true)).toBe(true);
	});
});

// ─── Configuration ──────────────────────────────────────────────────

describe('the fallback configuration', () => {
	const KEYS = [
		'LLM_FALLBACK_BASE_URL',
		'LLM_FALLBACK_API_KEY',
		'LLM_FALLBACK_MODEL',
		'LLM_FALLBACK_AUTH_STYLE',
		'LLM_FALLBACK_PROTOCOL',
	] as const;
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
	});

	afterEach(() => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	it('is unconfigured while either the URL or the key is missing', () => {
		delete process.env.LLM_FALLBACK_BASE_URL;
		delete process.env.LLM_FALLBACK_API_KEY;
		expect(getLlmFallbackConfig('primary-model')).toBeNull();

		process.env.LLM_FALLBACK_BASE_URL = 'https://fallback.example/v1';
		expect(getLlmFallbackConfig('primary-model')).toBeNull();

		delete process.env.LLM_FALLBACK_BASE_URL;
		process.env.LLM_FALLBACK_API_KEY = 'k'.repeat(20);
		expect(getLlmFallbackConfig('primary-model')).toBeNull();

		// A blank value means the same as absent, which is what a placeholder line
		// in `.env` produces.
		process.env.LLM_FALLBACK_BASE_URL = '   ';
		expect(getLlmFallbackConfig('primary-model')).toBeNull();
	});

	it('defaults to an OpenAI-compatible endpoint and inherits the primary model', () => {
		process.env.LLM_FALLBACK_BASE_URL = 'https://fallback.example/v1';
		process.env.LLM_FALLBACK_API_KEY = 'k'.repeat(20);
		delete process.env.LLM_FALLBACK_PROTOCOL;
		delete process.env.LLM_FALLBACK_AUTH_STYLE;
		delete process.env.LLM_FALLBACK_MODEL;

		expect(getLlmFallbackConfig('primary-model')).toMatchObject({
			label: FALLBACK_PROVIDER_LABEL,
			protocol: 'openai',
			authStyle: 'bearer',
			model: 'primary-model',
		});
	});

	it('infers the Anthropic protocol from an api-key auth style, and honours explicit values', () => {
		process.env.LLM_FALLBACK_BASE_URL = 'https://fallback.example';
		process.env.LLM_FALLBACK_API_KEY = 'k'.repeat(20);
		delete process.env.LLM_FALLBACK_PROTOCOL;
		process.env.LLM_FALLBACK_AUTH_STYLE = 'api-key';
		expect(getLlmFallbackConfig('primary-model')).toMatchObject({
			protocol: 'anthropic',
			authStyle: 'api-key',
		});

		process.env.LLM_FALLBACK_PROTOCOL = 'openai';
		process.env.LLM_FALLBACK_AUTH_STYLE = 'bearer';
		process.env.LLM_FALLBACK_MODEL = 'deepseek-chat';
		expect(getLlmFallbackConfig('primary-model')).toMatchObject({
			protocol: 'openai',
			authStyle: 'bearer',
			model: 'deepseek-chat',
		});
	});
});

// ─── Secrets ────────────────────────────────────────────────────────

describe('credentials never reach a log line or an error body', () => {
	it('redacts the configured credential from provider text', () => {
		const echo = `Invalid key ${FALLBACK_KEY} for request`;
		expect(redactSecret(echo, FALLBACK_KEY)).not.toContain(FALLBACK_KEY);
		expect(redactSecret(echo, FALLBACK_KEY)).toContain('[redacted]');
		// Short values are left alone: scrubbing a 2-character "secret" would
		// mangle ordinary prose.
		expect(redactSecret('a note about ab', 'ab')).toBe('a note about ab');
	});

	it('scrubs the credential out of an error raised by the provider wrapper', () => {
		const err = new ProviderRequestError(
			FALLBACK_PROVIDER_LABEL,
			'http',
			402,
			`gateway rejected key ${FALLBACK_KEY}: Insufficient Balance`,
			[FALLBACK_KEY],
		);
		expect(err.message).toContain('Insufficient Balance');
		expect(err.message).not.toContain(FALLBACK_KEY);
		// `status` is preserved so the existing `isCreditExhausted` /
		// `toAssistantError` classifiers read a fallback failure like a primary one.
		expect(err.status).toBe(402);
		expect(err.kind).toBe('http');
	});
});

// ─── The OpenAI-compatible translation ──────────────────────────────

describe('the OpenAI-compatible translation', () => {
	it('turns tool use and tool results into the OpenAI shape', () => {
		const messages = toOpenAIMessages(
			[
				{ role: 'user', content: 'add a task' },
				{
					role: 'assistant',
					content: [
						{ type: 'text', text: 'On it.' },
						{ type: 'tool_use', id: 'call_1', name: 'create_task', input: { title: 'Send invoice' } },
					],
				},
				{
					role: 'user',
					content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Task added.' }],
				},
			],
			'You are NOVA.',
		);

		expect(messages[0]).toEqual({ role: 'system', content: 'You are NOVA.' });
		expect(messages[2].tool_calls?.[0]).toEqual({
			id: 'call_1',
			type: 'function',
			function: { name: 'create_task', arguments: JSON.stringify({ title: 'Send invoice' }) },
		});
		expect(messages[3]).toEqual({ role: 'tool', content: 'Task added.', tool_call_id: 'call_1' });
	});

	it('rewrites tool definitions into OpenAI function tools', () => {
		const tools = toOpenAITools([
			{ name: 'create_task', description: 'Add a task', input_schema: { type: 'object', properties: {} } },
		]);
		expect(tools?.[0]).toMatchObject({ type: 'function', function: { name: 'create_task' } });
		expect(toOpenAITools([])).toBeUndefined();
	});
});

// ─── The hazard: a retry must never repeat a side effect ────────────

describe('a mid-loop provider failure never re-executes a tool', () => {
	it('executes the tool exactly once and lets the failure surface', async () => {
		const executor = await import('../services/assistant-tool-executor.js');
		const executed = vi.spyOn(executor, 'executeToolUses');
		const { runAssistantToolLoop } = await import('../services/assistant-tools.js');
		const mocked = vi.mocked(chatCompletion);

		const toolUse = { id: 'toolu_1', name: 'create_reminder', input: { title: 'Call the bank' } };
		const withTool: ChatCompletionResult = {
			content: '',
			model: 'primary-test-model',
			usage: { inputTokens: 1, outputTokens: 1 },
			blocks: [{ type: 'tool_use', ...toolUse }],
			stopReason: 'tool_use',
			toolUses: [toolUse],
			provider: 'anthropic',
			fellBack: false,
		};
		const exhausted = Object.assign(new Error('402 {"error":{"message":"Insufficient Balance"}}'), {
			status: 402,
		});

		mocked.mockReset();
		mocked.mockResolvedValueOnce(withTool).mockRejectedValueOnce(exhausted);

		const err = await runAssistantToolLoop('user-1', [{ role: 'user', content: 'remind me' }], {
			systemPrompt: 'NOVA',
		}).catch((e) => e);

		// One tool execution, and the turn failed rather than restarting it.
		expect(executed).toHaveBeenCalledTimes(1);
		expect(err).toBe(exhausted);

		// The retry gate: the first model call of the turn may fall back; the call
		// that follows an executed tool may not.
		expect(mocked.mock.calls).toHaveLength(2);
		expect((mocked.mock.calls[0][1] as any).allowProviderFallback).toBe(true);
		expect((mocked.mock.calls[1][1] as any).allowProviderFallback).toBe(false);

		vi.restoreAllMocks();
	});

	it('reports the fallback in the loop result when the secondary provider served the turn', async () => {
		const { runAssistantToolLoop } = await import('../services/assistant-tools.js');
		const mocked = vi.mocked(chatCompletion);

		mocked.mockReset();
		mocked.mockResolvedValueOnce({
			content: 'Fallback answer.',
			model: 'fallback-model',
			usage: { inputTokens: 1, outputTokens: 1 },
			blocks: [{ type: 'text', text: 'Fallback answer.' }],
			stopReason: 'end_turn',
			toolUses: [],
			provider: FALLBACK_PROVIDER_LABEL,
			fellBack: true,
		});

		const result = await runAssistantToolLoop('user-1', [{ role: 'user', content: 'hi' }], {
			systemPrompt: 'NOVA',
		});

		expect(result.provider).toBe(FALLBACK_PROVIDER_LABEL);
		expect(result.fellBack).toBe(true);
	});
});
