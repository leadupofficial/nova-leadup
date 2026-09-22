/**
 * NOVA API — the fallback choice is sticky for one assistant turn, and it is
 * decided by *where* a failure came from.
 *
 * Two defects are pinned here, both measured against the live API.
 *
 * 1. **Selected per request, not per turn.** `runAssistantToolLoop` calls the
 *    model once per iteration, and the retry gate was `toolCalls.length === 0`.
 *    So a turn whose first call fell back ran its tool — the reminder really was
 *    created — and then iteration 2 went back to the dead primary, failed, and
 *    the route answered `503` with "NOVA's AI credit has run out". The user was
 *    told the reminder had not been set when it had. The guard was right to
 *    refuse the retry; the bug is that the *provider choice* was forgotten.
 *
 * 2. **A dead relay ended the product.** The primary stopped answering `402` and
 *    began answering `404 404 page not found` — the relay's route had gone away.
 *    `isProviderUnusableFailure` refused every `404` by status code, on the
 *    (correct, for our own code) reasoning that a 404 means the request is
 *    wrong. It does not mean that when the *provider* raised it. Classification
 *    is therefore by origin: an error the provider's own request path produced
 *    is the provider being unusable; one this service raised is not.
 *
 * The provider boundary is two local HTTP servers (`./helpers/fake-llm-providers`),
 * and the modules under test are the **real** `chatCompletion`,
 * `runAssistantToolLoop` and `streamChatCompletion` — `vi.importActual` defeats
 * the route suite's stub in `./setup.ts`, because the retry decision lives
 * inside those modules.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup.js';

import { FALLBACK_PROVIDER_LABEL } from '../services/llm-fallback.js';import type { ChatMessage } from '../services/ai.js';
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
/**
 * Scripted primary behaviour, one entry per request, so a test can make the
 * primary answer the first call and then die — the shape the live defect took
 * once the relay's route went away.
 */
let primaryScript: PrimaryPlan[] = [];
let fallbackPlan: FallbackPlan = 'anthropic-completion';
let primary: FakeProvider;
let fallback: FakeProvider;
/** Real modules, loaded by `freshModules()` after the shared stub is undone. */
let realAi: typeof import('../services/ai.js');
let realLoop: typeof import('../services/assistant-tools.js');
let executor: typeof import('../services/assistant-tool-executor.js');
/** The Express app, rebuilt from the same registry `freshModules()` resets. */
let app: Awaited<typeof import('../server.js')>['default'];

/**
 * Loads the modules under test against the **real** `services/ai.ts`.
 *
 * This is load-bearing, not ceremony. `./setup.ts` stubs `services/ai.js` so no
 * route suite makes a network call, and Vitest resolves a module specifier
 * through the registry of whoever imports it — so a plain `vi.importActual`
 * hands back the stub, and `runAssistantToolLoop` (which imports
 * `../services/ai.js`) would call the stub while the provider stand-ins stayed
 * silent. That is exactly the trap that made this bug invisible to the suite:
 * the loop's provider choice was never observable. Undoing the mock *and*
 * resetting the registry is what makes the fakes below see the traffic.
 */
async function freshModules(): Promise<void> {
	vi.doUnmock('../services/ai.js');
	vi.resetModules();
	realAi = await import('../services/ai.js');
	executor = await import('../services/assistant-tool-executor.js');
	realLoop = await import('../services/assistant-tools.js');
	// The route suites mount the real `server.ts`; it must be built from the same
	// fresh registry for `/voice/chat` to reach the real provider path.
	app = (await import('../server.js')).default;
}

/**
 * Every name this file points at a fake provider, captured before any of them is
 * changed. Each file gets an isolated module registry, but a worker is shared
 * across files, so a leaked `ANTHROPIC_BASE_URL` would aim a later suite's
 * provider call at a server this file has already closed.
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

/** The turn the user actually spoke, verbatim from the bug report. */
const ASK: ChatMessage[] = [
	{ role: 'user', content: 'NOVA, tomorrow morning remind me to call the client about the website' },
];

const authHeader = (): Record<string, string> => ({
	Authorization: `Bearer ${jwt.sign(
		{ sub: 'user-123', email: 'test@example.com', role: 'user' },
		process.env.JWT_SECRET!,
		{ expiresIn: '1h' },
	)}`,
});

beforeAll(async () => {
	primary = await startFakeProvider((body) =>
		primaryReply(primaryScript.length ? primaryScript.shift()! : primaryPlan, body),
	);
	fallback = await startFakeProvider((body, path) => fallbackReply(fallbackPlan, body, path));

	// `BROCODE_API_KEY` wins over `ANTHROPIC_API_KEY` in `getAnthropicHttpConfig()`
	// and is read straight from `process.env`, so this pins the credential the
	// SDK actually sends.
	process.env.BROCODE_API_KEY = PRIMARY_KEY;
	process.env.ANTHROPIC_BASE_URL = primary.url;
	process.env.ANTHROPIC_API_KEY = PRIMARY_KEY;
	process.env.ANTHROPIC_AUTH_STYLE = 'api-key';
	process.env.ANTHROPIC_MODEL = 'primary-test-model';
	process.env.ANTHROPIC_REALTIME_MODEL = 'primary-test-model';
	process.env.LLM_FALLBACK_BASE_URL = fallback.url;
	process.env.LLM_FALLBACK_API_KEY = FALLBACK_KEY;
	process.env.LLM_FALLBACK_MODEL = 'fb-anthropic-model';
	// The fallback is configured for the Anthropic protocol here, which is the
	// shape the live deployment actually uses (`LLM_FALLBACK_PROTOCOL=anthropic`
	// against apimaster.ai, which serves `/v1/messages`). The OpenAI-protocol
	// branch is covered by `./llm-fallback-integration.test.ts`.
	process.env.LLM_FALLBACK_AUTH_STYLE = 'api-key';
	process.env.LLM_FALLBACK_PROTOCOL = 'anthropic';

	// Load the modules under test only now that the environment points at the
	// stand-ins above.
	await freshModules();
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
	primaryScript = [];
	fallbackPlan = 'anthropic-completion';
	primary.requests.length = 0;
	fallback.requests.length = 0;
	vi.restoreAllMocks();
});


describe('a turn that falls back stays on the fallback', () => {
	it('contacts the primary exactly once and the fallback for every later iteration', async () => {
		const executed = vi.spyOn(executor, 'executeToolUses');
		// Iteration 1: the primary is dead (404 — the live relay's current answer).
		primaryPlan = 'not-found';
		// The fallback serves the whole turn: it asks for the reminder, then
		// answers once the executor's tool_result is on the wire.
		fallbackPlan = 'anthropic-tool-then-text';

		const result = await realLoop.runAssistantToolLoop('user-123', ASK, { systemPrompt: 'NOVA' });

		// The defect: iteration 2 re-probed the dead primary. Sticky selection
		// means the primary is contacted for the first call and never again.
		expect(primary.requests).toHaveLength(1);
		// Iteration 1 (tool call) + iteration 2 (the answer), both on the fallback.
		expect(fallback.requests).toHaveLength(2);
		expect(result.iterations).toBe(2);
		expect(executed).toHaveBeenCalledTimes(1);

		// The turn is reported as fallback-served, so client and logs can see it.
		expect(result.provider).toBe(FALLBACK_PROVIDER_LABEL);
		expect(result.fellBack).toBe(true);
		// The tool ran once and the reply confirms it.
		expect(result.toolCalls.map((c) => `${c.name}:${c.ok}`)).toEqual(['create_reminder:true']);
		expect(result.content).toContain('reminder');
	});

	it('reports the fallback as the turn provider on a later iteration too', async () => {
		primaryPlan = 'not-found';
		fallbackPlan = 'anthropic-tool-then-text';

		const result = await realLoop.runAssistantToolLoop('user-123', ASK, { systemPrompt: 'NOVA' });

		// `fellBack` / `provider` keep describing the turn, not just its first call.
		expect(result.provider).toBe(FALLBACK_PROVIDER_LABEL);
		expect(result.fellBack).toBe(true);
		// The model that answered is the fallback's, not the primary's.
		expect(result.model).toBe('fb-anthropic-model');
	});
});

describe('a tool-using turn on a dead primary', () => {
	it('creates the reminder once and answers 200 with a reply that confirms it', async () => {
		const executed = vi.spyOn(executor, 'executeToolUses');
		primaryPlan = 'not-found';
		fallbackPlan = 'anthropic-tool-then-text';

		const res = await request(app)
			.post('/api/v1/voice/chat')
			.set(authHeader())
			.send({ messages: ASK, language: 'en' });

		// The measured defect: 503 "AI credit has run out" *after* the reminder had
		// already been created. With a sticky choice the turn never returns to the
		// dead primary, so it completes.
		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data.text).toContain('reminder');
		expect(res.body.data.text).not.toMatch(/credit|run out|can't reply/i);
		expect(res.body.data.provider).toBe(FALLBACK_PROVIDER_LABEL);
		expect(res.body.data.fellBack).toBe(true);

		// The side effect happened exactly once — not zero times, not twice.
		expect(executed).toHaveBeenCalledTimes(1);
		const toolUse = executed.mock.calls[0][1][0];
		expect(toolUse.name).toBe('create_reminder');
		expect(toolUse.input.title).toBe('Call the client about the website');

		// The key measured number: the dead primary was probed once, not once per
		// iteration.
		expect(primary.requests).toHaveLength(1);
		expect(fallback.requests).toHaveLength(2);
	});

	it('refuses a mid-turn retry once a tool has run', async () => {
		const executed = vi.spyOn(executor, 'executeToolUses');
		// The primary asks for the reminder and then dies on the next call, so
		// nothing in this turn has fallen back and the fallback is never chosen.
		primaryScript = ['tool-call', 'not-found'];
		fallbackPlan = 'anthropic-completion';

		const err = await realLoop
			.runAssistantToolLoop('user-123', ASK, { systemPrompt: 'NOVA' })
			.catch((e) => e);

		// Exactly one execution and no second attempt: the retry guard stayed
		// intact. The turn fails, as it did before this change — sticky selection
		// is what stops that from being the *common* case.
		expect(executed).toHaveBeenCalledTimes(1);
		expect(err).toBeInstanceOf(Error);
		expect(primary.requests).toHaveLength(2);
		expect(fallback.requests).toHaveLength(0);
	});
});

describe('the fallback choice is per turn, not global', () => {
	it('uses the primary again on the next turn once it recovers', async () => {
		// Turn 1: primary dead, fallback serves it.
		primaryPlan = 'not-found';
		fallbackPlan = 'anthropic-tool-then-text';
		const first = await realLoop.runAssistantToolLoop('user-123', ASK, { systemPrompt: 'NOVA' });
		expect(first.fellBack).toBe(true);
		expect(primary.requests).toHaveLength(1);

		// Turn 2: the primary is healthy again. A process-wide pin would keep
		// sending turns to the fallback; per-turn stickiness must not.
		primaryPlan = 'completion';
		const second = await realLoop.runAssistantToolLoop('user-123', [{ role: 'user', content: 'hello' }], {
			systemPrompt: 'NOVA',
		});

		expect(second.fellBack).toBe(false);
		expect(second.provider).toBe('anthropic');
		expect(second.content).toBe('Primary answer.');
		expect(primary.requests).toHaveLength(2);
		// No new fallback call was needed for turn 2.
		expect(fallback.requests).toHaveLength(2);
	});
});

// ─── Origin, not status code ────────────────────────────────────────

describe('a provider failure is classified by where it came from', () => {
	it('falls back when the provider itself answers 404', async () => {
		// The live relay's `404 404 page not found`: raised by the SDK's own error
		// generation, i.e. by the provider's request path, not by our handlers.
		primaryPlan = 'not-found';
		fallbackPlan = 'anthropic-completion';

		const result = await realAi.chatCompletion([{ role: 'user', content: 'say ok' }]);

		expect(result.content).toBe('Fallback answer.');
		expect(result.provider).toBe(FALLBACK_PROVIDER_LABEL);
		expect(result.fellBack).toBe(true);
		expect(primary.requests).toHaveLength(1);
		expect(fallback.requests).toHaveLength(1);
	});

	it('does NOT fall back on a 404 raised by our own code', async () => {
		// No provider was involved: this is the shape of a missing row or an
		// unknown route. A retry would waste a call and hide the bug, so a bare
		// 404 — one this service raised, not one the provider's request path
		// produced — must stay non-retryable.
		primaryPlan = 'completion';
		fallbackPlan = 'anthropic-completion';

		const ours = Object.assign(new Error('Reminder not found'), { status: 404 });

		// The policy is what decides this, and `isProviderUnusableFailure` is the
		// one place it is decided.
		const { isProviderUnusableFailure } = await vi.importActual<
			typeof import('../services/llm-fallback.js')
		>('../services/llm-fallback.js');
		expect(isProviderUnusableFailure(ours)).toBe(false);
		// And the same object, when it really came from the provider's request
		// path, is the provider being unusable — that is the whole distinction.
		const { ProviderRequestError } = await vi.importActual<
			typeof import('../services/llm-fallback.js')
		>('../services/llm-fallback.js');
		expect(
			isProviderUnusableFailure(new ProviderRequestError('anthropic', 'http', 404, '404 page not found')),
		).toBe(true);

		// Nothing was sent anywhere while the policy was being decided.
		expect(primary.requests).toHaveLength(0);
		expect(fallback.requests).toHaveLength(0);
	});

	it('still refuses a provider 400 or 422 — that is the request, not the provider', async () => {
		primaryPlan = 'bad-request';
		fallbackPlan = 'anthropic-completion';

		const err = await realAi.chatCompletion([{ role: 'user', content: 'say ok' }]).catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect(fallback.requests).toHaveLength(0);
	});

	it('still refuses a provider 401 — that provider needs its credential fixed', async () => {
		primaryPlan = 'unauthorized';
		fallbackPlan = 'anthropic-completion';

		const err = await realAi.chatCompletion([{ role: 'user', content: 'say ok' }]).catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect(fallback.requests).toHaveLength(0);
	});
});
