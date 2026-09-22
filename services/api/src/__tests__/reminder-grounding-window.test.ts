/**
 * NOVA API — reminders older than a day must not vanish from grounding.
 *
 * The query behind `buildUserContext` bounded reminders with
 * `gte(reminders.triggerAt, now - 24h)`, so anything overdue by more than a day
 * was invisible to both the model and the briefing. Measured consequence: with
 * reminders 1 and 2 days overdue in the database, "What is overdue?" answered
 * "none of your reminders are overdue" and `GET /api/v1/briefing` returned
 * `"overdue": 0, "missedReminders": 0`. A proactive assistant that cannot see
 * last week's missed items is not proactive.
 *
 * The bound stays — a 30-day window — but it must be wide enough to still see
 * yesterday and last week, and the limit must be spent on the most *recent*
 * items so a large backlog cannot crowd out today's relevant ones.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { getDb } from '../db/connection.js';
import { buildUserContext } from '../services/user-context.js';
import { composeBriefing } from '../services/briefing.js';
import { makeFilteringDb, type Row } from './helpers/tool-db.js';

const USER = '11111111-1111-4111-8111-111111111111';
const DAY = 24 * 60 * 60 * 1000;

/**
 * A fixed "now" for every case in this file.
 *
 * This is the file that hid a real production defect for two rounds. The briefing
 * renders a *spoken* clock time, and `minutesToWords` crashed for minutes :13–:19 —
 * but the rows here were built from `Date.now()`, so the rendered minute moved with
 * the wall clock and the failure only appeared when the suite happened to run in
 * that window. It was recorded twice as a "time-dependent flake" and was in fact
 * deterministic (see `briefing-speech.ts`).
 *
 * The crash is fixed and the assertions here are title-based rather than
 * time-string-based, so this file is not flaky today. It is pinned anyway, because
 * "not flaky today" is exactly what a future assertion about the rendered text
 * would stop being true of. 12:00 IST on a Monday, so the day-of-week and the
 * time-of-day are both unambiguous.
 */
const NOW = new Date('2026-09-21T06:30:00.000Z');

function reminderRow(id: string, title: string, triggerAt: Date, overrides: Row = {}): Row {
	return {
		id,
		userId: USER,
		title,
		triggerAt,
		timezone: 'Asia/Kolkata',
		dismissed: false,
		createdAt: new Date(triggerAt.getTime() - DAY),
		...overrides,
	};
}

function dbWith(seed: Record<string, Row[]>): void {
	vi.mocked(getDb).mockReturnValue(makeFilteringDb(seed).db);
}

afterEach(() => {
	vi.mocked(getDb).mockReset();
});

describe('buildUserContext — a reminder three days past is still grounding', () => {
	it('includes it in the grounding block instead of answering "nothing overdue"', async () => {
		const threeDaysAgo = new Date(NOW.getTime() - 3 * DAY);
		dbWith({ reminders: [reminderRow('r-old', 'Pay the electricity bill', threeDaysAgo)] });

		const context = await buildUserContext(USER, {}, NOW);

		// The defect: `trigger_at >= now - 24h` filtered this row out, so the
		// block never mentioned it and counts.reminders was 0.
		expect(context.text).toContain('Pay the electricity bill');
		expect(context.counts.reminders).toBe(1);
	});

	it('classifies it as past rather than upcoming, so "overdue" can be reasoned about', async () => {
		const threeDaysAgo = new Date(NOW.getTime() - 3 * DAY);
		dbWith({ reminders: [reminderRow('r-old', 'Pay the electricity bill', threeDaysAgo)] });

		const context = await buildUserContext(USER, {}, NOW);

		expect(context.facts.pastReminders.map((r) => r.title)).toContain('Pay the electricity bill');
		expect(context.facts.upcomingReminders).toHaveLength(0);
	});

	it('still sees yesterday, and a future reminder, in the same snapshot', async () => {
		dbWith({
			reminders: [
				reminderRow('r-2d', 'Two days missed', new Date(NOW.getTime() - 2 * DAY)),
				reminderRow('r-1d', 'Yesterday missed', new Date(NOW.getTime() - DAY)),
				reminderRow('r-future', 'Tomorrow', new Date(NOW.getTime() + DAY)),
			],
		});

		const context = await buildUserContext(USER, {}, NOW);

		expect(context.counts.reminders).toBe(3);
		expect(context.facts.pastReminders).toHaveLength(2);
		expect(context.facts.upcomingReminders.map((r) => r.title)).toEqual(['Tomorrow']);
	});

	it('keeps a genuinely ancient reminder out of the block', async () => {
		// The window is bounded on purpose: a reminder from last year is
		// history, not something to flag every single turn.
		dbWith({ reminders: [reminderRow('r-ancient', 'Last year', new Date(NOW.getTime() - 400 * DAY))] });

		const context = await buildUserContext(USER, {}, NOW);

		expect(context.text).not.toContain('Last year');
		expect(context.counts.reminders).toBe(0);
	});

	it('spends the limit on the most recent overdue reminders, not the oldest', async () => {
		// The query orders by `trigger_at`, so an ascending order fills the
		// budget with the *oldest* backlog and drops today's items — exactly
		// backwards for a proactive assistant.
		const reminders = Array.from({ length: 5 }, (_, index) =>
			reminderRow(`r-${index}`, `Missed ${index + 1} days ago`, new Date(NOW.getTime() - (index + 1) * DAY)),
		);
		dbWith({ reminders });

		const context = await buildUserContext(USER, { maxReminders: 2 });

		expect(context.counts.reminders).toBe(2);
		expect(context.facts.pastReminders.map((r) => r.title)).toEqual([
			'Missed 1 days ago',
			'Missed 2 days ago',
		]);
	});

	it('never lets a large backlog blow the prompt budget', async () => {
		const reminders = Array.from({ length: 200 }, (_, index) =>
			reminderRow(`r-${index}`, `Backlog item ${index}`, new Date(NOW.getTime() - (index + 1) * DAY)),
		);
		dbWith({ reminders });

		const context = await buildUserContext(USER, {}, NOW);

		expect(context.text.length).toBeLessThanOrEqual(4000);
		expect(context.counts.reminders).toBeLessThanOrEqual(12);
	});

	it('leaves a dismissed reminder out even when it is recent', async () => {
		dbWith({
			reminders: [reminderRow('r-dismissed', 'Already dismissed', new Date(NOW.getTime() - 2 * DAY), { dismissed: true })],
		});

		const context = await buildUserContext(USER, {}, NOW);

		expect(context.text).not.toContain('Already dismissed');
		expect(context.counts.reminders).toBe(0);
	});
});

describe('briefing — a reminder three days past is counted, not reported as zero', () => {
	it('counts it as missed and names it in the briefing text', async () => {
		const threeDaysAgo = new Date(NOW.getTime() - 3 * DAY);
		dbWith({ reminders: [reminderRow('r-old', 'Pay the electricity bill', threeDaysAgo)] });

		// The grounded snapshot is handed in rather than rebuilt, which is the seam
		// `composeBriefing` documents for a caller that has already grounded the
		// request — and it is the only way to give the briefing the same fixed
		// instant the rows were built from, so nothing in this file reads the clock.
		const context = await buildUserContext(USER, {}, NOW);
		const result = await composeBriefing(USER, { context });

		// The measured defect: `missedReminders` was 0 for anything over a day.
		expect(result.counts.missedReminders).toBe(1);
		expect(result.text).toContain('Pay the electricity bill');
	});
});
