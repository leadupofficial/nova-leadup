/**
 * NOVA API — grounding block tests.
 *
 * The header exists to tell the model *when* it is. It is not a fact about the
 * user and it is not optional: a brand-new account has no tasks, no reminders
 * and no memories, and if the grounding string is empty for that account the
 * model has no year to anchor on. Reproduced live, it resolved "tomorrow" to a
 * 2025 date, every `create_reminder` was refused as "in the past", the loop
 * burned all three iterations and the reply contradicted itself.
 *
 * The shared mock in `./setup` ignores `where` and returns fixed fixtures, so it
 * cannot express "this user has nothing". These tests therefore install the
 * pipeline's in-memory Drizzle look-alike (`makeDb`) over `getDb`, which is the
 * same seam `recording-limits.test.ts` uses for the same reason.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { getDb } from '../db/connection.js';
import { USER_TIMEZONE, buildUserContext } from '../services/user-context.js';
import { makeDb } from './helpers/recording-fixtures.js';

/** The register-and-ask case from the bug report: no rows in any table. */
function withNothingStored(): void {
	vi.mocked(getDb).mockReturnValue(makeDb({}));
}

afterEach(() => {
	vi.mocked(getDb).mockReset();
});

describe('buildUserContext — the current time always reaches the model', () => {
	it('grounds a user with zero tasks, reminders and memories in the current date', async () => {
		withNothingStored();

		const context = await buildUserContext('brand-new-user');

		expect(context.counts).toEqual({ tasks: 0, reminders: 0, memories: 0 });
		expect(context.text).not.toBe('');
		expect(context.text).toContain('current time:');
		expect(context.text).toContain(`in ${USER_TIMEZONE}`);
		// The whole point: a 4-digit *current* year, not just a month and day.
		// Given no year at all the model wrote 2025 for "tomorrow".
		expect(context.text).toContain(String(new Date().getFullYear()));
	});

	it('still tells the user they have nothing stored', async () => {
		withNothingStored();

		const context = await buildUserContext('brand-new-user');

		expect(context.text).toContain('no open tasks');
		expect(context.text).toContain('no upcoming reminders');
		expect(context.text).toContain('nothing saved to memory');
	});

	it("states today's date in the user's timezone, not UTC", async () => {
		withNothingStored();

		const context = await buildUserContext('brand-new-user');

		const iso = new Intl.DateTimeFormat('en-CA', {
			timeZone: USER_TIMEZONE,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(new Date());
		expect(context.text).toContain(iso);
	});

	it('keeps the populated case: data sections plus the date header', async () => {
		const now = new Date();
		vi.mocked(getDb).mockReturnValue(
			makeDb({
				tasks: [
					{
						id: 'task-1',
						userId: 'user-1',
						title: 'test task',
						status: 'pending',
						dueAt: null,
						metadata: {},
						createdAt: now,
						updatedAt: now,
					},
					{
						id: 'task-2',
						userId: 'user-1',
						title: 'finished task',
						status: 'completed',
						dueAt: null,
						metadata: {},
						createdAt: now,
						completedAt: now,
						updatedAt: now,
					},
				],
			}),
		);

		const context = await buildUserContext('user-1');

		// Both are visible now. Completed tasks used to be filtered out of this
		// context, so the assistant had no id to reopen one with: "actually reopen
		// it" was answered with "I don't have the task ID … in my list", and on
		// another run the model bound a pending task's id and silently reopened the
		// wrong record.
		// Not an exact count: the test double does not emulate `WHERE`, so both
		// queries see every row. What matters is that the completed task reaches
		// the text, which the assertions below pin.
		expect(context.counts.tasks).toBeGreaterThanOrEqual(2);
		expect(context.text).toContain('Recently completed tasks:');
		expect(context.text).toContain('finished task');
		expect(context.text).toContain('task-2');
		// A completed task must not be described as outstanding.
		expect(context.text).toContain('completed');
		expect(context.text).toContain('current time:');
		expect(context.text).toContain(`in ${USER_TIMEZONE}`);
		expect(context.text).toContain('Open tasks:');
		expect(context.text).toContain('test task');
		// The populated path must not fall back to the "nothing stored" wording.
		expect(context.text).not.toContain('nothing saved to memory');
	});

	it('truncates the data tail without being able to drop the date header', async () => {
		withNothingStored();

		const context = await buildUserContext('brand-new-user', { maxChars: 40 });

		expect(context.text.length).toBeLessThanOrEqual(40);
		expect(context.text.startsWith('What you know about this user right now')).toBe(true);
	});
});
