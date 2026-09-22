/**
 * NOVA API — snoozing a reminder, and the relative field that makes it work.
 *
 * Measured on a real device: "Snooze the plumber reminder by an hour" was
 * refused. The user was told NOVA could not do it — which was true of the tool
 * contract at the time, because `update_reminder` only accepted an *absolute*
 * ISO date-time. §31 of the acceptance criteria requires "Not now. Remind me
 * after lunch." to reschedule the reminder, and this is the single most common
 * thing a real user says to a reminder assistant.
 *
 * The fix is a relative field (`in_minutes`) resolved against the **server's**
 * clock — never the model's idea of "now" — and rendered in the reminder's own
 * timezone. These tests pin all three parts: the arithmetic (an exact offset
 * from an injected `now`), the timezone (the reminder's, not the user default),
 * and the advertisement (a schema field and a prompt line, without which the
 * model can never pick it).
 *
 * They run against `makeFilteringDb`, which honours `WHERE`, so the ownership
 * boundary on `(id, userId)` is a real assertion rather than a property of the
 * mock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { getDb } from '../db/connection.js';
import { executeAssistantTool } from '../services/assistant-tool-executor.js';
import { ASSISTANT_TOOLS, ASSISTANT_TOOLS_PROMPT } from '../services/assistant-tools.js';
import { USER_TIMEZONE } from '../services/user-context.js';
import { makeFilteringDb, type Row } from './helpers/tool-db.js';
import type { ToolUseBlock } from '../services/ai.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '33333333-3333-4333-8333-333333333333';
const REMINDER_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const UNKNOWN_ID = 'cccccccc-9999-4999-8999-999999999999';

/**
 * The frozen server clock. Deliberately *not* today: if the executor reaches
 * for `new Date()` instead of the injected instant, the assertion below cannot
 * accidentally pass.
 */
const FROZEN_NOW = new Date('2026-02-11T09:00:00.000Z');
const MINUTE_MS = 60_000;

function callFor(name: string, input: Record<string, unknown>): ToolUseBlock {
	return { id: `toolu_${name}`, name, input };
}

function reminderRow(overrides: Row = {}): Row {
	return {
		id: REMINDER_A,
		userId: USER_A,
		title: 'Call the plumber',
		// Already overdue when the user snoozes it.
		triggerAt: new Date('2026-02-11T08:00:00.000Z'),
		timezone: USER_TIMEZONE,
		dismissed: false,
		createdAt: new Date('2026-02-01T00:00:00.000Z'),
		...overrides,
	};
}

/** Installs the filtering double, freezes only this call's clock, runs it. */
async function snooze(
	input: Record<string, unknown>,
	seed: Record<string, Row[]> = { reminders: [reminderRow()] },
	userId = USER_A,
): Promise<{ store: Record<string, Row[]>; result: Awaited<ReturnType<typeof executeAssistantTool>> }> {
	const { db, store } = makeFilteringDb(seed);
	vi.mocked(getDb).mockReturnValue(db);
	const result = await executeAssistantTool(userId, callFor('update_reminder', input), {
		now: FROZEN_NOW,
	});
	return { store, result };
}

function theRow(store: Record<string, Row[]>): Row {
	const rows = store.reminders ?? [];
	expect(rows, 'expected exactly one reminders row').toHaveLength(1);
	return rows[0];
}

afterEach(() => {
	vi.mocked(getDb).mockReset();
});

// ─── The arithmetic ─────────────────────────────────────────────────────────

describe('update_reminder — a relative offset reschedules the reminder', () => {
	it('moves triggerAt forward by exactly the offset from the server clock', async () => {
		const { store, result } = await snooze({ reminder_id: REMINDER_A, in_minutes: 60 });

		expect(result.ok).toBe(true);
		expect(new Date(theRow(store).triggerAt as Date).getTime()).toBe(
			FROZEN_NOW.getTime() + 60 * MINUTE_MS,
		);
		expect(result.data?.trigger_at).toBe('2026-02-11T10:00:00.000Z');
	});

	it('snoozes by a half hour', async () => {
		const { store, result } = await snooze({ reminder_id: REMINDER_A, in_minutes: 30 });

		expect(result.ok).toBe(true);
		expect(new Date(theRow(store).triggerAt as Date).getTime()).toBe(
			FROZEN_NOW.getTime() + 30 * MINUTE_MS,
		);
	});

	it('ignores a stale absolute time and takes "after lunch" from now', async () => {
		// 90 minutes is what the model computes for "not now, remind me after
		// lunch" when the frozen clock reads 09:00 UTC (14:30 in Asia/Kolkata).
		const { store, result } = await snooze({ reminder_id: REMINDER_A, in_minutes: 90 });

		expect(result.ok).toBe(true);
		expect(new Date(theRow(store).triggerAt as Date).getTime()).toBe(
			FROZEN_NOW.getTime() + 90 * MINUTE_MS,
		);
	});

	it('states the new time in the reminder\'s own timezone, not the user default', async () => {
		// A reminder that belongs to New York stays a New York reminder. The
		// offset is a *duration*, so it is resolved against the server's instant
		// and only rendered in the zone the row already carries: 09:00Z + 1h is
		// 10:00Z, which is 05:00 in New York (EST, UTC-5) in February.
		const { store, result } = await snooze(
			{ reminder_id: REMINDER_A, in_minutes: 60 },
			{ reminders: [reminderRow({ timezone: 'America/New_York' })] },
		);

		expect(result.ok).toBe(true);
		expect(result.data?.timezone).toBe('America/New_York');
		expect(result.data?.trigger_at).toBe('2026-02-11T10:00:00.000Z');
		expect(String(result.data?.trigger_at_local)).toContain('05:00');
		expect(String(result.summary)).toContain('America/New_York');
		// The stored zone is unchanged — snoozing must not silently move a
		// reminder to the server's default zone.
		expect(theRow(store).timezone).toBe('America/New_York');
	});

	it('still accepts an absolute trigger_at, unchanged', async () => {
		const { store, result } = await snooze(
			{ reminder_id: REMINDER_A, trigger_at: '2026-02-11T14:30:00.000Z' },
		);

		expect(result.ok).toBe(true);
		expect(new Date(theRow(store).triggerAt as Date).toISOString()).toBe('2026-02-11T14:30:00.000Z');
	});
});

// ─── Refusals ───────────────────────────────────────────────────────────────

describe('update_reminder — a relative offset is validated like any other input', () => {
	it('refuses an absolute time and an offset in the same call', async () => {
		const { store, result } = await snooze({
			reminder_id: REMINDER_A,
			trigger_at: '2026-02-11T14:30:00.000Z',
			in_minutes: 60,
		});

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not both/i);
		expect(new Date(theRow(store).triggerAt as Date).getTime()).toBe(
			new Date('2026-02-11T08:00:00.000Z').getTime(),
		);
	});

	it.each([0, -30, 100_000, 1.5])('refuses %j minutes', async (inMinutes) => {
		const { store, result } = await snooze({ reminder_id: REMINDER_A, in_minutes: inMinutes });

		expect(result.ok).toBe(false);
		expect(new Date(theRow(store).triggerAt as Date).getTime()).toBe(
			new Date('2026-02-11T08:00:00.000Z').getTime(),
		);
	});

	it('refuses an id that does not exist', async () => {
		const { result } = await snooze({ reminder_id: UNKNOWN_ID, in_minutes: 60 });

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not found|no reminder/i);
	});

	it("refuses to snooze another user's reminder", async () => {
		const { store, result } = await snooze({ reminder_id: REMINDER_A, in_minutes: 60 }, undefined, USER_B);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not found|no reminder/i);
		expect(new Date(theRow(store).triggerAt as Date).getTime()).toBe(
			new Date('2026-02-11T08:00:00.000Z').getTime(),
		);
	});
});

// ─── Advertisement: schema and prompt ───────────────────────────────────────

describe('the relative field is offered to the model and described in the prompt', () => {
	it('is in the update_reminder JSON schema', () => {
		const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === 'update_reminder');
		expect(tool).toBeDefined();
		const properties = tool!.input_schema.properties as Record<string, { description?: string }>;
		expect(properties.in_minutes).toBeDefined();
		// The model only picks a field it understands: the description has to say
		// what the number means and where "now" comes from.
		expect(String(properties.in_minutes.description)).toMatch(/minutes/i);
		// And it must not require trigger_at, which is the field the measured
		// "snooze it by an hour" cannot fill in.
		expect(tool!.input_schema.required).toEqual(['reminder_id']);
	});

	it('is named in the prompt line the routes append', () => {
		expect(ASSISTANT_TOOLS_PROMPT).toContain('in_minutes');
		expect(ASSISTANT_TOOLS_PROMPT).toMatch(/snooze/i);
	});
});

/**
 * The fabricated-time guard.
 *
 * The prompt told the model to *resolve* "tomorrow" and said nothing about a day
 * given without a time, so the model supplied an hour. Measured in the §31 run,
 * with the row to prove it: the user said only *"tomorrow I need to finish the
 * website proposal and call the client"*, the reply was *"Both tasks are set for
 * tomorrow by six o'clock in the evening"*, and both rows were written with
 * `due_at` = 18:00 IST — a commitment time nobody stated. A time in the database
 * is indistinguishable from a time the user gave, and §5 names this exact case:
 * NOVA should ask, not invent.
 *
 * A prompt is not code, so this pins the instruction's presence rather than its
 * effect. The behavioural half lives in `scripts/probe-continuous-assistant.mjs`,
 * which fails the §31 phase-1 check if any row carries a time the user did not
 * give.
 */
describe('ASSISTANT_TOOLS_PROMPT — a day is not a time', () => {
	it('tells the model never to choose an hour the user did not give', () => {
		expect(ASSISTANT_TOOLS_PROMPT).toMatch(/a day on its own is not a time/i);
		expect(ASSISTANT_TOOLS_PROMPT).toMatch(/never say or store a\s+clock time they did not give/i);
		expect(ASSISTANT_TOOLS_PROMPT).toMatch(/ask for it in one\s+short question/i);
	});

	it('still tells it to resolve the day references it must resolve', () => {
		// The new rule must not read as "never resolve anything": the grounding
		// header supplies the current time, and a model that stops using it cannot
		// place "tomorrow" at all.
		expect(ASSISTANT_TOOLS_PROMPT).toMatch(/resolve "tomorrow"/);
	});
});
