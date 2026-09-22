/**
 * NOVA API — a clock time the user never gave is refused, not stored.
 *
 * The measured defect, with the row that proves it. The user said, in a live §31
 * run:
 *
 *   "NOVA, tomorrow I need to finish the website proposal and call the client."
 *
 * No hour, no clock time, no part of the day. NOVA answered *"Both tasks are set
 * for tomorrow by six o'clock in the evening"* and wrote 18:00 IST into both
 * rows. §5 names this case and the behaviour it wants — *"Sure. What time
 * tomorrow morning would you like me to remind you?"* — and a prompt sentence
 * asking the model not to do it did not stop it, because a prompt is a request
 * and this needs a deterministic guard.
 *
 * So the guard is here, in two halves:
 *
 *  1. `stated-time.ts` answers whether the user's *own turn* stated a clock time,
 *     a part of the day, or neither. The load-bearing distinction is that a day
 *     is not a time and a count is not a time: "tomorrow" is a day, "2 tasks" is
 *     a count, and neither may license an hour.
 *  2. The executor consults it before it parses a supplied `due_at`/`trigger_at`
 *     into a row. A clock time the turn never stated comes back as the ordinary
 *     failed tool result the model can act on in one step.
 *
 * The negative half matters more than the positive one: a user who *did* give a
 * time must not be refused, or the guard has traded a fabrication for an
 * inability to take a reminder. Both directions are pinned below, in the helper
 * and through the real executor against `makeFilteringDb`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import './setup.js';
import { getDb } from '../db/connection.js';
import { executeAssistantTool } from '../services/assistant-tool-executor.js';
import { clockTimeInDateTime, statedTimeIn } from '../services/stated-time.js';
import { makeFilteringDb, type Row } from './helpers/tool-db.js';
import type { ToolUseBlock } from '../services/ai.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const REMINDER_A = 'aaaaaaaa-1111-4111-8111-111111111111';

/** The turn from the bug report, verbatim: a day, and nothing else. */
const MEASURED_TURN = 'tomorrow I need to finish the website proposal and call the client';

/** A date on its own. `parseDateTime` resolves it to midnight in the user zone. */
const DATE_ONLY = '2030-09-22';

/**
 * The hour the model invented for the measured turn, exactly as it was stored:
 * `2030-09-22T12:30Z` is 18:00 in Asia/Kolkata — "six o'clock in the evening".
 * Far enough in the future that the executor's past-date refusal cannot be what
 * a failing test is actually observing.
 */
const FABRICATED_18_IST = '2030-09-22T12:30:00.000Z';

function callFor(name: string, input: Record<string, unknown>): ToolUseBlock {
	return { id: `toolu_${name}`, name, input };
}

function reminderRow(overrides: Row = {}): Row {
	return {
		id: REMINDER_A,
		userId: USER_A,
		title: 'Call the plumber',
		triggerAt: new Date('2030-01-01T08:00:00.000Z'),
		timezone: 'Asia/Kolkata',
		dismissed: false,
		createdAt: new Date('2030-01-01T00:00:00.000Z'),
		...overrides,
	};
}

/** Installs the filtering double and runs one tool call with the user's turn. */
async function run(
	name: string,
	input: Record<string, unknown>,
	userTurn: string | undefined,
	seed: Record<string, Row[]> = {},
): Promise<{ store: Record<string, Row[]>; result: Awaited<ReturnType<typeof executeAssistantTool>> }> {
	const { db, store } = makeFilteringDb(seed);
	vi.mocked(getDb).mockReturnValue(db);
	const result = await executeAssistantTool(USER_A, callFor(name, input), { userTurn });
	return { store, result };
}

afterEach(() => {
	vi.mocked(getDb).mockReset();
});

// ─── The helper: what the user's own words stated ───────────────────────────

describe('statedTimeIn — a clock time the user actually stated', () => {
	it.each([
		'6pm',
		'6 pm',
		'remind me at 6 pm',
		'18:00',
		'tomorrow at 10:30',
		'10:30',
		'half past nine',
		'quarter to seven',
		"7 o'clock",
		'9 மணிக்கு',
		'நாளைக்கு 10 மணிக்கு',
		'9 manikku',
		'tomorrow at 9',
		'by 7',
		'noon',
		'midnight',
		// Every Indian language NOVA can transcribe, not just Tamil. Measured on
		// a real handset: with only the Tamil patterns present, `create_reminder`
		// failed on every Hindi, Telugu, Kannada and Bengali turn — the user had
		// named an hour, the guard read the turn as naming none, and it refused
		// the model's correct answer as an invention, three times, to the cap.
		'कल सुबह 8 बजे का रिमाइंडर लगा दो',
		'రేపు ఉదయం ఎనిమిది గంటలకు రిమైండర్ పెట్టు',
		'ನಾಳೆ ಬೆಳಿಗ್ಗೆ 8 ಗಂಟೆಗೆ ರಿಮೈಂಡರ್ ಹಾಕು',
		'আগামীকাল সকাল আটটায় একটা রিমাইন্ডার সেট করো',
		'उद्या सकाळी 8 वाजता रिमाइंडर लाव',
		'നാളെ രാവിലെ 8 മണിക്ക് ഒരു റിമൈൻഡർ വെക്കൂ',
		'કાલે સવારે 8 વાગ્યે રિમાઇન્ડર મૂકો',
		'ਕੱਲ੍ਹ ਸਵੇਰੇ 8 ਵਜੇ ਰਿਮਾਈਂਡਰ ਲਗਾਓ',
		'ଆସନ୍ତାକାଲି ସକାଳ 8 ଟାରେ ରିମାଇଣ୍ଡର',
		// Tamil writing the English word phonetically, which is what Sarvam
		// returns for a Tanglish "eight o'clock".
		'நாளைக்கு மார்னிங் 8 ஓ கிளாக் ஒரு ரிமைண்டர்',
		// Hinglish, typed the way a person types it.
		'Kal subah 8 baje ka reminder lagao',
	])('reads %j as a clock time', (turn) => {
		expect(statedTimeIn(turn).kind).toBe('clock_time');
	});

	it('quotes the words that decided it, so a refusal can name them', () => {
		expect(statedTimeIn('remind me at 6pm').evidence).toBe('6pm');
		expect(statedTimeIn('half past nine please').evidence).toBe('half past nine');
	});
});

describe('statedTimeIn — a part of the day, which is not an hour', () => {
	it.each([
		'tomorrow morning',
		'tomorrow afternoon',
		'tomorrow evening',
		'tomorrow night',
		'நாளைக்கு காலை',
		'நாளை மாலை',
		'naalai kaalai',
		// The same part of the day in the other languages Sarvam transcribes.
		'कल सुबह',
		'రేపు ఉదయం',
		'ನಾಳೆ ಬೆಳಿಗ್ಗೆ',
		'আগামীকাল সকাল',
		'നാളെ രാവിലെ',
		'उद्या सकाळी',
		'કાલે સવારે',
		'kal subah',
	])('reads %j as a part of the day', (turn) => {
		expect(statedTimeIn(turn).kind).toBe('part_of_day');
	});

	it('still prefers a clock time when the turn gave one as well', () => {
		// "tomorrow morning at 9" states the hour; refusing it would be the guard
		// refusing a time the user did give.
		expect(statedTimeIn('tomorrow morning at 9').kind).toBe('clock_time');
		expect(statedTimeIn('காலை 9 மணிக்கு').kind).toBe('clock_time');
	});
});

describe('statedTimeIn — numbers that are not times', () => {
	it.each([
		// The measured turn: a day, and no time at all.
		MEASURED_TURN,
		'tomorrow',
		'Wednesday',
		'next Monday',
		'22/09',
		// Counts, which is the other half of the distinction.
		'add 2 tasks',
		'5 reminders',
		'call Kumar 2',
		'finish 3 tasks and call Kumar 2',
		// A phone number has no hour in it.
		'call 9876543210',
		'call +91 98765 43210',
		// The guard has to keep refusing in the new scripts too, or widening it
		// would just have replaced one failure with the other: a day and a task,
		// still no hour.
		'कल वेबसाइट प्रोपोजल पूरा करना है',
		'రేపు వెబ్‌సైట్ ప్రపోజల్ పూర్తి చేయాలి',
		'ನಾಳೆ ವೆಬ್‌ಸೈಟ್ ಪ್ರಸ್ತಾವನೆ ಮುಗಿಸಬೇಕು',
	])('reads %j as no stated time', (turn) => {
		expect(statedTimeIn(turn).kind).toBe('none');
	});

	it('reads an absent or empty turn as no stated time', () => {
		expect(statedTimeIn(undefined).kind).toBe('none');
		expect(statedTimeIn('').kind).toBe('none');
	});
});

describe('clockTimeInDateTime — does the value the model sent carry an hour', () => {
	it('finds the hour in a date-time', () => {
		expect(clockTimeInDateTime(FABRICATED_18_IST)).toBe('12:30');
		expect(clockTimeInDateTime('2026-09-19 17:00')).toBe('17:00');
	});

	it('finds no hour in a date on its own', () => {
		expect(clockTimeInDateTime(DATE_ONLY)).toBeNull();
		expect(clockTimeInDateTime(undefined)).toBeNull();
		expect(clockTimeInDateTime('')).toBeNull();
	});
});

// ─── The executor: create_task ──────────────────────────────────────────────

describe('create_task — an hour the user never gave is refused', () => {
	it('refuses the measured turn, and writes no row', async () => {
		const { store, result } = await run(
			'create_task',
			{ title: 'Finish the website proposal', due_at: FABRICATED_18_IST },
			MEASURED_TURN,
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/clock time/i);
		// The message has to be actionable in one step: record it with no time, or ask.
		expect(result.error).toMatch(/ask them/i);
		expect(result.error).toMatch(/date and no clock time/i);
		// Nothing was written — a refused call leaves no row behind.
		expect(store.tasks ?? []).toHaveLength(0);
	});

	it('allows the same call with no due_at at all', async () => {
		const { store, result } = await run('create_task', { title: 'Finish the website proposal' }, MEASURED_TURN);

		expect(result.ok).toBe(true);
		expect(store.tasks).toHaveLength(1);
		expect(store.tasks[0].dueAt).toBeNull();
	});

	it('allows the same call with a date on its own', async () => {
		const { store, result } = await run(
			'create_task',
			{ title: 'Finish the website proposal', due_at: DATE_ONLY },
			MEASURED_TURN,
		);

		expect(result.ok).toBe(true);
		expect(store.tasks).toHaveLength(1);
		expect(store.tasks[0].dueAt).toBeInstanceOf(Date);
	});

	it('refuses an invented hour on a part-of-day turn, and says which part', async () => {
		const { store, result } = await run(
			'create_task',
			{ title: 'Finish the website proposal', due_at: FABRICATED_18_IST },
			'tomorrow morning',
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/part of the day/i);
		expect(result.error).toMatch(/morning/);
		expect(store.tasks ?? []).toHaveLength(0);
	});

	it('allows the hour when the user stated one', async () => {
		const { store, result } = await run(
			'create_task',
			{ title: 'Call the client', due_at: FABRICATED_18_IST },
			'remind me at 6pm to call the client',
		);

		expect(result.ok).toBe(true);
		expect(store.tasks).toHaveLength(1);
	});

	it('still refuses the hour when the turn only counted things', async () => {
		// The other half of "a count is not a time": these numbers must not be
		// mistaken for the hour the model chose.
		for (const turn of ['add 2 tasks', 'call Kumar 2', 'remind me 5 times']) {
			const { store, result } = await run(
				'create_task',
				{ title: 'Finish the website proposal', due_at: FABRICATED_18_IST },
				turn,
			);
			expect(result.ok, turn).toBe(false);
			expect(store.tasks ?? [], turn).toHaveLength(0);
		}
	});
});

// ─── The executor: create_reminder ──────────────────────────────────────────

describe('create_reminder — an hour the user never gave is refused', () => {
	it('refuses the measured turn, and writes no row', async () => {
		const { store, result } = await run(
			'create_reminder',
			{ title: 'Call the client', trigger_at: FABRICATED_18_IST },
			MEASURED_TURN,
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/clock time/i);
		// `trigger_at` is required on this tool, so the one-step route has to be a
		// date on its own — "leave the field out" would only produce a schema error.
		expect(result.error).toMatch(/date on its own/i);
		expect(result.error).toMatch(/ask them/i);
		expect(store.reminders ?? []).toHaveLength(0);
	});

	it('refuses a part-of-day turn with an invented hour', async () => {
		const { store, result } = await run(
			'create_reminder',
			{ title: 'Call the client', trigger_at: FABRICATED_18_IST },
			'tomorrow morning',
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/part of the day/i);
		expect(store.reminders ?? []).toHaveLength(0);
	});

	it('allows a date on its own, which is what "leave it unset" looks like for a reminder', async () => {
		const { store, result } = await run(
			'create_reminder',
			{ title: 'Call the client', trigger_at: DATE_ONLY },
			MEASURED_TURN,
		);

		expect(result.ok).toBe(true);
		expect(store.reminders).toHaveLength(1);
	});

	it('allows a time the user did state', async () => {
		const { result } = await run(
			'create_reminder',
			{ title: 'Call the client', trigger_at: FABRICATED_18_IST },
			'remind me at 6pm to call the client',
		);

		expect(result.ok).toBe(true);
	});

	it('allows a time stated in Tamil', async () => {
		const { result } = await run(
			'create_reminder',
			{ title: 'Call the client', trigger_at: '2030-09-23T10:00:00+05:30' },
			'நாளைக்கு 10 மணிக்கு client-க்கு call பண்ண remind பண்ணு',
		);

		expect(result.ok).toBe(true);
	});
});

// ─── The executor: update_reminder ──────────────────────────────────────────

describe('update_reminder — the same guard, and the relative path left alone', () => {
	it('refuses a move to an hour the user never gave', async () => {
		const { store, result } = await run(
			'update_reminder',
			{ reminder_id: REMINDER_A, trigger_at: FABRICATED_18_IST },
			'push the plumber reminder to tomorrow',
			{ reminders: [reminderRow()] },
		);

		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/clock time/i);
		expect(new Date(store.reminders[0].triggerAt as Date).toISOString()).toBe('2030-01-01T08:00:00.000Z');
	});

	it('still allows "in an hour", which states a duration rather than a clock time', async () => {
		// `in_minutes` is arithmetic on the server's clock, resolved from the
		// user's own words. A turn with no clock time in it is exactly the turn
		// that asks for one, and refusing it would break every snooze.
		const { result } = await run(
			'update_reminder',
			{ reminder_id: REMINDER_A, in_minutes: 60 },
			'not now, remind me after lunch',
			{ reminders: [reminderRow()] },
		);

		expect(result.ok).toBe(true);
	});
});

// ─── The regression guard: no turn means "cannot check" ─────────────────────

describe('a caller that supplies no turn keeps the behaviour it had', () => {
	it('accepts a clock time from a caller that has no user turn', async () => {
		const { store, result } = await run(
			'create_task',
			{ title: 'Finish the website proposal', due_at: FABRICATED_18_IST },
			undefined,
		);

		expect(result.ok).toBe(true);
		expect(store.tasks).toHaveLength(1);
	});
});
