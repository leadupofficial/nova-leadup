/**
 * NOVA API — the correction a refused `create_reminder` hands back.
 *
 * A reminder in the past can never fire and is invisible to the
 * upcoming-reminders query, so the executor refuses it and asks the model to
 * recompute. That only works if the correction says *when* it is — and the
 * version that shipped said "the current time is Mon 21 Sept, 02:54 pm" with no
 * year, while the offending value was rendered the same way. Given a year-less
 * "now", the model produced a fresh 2025 date on all three retries and the loop
 * ended `capped: true` with the user seeing a reply that set a reminder and
 * denied setting it in the same breath.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { getDb } from '../db/connection.js';
import { USER_TIMEZONE } from '../services/user-context.js';
import { formatInZone } from '../services/assistant-datetime.js';
import { executeAssistantTool } from '../services/assistant-tool-executor.js';
import type { ToolUseBlock } from '../services/ai.js';

/** A model-supplied trigger that is unambiguously in the past. */
const PAST_TRIGGER = '2025-01-02T03:30:00.000Z';

const toolUse: ToolUseBlock = {
	id: 'toolu_test_1',
	name: 'create_reminder',
	input: {
		title: 'call the client about the website',
		trigger_at: PAST_TRIGGER,
	},
};

/** Fails the test loudly if a refused call reaches the database. */
function dbThatMustNotBeWritten(): void {
	vi.mocked(getDb).mockReturnValue({
		select: () => {
			throw new Error('a refused reminder must not read the database');
		},
		insert: () => {
			throw new Error('a refused reminder must not be written');
		},
	} as unknown as ReturnType<typeof getDb>);
}

/** Runs the refusal and returns the message the model would read. */
async function correction(): Promise<string> {
	dbThatMustNotBeWritten();
	const result = await executeAssistantTool('user-1', toolUse);
	expect(result.ok).toBe(false);
	return result.error ?? '';
}

afterEach(() => {
	vi.mocked(getDb).mockReset();
});

describe('create_reminder refuses a past trigger_at with a self-correcting message', () => {
	it('fails the call and writes nothing', async () => {
		const message = await correction();

		expect(message).toContain('is in the past');
	});

	it("includes the current time's year so the retry can recompute", async () => {
		const message = await correction();

		// The defect: no year anywhere in the correction, so "tomorrow" was
		// resolved against an unknown year and 2025 came back again.
		expect(message).toContain(String(new Date().getFullYear()));
	});

	it('states the current time as a full ISO date, not just a clock time', async () => {
		const message = await correction();

		// Exactly one instant, rendered as a complete ISO timestamp. This is what
		// makes the retry mechanical instead of a guess at the year.
		const iso = /current time is (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/.exec(message);
		expect(iso).not.toBeNull();
		expect(message).toContain(USER_TIMEZONE);

		// …and the same instant rendered in the user's own zone, by the same formatter the
		// implementation uses, so the year and the local date are both on screen.
		//
		// This assertion used to demand the user-local date in `YYYY-MM-DD` form, which the message
		// has never contained — it names the local *rendering* (`Tue, 22 Sept 2026, 12:00 am`), not a
		// second ISO date. It therefore passed only while the UTC date and the Asia/Kolkata date
		// happened to be the same day (05:30–24:00 IST) and failed for the other five and a half
		// hours of every day. It was found by a full-suite run at 00:00 IST, one minute after the
		// previous run passed, with no code change in between.
		expect(message).toContain(formatInZone(new Date(iso![1]), USER_TIMEZONE));
	});

	it('names the offending value with its own year', async () => {
		const message = await correction();

		expect(message).toContain(PAST_TRIGGER);
		expect(message).toContain('2025');
	});
});
