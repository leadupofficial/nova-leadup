/**
 * NOVA API — the assistant's *management* verbs.
 *
 * The four create tools made NOVA able to add things and nothing else. Every
 * management request was refused out loud — "I don't have a way to edit an
 * existing reminder", "I'm unable to mark tasks as completed" — and in one
 * measured run "Okay, I finished the proposal" produced "That's great! One
 * down! 🎉" while the row stayed `pending`, because the model's own false claim
 * became conversation context and overrode the grounding facts.
 *
 * These tests pin the four new verbs (`update_reminder`, `cancel_reminder`,
 * `complete_task`, `reopen_task`), the registry entries the permission model
 * needs, and the prompt line that tells the model they exist.
 *
 * They run against `makeFilteringDb`, which honours `WHERE`. That matters more
 * than usual here: the whole point of an id-taking tool is that it must not
 * reach another user's row, and the two doubles already in the suite ignore
 * `where`, so a tool that dropped `eq(…userId, userId)` would pass against them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../server.js';
import { getDb } from '../db/connection.js';
import { executeAssistantTool } from '../services/assistant-tool-executor.js';
import { chatCompletion } from '../services/ai.js';
import {
	ASSISTANT_TOOLS,
	ASSISTANT_TOOL_LEVELS,
	ASSISTANT_TOOLS_PROMPT,
	TOOL_LEVEL_PERSONAL_WRITE,
	toolPermissionLevel,
} from '../services/assistant-tools.js';
import { makeFilteringDb, type Row } from './helpers/tool-db.js';
import type { ToolUseBlock } from '../services/ai.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '33333333-3333-4333-8333-333333333333';
const REMINDER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const TASK_A = 'bbbbbbbb-1111-4111-8111-111111111111';
/** Shaped like a uuid so only ownership — never format — can be the refusal. */
const UNKNOWN_ID = 'cccccccc-9999-4999-8999-999999999999';

const ORIGINAL_TRIGGER = new Date('2026-01-05T09:00:00.000Z');
const NEW_TRIGGER = '2026-02-11T14:30:00.000Z';

function callFor(name: string, input: Record<string, unknown>): ToolUseBlock {
	return { id: `toolu_${name}`, name, input };
}

function reminderRow(overrides: Row = {}): Row {
	return {
		id: REMINDER_A,
		userId: USER_A,
		title: 'Call the bank',
		triggerAt: ORIGINAL_TRIGGER,
		timezone: 'Asia/Kolkata',
		dismissed: false,
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	};
}

function taskRow(overrides: Row = {}): Row {
	return {
		id: TASK_A,
		userId: USER_A,
		title: 'Send the proposal',
		status: 'pending',
		completedAt: null,
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

function theRow(store: Record<string, Row[]>, table: string): Row {
	const rows = store[table] ?? [];
	expect(rows, `expected exactly one ${table} row`).toHaveLength(1);
	return rows[0];
}

afterEach(() => {
	vi.mocked(getDb).mockReset();
});

/**
 * The route-level test posts through the whole app, which needs a database
 * before the tool loop is ever reached. `setup.ts` mocks `getDb` as a plain
 * `vi.fn` with no default return, so once `afterEach` has reset it the route
 * 500s before the prompt is composed — put the shared builder back for that
 * one test rather than leaving it with no value.
 */
function restoreSharedDb(): void {
	const shared = makeFilteringDb({ tasks: [taskRow()] });
	vi.mocked(getDb).mockReturnValue(shared.db);
}

// ─── update_reminder ────────────────────────────────────────────────────────

describe('update_reminder — the assistant can change a reminder it already made', () => {
	it('reschedules an existing reminder and states the new time', async () => {
		const store = dbWith({ reminders: [reminderRow()] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('update_reminder', { reminder_id: REMINDER_A, trigger_at: NEW_TRIGGER }),
		);

		expect(result.ok).toBe(true);
		expect(new Date(theRow(store, 'reminders').triggerAt as Date).toISOString()).toBe(
			new Date(NEW_TRIGGER).toISOString(),
		);
	});

	it('retitles a reminder without moving its time', async () => {
		const store = dbWith({ reminders: [reminderRow()] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('update_reminder', { reminder_id: REMINDER_A, title: 'Call the bank manager' }),
		);

		expect(result.ok).toBe(true);
		const row = theRow(store, 'reminders');
		expect(row.title).toBe('Call the bank manager');
		expect(new Date(row.triggerAt as Date).toISOString()).toBe(ORIGINAL_TRIGGER.toISOString());
	});

	it('refuses an id that does not exist', async () => {
		const store = dbWith({ reminders: [reminderRow()] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('update_reminder', { reminder_id: UNKNOWN_ID, title: 'Nope' }),
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not found|no reminder/i);
		expect(theRow(store, 'reminders').title).toBe('Call the bank');
	});

	it("refuses to edit another user's reminder and leaves it untouched", async () => {
		const store = dbWith({ reminders: [reminderRow()] });

		const result = await executeAssistantTool(
			USER_B,
			callFor('update_reminder', { reminder_id: REMINDER_A, title: 'Hijacked' }),
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not found|no reminder/i);
		expect(theRow(store, 'reminders').title).toBe('Call the bank');
	});
});

// ─── cancel_reminder ────────────────────────────────────────────────────────

describe('cancel_reminder — the assistant stops a reminder firing', () => {
	it('marks the reminder dismissed, the same flag the app and the API use', async () => {
		const store = dbWith({ reminders: [reminderRow()] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('cancel_reminder', { reminder_id: REMINDER_A }),
		);

		expect(result.ok).toBe(true);
		// The row survives — `DELETE /reminders/:id` hard-deletes, while the
		// app's own Dismiss writes `dismissed`. Cancelling must match the
		// latter: `Restore` in the reminders screen has to still work.
		expect(theRow(store, 'reminders').dismissed).toBe(true);
	});

	it('refuses an id that does not exist', async () => {
		const store = dbWith({ reminders: [reminderRow()] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('cancel_reminder', { reminder_id: UNKNOWN_ID }),
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not found|no reminder/i);
		expect(theRow(store, 'reminders').dismissed).toBe(false);
	});

	it("refuses to cancel another user's reminder", async () => {
		const store = dbWith({ reminders: [reminderRow()] });

		const result = await executeAssistantTool(
			USER_B,
			callFor('cancel_reminder', { reminder_id: REMINDER_A }),
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not found|no reminder/i);
		expect(theRow(store, 'reminders').dismissed).toBe(false);
	});
});

// ─── complete_task / reopen_task ────────────────────────────────────────────

describe('complete_task — the assistant stops claiming it finished something it did not', () => {
	it('writes the real status the tasks API uses and stamps completed_at', async () => {
		const store = dbWith({ tasks: [taskRow()] });

		const result = await executeAssistantTool(USER_A, callFor('complete_task', { task_id: TASK_A }));

		expect(result.ok).toBe(true);
		const row = theRow(store, 'tasks');
		// 'completed' is the vocabulary in `routes/tasks.ts` and
		// `UpdateTaskSchema` — not an invented 'done'.
		expect(row.status).toBe('completed');
		expect(row.completedAt).toBeInstanceOf(Date);
	});

	it('refuses an id that does not exist', async () => {
		const store = dbWith({ tasks: [taskRow()] });

		const result = await executeAssistantTool(USER_A, callFor('complete_task', { task_id: UNKNOWN_ID }));

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not found|no task/i);
		expect(theRow(store, 'tasks').status).toBe('pending');
	});

	it("refuses to complete another user's task", async () => {
		const store = dbWith({ tasks: [taskRow()] });

		const result = await executeAssistantTool(USER_B, callFor('complete_task', { task_id: TASK_A }));

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not found|no task/i);
		expect(theRow(store, 'tasks').status).toBe('pending');
	});
});

describe('reopen_task — a completed task can be brought back', () => {
	it('returns a completed task to pending and clears completed_at', async () => {
		const store = dbWith({ tasks: [taskRow({ status: 'completed', completedAt: new Date() })] });

		const result = await executeAssistantTool(USER_A, callFor('reopen_task', { task_id: TASK_A }));

		expect(result.ok).toBe(true);
		const row = theRow(store, 'tasks');
		expect(row.status).toBe('pending');
		expect(row.completedAt).toBeNull();
	});

	it('refuses an id that does not exist', async () => {
		const store = dbWith({ tasks: [taskRow({ status: 'completed' })] });

		const result = await executeAssistantTool(USER_A, callFor('reopen_task', { task_id: UNKNOWN_ID }));

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not found|no task/i);
		expect(theRow(store, 'tasks').status).toBe('completed');
	});

	it("refuses to reopen another user's task", async () => {
		const store = dbWith({ tasks: [taskRow({ status: 'completed' })] });

		const result = await executeAssistantTool(USER_B, callFor('reopen_task', { task_id: TASK_A }));

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not found|no task/i);
		expect(theRow(store, 'tasks').status).toBe('completed');
	});
});

// ─── The permission registry and the prompt ─────────────────────────────────

describe('the new verbs are registered, classified and advertised', () => {
	const NEW_VERBS = ['update_reminder', 'cancel_reminder', 'complete_task', 'reopen_task'];

	it('offers every new verb to the model', () => {
		const offered = ASSISTANT_TOOLS.map((tool) => tool.name);
		expect(offered).toEqual(expect.arrayContaining(NEW_VERBS));
	});

	it('classifies each new verb in the level map with no strays on either side', () => {
		expect(Object.keys(ASSISTANT_TOOL_LEVELS).sort()).toEqual(
			ASSISTANT_TOOLS.map((tool) => tool.name).sort(),
		);
		for (const verb of NEW_VERBS) {
			expect(toolPermissionLevel(verb)).toBe(TOOL_LEVEL_PERSONAL_WRITE);
		}
	});

	it('gives every new verb a JSON schema that requires its target id', () => {
		for (const verb of NEW_VERBS) {
			const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === verb);
			expect(tool, `${verb} must be defined`).toBeDefined();
			expect(tool!.input_schema.required).toContain(verb.endsWith('_reminder') ? 'reminder_id' : 'task_id');
		}
	});

	it('tells the model in the prompt that it can edit, cancel, complete and reopen', () => {
		// The old string enumerated only the three create tools, so the model
		// kept answering "I don't have a way to edit an existing reminder".
		for (const verb of NEW_VERBS) {
			expect(ASSISTANT_TOOLS_PROMPT).toContain(verb);
		}
		expect(ASSISTANT_TOOLS_PROMPT).not.toMatch(/only (create|create things)/i);
	});

	it('reaches the provider inside the system prompt, not just as an exported string', async () => {
		vi.mocked(chatCompletion).mockClear();
		restoreSharedDb();
		const token = jwt.sign(
			{ sub: USER_A, email: 'test@example.com', role: 'user' },
			process.env.JWT_SECRET!,
			{ expiresIn: '1h' },
		);

		await request(app)
			.post('/api/v1/chat/message')
			.set({ Authorization: `Bearer ${token}` })
			.send({ sessionId: '11111111-1111-4111-8111-111111111111', content: 'cancel that reminder' });

		const calls = vi.mocked(chatCompletion).mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		const systemPrompt = String((calls[calls.length - 1][1] as { systemPrompt?: string })?.systemPrompt ?? '');
		for (const verb of NEW_VERBS) {
			expect(systemPrompt).toContain(verb);
		}
	});
});
