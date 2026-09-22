/**
 * Two local HTTP servers standing in for an LLM provider.
 *
 * The fallback tests must exercise the real `chatCompletion` and
 * `streamChatCompletion` — the retry decision, the protocol translation and the
 * SSE parsing are the behaviour under test — so the provider boundary is what is
 * faked, not the module. `ANTHROPIC_BASE_URL` and `LLM_FALLBACK_BASE_URL` point
 * at `127.0.0.1`, so no model and no network are involved.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** The credential the primary is configured with; asserted to be on the wire. */
export const PRIMARY_KEY = 'primary-secret-key-abcdef123456';
/** The credential the fallback is configured with; asserted never to leak. */
export const FALLBACK_KEY = 'fallback-secret-key-zyxwvu987654';

export type PrimaryPlan =
	/** `402 {"error":{"message":"Insufficient Balance","type":"billing_error"}}` */
	| 'credit'
	/** A 500 from the provider. */
	| 'server-error'
	/** A 400: the request is wrong, not the provider. */
	| 'bad-request'
	/**
	 * A provider-originated `404` — the relay's endpoint has gone away
	 * (`404 page not found`), which the Anthropic SDK raises as a
	 * `NotFoundError`. The *provider*, not this service, produced it, so the
	 * fallback must cover it.
	 */
	| 'not-found'
	/** A 401 from the provider: a credential problem for *that* provider. */
	| 'unauthorized'
	/**
	 * A `200` Anthropic Messages reply asking for one tool call. `plan` is set
	 * to this for the first model call of a tool-using turn; the second call
	 * must then use `completion` so the turn can finish.
	 */
	| 'tool-call'
	/** A normal non-streaming Anthropic Messages reply. */
	| 'completion'
	/** A normal Anthropic SSE reply. */
	| 'sse-text'
	/** SSE that fails on an `error` event before emitting any text. */
	| 'sse-error-before-delta'
	/** SSE that emits one delta and then fails — the un-retryable case. */
	| 'sse-error-after-delta';

export type FallbackPlan =
	| 'openai-completion'
	| 'openai-stream'
	| 'anthropic-completion'
	/**
	 * Anthropic-protocol: first call asks for a tool, every later call answers
	 * with text. Used to drive a whole tool-using turn through the fallback.
	 */
	| 'anthropic-tool-then-text'
	| 'credit'
	/** A 402 whose body echoes the submitted credential back. */
	| 'echo-credential-error';

export interface Recorded {
	path: string;
	headers: http.IncomingHttpHeaders;
	body: any;
}

export interface FakeReply {
	status: number;
	json?: unknown;
	sse?: string[];
}

export interface FakeProvider {
	url: string;
	requests: Recorded[];
	close: () => Promise<void>;
}

/** Anthropic Message body for a successful non-streaming reply. */
export function anthropicMessage(text: string, model = 'primary-test-model'): Record<string, unknown> {
	return {
		id: 'msg_1',
		type: 'message',
		role: 'assistant',
		model,
		content: [{ type: 'text', text }],
		stop_reason: 'end_turn',
		usage: { input_tokens: 11, output_tokens: 7 },
	};
}

/**
 * Anthropic Message body in which the model asks for one `create_reminder`.
 *
 * `title` is carried through to the tool result so a test can name the row the
 * executor was asked to write without depending on its generated id.
 */
export function anthropicToolUse(
	name: string,
	input: Record<string, unknown>,
	id = 'toolu_1',
	model = 'primary-test-model',
): Record<string, unknown> {
	return {
		id: 'msg_1',
		type: 'message',
		role: 'assistant',
		model,
		content: [{ type: 'tool_use', id, name, input }],
		stop_reason: 'tool_use',
		usage: { input_tokens: 11, output_tokens: 7 },
	};
}

/**
 * True when a request body already carries a `tool_result`.
 *
 * This is how a fake provider tells the first model call of a turn from the
 * second: the loop replays the executor's answer as a `tool_result` block, and
 * that block's presence is the only thing that distinguishes them on the wire.
 */
export function hasToolResult(body: any): boolean {
	const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
	return messages.some((m) =>
		Array.isArray(m?.content) ? m.content.some((b: any) => b?.type === 'tool_result') : false,
	);
}

/** Anthropic-style SSE frames for one short reply. */
export function anthropicSse(text: string): string[] {
	return [
		`data: ${JSON.stringify({ type: 'message_start', message: { id: 'm', model: 'primary-test-model', usage: { input_tokens: 4, output_tokens: 0 } } })}\n\n`,
		`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
		`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
		`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
		`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } })}\n\n`,
	];
}

/**
 * The trigger the scripted model asks for in the two tool-calling plans below.
 *
 * A date on its own rather than a date-time. The executor now refuses a clock
 * time the user's own turn never stated (`services/stated-time.ts`, measured on
 * the live §31 run), and the turn these plans answer
 * (`llm-provider-stickiness.test.ts`) names a part of the day and no hour — so a
 * scripted call carrying one would be refused, and those suites are about which
 * provider serves a tool-using turn, not about fabricated times. The fabrication
 * itself is pinned in `assistant-stated-time-loop.test.ts`.
 */
const SCRIPTED_TRIGGER = '2030-01-02';

/** Starts a provider stand-in that records every request it receives. */
export async function startFakeProvider(pick: (body: any, path: string) => FakeReply): Promise<FakeProvider> {
	const requests: Recorded[] = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => (raw += chunk));
		req.on('end', () => {
			let body: any = null;
			try {
				body = raw ? JSON.parse(raw) : null;
			} catch {
				body = raw;
			}
			requests.push({ path: req.url ?? '', headers: req.headers, body });
			const reply = pick(body, req.url ?? '');
			if (reply.sse) {
				res.writeHead(reply.status, { 'content-type': 'text/event-stream' });
				for (const frame of reply.sse) res.write(frame);
				res.end();
				return;
			}
			res.writeHead(reply.status, { 'content-type': 'application/json' });
			res.end(reply.json === undefined ? '' : JSON.stringify(reply.json));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** The primary's reply for one plan. */
export function primaryReply(plan: PrimaryPlan, body: any = null): FakeReply {
	switch (plan) {
		case 'credit':
			return { status: 402, json: { error: { message: 'Insufficient Balance', type: 'billing_error' } } };
		case 'server-error':
			return { status: 500, json: { error: { message: 'upstream exploded' } } };
		case 'bad-request':
			return { status: 400, json: { error: { message: 'max_tokens must be positive' } } };
		// Exactly what the live relay answered after the account's route went
		// away: `404 404 page not found`, raised by the SDK as a NotFoundError.
		case 'not-found':
			return { status: 404, json: { type: 'error', error: { type: 'not_found_error', message: '404 page not found' } } };
		case 'unauthorized':
			return { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid key' } } };
		case 'tool-call':
			// First call asks for the reminder; once the executor's `tool_result`
			// is on the wire the turn must be able to finish.
			return hasToolResult(body)
				? { status: 200, json: anthropicMessage('Reminder set for tomorrow morning.') }
				: {
						status: 200,
						json: anthropicToolUse('create_reminder', {
							title: 'Call the client about the website',
							trigger_at: SCRIPTED_TRIGGER,
						}),
					};
		case 'sse-text':
			return { status: 200, sse: anthropicSse('Hello from the primary.') };
		case 'sse-error-before-delta':
			return {
				status: 200,
				sse: [
					`data: ${JSON.stringify({ type: 'message_start', message: { id: 'm', model: 'primary-test-model', usage: {} } })}\n\n`,
					`data: ${JSON.stringify({ type: 'error', error: { message: 'relay died' } })}\n\n`,
				],
			};
		case 'sse-error-after-delta':
			return {
				status: 200,
				sse: [
					`data: ${JSON.stringify({ type: 'message_start', message: { id: 'm', model: 'primary-test-model', usage: {} } })}\n\n`,
					`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
					`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half a sentence' } })}\n\n`,
					`data: ${JSON.stringify({ type: 'error', error: { message: 'relay died mid-stream' } })}\n\n`,
				],
			};
		default:
			return { status: 200, json: anthropicMessage('Primary answer.') };
	}
}

/** The fallback's reply for one plan, dispatched on the protocol in the path. */
export function fallbackReply(plan: FallbackPlan, body: any, path: string): FakeReply {
	if (path.endsWith('/v1/messages')) {
		if (plan === 'credit') return { status: 402, json: { error: { message: 'Insufficient Balance' } } };
		if (plan === 'anthropic-tool-then-text') {
			// Same shape as the primary's `tool-call`: the fallback serves the
			// whole turn, so it is the provider that first asks for the reminder
			// and then has to answer once the tool result comes back.
			return hasToolResult(body)
				? { status: 200, json: anthropicMessage('Done — I have set your reminder for tomorrow morning.', 'fb-anthropic-model') }
				: {
						status: 200,
						json: anthropicToolUse(
							'create_reminder',
							{
								title: 'Call the client about the website',
								trigger_at: SCRIPTED_TRIGGER,
							},
							'toolu_fallback_1',
							'fb-anthropic-model',
						),
					};
		}
		return { status: 200, json: anthropicMessage('Fallback answer.', 'fb-anthropic-model') };
	}

	if (plan === 'credit') return { status: 402, json: { error: { message: 'Insufficient Balance' } } };
	if (plan === 'echo-credential-error') {
		return { status: 402, json: { error: { message: `Insufficient Balance for key ${FALLBACK_KEY}` } } };
	}
	if (plan === 'openai-stream' || body?.stream === true) {
		return {
			status: 200,
			sse: [
				`data: ${JSON.stringify({ model: 'fallback-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Fallback ' } }] })}\n\n`,
				`data: ${JSON.stringify({ model: 'fallback-model', choices: [{ index: 0, delta: { content: 'answer.' }, finish_reason: null }] })}\n\n`,
				`data: ${JSON.stringify({ model: 'fallback-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
				'data: [DONE]\n\n',
			],
		};
	}
	return {
		status: 200,
		json: {
			id: 'cmpl_1',
			model: 'fallback-model',
			choices: [{ index: 0, message: { role: 'assistant', content: 'Fallback answer.' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 12, completion_tokens: 5 },
		},
	};
}
