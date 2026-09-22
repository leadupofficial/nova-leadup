/**
 * NOVA API — the assistant records a recurrence instead of discarding it.
 *
 * Measured on the acceptance run for §14: *"Remind me every Monday"* was refused
 * with *"I can only set it for a specific date and time rather than a recurring
 * schedule."* That answer was honest. `reminders.repeat_rule` existed as a column
 * and `CreateReminderSchema` accepted it, but the assistant's tool contract had
 * no field for it, `ASSISTANT_TOOLS_PROMPT` never mentioned recurrence, and the
 * executor wrote `repeatRule: null` on every insert — so the column was always
 * empty and no part of the system could ever have repeated anything.
 *
 * These tests pin the whole path from the model's end: the field is offered, the
 * prompt teaches the grammar, the executor stores the canonical rule instead of
 * null, a malformed rule is refused with a message that names what was wrong, and
 * the confirmation says the recurrence in words. They run against
 * `makeFilteringDb`, so the stored row is the real assertion, not the mock's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { getDb } from '../db/connection.js';
import { executeAssistantTool } from '../services/assistant-tool-executor.js';
import { ASSISTANT_TOOLS, ASSISTANT_TOOLS_PROMPT } from '../services/assistant-tools.js';
import { makeFilteringDb, type Row } from './helpers/tool-db.js';
import type { ToolUseBlock } from '../services/ai.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const REMINDER_A = 'aaaaaaaa-1111-4111-8111-111111111111';

/**
 * A frozen server clock, so the confirmation's "next one" is deterministic.
 * Deliberately not the real date: if the executor reaches for `new Date()` the
 * assertions below cannot accidentally pass.
 */
const FROZEN_NOW = new Date('2026-09-21T00:00:00.000Z');
/** 09:00 on Monday 1 March 2027 in Asia/Kolkata (UTC+05:30). */
const MONDAY_IST = '2027-03-01T03:30:00.000Z';

function callFor(name: string, input: Record<string, unknown>): ToolUseBlock {
	return { id: `toolu_${name}`, name, input };
}

function reminderRow(overrides: Row = {}): Row {
	return {
		id: REMINDER_A,
		userId: USER_A,
		title: 'Take the bins out',
		triggerAt: new Date(MONDAY_IST),
		timezone: 'Asia/Kolkata',
		repeatRule: null,
		dismissed: false,
		createdAt: new Date('2026-09-01T00:00:00.000Z'),
		...overrides,
	};
}

function dbWith(seed: Record<string, Row[]>): Record<string, Row[]> {
	const { db, store } = makeFilteringDb(seed);
	vi.mocked(getDb).mockReturnValue(db);
	return store;
}

function rows(store: Record<string, Row[]>, table: string): Row[] {
	return store[table] ?? [];
}

afterEach(() => {
	vi.mocked(getDb).mockReset();
});

// ─── create_reminder ────────────────────────────────────────────────────────

describe('create_reminder — a recurrence reaches the column', () => {
	it('stores "every Monday" instead of discarding it', async () => {
		// The exact defect: this call used to write `repeatRule: null`.
		const store = dbWith({ reminders: [] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('create_reminder', {
				title: 'Take the bins out',
				trigger_at: MONDAY_IST,
				timezone: 'Asia/Kolkata',
				repeat_rule: 'FREQ=WEEKLY;BYDAY=MO',
			}),
			{ now: FROZEN_NOW },
		);

		expect(result.ok).toBe(true);
		const row = rows(store, 'reminders')[0];
		expect(row.repeatRule).toBe('FREQ=WEEKLY;BYDAY=MO');
		expect(result.data?.repeat_rule).toBe('FREQ=WEEKLY;BYDAY=MO');
	});

	it('says the recurrence out loud in the confirmation', async () => {
		dbWith({ reminders: [] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('create_reminder', {
				title: 'Take the bins out',
				trigger_at: MONDAY_IST,
				timezone: 'Asia/Kolkata',
				repeat_rule: 'FREQ=WEEKLY;BYDAY=MO',
			}),
			{ now: FROZEN_NOW },
		);

		expect(result.ok).toBe(true);
		expect(result.summary).toMatch(/every Monday/);
		// The first occurrence is the trigger, so there is no separate "next one" to
		// name — but the words have to be there either way.
		expect(result.summary).toContain('Take the bins out');
	});

	it('stores a normalised rule whatever spelling the model sent', async () => {
		const store = dbWith({ reminders: [] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('create_reminder', {
				title: 'Stand-up',
				trigger_at: MONDAY_IST,
				timezone: 'Asia/Kolkata',
				repeat_rule: 'freq=weekly;byday=mo',
			}),
			{ now: FROZEN_NOW },
		);

		expect(result.ok).toBe(true);
		expect(rows(store, 'reminders')[0].repeatRule).toBe('FREQ=WEEKLY;BYDAY=MO');
	});

	it('still writes null when the user asked for no repeat at all', async () => {
		// The regression guard. Every one-shot reminder in the product goes down
		// this path, and `repeat_rule` has to stay empty for it.
		const store = dbWith({ reminders: [] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('create_reminder', {
				title: 'Call the bank',
				trigger_at: MONDAY_IST,
				timezone: 'Asia/Kolkata',
			}),
			{ now: FROZEN_NOW },
		);

		expect(result.ok).toBe(true);
		const row = rows(store, 'reminders')[0];
		expect(row.repeatRule).toBeNull();
		expect(result.summary).not.toMatch(/repeat|every /i);
	});

	it.each([
		['FREQ=YEARLY'],
		['every Monday'],
		['FREQ=WEEKLY'],
		['FREQ=MONTHLY;BYMONTHDAY=32'],
		['RRULE:FREQ=WEEKLY;BYDAY=MO'],
	])('refuses the malformed rule %j with something the model can act on', async (repeatRule) => {
		const store = dbWith({ reminders: [] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('create_reminder', {
				title: 'Take the bins out',
				trigger_at: MONDAY_IST,
				timezone: 'Asia/Kolkata',
				repeat_rule: repeatRule,
			}),
			{ now: FROZEN_NOW },
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/repeat_rule/);
		// A refused rule must leave no reminder behind: the user would otherwise get
		// a one-shot they never asked for, silently stripped of its repeat.
		expect(rows(store, 'reminders')).toHaveLength(0);
	});

	it('refuses "every 3 days", naming what the phone can actually repeat', async () => {
		// The format and the pure next-occurrence function both support intervals —
		// but `flutter_local_notifications` has no interval component, so the device
		// cannot repeat one with the app closed. Advertising it here would ship a
		// promise the other half of the stack cannot keep.
		const store = dbWith({ reminders: [] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('create_reminder', {
				title: 'Water the plants',
				trigger_at: MONDAY_IST,
				timezone: 'Asia/Kolkata',
				repeat_rule: 'FREQ=DAILY;INTERVAL=3',
			}),
			{ now: FROZEN_NOW },
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/every 3 days/);
		expect(result.error).toMatch(/every day|weekly|monthly/i);
		expect(rows(store, 'reminders')).toHaveLength(0);
	});
});

// ─── update_reminder ────────────────────────────────────────────────────────

describe('update_reminder — the rule can be added, changed and cleared', () => {
	it('adds a recurrence to an existing one-shot reminder', async () => {
		const store = dbWith({ reminders: [reminderRow()] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('update_reminder', { reminder_id: REMINDER_A, repeat_rule: 'FREQ=MONTHLY;BYMONTHDAY=1' }),
			{ now: FROZEN_NOW },
		);

		expect(result.ok).toBe(true);
		expect(rows(store, 'reminders')[0].repeatRule).toBe('FREQ=MONTHLY;BYMONTHDAY=1');
		expect(result.summary).toMatch(/every month on the 1st/);
	});

	it('clears the recurrence when the user says it should stop repeating', async () => {
		const store = dbWith({ reminders: [reminderRow({ repeatRule: 'FREQ=WEEKLY;BYDAY=MO' })] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('update_reminder', { reminder_id: REMINDER_A, repeat_rule: null }),
			{ now: FROZEN_NOW },
		);

		expect(result.ok).toBe(true);
		expect(rows(store, 'reminders')[0].repeatRule).toBeNull();
		expect(result.summary).toMatch(/no longer repeats|once/i);
	});

	it('leaves the rule untouched when the call does not mention it', async () => {
		// The regression guard for every other update: renaming a recurring reminder
		// must not quietly turn it into a one-shot.
		const store = dbWith({ reminders: [reminderRow({ repeatRule: 'FREQ=WEEKLY;BYDAY=MO' })] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('update_reminder', { reminder_id: REMINDER_A, title: 'Take the recycling out' }),
			{ now: FROZEN_NOW },
		);

		expect(result.ok).toBe(true);
		const row = rows(store, 'reminders')[0];
		expect(row.title).toBe('Take the recycling out');
		expect(row.repeatRule).toBe('FREQ=WEEKLY;BYDAY=MO');
	});

	it('names the next occurrence when the new rule moves off the trigger\'s day', async () => {
		// "Make it every Tuesday" leaves `trigger_at` on the Monday it already had.
		// The rule is what the phone repeats from, so the confirmation has to say the
		// next *actual* occurrence — Tuesday — rather than repeat the stored Monday.
		dbWith({ reminders: [reminderRow()] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('update_reminder', { reminder_id: REMINDER_A, repeat_rule: 'FREQ=WEEKLY;BYDAY=TU' }),
			{ now: FROZEN_NOW },
		);

		expect(result.ok).toBe(true);
		expect(result.summary).toMatch(/every Tuesday/);
		expect(result.summary).toMatch(/the next one is/);
		expect(result.summary).toMatch(/Tue/);
	});

	it('refuses a malformed rule and changes nothing', async () => {
		const store = dbWith({ reminders: [reminderRow({ repeatRule: 'FREQ=DAILY' })] });

		const result = await executeAssistantTool(
			USER_A,
			callFor('update_reminder', { reminder_id: REMINDER_A, title: 'Changed', repeat_rule: 'FREQ=FORTNIGHTLY' }),
			{ now: FROZEN_NOW },
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/repeat_rule/);
		const row = rows(store, 'reminders')[0];
		expect(row.repeatRule).toBe('FREQ=DAILY');
		expect(row.title).toBe('Take the bins out');
	});
});

// ─── Advertisement: schema and prompt ───────────────────────────────────────

describe('the recurrence is offered to the model and described in the prompt', () => {
	it.each(['create_reminder', 'update_reminder'])('%s has a repeat_rule field', (name) => {
		const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === name);
		expect(tool).toBeDefined();
		const properties = tool!.input_schema.properties as Record<string, { description?: string }>;
		expect(properties.repeat_rule).toBeDefined();
		// The model only picks a field it understands: the description has to spell
		// out the grammar, because there is no way to guess `FREQ=WEEKLY;BYDAY=MO`.
		const description = String(properties.repeat_rule.description);
		expect(description).toMatch(/FREQ=DAILY/);
		expect(description).toMatch(/FREQ=WEEKLY;BYDAY=/);
		expect(description).toMatch(/FREQ=MONTHLY;BYMONTHDAY=/);
	});

	it('does not make the recurrence required', () => {
		for (const name of ['create_reminder', 'update_reminder']) {
			const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === name);
			expect(tool!.input_schema.required ?? []).not.toContain('repeat_rule');
		}
	});

	it('teaches the vocabulary in the prompt line the routes append', () => {
		expect(ASSISTANT_TOOLS_PROMPT).toContain('repeat_rule');
		expect(ASSISTANT_TOOLS_PROMPT).toMatch(/every Monday/);
		// And the one case that has to be explained rather than stored silently.
		expect(ASSISTANT_TOOLS_PROMPT).toMatch(/31st|day of the month/i);
	});
});
