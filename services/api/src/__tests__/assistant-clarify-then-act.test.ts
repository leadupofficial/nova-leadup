/**
 * NOVA API — the second chance has to **act**, not just tell the truth.
 *
 * The honesty guard in `services/assistant-tools.ts` is solved and pinned by
 * `assistant-grounding.test.ts`: a reply that claims a change with no tool call
 * behind it never reaches the user as a success. What that suite did not cover is
 * what happens around it. Measured on the live spoken route, Tanglish create
 * path:
 *
 *   USER:  asks NOVA to set a reminder
 *   NOVA:  claims one, `tools: []`                      ← iteration 1
 *   loop:  sends `UNBACKED_CLAIM_CORRECTION`
 *   NOVA:  prose again, `tools: []`                     ← iteration 2
 *   USER:  "I haven't changed anything yet — no action was carried out."
 *
 * Every word of that is true and the reminder the user asked for was never set.
 * The guard was doing its job; the turn had given up. Measured across six spoken
 * prompts, one in six produced no action at all.
 *
 * The fix is one more, narrower corrective turn that says what to do *instead of*
 * asking (`UNBACKED_CLAIM_ACTION_CORRECTION`), sent at most once and gated so it
 * cannot push the model past a legitimate question. These tests drive the **real**
 * loop through the **real** transport and the **real** executor against a local
 * provider stand-in — the same shape as `llm-provider-stickiness.test.ts` —
 * because "the tool actually ran" is the behaviour under test, and a mocked loop
 * would assert the mock instead.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import {
	PRIMARY_KEY,
	anthropicMessage,
	anthropicToolUse,
	startFakeProvider,
	type FakeProvider,
} from './helpers/fake-llm-providers.js';
import { makeFilteringDb, type Row } from './helpers/tool-db.js';

/**
 * Every name pointed at the stand-in, captured before any of them is changed. A
 * worker is shared across files, so a leaked base URL would aim a later suite's
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
] as const;
const originalEnv: Record<string, string | undefined> = Object.fromEntries(
	TOUCHED.map((key) => [key, process.env[key]]),
);

/**
 * The turn from the measurement: an unambiguous "action, not a read", with the
 * hour stated so the executor's stated-time guard is not what decides this turn.
 *
 * The measured turn named a day and no hour, and the guard then refuses *any*
 * clock time for it — including the one the scripted model would send. That
 * refusal is correct and is pinned in `assistant-stated-time-loop.test.ts`; here
 * it would mask the behaviour under test behind a second, unrelated guard, so the
 * user names the hour and this suite stays about whether a skipped action is
 * ever taken.
 */
const SPOKEN_TURN = 'NOVA, remind me to call the client about the website tomorrow at 6pm';

/**
 * A trigger the executor accepts: an actual date-time, far enough out that it is
 * always in the future. The turn it answers names a day and no hour, so the hour
 * this carries was *not* given by the user — which is deliberate here. This suite
 * is about whether a skipped action is ever taken, not about the stated-time
 * refusal pinned in `assistant-stated-time-loop.test.ts`.
 */
const SCRIPTED_TRIGGER = '2031-01-02T10:00:00+05:30';

/** What the model says when it claims the reminder is already set. */
const CLAIM = "Done! I've set your reminder for tomorrow at six in the evening.";
/** Plain prose with no claim and no question: the shape that preceded the floor. */
const PROSE = "Sure, I will get that sorted.";
/** The reminder the model finally asks for, once it is pushed to act. */
const TOOL_CALL: { tool: true } = { tool: true };

let primary: FakeProvider;
/** One scripted reply per provider call, consumed in order. */
let script: Array<{ text: string } | { tool: true }> = [];
let realLoop: typeof import('../services/assistant-tools.js');
let connection: typeof import('../db/connection.js');

/**
 * Loads the modules under test against the **real** `services/ai.ts`.
 *
 * `./setup.ts` stubs `services/ai.js` so no route suite makes a network call, and
 * Vitest resolves a specifier through the registry of whoever imports it — so the
 * stub has to be undone and the registry reset before the loop can reach the
 * provider stand-in below.
 */
async function freshModules(): Promise<void> {
	vi.doUnmock('../services/ai.js');
	vi.resetModules();
	connection = await import('../db/connection.js');
	realLoop = await import('../services/assistant-tools.js');
}

beforeAll(async () => {
	primary = await startFakeProvider(() => {
		const next = script.shift();
		if (next && 'tool' in next) {
			return {
				status: 200,
				json: anthropicToolUse('create_reminder', {
					title: 'Call the client about the website',
					trigger_at: SCRIPTED_TRIGGER,
				}),
			};
		}
		return { status: 200, json: anthropicMessage(next?.text ?? '') };
	});

	process.env.BROCODE_API_KEY = PRIMARY_KEY;
	process.env.ANTHROPIC_BASE_URL = primary.url;
	process.env.ANTHROPIC_API_KEY = PRIMARY_KEY;
	process.env.ANTHROPIC_AUTH_STYLE = 'api-key';
	process.env.ANTHROPIC_MODEL = 'primary-test-model';
	process.env.ANTHROPIC_REALTIME_MODEL = 'primary-test-model';
	// The turn must not silently succeed through a fallback: this suite is about
	// the primary model skipping the action, so no second provider is configured.
	delete process.env.LLM_FALLBACK_BASE_URL;
	delete process.env.LLM_FALLBACK_API_KEY;

	await freshModules();
});

afterAll(async () => {
	await primary?.close();
	for (const key of TOUCHED) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
});

beforeEach(() => {
	script = [];
	primary.requests.length = 0;
	vi.restoreAllMocks();
});

/**
 * The last *correction* the loop had on the wire for one provider request.
 *
 * A `tool_result` turn is also `role: 'user'`, so the last user message is not
 * necessarily the correction: it is whichever user turn carries prose. That is
 * the same distinction `userTurnText` makes when it picks the user's own turn.
 */
function lastCorrectionOnTheWire(request: { body: any }): string {
	const messages: any[] = request?.body?.messages ?? [];
	const proseTurns = messages.filter(
		(message) => message?.role === 'user' && typeof message.content === 'string',
	);
	return proseTurns.length ? String(proseTurns[proseTurns.length - 1].content) : '';
}

/** Runs one loop turn against the scripted model, with a fresh row store. */
async function turn(
	userTurn: string,
): Promise<{ store: Record<string, Row[]>; result: Awaited<ReturnType<typeof realLoop.runAssistantToolLoop>> }> {
	const { db, store } = makeFilteringDb({ tasks: [], reminders: [] });
	vi.mocked(connection.getDb).mockReturnValue(db);
	const result = await realLoop.runAssistantToolLoop('user-123', [{ role: 'user', content: userTurn }], {
		systemPrompt: 'NOVA',
	});
	return { store, result };
}

// ─── The measured case, end to end ──────────────────────────────────────────

describe('the measured spoken case: a claim, prose after the correction, and then action', () => {
	it('takes the third chance and creates the reminder the user asked for', async () => {
		script = [{ text: CLAIM }, { text: PROSE }, TOOL_CALL];

		const { store, result } = await turn(SPOKEN_TURN);

		// Before the change this turn ended at iteration 2 on the honesty floor
		// with `tools: []`: true, and the reminder did not exist.
		expect(result.toolCalls.map((call) => `${call.name}:${call.ok}`)).toEqual(['create_reminder:true']);
		expect(store.reminders ?? []).toHaveLength(1);
		expect(store.reminders[0].title).toBe('Call the client about the website');

		// The user hears the outcome, not the floor. The model's own last sentence
		// named the hour *it* chose, and the executor's summary is the account of
		// what actually happened — so the grounded reply is what the user gets, and
		// it is the executor's, not the claim.
		expect(result.content).not.toMatch(/haven't changed anything/i);
		expect(result.content).toContain('Call the client about the website');
		expect(result.content).not.toMatch(/six in the evening/i);
		// The write succeeded, so the model's confirmation is now true and stands.
		expect(result.claimCorrected).toBeFalsy();
		expect(result.writeIntentUnfulfilled).toBeFalsy();
		// Three calls: the claim, the prose, and the third chance that acted. The
		// loop is at `MAX_TOOL_ITERATIONS` when that call comes back, so the model
		// never gets to narrate the result — the executor's own account is the
		// outcome, which is the existing cap behaviour and is what the user hears.
		expect(primary.requests).toHaveLength(3);
	});

	it('says what to do instead of asking, in the third turn it sends', async () => {
		script = [{ text: CLAIM }, { text: PROSE }, TOOL_CALL, { text: 'Done — I have set your reminder for six in the evening.' }];

		await turn(SPOKEN_TURN);

		const { UNBACKED_CLAIM_ACTION_CORRECTION, UNBACKED_CLAIM_CORRECTION } = realLoop;
		// The first correction is the one already pinned elsewhere; the second is
		// the new one, and both went on the wire in that order.
		expect(lastCorrectionOnTheWire(primary.requests[1])).toBe(UNBACKED_CLAIM_CORRECTION);
		expect(lastCorrectionOnTheWire(primary.requests[2])).toBe(UNBACKED_CLAIM_ACTION_CORRECTION);
		expect(UNBACKED_CLAIM_ACTION_CORRECTION).not.toBe(UNBACKED_CLAIM_CORRECTION);
		// It must push towards the call, and it must still allow a genuine question.
		expect(UNBACKED_CLAIM_ACTION_CORRECTION).toMatch(/call the matching tool now/i);
		expect(UNBACKED_CLAIM_ACTION_CORRECTION).toMatch(/genuinely cannot be resolved/i);
	});

	it('costs exactly one extra model call and stays inside the iteration cap', async () => {
		// Every call claims success and never calls a tool: the worst shape, where
		// the second chance is offered and refused.
		script = [{ text: CLAIM }, { text: CLAIM }, { text: CLAIM }];

		const { result } = await turn(SPOKEN_TURN);

		// The pre-fix turn took 2 calls and gave up; this one takes 3 and stops.
		expect(result.iterations).toBe(3);
		expect(primary.requests).toHaveLength(3);
		expect(result.toolCalls).toEqual([]);
		// And it still ends with the honest floor rather than the claim.
		expect(result.content).toMatch(/haven't changed anything/i);
		expect(result.claimCorrected).toBe(true);
	});
});

// ─── The negative case that must not regress ────────────────────────────────

describe('a legitimate clarifying question is not re-prompted into acting', () => {
	it('leaves the question alone and never sends the action correction', async () => {
		// Two tasks and "reopen it": the reference genuinely cannot be resolved, so
		// asking is the correct answer. A model pushed past this writes a wrong row.
		const { db, store } = makeFilteringDb({
			tasks: [
				{ id: 'task-1', userId: 'user-123', title: 'Prepare the client proposal', status: 'completed' },
				{ id: 'task-2', userId: 'user-123', title: 'Send the invoice', status: 'completed' },
			],
			reminders: [],
		});
		vi.mocked(connection.getDb).mockReturnValue(db);
		script = [{ text: 'Which one do you mean — the proposal or the invoice?' }];

		const result = await realLoop.runAssistantToolLoop('user-123', [{ role: 'user', content: 'reopen it' }], {
			systemPrompt: 'NOVA',
		});

		// One call, the question, and no tool.
		expect(primary.requests).toHaveLength(1);
		expect(result.toolCalls).toEqual([]);
		expect(result.content).toBe('Which one do you mean — the proposal or the invoice?');
		expect(result.claimCorrected).toBeFalsy();
		// Nothing was written while the model was deciding which item to touch.
		expect(store.tasks.every((task) => task.status === 'completed')).toBe(true);
	});

	it('does not chase a question asked after the first correction either', async () => {
		// The claim arrives first, the correction goes out, and the model's answer
		// is a question. That is still the right answer, so the second chance is
		// not spent on it.
		script = [{ text: CLAIM }, { text: 'Which reminder do you mean?' }];

		const { result } = await turn(SPOKEN_TURN);

		expect(primary.requests).toHaveLength(2);
		expect(result.toolCalls).toEqual([]);
		expect(result.content).toBe('Which reminder do you mean?');
		// A question, not a claim, so nothing was replaced and nothing was chased.
		expect(result.claimCorrected).toBe(false);
	});
});

// ─── The honest floor and the cap ───────────────────────────────────────────

describe('a model that never calls a tool still terminates honestly', () => {
	it('answers with the floor and stops at the cap when it never claims either', async () => {
		// Neither a claim nor a question: the loop has nothing to correct and
		// nothing to clarify, so it must not spend the extra call at all.
		script = [{ text: PROSE }, { text: PROSE }, { text: PROSE }];

		const { result } = await turn(SPOKEN_TURN);

		expect(result.toolCalls).toEqual([]);
		expect(result.iterations).toBe(1);
		expect(primary.requests).toHaveLength(1);
		// Nothing was claimed, so there is nothing to replace — but the metric
		// still records that the write the user asked for did not happen.
		expect(result.content).toBe(PROSE);
		expect(result.claimCorrected).toBe(false);
		expect(result.writeIntentUnfulfilled).toBe(true);
	});

	it('still terminates within the cap when the model keeps claiming', async () => {
		script = [{ text: CLAIM }, { text: CLAIM }, { text: CLAIM }];

		const { result } = await turn(SPOKEN_TURN);

		expect(result.iterations).toBeLessThanOrEqual(3);
		expect(primary.requests).toHaveLength(3);
		expect(result.capped).toBe(false);
	});
});

// ─── The metric ─────────────────────────────────────────────────────────────

describe('the write-intent metric counts the failure and not the clarification', () => {
	it('counts a write that was asked for and never performed', async () => {
		script = [{ text: CLAIM }, { text: CLAIM }, { text: CLAIM }];

		const { result } = await turn(SPOKEN_TURN);

		expect(result.writeIntentUnfulfilled).toBe(true);
		expect(result.askedUserBack).toBeFalsy();
	});

	it('does not count a turn whose reply is a question put back to the user', async () => {
		script = [{ text: 'Which reminder do you mean — the one about the bank or the one about the client?' }];

		const { result } = await turn(SPOKEN_TURN);

		expect(result.toolCalls).toEqual([]);
		// The clarification is recorded, and the failure counter stays clear: an
		// unresolvable reference is not a model that gave up.
		expect(result.askedUserBack).toBe(true);
		expect(result.writeIntentUnfulfilled).toBeFalsy();
	});

	it('does not count a successful write', async () => {
		script = [TOOL_CALL, { text: 'Done — I have set your reminder for six in the evening.' }];

		const { result } = await turn(SPOKEN_TURN);

		expect(result.toolCalls.map((call) => call.ok)).toEqual([true]);
		expect(result.writeIntentUnfulfilled).toBeFalsy();
	});

	it('does not count a turn that asked for no write at all', async () => {
		script = [{ text: 'You have two tasks tomorrow.' }];

		const { result } = await turn('what do I have tomorrow?');

		expect(result.writeIntentUnfulfilled).toBeFalsy();
		expect(result.askedUserBack).toBeFalsy();
	});
});

// ─── The two detectors the gate is built on ─────────────────────────────────

describe('asksForWrite — the write half of the signal', () => {
	it.each([
		'remind me to call the bank tomorrow',
		'NOVA, add a task to send the invoice',
		"don't forget to pick up the dry cleaning",
		'remember that I prefer morning meetings',
		'forget about the Algarve trip',
		'cancel that reminder',
		'actually reopen it',
		'can you push the plumber reminder to Friday?',
		'snooze it by thirty minutes',
		'mark the proposal as done',
	])('reads %j as a request to change something', (text) => {
		expect(realLoop.asksForWrite(text)).toBe(true);
	});

	it.each([
		// A question about what is already known, not a request to store something.
		'do you remember my birthday?',
		'what do I have tomorrow?',
		'how many reminders do I have?',
		'which one do you mean?',
		'',
	])('does not read %j as a write request', (text) => {
		expect(realLoop.asksForWrite(text)).toBe(false);
	});

	it('reads a missing turn as no request rather than throwing', () => {
		expect(realLoop.asksForWrite(undefined)).toBe(false);
	});
});

describe('asksUserBack — a question is not a failure', () => {
	it.each([
		'Which one do you mean — the proposal or the invoice?',
		'What time tomorrow would you like me to remind you?',
		'Did you mean the bank reminder?',
	])('reads %j as a question put back to the user', (text) => {
		expect(realLoop.asksUserBack(text)).toBe(true);
	});

	it.each([
		// A claim is never a question, whatever it ends with — that is what keeps
		// a claim-plus-question from slipping through the metric as "clarifying".
		"Done! I've set your reminder — is there anything else?",
		'Sure, I will get that sorted.',
		'',
	])('does not read %j as a question', (text) => {
		expect(realLoop.asksUserBack(text)).toBe(false);
	});
});
