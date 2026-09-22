/**
 * NOVA API — the guard, driven through the *real* assistant tool loop.
 *
 * The executor test (`assistant-stated-time.test.ts`) proves the refusal at the
 * tool boundary. This one proves the other end of the same wire: that the user's
 * own turn actually reaches the executor through `runAssistantToolLoop`, so the
 * guard is consulted on the path the user is really on, and that the fabricated
 * row never lands.
 *
 * The model is scripted by two local HTTP servers
 * (`./helpers/fake-llm-providers`), and the loop, `chatCompletion` and the
 * executor are the **real** ones — the same shape as
 * `./llm-provider-stickiness.test.ts`. Nothing about the loop is mocked,
 * because "the turn reaches the executor" is precisely the behaviour under test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import {
	PRIMARY_KEY,
	anthropicMessage,
	anthropicToolUse,
	hasToolResult,
	startFakeProvider,
	type FakeProvider,
} from './helpers/fake-llm-providers.js';
import { makeFilteringDb, type Row } from './helpers/tool-db.js';

/** The turn from the bug report, verbatim: a day, and no hour. */
const MEASURED_TURN = 'tomorrow I need to finish the website proposal and call the client';

/** `2030-09-22T12:30Z` is 18:00 IST — "six o'clock in the evening". */
const FABRICATED_18_IST = '2030-09-22T12:30:00.000Z';

/** What the user is asked when the hour they did not give cannot be invented. */
const CLARIFYING_ANSWER = 'Sure. What time tomorrow would you like me to remind you?';

let primary: FakeProvider;
let realLoop: typeof import('../services/assistant-tools.js');
let connection: typeof import('../db/connection.js');

/** The tool call the scripted model asks for on its first call of a turn. */
let toolCall: { name: string; input: Record<string, unknown> } | null = null;

const TOUCHED = [
	'BROCODE_API_KEY',
	'ANTHROPIC_BASE_URL',
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_STYLE',
	'ANTHROPIC_MODEL',
] as const;
const originalEnv: Record<string, string | undefined> = Object.fromEntries(
	TOUCHED.map((key) => [key, process.env[key]]),
);

/**
 * Loads the modules under test against the **real** `services/ai.ts`.
 *
 * `./setup.ts` stubs `services/ai.js` so no route suite makes a network call,
 * and Vitest resolves a specifier through the registry of whoever imports it —
 * so the stub has to be undone and the registry reset before the loop can reach
 * the provider stand-in below.
 */
async function freshModules(): Promise<void> {
	vi.doUnmock('../services/ai.js');
	vi.resetModules();
	connection = await import('../db/connection.js');
	realLoop = await import('../services/assistant-tools.js');
}

beforeAll(async () => {
	primary = await startFakeProvider((body) =>
		hasToolResult(body) || !toolCall
			? { status: 200, json: anthropicMessage(CLARIFYING_ANSWER) }
			: {
					status: 200,
					json: anthropicToolUse(toolCall.name, toolCall.input, 'toolu_1'),
				},
	);

	process.env.BROCODE_API_KEY = PRIMARY_KEY;
	process.env.ANTHROPIC_BASE_URL = primary.url;
	process.env.ANTHROPIC_API_KEY = PRIMARY_KEY;
	process.env.ANTHROPIC_AUTH_STYLE = 'api-key';
	process.env.ANTHROPIC_MODEL = 'primary-test-model';

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
	toolCall = null;
	primary.requests.length = 0;
	vi.restoreAllMocks();
});

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

/** Every `tool_result` block the loop put back on the wire, decoded. */
function toolResultsOnTheWire(): Array<{ ok: boolean; error: string | null; message: string; isError?: boolean }> {
	const messages: any[] = primary.requests[1]?.body?.messages ?? [];
	const results: Array<{ ok: boolean; error: string | null; message: string; isError?: boolean }> = [];
	for (const message of messages) {
		if (!Array.isArray(message?.content)) continue;
		for (const block of message.content) {
			if (block?.type !== 'tool_result') continue;
			results.push({ ...JSON.parse(block.content), isError: block.is_error });
		}
	}
	return results;
}

describe('runAssistantToolLoop — a day is not a time', () => {
	it('refuses the measured turn: no row lands, and the model is told to ask', async () => {
		toolCall = {
			name: 'create_task',
			input: { title: 'Finish the website proposal', due_at: FABRICATED_18_IST },
		};

		const { store, result } = await turn(MEASURED_TURN);

		// The fabricated time was refused, so nothing was written.
		expect(result.toolCalls.map((call) => `${call.name}:${call.ok}`)).toEqual(['create_task:false']);
		expect(result.toolCalls[0].error).toMatch(/clock time/i);
		expect(store.tasks ?? []).toHaveLength(0);

		// The refusal reached the model as an ordinary failed tool result, with
		// the instruction that lets it resolve the turn in one step.
		const [onTheWire] = toolResultsOnTheWire();
		expect(onTheWire.isError).toBe(true);
		expect(onTheWire.ok).toBe(false);
		expect(onTheWire.error).toMatch(/clock time/i);
		expect(onTheWire.message).toMatch(/ask them/i);
		expect(onTheWire.message).toMatch(/date and no clock time/i);

		// And what the user is left with is the §5 question, not a claim.
		expect(result.content).toContain('What time');
		expect(result.content).not.toMatch(/six o'clock|6 ?pm|18:00/i);
	});

	it('refuses the reminder too — the measured turn wrote both rows', async () => {
		toolCall = {
			name: 'create_reminder',
			input: { title: 'Call the client', trigger_at: FABRICATED_18_IST },
		};

		const { store, result } = await turn(MEASURED_TURN);

		expect(result.toolCalls.map((call) => `${call.name}:${call.ok}`)).toEqual(['create_reminder:false']);
		expect(store.reminders ?? []).toHaveLength(0);
	});

	it('still writes the row when the user did state the hour', async () => {
		toolCall = {
			name: 'create_task',
			input: { title: 'Finish the website proposal', due_at: FABRICATED_18_IST },
		};

		// The guard against over-refusal, through the whole loop: the same tool
		// call, on a turn that really did name the hour.
		const { store, result } = await turn('add a task to finish the website proposal at 6pm');

		expect(result.toolCalls.map((call) => `${call.name}:${call.ok}`)).toEqual(['create_task:true']);
		expect(store.tasks).toHaveLength(1);
		expect(new Date(store.tasks[0].dueAt as Date).toISOString()).toBe(FABRICATED_18_IST);
	});
});
