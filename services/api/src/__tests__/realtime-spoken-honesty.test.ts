/**
 * NOVA API — the **spoken** path refuses to let a claim of an action stand
 * unbacked, and it did not before.
 *
 * `services/assistant-tools.ts` has carried this guard on the REST path for a
 * while: if a turn's prose says a change happened and no tool ran, that sentence
 * is replaced with the truth. Its doc comment describes `realtime/tool-loop.ts`
 * as having "deliberately identical" semantics — and the streaming loop contained
 * **no `claimsStateChange` call at all**. So on the primary voice path, the one
 * the app actually uses when the socket is up, a model could say *"Done, I've set
 * the reminder"* with `toolUses: []` and the user heard it. The typed path would
 * have corrected that sentence; the spoken one forwarded it.
 *
 * The fix cannot replace text the way REST does — audio already played cannot be
 * retracted, and buffering the turn to check it first would destroy
 * time-to-first-word, which is the entire reason this path streams. So the
 * correction is *spoken immediately after* the claim.
 *
 * These tests drive the **real** loop through the **real** SSE transport against a
 * local provider stand-in, not a stubbed `streamChatCompletion`: the claim is only
 * observable if the text actually arrives through the streaming path the app uses.
 *
 * Also covered: the corrective sentence is written in the user's language. It used
 * to be English only, and the guard fires when the model has misbehaved — most
 * often on exactly the languages the model is weakest in, so the English floor
 * landed on the users least able to read it. Measured live: a Tanglish turn
 * answered with the English floor.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	PRIMARY_KEY,
	anthropicSse,
	startFakeProvider,
	type FakeProvider,
} from './helpers/fake-llm-providers.js';
import { UNBACKED_CLAIM_CORRECTION } from '../services/assistant-tools.js';

/**
 * Every name pointed at the stand-in, captured before any of them is changed. A
 * worker is shared across files, so a leaked base URL would aim a later suite's
 * provider call at a server this file has already closed. A leaked fallback would
 * also mean a turn that should fail once instead silently succeeds.
 */
const TOUCHED = [
	'ANTHROPIC_BASE_URL',
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_STYLE',
	'BROCODE_API_KEY',
	'LLM_FALLBACK_BASE_URL',
	'LLM_FALLBACK_API_KEY',
] as const;
const originalEnv: Record<string, string | undefined> = Object.fromEntries(
	TOUCHED.map((key) => [key, process.env[key]]),
);

const ENGLISH_FLOOR =
	"I haven't changed anything yet — no action was carried out. Tell me what you'd like me to do and I'll do it.";

let provider: FakeProvider;
/** One scripted spoken reply per provider call, consumed in order. */
let script: string[] = [];
let runStreamingAssistantLoop: typeof import('../realtime/tool-loop.js').runStreamingAssistantLoop;

beforeEach(async () => {
	script = [];
	provider = await startFakeProvider(() => ({
		status: 200,
		sse: anthropicSse(script.shift() ?? ''),
	}));
	process.env.ANTHROPIC_BASE_URL = provider.url;
	process.env.ANTHROPIC_API_KEY = PRIMARY_KEY;
	process.env.ANTHROPIC_AUTH_STYLE = 'bearer';
	delete process.env.BROCODE_API_KEY;
	delete process.env.LLM_FALLBACK_BASE_URL;
	delete process.env.LLM_FALLBACK_API_KEY;
	({ runStreamingAssistantLoop } = await import('../realtime/tool-loop.js'));
});

afterEach(async () => {
	await provider?.close();
});

afterAll(() => {
	for (const key of TOUCHED) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
});

/** Runs one spoken turn against the scripted provider, collecting what was spoken. */
async function speak(reply: string, language?: string) {
	// Three copies, because a claim now gets a second chance: the first call speaks
	// the claim, the corrective turn is the second call, and a model that claims
	// again lands on the third. A non-claiming reply uses only the first and leaves
	// the rest unread — which is why the run-out guard below still matters.
	script = [reply, reply, reply];
	const deltas: string[] = [];
	const result = await runStreamingAssistantLoop(
		'user-123',
		[{ role: 'user', content: 'set a reminder' }],
		{ systemPrompt: 'You are NOVA.', ...(language ? { language } : {}) },
		(text) => deltas.push(text),
	);
	return { result, spoken: deltas.join(''), deltas };
}

describe('a spoken claim with no tool call behind it', () => {
	it('is corrected out loud — the behaviour the REST path already had', async () => {
		const claim = "Done! I've set the reminder for tomorrow at eleven.";
		const { result, spoken, deltas } = await speak(claim);

		expect(result.claimCorrected).toBe(true);
		expect(result.claimCorrection).toBeTruthy();
		// The claim is already audible, so it stays; the truth follows it.
		expect(result.content.startsWith(claim)).toBe(true);
		expect(result.content).toContain(result.claimCorrection!);
		// And it went through the same channel the audio does, so it is actually
		// heard rather than only recorded in the transcript.
		expect(deltas).toContain(` ${result.claimCorrection!}`);
		expect(spoken).toContain(result.claimCorrection!);
		// No tool ran, which is what makes the claim false in the first place.
		expect(result.toolCalls).toEqual([]);
	});

	it("speaks the correction in the user's language, not always English", async () => {
		const { result } = await speak('செய்துட்டேன்! Reminder set ஆயிடுச்சு.', 'ta');
		expect(result.claimCorrected).toBe(true);
		// A Tamil sentence, not the English floor.
		expect(/[\u0B80-\u0BFF]/.test(result.claimCorrection!)).toBe(true);
		expect(result.claimCorrection).not.toBe(ENGLISH_FLOOR);
	});

	it('falls back to the English floor for a language with no checked wording', async () => {
		const { result } = await speak('Done! I have set the reminder.', 'de');
		expect(result.claimCorrection).toBe(ENGLISH_FLOOR);
	});
});

describe('the correction does not fire when it should not', () => {
	it('leaves an ordinary answer untouched', async () => {
		const answer = 'You have two tasks tomorrow. Which should come first?';
		const { result, deltas } = await speak(answer);
		expect(result.claimCorrected).toBeUndefined();
		expect(result.claimCorrection).toBeUndefined();
		expect(result.content).toBe(answer);
		expect(deltas).toEqual([answer]);
	});

	it('does not fire on a Tamil statement of existing state, which is true', async () => {
		const text = 'நாளைக்கு காலை client-க்கு call பண்ண ஒரு reminder இருக்கு.';
		const { result } = await speak(text, 'ta');
		expect(result.claimCorrected).toBeUndefined();
		expect(result.content).toBe(text);
	});

	it('gives the model a second chance to ACT, not just to apologise', async () => {
		// Measured defect: the spoken path claimed a change, called no tool, and the
		// turn *ended* — the user heard "nothing was carried out" and the reminder was
		// never set. The REST loop already re-prompts here; the streaming loop did
		// not, which is the same one-path-only gap the honesty guard itself had.
		//
		// The sequence a real user now hears is deliberate and worth stating: the
		// false claim, then the correction, then — because the second chance worked —
		// the model actually doing it. Three short utterances instead of a polite
		// nothing.
		await provider.close();
		const bodies: unknown[] = [];
		let call = 0;
		provider = await startFakeProvider((body) => {
			bodies.push(body);
			call += 1;
			if (call === 1) {
				// The claim, with no tool call at all.
				return { status: 200, sse: anthropicSse("Done! I've set the reminder for eleven.") };
			}
			if (call === 2) {
				// The corrective turn is answered with the tool it should have called.
				return {
					status: 200,
					sse: [
						`data: ${JSON.stringify({ type: 'message_start', message: { id: 'm2', model: 'x', usage: { input_tokens: 4, output_tokens: 0 } } })}\n\n`,
						`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_2', name: 'create_reminder', input: {} } })}\n\n`,
						`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ title: 'Call Kumar', trigger_at: '2030-01-01T10:00:00Z' }) } })}\n\n`,
						`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
						`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } })}\n\n`,
					],
				};
			}
			return { status: 200, sse: anthropicSse('Set for eleven in the morning.') };
		});
		process.env.ANTHROPIC_BASE_URL = provider.url;
		({ runStreamingAssistantLoop } = await import('../realtime/tool-loop.js'));

		const deltas: string[] = [];
		const result = await runStreamingAssistantLoop(
			'user-123',
			[{ role: 'user', content: 'remind me to call Kumar' }],
			{ systemPrompt: 'You are NOVA.', language: 'en', confirmationLevel: 99 },
			(text) => deltas.push(text),
		);

		// The second chance was actually taken: a third model call happened.
		expect(call).toBe(3);
		expect(result.claimReprompted).toBe(true);
		// And the instruction sent on the second call is the shared corrective turn,
		// not a locally invented one — so the two loops cannot drift.
		expect(JSON.stringify(bodies[1])).toContain(UNBACKED_CLAIM_CORRECTION.slice(0, 60));
		// The user heard the claim, then the correction, then the real outcome.
		expect(deltas[0]).toContain("I've set the reminder");
		expect(deltas.join('')).toContain(ENGLISH_FLOOR);
		expect(result.content).toContain('Set for eleven');
	});

	it('takes the second chance at most once, so a stubborn model cannot burn the cap', async () => {
		// A model that claims a change on every call must not turn the turn into an
		// unbounded loop of corrections.
		await provider.close();
		let call = 0;
		provider = await startFakeProvider(() => {
			call += 1;
			return { status: 200, sse: anthropicSse("Done! I've set the reminder.") };
		});
		process.env.ANTHROPIC_BASE_URL = provider.url;
		({ runStreamingAssistantLoop } = await import('../realtime/tool-loop.js'));

		const result = await runStreamingAssistantLoop(
			'user-123',
			[{ role: 'user', content: 'remind me to call Kumar' }],
			{ systemPrompt: 'You are NOVA.', language: 'en', confirmationLevel: 99 },
			() => {},
		);

		// One original call plus exactly one second chance.
		expect(call).toBe(2);
		expect(result.claimReprompted).toBe(true);
		expect(result.claimCorrected).toBe(true);
	});

	it('does not fire once a tool has run, because the claim is then true', async () => {
		// A tool-bearing turn: the loop executes the tool and loops back, so the
		// second provider call is the model's confirmation of something real. The
		// stand-in is rebuilt with its own picker so the first call can answer with
		// a `tool_use` block, which is the only way the turn reaches that second
		// call.
		await provider.close();
		let call = 0;
		provider = await startFakeProvider(() => {
			call += 1;
			if (call === 1) {
				return {
					status: 200,
					sse: [
						`data: ${JSON.stringify({ type: 'message_start', message: { id: 'm', model: 'x', usage: { input_tokens: 4, output_tokens: 0 } } })}\n\n`,
						`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'create_reminder', input: {} } })}\n\n`,
						`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ title: 'Call Kumar', trigger_at: '2030-01-01T10:00:00Z' }) } })}\n\n`,
						`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
						`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } })}\n\n`,
					],
				};
			}
			return { status: 200, sse: anthropicSse("Done! I've set the reminder.") };
		});
		process.env.ANTHROPIC_BASE_URL = provider.url;
		({ runStreamingAssistantLoop } = await import('../realtime/tool-loop.js'));

		const deltas: string[] = [];
		const result = await runStreamingAssistantLoop(
			'user-123',
			[{ role: 'user', content: 'remind me to call Kumar' }],
			// A level above every tool, so the approval gate does not hold the call.
			{ systemPrompt: 'You are NOVA.', language: 'en', confirmationLevel: 99 },
			(text) => deltas.push(text),
		);
		expect(result.claimCorrected).toBeUndefined();
		expect(result.content).toBe("Done! I've set the reminder.");
	});
});
