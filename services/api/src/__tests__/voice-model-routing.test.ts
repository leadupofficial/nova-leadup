/**
 * NOVA API — the spoken route uses the spoken model, and the spoken prompt
 * states the user's language once more for the one reply that drops it.
 *
 * Both halves are pinned here because both were measured against the live API,
 * not reasoned about.
 *
 * 1. **One model served every surface.** `POST /api/v1/voice/chat` resolved its
 *    model from `ANTHROPIC_MODEL`, the id chosen for typed reasoning. Driving six
 *    representative spoken prompts through the running route with GLM-5.3 there:
 *    15.5 s, 130.7 s, 38.8 s, 35.1 s, 37.0 s, and **HTTP 502 after 111.8 s** on
 *    the advice prompt (`stopReason: max_tokens`, `outputTokens: 4096`, no text —
 *    the reasoning consumed the whole budget). The same six on claude-haiku-4-5:
 *    3.7 s mean, 6/6 correct. A minute per spoken turn is not a conversation.
 *
 * 2. **The language lock slipped on exactly one kind of reply.** Asked in Tanglish
 *    to set a reminder, claude-haiku-4-5 answered *"Done. I've set a reminder for
 *    you to call the client tomorrow at nine in the morning."* — in English —
 *    while the same session's non-tool turns came back in Tamil script. The
 *    system prompt already named the language; it was not read as applying to a
 *    three-word acknowledgement after a tool call, so it is restated last.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup.js';
import app from '../server.js';
import { getAnthropicHttpConfig } from '../services/ai.js';
import { composeSystemPrompt } from '../services/user-context.js';

const JWT_SECRET = process.env.JWT_SECRET!;

function token(): string {
	return jwt.sign({ sub: 'user-123', email: 'test@example.com', role: 'user' }, JWT_SECRET, {
		expiresIn: '1h',
	});
}

/** The `chatCompletion` stub `./setup.ts` installs, so a turn can be observed. */
async function chatStub() {
	const mod = await import('../services/ai.js');
	return vi.mocked(mod.chatCompletion);
}

const SAVED = ['ANTHROPIC_MODEL', 'ANTHROPIC_REALTIME_MODEL', 'ANTHROPIC_VOICE_MODEL'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
	saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
});

afterEach(() => {
	for (const k of SAVED) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('spoken-model configuration', () => {
	it('defaults the voice model to the realtime model, which defaults to the general one', () => {
		delete process.env.ANTHROPIC_VOICE_MODEL;
		delete process.env.ANTHROPIC_REALTIME_MODEL;
		process.env.ANTHROPIC_MODEL = 'general-model';
		expect(getAnthropicHttpConfig().voiceModel).toBe('general-model');

		process.env.ANTHROPIC_REALTIME_MODEL = 'realtime-model';
		expect(getAnthropicHttpConfig().voiceModel).toBe('realtime-model');
	});

	it('lets ANTHROPIC_VOICE_MODEL override the spoken tier without touching the typed one', () => {
		process.env.ANTHROPIC_MODEL = 'slow-reasoning-model';
		process.env.ANTHROPIC_REALTIME_MODEL = 'realtime-model';
		process.env.ANTHROPIC_VOICE_MODEL = 'fast-voice-model';

		const cfg = getAnthropicHttpConfig();
		expect(cfg.model).toBe('slow-reasoning-model');
		expect(cfg.realtimeModel).toBe('realtime-model');
		expect(cfg.voiceModel).toBe('fast-voice-model');
	});
});

describe('POST /api/v1/voice/chat model routing', () => {
	it('asks for the voice model, not the model configured for typed reasoning', async () => {
		process.env.ANTHROPIC_MODEL = 'slow-reasoning-model';
		process.env.ANTHROPIC_VOICE_MODEL = 'fast-voice-model';
		const stub = await chatStub();
		stub.mockClear();

		const res = await request(app)
			.post('/api/v1/voice/chat')
			.set({ Authorization: `Bearer ${token()}` })
			.send({ messages: [{ role: 'user', content: 'Remind me to call Kumar tomorrow.' }], language: 'en' });

		expect(res.status).toBe(200);
		expect(stub).toHaveBeenCalled();
		// The second argument is `ChatOptions`; `model` is what reaches the provider.
		const options = stub.mock.calls[0]![1] as { model?: string };
		expect(options.model).toBe('fast-voice-model');
		expect(options.model).not.toBe('slow-reasoning-model');
	});
});

describe('spoken language lock', () => {
	const base = { basePrompt: 'You are NOVA.', language: 'tanglish' };

	it('restates the language for a spoken turn, last, so a short confirmation cannot slip into English', () => {
		const prompt = composeSystemPrompt({ ...base, spoken: true });
		const last = prompt.split('\n\n').at(-1)!;
		expect(last).toContain('Language check for every reply of this turn');
		expect(last).toContain('tanglish');
		expect(last).toContain('acknowledgement');
	});

	it('names the language properly when the catalogue has a display name', () => {
		const prompt = composeSystemPrompt({
			basePrompt: 'You are NOVA.',
			language: 'ta',
			languageName: 'Tamil',
			spoken: true,
		});
		expect(prompt.split('\n\n').at(-1)).toContain('Tamil');
	});

	it('does not add the restatement to a typed turn', () => {
		const prompt = composeSystemPrompt({ ...base, spoken: false });
		expect(prompt).not.toContain('Language check for every reply of this turn');
	});

	it('does not add it when the language is auto, because there is no name to state', () => {
		const prompt = composeSystemPrompt({ basePrompt: 'You are NOVA.', language: 'auto', spoken: true });
		expect(prompt).not.toContain('Language check for every reply of this turn');
	});
});
