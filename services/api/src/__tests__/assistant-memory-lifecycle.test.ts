/**
 * NOVA API — memory correction and forgetting.
 *
 * Measured on a real device, in one conversation:
 *
 *   USER:  "Remember my favourite colour is blue"
 *   NOVA:  "Got it — your favourite colour is blue."
 *   USER:  "Actually my favourite colour is green, not blue"
 *   NOVA:  "Updated!"
 *   db:    BOTH rows in `memories`, both live
 *
 * The confirmation was true about the write and false about the state: nothing
 * was superseded, so the user now has two contradictory memories and a reply
 * that says otherwise. The sibling failure is worse in the other direction —
 * "Forget my favourite colour" was refused outright, because no delete path
 * existed at all, and the model has to say something.
 *
 * These tests pin the three properties: a correction leaves exactly **one** live
 * row, `forget_memory` takes a fact out of the live set without destroying the
 * row, and neither the model nor the loop may claim a memory changed when no
 * write happened.
 *
 * They run against `makeFilteringDb`, which honours `WHERE`. That matters here:
 * both verbs are scoped by `userId`, and the looser doubles in the suite ignore
 * `where`, so a forget that dropped `eq(memories.userId, userId)` would pass
 * against them while archiving somebody else's memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { getDb } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { executeAssistantTool, toolSummaryText, type ExecutedToolCall } from '../services/assistant-tool-executor.js';
import {
	ASSISTANT_TOOLS,
	ASSISTANT_TOOL_LEVELS,
	ASSISTANT_TOOLS_PROMPT,
	NOTHING_PERFORMED_REPLY,
	TOOL_LEVEL_PERSONAL_WRITE,
	claimsStateChange,
	groundAssistantReply,
	toolPermissionLevel,
} from '../services/assistant-tools.js';
import { buildUserContext } from '../services/user-context.js';
import { makeFilteringDb, type Row } from './helpers/tool-db.js';
import type { ToolUseBlock } from '../services/ai.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '33333333-3333-4333-8333-333333333333';

/**
 * The statuses `user-context.ts` renders into the assistant's grounding block,
 * copied here as the *observable* definition of "live": a row outside this set
 * cannot reach the model, which is the whole point of archiving rather than
 * deleting.
 */
const LIVE_STATUSES = ['proposed', 'approved', 'active', 'corrected'];

const BLUE = 'aaaaaaaa-1111-4111-8111-111111111111';
const COFFEE = 'bbbbbbbb-1111-4111-8111-111111111111';
const THEIRS = 'cccccccc-1111-4111-8111-111111111111';

function callFor(name: string, input: Record<string, unknown>): ToolUseBlock {
	return { id: `toolu_${name}`, name, input };
}

function memoryRow(overrides: Row = {}): Row {
	return {
		id: BLUE,
		userId: USER_A,
		category: 'preference',
		content: 'Favourite colour is blue',
		status: 'proposed',
		importance: 50,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	};
}

/** Installs the filtering double and hands back the store it will mutate. */
function dbWith(seed: Record<string, Row[]>): Record<string, Row[]> {
	const { db, store } = makeFilteringDb(seed);
	vi.mocked(getDb).mockReturnValue(db);
	return store;
}

/** The rows `user-context.ts` would actually render for this user. */
function live(store: Record<string, Row[]>): Row[] {
	return (store.memories ?? []).filter((row) => LIVE_STATUSES.includes(String(row.status)));
}

function rowById(store: Record<string, Row[]>, id: string): Row {
	const row = (store.memories ?? []).find((candidate) => candidate.id === id);
	expect(row, `expected a memories row with id ${id}`).toBeDefined();
	return row!;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	// `createMemory` fires the embedding hook without awaiting it; with no
	// provider configured that is an expected warning, not this suite's subject.
	warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
});

afterEach(() => {
	warnSpy.mockRestore();
	vi.mocked(getDb).mockReset();
});

// ─── save_memory: a correction supersedes, it does not append ───────────────

describe('save_memory — a correction replaces the fact it contradicts', () => {
	it('leaves exactly one live memory after the measured two-turn correction', async () => {
		const store = dbWith({});

		const first = await executeAssistantTool(
			USER_A,
			callFor('save_memory', { content: 'My favourite colour is blue', category: 'preference' }),
		);
		expect(first.ok).toBe(true);

		const second = await executeAssistantTool(
			USER_A,
			callFor('save_memory', {
				content: 'Actually my favourite colour is green, not blue',
				category: 'preference',
			}),
		);

		expect(second.ok).toBe(true);
		// The defect: this was 2, with "Updated!" in between.
		expect(live(store)).toHaveLength(1);
		// Nothing was destroyed — the superseded row is archived, not deleted.
		expect(store.memories).toHaveLength(2);

		const [current] = live(store);
		expect(String(current.content)).toContain('green');

		const superseded = store.memories!.find((row) => row.id !== current.id)!;
		expect(String(superseded.content)).toContain('blue');
		expect(String(superseded.status)).not.toBe('proposed');
		expect(LIVE_STATUSES).not.toContain(String(superseded.status));
	});

	it('tells the model which older fact it replaced, so "Updated" is backed by a result', async () => {
		const store = dbWith({
			memories: [memoryRow({ id: BLUE, content: 'My favourite colour is blue' })],
		});

		const result = await executeAssistantTool(
			USER_A,
			callFor('save_memory', {
				content: 'Actually my favourite colour is green, not blue',
				category: 'preference',
			}),
		);

		expect(result.ok).toBe(true);
		expect(Array.isArray(result.data?.superseded)).toBe(true);
		const superseded = result.data!.superseded as { memory_id: string }[];
		expect(superseded.map((entry) => entry.memory_id)).toEqual([BLUE]);
		expect(live(store)).toHaveLength(1);

		// The reply is the outcome: a write really happened, so the model's
		// "Updated" stands — and it is only true because of the assertion above.
		const grounded = groundAssistantReply('Updated — your favourite colour is green now.', [result]);
		expect(grounded.corrected).toBe(false);
		expect(grounded.text).toBe('Updated — your favourite colour is green now.');
	});

	it('supersedes a terse restatement too ("... is green", no mention of blue)', async () => {
		const store = dbWith({
			memories: [memoryRow({ content: 'My favourite colour is blue' })],
		});

		const result = await executeAssistantTool(
			USER_A,
			callFor('save_memory', { content: 'My favourite colour is green', category: 'preference' }),
		);

		expect(result.ok).toBe(true);
		expect(live(store)).toHaveLength(1);
		expect(String(live(store)[0].content)).toContain('green');
	});

	it('leaves an unrelated memory alone, even in the same category', async () => {
		const store = dbWith({
			memories: [memoryRow({ id: COFFEE, content: 'Lives in Chennai', category: 'fact' })],
		});

		const result = await executeAssistantTool(
			USER_A,
			callFor('save_memory', { content: 'Works in Chennai', category: 'fact' }),
		);

		expect(result.ok).toBe(true);
		// Two distinct facts about the same city are not a correction.
		expect(live(store)).toHaveLength(2);
		expect(String(rowById(store, COFFEE).status)).toBe('proposed');
	});

	it("never supersedes another user's memory", async () => {
		const store = dbWith({
			memories: [memoryRow({ id: THEIRS, userId: USER_B, content: 'My favourite colour is blue' })],
		});

		const result = await executeAssistantTool(
			USER_A,
			callFor('save_memory', { content: 'My favourite colour is green', category: 'preference' }),
		);

		expect(result.ok).toBe(true);
		expect(String(rowById(store, THEIRS).status)).toBe('proposed');
		expect(live(store)).toHaveLength(2); // theirs + the new one
	});
});

// ─── forget_memory ──────────────────────────────────────────────────────────

describe('forget_memory — the user can take a fact back', () => {
	it('archives the matching fact so it leaves the live set and the grounding block', async () => {
		const store = dbWith({
			memories: [
				memoryRow({ id: BLUE, content: 'Favourite colour is blue' }),
				memoryRow({ id: COFFEE, content: 'Likes filter coffee' }),
			],
		});

		const result = await executeAssistantTool(
			USER_A,
			callFor('forget_memory', { content: 'my favourite colour' }),
		);

		expect(result.ok).toBe(true);
		expect(String(rowById(store, BLUE).status)).not.toBe('proposed');
		expect(LIVE_STATUSES).not.toContain(String(rowById(store, BLUE).status));
		// The unrelated memory is untouched.
		expect(String(rowById(store, COFFEE).status)).toBe('proposed');
		// Reversible: the row survives, so nothing is destroyed by a misheard name.
		expect(store.memories).toHaveLength(2);

		const context = await buildUserContext(USER_A);
		expect(context.text).not.toContain('Favourite colour');
		expect(context.text).toContain('filter coffee');
		expect(context.counts.memories).toBe(1);
	});

	it('reports what it forgot, so the model can confirm it truthfully', async () => {
		dbWith({ memories: [memoryRow({ content: 'Favourite colour is blue' })] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('forget_memory', { content: 'favourite colour' }),
		);

		expect(result.ok).toBe(true);
		expect(result.data?.count).toBe(1);
		expect(result.summary).toContain('Favourite colour is blue');
	});

	it('refuses, and forgets nothing, when no saved memory matches', async () => {
		const store = dbWith({ memories: [memoryRow({ content: 'Favourite colour is blue' })] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('forget_memory', { content: 'the Algarve trip' }),
		);

		// A refusal, not a success with a caveat: a grounded "that didn't work"
		// is the only honest answer when the row does not exist.
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/no saved memory/i);
		expect(LIVE_STATUSES).toContain(String(rowById(store, BLUE).status));
	});

	it("never forgets another user's memory", async () => {
		const store = dbWith({
			memories: [memoryRow({ id: THEIRS, userId: USER_B, content: 'Favourite colour is blue' })],
		});

		const result = await executeAssistantTool(
			USER_A,
			callFor('forget_memory', { content: 'favourite colour' }),
		);

		expect(result.ok).toBe(false);
		expect(LIVE_STATUSES).toContain(String(rowById(store, THEIRS).status));
	});
});

// ─── Truthfulness: no claim without a write ─────────────────────────────────

describe('the reply never claims a memory changed when no write happened', () => {
	it.each([
		"I've deleted that memory.",
		"I've forgotten that.",
		'I deleted the memory about your colour preference.',
		'Your favourite colour is no longer saved.',
	])('flags %j as a state-change claim', (text) => {
		expect(claimsStateChange(text)).toBe(true);
	});

	it('replaces a deletion claim that no tool backs', () => {
		const grounded = groundAssistantReply("I've deleted that memory for you.", []);
		expect(grounded.corrected).toBe(true);
		expect(grounded.text).toBe(NOTHING_PERFORMED_REPLY);
	});

	it('does not believe a deletion claim when the forget tool refused', () => {
		const refused: ExecutedToolCall = {
			toolUseId: 'toolu_forget_memory',
			name: 'forget_memory',
			input: { content: 'the Algarve trip' },
			ok: false,
			summary: 'No saved memory matches that, so nothing was forgotten.',
			error: 'No saved memory matches that, so nothing was forgotten.',
		};

		const grounded = groundAssistantReply("I've deleted that memory.", [refused]);
		expect(grounded.corrected).toBe(true);
		// The claim is replaced by the executor's own account, which states the
		// memory was *not* deleted rather than that it was.
		expect(grounded.text).toMatch(/didn't work/i);
		expect(grounded.text).not.toMatch(/\bI've\b|\bdone\b/i);

		const summary = toolSummaryText([refused]);
		expect(summary).toMatch(/nothing was deleted from memory/i);
		// The internal tool name and the model-facing error must not leak.
		expect(summary).not.toMatch(/forget_memory|matches that/i);
	});
});

// ─── Registration and advertisement ────────────────────────────────────────

describe('forget_memory is registered, classified and advertised', () => {
	it('offers it to the model', () => {
		expect(ASSISTANT_TOOLS.map((tool) => tool.name)).toContain('forget_memory');
	});

	it('classifies it, with no strays on either side of the registry', () => {
		expect(Object.keys(ASSISTANT_TOOL_LEVELS).sort()).toEqual(
			ASSISTANT_TOOLS.map((tool) => tool.name).sort(),
		);
		expect(toolPermissionLevel('forget_memory')).toBe(TOOL_LEVEL_PERSONAL_WRITE);
	});

	it('requires the fact itself, because memories carry no id in the grounding block', () => {
		const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === 'forget_memory');
		expect(tool).toBeDefined();
		expect(tool!.input_schema.required).toContain('content');
	});

	it('tells the model in the prompt that it can forget things', () => {
		expect(ASSISTANT_TOOLS_PROMPT).toContain('forget_memory');
	});
});
