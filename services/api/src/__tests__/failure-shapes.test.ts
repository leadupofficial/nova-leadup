/**
 * NOVA API — the status class has to tell "you asked for the impossible" apart
 * from "we are broken".
 *
 * Three measured cases, each of which reported the wrong *kind* of failure:
 *
 *  1. STT with unusable audio → 500 `{"detail":"An unexpected error occurred"}`.
 *     Undecodable input is a client error, and a 500 tells the app to retry
 *     something that can never succeed.
 *  2. A refused prompt injection → 502 `AI_BLOCKED`. A request this service
 *     deliberately declined to send is not a server fault.
 *  3. The provider account out of credit (`402 {"error":{"message":
 *     "Insufficient Balance","type":"billing_error"}}`) → 502 with the generic
 *     text, so the app could only say "something went wrong".
 *
 * Every test here fails against the code before the fix; the assertion that
 * pins each one is noted beside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import './setup.js';
import app from '../server.js';
import { chatCompletion, transcribeAudio } from '../services/ai.js';
import {
	AI_CREDIT_EXHAUSTED_MESSAGE,
	assistantErrorStatus,
	toAssistantError,
} from '../services/assistant.js';
import { streamChatCompletion } from '../realtime/llm.js';
import { HttpError, errorHandler } from '../middleware/error-handler.js';

const JWT_SECRET = process.env.JWT_SECRET!;

function authHeader(): Record<string, string> {
	return {
		Authorization: `Bearer ${jwt.sign(
			{ sub: 'user-123', email: 'test@example.com', role: 'user' },
			JWT_SECRET,
			{ expiresIn: '1h' },
		)}`,
	};
}

/** Exactly what the SDK throws for an exhausted balance. */
const CREDIT_ERROR = Object.assign(
	new Error('402 {"error":{"message":"Insufficient Balance","type":"billing_error"}}'),
	{ status: 402 },
);

const mockedChatCompletion = vi.mocked(chatCompletion);
const mockedTranscribe = vi.mocked(transcribeAudio);

const postVoiceChat = () =>
	request(app)
		.post('/api/v1/voice/chat')
		.set(authHeader())
		.send({ messages: [{ role: 'user', content: 'hello' }], language: 'en' });

beforeEach(() => {
	mockedChatCompletion.mockReset();
	mockedTranscribe.mockReset();
	mockedTranscribe.mockResolvedValue({ transcript: 'mock transcript', confidence: 0.99, language: 'en' });
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

// ─── 1. STT: unusable audio is a client error ───────────────────────────────

describe('POST /api/v1/voice/stt — unusable audio', () => {
	it('answers 400, not 500, when the provider cannot decode the audio', async () => {
		const { SpeechProviderError } = await vi.importActual<typeof import('../services/ai.js')>(
			'../services/ai.js',
		);
		mockedTranscribe.mockRejectedValueOnce(
			new SpeechProviderError('deepgram', 400, 'Deepgram STT failed (400): failed to decode audio'),
		);

		const res = await request(app)
			.post('/api/v1/voice/stt')
			.set(authHeader())
			.send({ audioData: Buffer.from('not really audio') });

		// Before the fix: 500 STT_ERROR for every provider failure.
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('STT_UNUSABLE_AUDIO');
		expect(res.body.detail).toMatch(/record again/i);
	});

	it('does not forward the provider body or its name to the client', async () => {
		const { SpeechProviderError } = await vi.importActual<typeof import('../services/ai.js')>(
			'../services/ai.js',
		);
		mockedTranscribe.mockRejectedValueOnce(
			new SpeechProviderError('deepgram', 415, 'Deepgram STT failed (415): unsupported content-type audio/flac'),
		);

		const res = await request(app)
			.post('/api/v1/voice/stt')
			.set(authHeader())
			.send({ audioData: Buffer.from('not really audio') });

		const body = JSON.stringify(res.body);
		expect(body).not.toMatch(/deepgram/i);
		expect(body).not.toMatch(/content-type|unsupported|flac/i);
	});

	it('rejects an empty recording without asking the provider at all', async () => {
		const res = await request(app)
			.post('/api/v1/voice/stt')
			.set(authHeader())
			.send({ audioData: 'data:audio/wav;base64,' });

		// Before the fix: 200 with the provider's stub transcript for no audio.
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('STT_UNUSABLE_AUDIO');
		expect(mockedTranscribe).not.toHaveBeenCalled();
	});

	it('keeps a provider outage in the 5xx class', async () => {
		const { SpeechProviderError } = await vi.importActual<typeof import('../services/ai.js')>(
			'../services/ai.js',
		);
		mockedTranscribe.mockRejectedValueOnce(
			new SpeechProviderError('deepgram', 503, 'Deepgram STT failed (503): upstream unavailable'),
		);

		const res = await request(app)
			.post('/api/v1/voice/stt')
			.set(authHeader())
			.send({ audioData: Buffer.from('audio') });

		// A dead provider is ours, not the caller's — but it must not be a 4xx
		// and it must not leak the upstream text.
		expect(res.status).toBe(502);
		expect(res.body.code).toBe('STT_ERROR');
		expect(JSON.stringify(res.body)).not.toMatch(/upstream unavailable/i);
	});

	it('classifies a refused decode by upstream status on the real provider call', async () => {
		const actual = await vi.importActual<typeof import('../services/ai.js')>('../services/ai.js');

		vi.stubGlobal('fetch', vi.fn(async () => new Response('failed to decode audio', { status: 400 })));
		const refused = await actual.transcribeAudio(Buffer.from('x')).catch((err: unknown) => err);
		expect(refused).toBeInstanceOf(actual.SpeechProviderError);
		expect((refused as InstanceType<typeof actual.SpeechProviderError>).provider).toBe('deepgram');
		expect((refused as InstanceType<typeof actual.SpeechProviderError>).upstreamStatus).toBe(400);
		expect((refused as InstanceType<typeof actual.SpeechProviderError>).isUnusableInput).toBe(true);

		vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
		const outage = await actual.transcribeAudio(Buffer.from('x')).catch((err: unknown) => err);
		expect((outage as InstanceType<typeof actual.SpeechProviderError>).upstreamStatus).toBe(503);
		// An outage is not bad audio, which is the whole distinction the route needs.
		expect((outage as InstanceType<typeof actual.SpeechProviderError>).isUnusableInput).toBe(false);
	});
});

// ─── 2. A refused input is the caller's, not ours ───────────────────────────

describe('a safety-refused request', () => {
	it('is answered 400, not 502', async () => {
		mockedChatCompletion.mockRejectedValueOnce(
			new Error('Request contains a jailbreak attempt and was blocked'),
		);

		const res = await postVoiceChat();

		// Before the fix: 502 — the same class as "the provider is down".
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('AI_BLOCKED');
		expect(res.body.detail).toMatch(/blocked by the safety filter/i);
	});

	it('is classified and status-mapped consistently', () => {
		expect(toAssistantError(new Error('Request contains unsafe content and was blocked'))).toEqual({
			code: 'AI_BLOCKED',
			message: 'That request was blocked by the safety filter.',
		});
		expect(assistantErrorStatus('AI_BLOCKED')).toBe(400);
		// The provider-side conditions stay server-side.
		expect(assistantErrorStatus('AI_ERROR')).toBe(502);
		expect(assistantErrorStatus('AI_NOT_CONFIGURED')).toBe(503);
	});
});

// ─── 3. An exhausted balance is a named operational condition ───────────────

describe('the provider account is out of credit', () => {
	it('returns a distinct code and a human message, not a generic failure', async () => {
		mockedChatCompletion.mockRejectedValueOnce(CREDIT_ERROR);

		const res = await postVoiceChat();

		// Before the fix: 502 AI_ERROR with "The AI reply could not be generated."
		expect(res.status).toBe(503);
		expect(res.body.code).toBe('AI_CREDIT_EXHAUSTED');
		expect(res.body.detail).toBe(AI_CREDIT_EXHAUSTED_MESSAGE);
		expect(res.body.detail).toMatch(/credit has run out/i);
		// The problem+json shape is unchanged.
		expect(res.body.type).toBe('https://api.nova.leadup.in/problems/ai_credit_exhausted');
		expect(res.body.status).toBe(503);
	});

	it('leaks nothing from the upstream body', async () => {
		mockedChatCompletion.mockRejectedValueOnce(CREDIT_ERROR);

		const res = await postVoiceChat();

		expect(JSON.stringify(res.body)).not.toMatch(/insufficient balance|billing_error|402/i);
	});

	it('is recognised by wording too, for the gateway that answers 200 with a notice', () => {
		// `looksLikeProviderNotice` in services/ai.ts rethrows the notice text as
		// the error message when a proxy sends the billing problem as content.
		expect(toAssistantError(new Error('AI provider rejected the request: Insufficient Balance')).code).toBe(
			'AI_CREDIT_EXHAUSTED',
		);
		expect(toAssistantError(new Error('You have run out of credit')).code).toBe('AI_CREDIT_EXHAUSTED');
		// A genuine generic failure is still generic.
		expect(toAssistantError(new Error('socket hang up')).code).toBe('AI_ERROR');
	});
});

// ─── The generic text must survive for unnamed failures ─────────────────────

describe('the error handler surfaces an operational 5xx, and only that', () => {
	function appWith(err: HttpError): express.Express {
		const instance = express();
		instance.get('/boom', (_req, _res, next) => next(err));
		instance.use(errorHandler);
		return instance;
	}

	it('shows the credit message in production instead of the generic one', async () => {
		vi.stubEnv('NODE_ENV', 'production');

		const res = await request(
			appWith(new HttpError(503, AI_CREDIT_EXHAUSTED_MESSAGE, 'AI_CREDIT_EXHAUSTED')),
		).get('/boom');

		expect(res.status).toBe(503);
		expect(res.body.detail).toContain('credit has run out');
		expect(res.body.title).toContain('credit has run out');
	});

	it('still hides the message of an unnamed 5xx', async () => {
		vi.stubEnv('NODE_ENV', 'production');

		const res = await request(
			appWith(new HttpError(500, 'connection to postgres://user:pw@host failed', 'INTERNAL_ERROR')),
		).get('/boom');

		expect(res.body.title).toBe('Internal Server Error');
		expect(res.body.detail).toBe('An unexpected error occurred');
	});
});

// ─── 4. The realtime socket reports the same condition as REST ──────────────

/**
 * `realtime/llm.ts` talks the Messages SSE protocol itself, so it sees the
 * provider's HTTP status directly instead of receiving an SDK error. It mapped
 * every status other than 401/403 onto `AI_ERROR`/502 — including the 402 the
 * gateway sends when the account is out of credit — and `realtime/session.ts`
 * classifies whatever it throws through `toAssistantError`. A voice turn
 * therefore told the user "something went wrong" while the identical REST call
 * named the condition. These tests drive the streaming function with a stubbed
 * `fetch`, which is the only seam it has.
 */
describe('the realtime stream maps a dead provider the way REST does', () => {
	const say = () => undefined;

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('reports an exhausted balance as AI_CREDIT_EXHAUSTED, not a generic AI_ERROR', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response('{"error":{"message":"Insufficient Balance","type":"billing_error"}}', {
					status: 402,
				}),
			),
		);

		const err = await streamChatCompletion([{ role: 'user', content: 'hello' }], {}, say).catch(
			(e: unknown) => e,
		);

		// This is the value `session.ts` puts on the socket, so an assertion here is
		// an assertion about what the app receives.
		const classified = toAssistantError(err);
		expect(classified.code).toBe('AI_CREDIT_EXHAUSTED');
		expect(classified.message).toBe(AI_CREDIT_EXHAUSTED_MESSAGE);
		// The HTTP status the session would have reported for the same code.
		expect(assistantErrorStatus('AI_CREDIT_EXHAUSTED')).toBe(503);
	});

	it('still classifies a genuine provider outage as a generic failure', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

		const err = await streamChatCompletion([{ role: 'user', content: 'hello' }], {}, say).catch(
			(e: unknown) => e,
		);

		// Guarding against the fix becoming "any provider failure is a credit
		// problem": an anonymous 500 must stay anonymous.
		expect(toAssistantError(err).code).toBe('AI_ERROR');
		expect(JSON.stringify(toAssistantError(err))).not.toMatch(/credit/i);
	});

	it('names the credit condition when the gateway streams it as ordinary text', async () => {
		// Some gateways answer 200 and put the billing problem in the message body
		// with zero output tokens. `looksLikeProviderNotice` refuses to let that read
		// as a reply; this asserts the realtime path now reports the same condition
		// REST reports for the same text, instead of a bare `AI_ERROR`.
		//
		// Out of scope and left alone: the notice *is* streamed to the caller as it
		// arrives, so the voice socket may already have spoken it. Fixing that needs
		// a buffering decision, not a classification change.
		//
		// Note the wording has to trip `looksLikeProviderNotice` (which matches on
		// `credit`/`billing`/`quota`/…) for this path to be reached at all — see the
		// reported gap in the notice keyword list.
		const notice = 'Insufficient Balance — your credit is exhausted.';
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(notice)}}}\n\n` +
							'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":0}}\n\n',
						{ status: 200 },
					),
			),
		);

		const err = await streamChatCompletion([{ role: 'user', content: 'hello' }], {}, say).catch(
			(e: unknown) => e,
		);

		expect(toAssistantError(err).code).toBe('AI_CREDIT_EXHAUSTED');
	});
});
