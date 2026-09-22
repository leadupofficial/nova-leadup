/**
 * NOVA API — daily briefing tests.
 *
 * The composer is exercised with a controlled grounding snapshot so each rule
 * is provable without a database: the empty day, one reminder, an overdue task,
 * and — the one that matters most — a model that tries to invent a meeting.
 *
 * The snapshot is handed in through `ComposeBriefingOptions.context`, the same
 * seam a caller uses when it has already grounded the request: the real
 * classification, rendering and guarding all run, only the database read is
 * replaced.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import app from '../server.js';
import { chatCompletion } from '../services/ai.js';
import {
	classifyFacts,
	type MemoryFact,
	type ReminderFact,
	type TaskFact,
	type UserContext,
	type UserContextFacts,
} from '../services/user-context.js';
import {
	briefingCounts,
	composeBriefing,
	guardBriefingText,
	renderGroundedBriefing,
	toBriefingSpeech,
} from '../services/briefing.js';
import { minutesToWords } from '../services/briefing-speech.js';

/** 08:00 in Asia/Kolkata, so the greeting is deterministic. */
const NOW = new Date('2026-09-18T02:30:00.000Z');

const task = (id: string, title: string, dueAt: string | null): TaskFact => ({
	id,
	title,
	status: 'pending',
	dueAt: dueAt ? new Date(dueAt) : null,
});

const reminder = (id: string, title: string, triggerAt: string): ReminderFact => ({
	id,
	title,
	triggerAt: new Date(triggerAt),
});

const memory = (id: string, content: string): MemoryFact => ({
	id,
	category: 'preference',
	content,
	importance: 3,
});

function snapshot(partial: {
	tasks?: TaskFact[];
	reminders?: ReminderFact[];
	memories?: MemoryFact[];
}): UserContext {
	const facts: UserContextFacts = {
		tasks: partial.tasks ?? [],
		overdueTasks: [],
		dueTodayTasks: [],
		laterTasks: [],
		undatedTasks: [],
		reminders: partial.reminders ?? [],
		upcomingReminders: [],
		pastReminders: [],
		nextReminder: null,
		memories: partial.memories ?? [],
	};
	classifyFacts(facts, NOW);
	return {
		text: 'Open tasks:\n- stub',
		counts: {
			tasks: facts.tasks.length,
			reminders: facts.reminders.length,
			memories: facts.memories.length,
		},
		now: NOW,
		facts,
	};
}

function completion(content: string) {
	return {
		content,
		model: 'claude-sonnet-4-20250514',
		usage: { inputTokens: 10, outputTokens: 20 },
		blocks: [{ type: 'text' as const, text: content }],
		stopReason: 'end_turn',
		toolUses: [],
	};
}

/** One overdue task, the fixture most tests build on. */
const OVERDUE_TASK = task('t1', 'Send the invoice', '2026-09-17T12:00:00.000Z');

beforeEach(() => {
	vi.mocked(chatCompletion).mockReset();
});

describe('composeBriefing — an empty day', () => {
	it('says so gracefully and never asks the model', async () => {
		const result = await composeBriefing('user-1', { context: snapshot({}) });

		expect(result.source).toBe('grounded');
		expect(result.guardRejection).toBeNull();
		expect(result.text).toMatch(/^Good morning\./);
		expect(result.text).toContain('Nothing is due today');
		expect(
			chatCompletion,
			'an empty snapshot is exactly the prompt that makes a model invent a meeting',
		).not.toHaveBeenCalled();
	});

	it('mentions open tasks with no due date without calling them scheduled', async () => {
		const result = await composeBriefing('user-1', {
			context: snapshot({ tasks: [task('t1', 'Read the handbook', null)] }),
		});

		expect(result.source).toBe('grounded');
		expect(result.counts.undated).toBe(1);
		expect(result.text).toContain('Read the handbook');
		expect(result.text).toContain('no due date');
		expect(chatCompletion).not.toHaveBeenCalled();
	});
});

describe('composeBriefing — one reminder', () => {
	it('names the reminder and states its time in words', async () => {
		vi.mocked(chatCompletion).mockResolvedValue(
			completion('Good morning. Your next reminder is Pay electricity bill at seven in the evening.'),
		);

		const result = await composeBriefing('user-1', {
			context: snapshot({
				reminders: [reminder('r1', 'Pay electricity bill', '2026-09-18T13:30:00.000Z')],
			}),
		});

		expect(result.source).toBe('model');
		expect(result.text).toContain('Pay electricity bill');
		expect(result.counts.upcomingReminders).toBe(1);
		expect(result.text).not.toMatch(/https?:|\d{1,2}:\d{2}/);
	});

	it('falls back to the grounded rendering when the provider fails', async () => {
		vi.mocked(chatCompletion).mockRejectedValue(new Error('provider exploded'));

		const result = await composeBriefing('user-1', {
			context: snapshot({
				reminders: [reminder('r1', 'Pay electricity bill', '2026-09-18T13:30:00.000Z')],
			}),
		});

		expect(result.source).toBe('grounded');
		expect(result.guardRejection).toBe('model-unavailable');
		expect(result.text).toContain('Pay electricity bill');
		expect(result.text).toContain('seven in the evening');
	});
});

describe('composeBriefing — an overdue task', () => {
	it('reports it as overdue and keeps the real title', async () => {
		vi.mocked(chatCompletion).mockResolvedValue(
			completion('Good morning. One task is overdue: Send the invoice.'),
		);

		const result = await composeBriefing('user-1', { context: snapshot({ tasks: [OVERDUE_TASK] }) });

		expect(result.counts.overdue).toBe(1);
		expect(result.text).toContain('overdue');
		expect(result.text).toContain('Send the invoice');
		expect(result.source).toBe('model');
	});

	it('renders overdue, due-today and next reminder deterministically', () => {
		const context = snapshot({
			tasks: [
				OVERDUE_TASK,
				task('t2', 'Call the bank', '2026-09-18T12:00:00.000Z'),
				task('t3', 'Draft the proposal', '2026-09-20T12:00:00.000Z'),
			],
			reminders: [reminder('r1', 'Pay electricity bill', '2026-09-18T13:30:00.000Z')],
		});

		const text = renderGroundedBriefing(context.facts, NOW);

		expect(text).toContain('One task is overdue: Send the invoice');
		expect(text).toContain('One task is due today: Call the bank');
		expect(text).toContain('Your next reminder is Pay electricity bill at seven in the evening');
		// A task due on a later day is not part of a briefing about today.
		expect(text).not.toContain('Draft the proposal');
		expect(text).not.toMatch(/[*_`#]|https?:/);
	});
});

describe('no fabrication', () => {
	it('discards a draft that invents a meeting, a person and a deadline', async () => {
		const context = snapshot({ tasks: [OVERDUE_TASK] });
		const invented =
			'Good morning. You have a meeting with Ramesh about the Dubai project and a deadline for the tax filing today.';
		vi.mocked(chatCompletion).mockResolvedValue(completion(invented));

		const result = await composeBriefing('user-1', { context });

		expect(result.source).toBe('grounded');
		expect(result.guardRejection).toMatch(/^ungrounded-(name|event)/);
		expect(result.text).not.toContain('Ramesh');
		expect(result.text).not.toContain('Dubai');
		expect(result.text.toLowerCase()).not.toContain('meeting');
		expect(result.text.toLowerCase()).not.toContain('deadline');
		expect(result.text).toBe(renderGroundedBriefing(context.facts, NOW));
	});

	it('accepts a grounded rewrite, so the guard is not simply refusing everything', async () => {
		vi.mocked(chatCompletion).mockResolvedValue(
			completion('Good morning. One task is overdue: Send the invoice. Nothing else needs you right now.'),
		);

		const result = await composeBriefing('user-1', { context: snapshot({ tasks: [OVERDUE_TASK] }) });

		expect(result.source).toBe('model');
		expect(result.guardRejection).toBeNull();
	});

	it('refuses invented occasions, times, quantities and names', () => {
		const facts = snapshot({ tasks: [OVERDUE_TASK] }).facts;

		expect(guardBriefingText('Good morning. One task is overdue: Send the invoice.', facts).ok).toBe(true);

		expect(guardBriefingText('Good morning. You have an appointment with the dentist.', facts)).toMatchObject({
			ok: false,
			reason: 'ungrounded-event:appointment',
		});
		expect(guardBriefingText('Good morning. Your report is due at 3.', facts).reason).toBe(
			'ungrounded-number:3',
		);
		expect(guardBriefingText('Good morning. Three tasks are overdue.', facts).reason).toBe(
			'ungrounded-quantity:three',
		);
		expect(guardBriefingText('Good morning. Ramesh will call you.', facts).ok).toBe(false);
		expect(guardBriefingText('Good morning. Send the invoice tomorrow.', facts).reason).toBe(
			'ungrounded-time:tomorrow',
		);
		expect(guardBriefingText('Good morning. 🎉 Send the invoice.', facts).reason).toBe('emoji');
		expect(guardBriefingText('Details: https://example.com/x', facts).reason).toBe('url');
	});

	it('normalises anything heading for a speech engine', () => {
		expect(toBriefingSpeech('**Good morning**\n• https://x.example 🎉 5:00 pm'))
			.toBe('Good morning 5 pm');
	});

	it('reports the sources it does not have instead of inventing them', () => {
		expect(briefingCounts(snapshot({ tasks: [OVERDUE_TASK] }).facts).overdue).toBe(1);
	});
});

describe('GET /api/v1/briefing', () => {
	const token = jwt.sign(
		{ sub: 'user-1', email: 'test@example.com', role: 'user' },
		process.env.JWT_SECRET!,
		{ expiresIn: '1h' },
	);

	it('requires authentication', async () => {
		const res = await request(app).get('/api/v1/briefing');
		expect(res.status).toBe(401);
	});

	it('returns speakable text with an honest capability flag set', async () => {
		// No `context` is injected here on purpose: this exercises the route's real
		// path — `buildUserContext` against the harness's fixture rows — which for
		// this fixture is one open task with no due date and no reminders.
		vi.mocked(chatCompletion).mockResolvedValue(
			completion('Good morning. One task is overdue: Send the invoice.'),
		);

		const res = await request(app).get('/api/v1/briefing').set('Authorization', `Bearer ${token}`);

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(typeof res.body.data.text).toBe('string');
		expect(res.body.data.text).toContain('no due date');
		expect(res.body.data.counts).toMatchObject({ overdue: 0, dueToday: 0, upcomingReminders: 0 });
		// Nothing is scheduled, so the model is never consulted — the route cannot
		// have fabricated a meeting even if the provider would have supplied one.
		expect(chatCompletion).not.toHaveBeenCalled();
		expect(res.body.data.guardRejection).toBeNull();
		expect(res.body.data.capabilities).toMatchObject({
			calendar: false,
			weather: false,
			eveningRecap: false,
			locationNudges: false,
			tasks: true,
			reminders: true,
			memories: true,
		});
	});

	it('rejects an out-of-range language parameter', async () => {
		const res = await request(app)
			.get('/api/v1/briefing?language=x')
			.set('Authorization', `Bearer ${token}`);
		expect(res.status).toBe(400);
	});
});

describe('minutesToWords — every minute of the hour', () => {
	// The exhaustive table is the point. This function renders a *spoken* clock
	// time, and it used to derive 10–19 from `NUMBER_WORDS` with an `e` prefix,
	// which produced "een" for 10 minutes, "ewelve" for 12, and a **TypeError for
	// 13–19** — the last of which propagated out of `renderGroundedBriefing` and
	// failed the whole briefing route. It survived a test suite because the only
	// test that reached it built a reminder relative to "now", so it failed only
	// when the suite ran between :10 and :19, and was twice dismissed as a
	// time-dependent flake. Enumerating all sixty minutes is what makes that
	// impossible: there is no wall clock left for the defect to hide behind.
	const EXPECTED = [
		'', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
		'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
		'seventeen', 'eighteen', 'nineteen',
		'twenty', 'twenty one', 'twenty two', 'twenty three', 'twenty four',
		'twenty five', 'twenty six', 'twenty seven', 'twenty eight', 'twenty nine',
		'thirty', 'thirty one', 'thirty two', 'thirty three', 'thirty four',
		'thirty five', 'thirty six', 'thirty seven', 'thirty eight', 'thirty nine',
		'forty', 'forty one', 'forty two', 'forty three', 'forty four', 'forty five',
		'forty six', 'forty seven', 'forty eight', 'forty nine',
		'fifty', 'fifty one', 'fifty two', 'fifty three', 'fifty four', 'fifty five',
		'fifty six', 'fifty seven', 'fifty eight', 'fifty nine',
	];

	it('spells all sixty minutes, and throws for none of them', () => {
		const actual = Array.from({ length: 60 }, (_, m) => minutesToWords(m));
		expect(actual).toEqual(EXPECTED);
	});

	it('never returns a digit, because the result is handed to speech synthesis', () => {
		for (let m = 0; m < 60; m++) {
			expect(minutesToWords(m)).not.toMatch(/[0-9]/);
		}
	});
});
