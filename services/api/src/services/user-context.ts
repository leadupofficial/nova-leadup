/**
 * NOVA API — Grounding the assistant in the user's own data.
 *
 * Before this, the conversation path passed the model nothing but a generic
 * persona prompt and the tail of the conversation. Ask NOVA "what do I have
 * tomorrow?" and it correctly answered that it had no way to see your calendar
 * or tasks — because it genuinely did not. Reminders, tasks and memories were
 * real, DB-backed and visible on their own screens, yet invisible to the
 * assistant, which is the opposite of a companion that remembers things.
 *
 * This renders a compact, token-bounded snapshot of that data and hands it to
 * the model as part of the system prompt.
 */
import { getDb } from '../db/connection.js';
import { tasks, reminders, memories } from '@nova/database';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';

export interface UserContextLimits {
	maxTasks: number;
	maxReminders: number;
	maxMemories: number;
	/** Per-item character cap, so one long memory cannot crowd out the rest. */
	maxCharsPerItem: number;
	/** Overall cap on the rendered block. */
	maxChars: number;
}

const DEFAULT_LIMITS: UserContextLimits = {
	maxTasks: 12,
	maxReminders: 12,
	maxMemories: 12,
	maxCharsPerItem: 180,
	maxChars: 4000,
};

function truncate(value: string, max: number): string {
	const flat = value.replace(/\s+/g, ' ').trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * `Asia/Kolkata` regardless of server locale. Reminders are stored with their
 * own timezone, but a stable reference frame is what makes "today" and
 * "tomorrow" mean the same thing to NOVA as they do to the user.
 */
export const USER_TIMEZONE = 'Asia/Kolkata';

function formatWhen(date: Date | null): string {
	if (!date) return 'no time set';
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: USER_TIMEZONE,
		weekday: 'short',
		day: '2-digit',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hour12: true,
	}).format(date);
}

/**
 * Year-bearing "now" for the prompt header.
 *
 * The header used `formatWhen`, which omits the year. Asked to "remind me
 * tomorrow at 5pm" on 2026-09-18, the model read "Fri, 18 Sep" and resolved
 * tomorrow as **2025**-09-19 — a reminder in the past, which can never fire
 * and is invisible to the upcoming-reminders query. The year has to be stated.
 */
function formatNow(date: Date): string {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone: USER_TIMEZONE,
		weekday: 'short',
		day: '2-digit',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: true,
	}).format(date);
}

/** `YYYY-MM-DD` as it is in the user's timezone (not UTC). */
function isoDateInUserZone(date: Date): string {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: USER_TIMEZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(date);
	const read = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
	return `${read('year')}-${read('month')}-${read('day')}`;
}

/** One open task as the grounding read saw it. */
export interface TaskFact {
	id: string;
	title: string;
	status: string;
	/** Coerced to null so an absent column reads as "no due date", not undefined. */
	dueAt: Date | null;
}

/** One undismissed reminder inside the grounding window. */
export interface ReminderFact {
	id: string;
	title: string;
	triggerAt: Date;
}

export interface MemoryFact {
	id: string;
	category: string;
	content: string;
	importance: number | null;
}

/**
 * The same rows the rendered block is built from, kept structured.
 *
 * The briefing needs to *reason* about the snapshot — what is overdue, what is
 * due today, which reminder is next — and doing that by re-parsing the rendered
 * prompt text would be a second, divergent grounding read. Deriving it here
 * costs one pass over rows that were already fetched, so chat grounding and the
 * briefing can never disagree about the user's data.
 *
 * `overdueTasks`/`dueTodayTasks`/`laterTasks`/`undatedTasks` partition `tasks`;
 * `upcomingReminders`/`pastReminders` partition `reminders`.
 */
export interface UserContextFacts {
	tasks: TaskFact[];
	overdueTasks: TaskFact[];
	dueTodayTasks: TaskFact[];
	/** Due on a future date, not today. */
	laterTasks: TaskFact[];
	undatedTasks: TaskFact[];
	reminders: ReminderFact[];
	upcomingReminders: ReminderFact[];
	/** Already fired within the last day and never dismissed. */
	pastReminders: ReminderFact[];
	nextReminder: ReminderFact | null;
	memories: MemoryFact[];
}

export interface UserContext {
	/** The rendered block, or '' when the user has nothing worth injecting. */
	text: string;
	counts: { tasks: number; reminders: number; memories: number };
	/** The shared "now" the snapshot was taken at, for the prompt. */
	now: Date;
	/** The structured view of the same rows, for callers that must reason. */
	facts: UserContextFacts;
}

function emptyFacts(): UserContextFacts {
	return {
		tasks: [],
		overdueTasks: [],
		dueTodayTasks: [],
		laterTasks: [],
		undatedTasks: [],
		reminders: [],
		upcomingReminders: [],
		pastReminders: [],
		nextReminder: null,
		memories: [],
	};
}

/**
 * Classifies one snapshot's tasks and reminders against `now`, in the same
 * timezone the prompt header states. Kept separate from the query so the rules
 * are testable without a database.
 */
export function classifyFacts(
	facts: UserContextFacts,
	now: Date,
): UserContextFacts {
	const today = isoDateInUserZone(now);
	for (const task of facts.tasks) {
		if (!task.dueAt) {
			facts.undatedTasks.push(task);
		} else if (task.dueAt.getTime() < now.getTime()) {
			facts.overdueTasks.push(task);
		} else if (isoDateInUserZone(task.dueAt) === today) {
			facts.dueTodayTasks.push(task);
		} else {
			facts.laterTasks.push(task);
		}
	}

	// `reminders` arrives ordered by `triggerAt` ascending, so the first one
	// still in the future is the next one. A reminder that fired earlier today
	// is not "next" — it is something that was missed, which is exactly what
	// `pastReminders` is for.
	facts.upcomingReminders = facts.reminders.filter((r) => r.triggerAt.getTime() > now.getTime());
	facts.pastReminders = facts.reminders.filter((r) => r.triggerAt.getTime() <= now.getTime());
	facts.nextReminder = facts.upcomingReminders[0] ?? null;
	return facts;
}

/**
 * Builds the grounding block. Never throws: a failure to read one section
 * degrades that section to a note rather than breaking the user's chat turn —
 * losing grounding is bad, losing the reply is worse.
 */
export async function buildUserContext(
	userId: string,
	limits: Partial<UserContextLimits> = {}
): Promise<UserContext> {
	const l: UserContextLimits = { ...DEFAULT_LIMITS, ...limits };
	const db = getDb();
	const now = new Date();

	const counts = { tasks: 0, reminders: 0, memories: 0 };
	const sections: string[] = [];
	const facts = emptyFacts();
	// The three reads are independent, so they run together. Sequentially they
	// sat directly in the latency path of every spoken turn — this runs before
	// the model is even called — and three round trips where one would do is
	// pure added delay.
	const [taskSection, reminderSection, memorySection] = await Promise.all([
		(async () => {
			try {
				// `tasks` has no priority column — CreateTaskSchema accepts one, but
				// the table does not store it, so selecting it would be a lie.
				const rows = await db
					.select({ id: tasks.id, title: tasks.title, status: tasks.status, dueAt: tasks.dueAt })
					.from(tasks)
					.where(and(eq(tasks.userId, userId), inArray(tasks.status, ['pending', 'in_progress'])))
					.orderBy(asc(tasks.dueAt), desc(tasks.createdAt))
					.limit(l.maxTasks);
				counts.tasks = rows.length;
				facts.tasks = rows.map((t) => ({
					id: t.id,
					title: t.title,
					status: t.status,
					dueAt: t.dueAt ?? null,
				}));
				if (!rows.length) return null;
				return `Open tasks:\n${rows
					.map((t) => {
						const due = t.dueAt ? ` (due ${formatWhen(t.dueAt)})` : ' (no due date)';
						const state = t.status === 'in_progress' ? 'in progress' : 'pending';
						return `- ${truncate(t.title, l.maxCharsPerItem)} — ${state}${due}`;
					})
					.join('\n')}`;
			} catch {
				return 'Open tasks: unavailable right now.';
			}
		})(),
		(async () => {
			try {
				// Only reminders that have not been dismissed and are not in the past
				// by more than a day, so the block stays about what is coming up.
				const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
				const rows = await db
					.select({ id: reminders.id, title: reminders.title, triggerAt: reminders.triggerAt, dismissed: reminders.dismissed })
					.from(reminders)
					.where(and(eq(reminders.userId, userId), eq(reminders.dismissed, false), gte(reminders.triggerAt, since)))
					.orderBy(asc(reminders.triggerAt))
					.limit(l.maxReminders);
				counts.reminders = rows.length;
				facts.reminders = rows.map((r) => ({
					id: r.id,
					title: r.title,
					triggerAt: r.triggerAt,
				}));
				if (!rows.length) return null;
				return `Upcoming reminders:\n${rows
					.map((r) => `- ${formatWhen(r.triggerAt)} — ${truncate(r.title, l.maxCharsPerItem)}`)
					.join('\n')}`;
			} catch {
				return 'Upcoming reminders: unavailable right now.';
			}
		})(),
		(async () => {
			try {
				// `memories` has no deletedAt; it is archived through `status`. New
				// memories default to 'proposed', so this is the right filter rather
				// than demanding 'approved'.
				const rows = await db
					.select({ id: memories.id, content: memories.content, category: memories.category, importance: memories.importance })
					.from(memories)
					.where(and(eq(memories.userId, userId), inArray(memories.status, ['proposed', 'approved', 'active', 'corrected'])))
					.orderBy(desc(memories.importance), desc(memories.createdAt))
					.limit(l.maxMemories);
				counts.memories = rows.length;
				facts.memories = rows.map((m) => ({
					id: m.id,
					category: m.category,
					content: m.content,
					importance: m.importance ?? null,
				}));
				if (!rows.length) return null;
				return `Things you remember about the user:\n${rows
					.map((m) => `- [${m.category}] ${truncate(m.content, l.maxCharsPerItem)}`)
					.join('\n')}`;
			} catch {
				return 'Saved memories: unavailable right now.';
			}
		})(),
	]);

	for (const section of [taskSection, reminderSection, memorySection]) {
		if (section) sections.push(section);
	}

	classifyFacts(facts, now);

	if (!sections.length) {
		return { text: '', counts, now, facts };
	}

	const header =
		`What you know about this user right now (current time: ${formatNow(now)}, ` +
		`today's date is ${isoDateInUserZone(now)} in ${USER_TIMEZONE}):`;

	let text = `${header}\n\n${sections.join('\n\n')}`;
	if (!counts.tasks && !counts.reminders && !counts.memories) {
		text +=
			'\n\nThey currently have no open tasks, no upcoming reminders and nothing saved to memory.';
	} else {
		text +=
			'\n\nUse this when they ask what they have coming up or want to be reminded of something. ' +
			'Never claim you cannot see their tasks, reminders or memories — they are listed above. ' +
			'If something they ask about is not listed, say you do not have it saved.';
	}

	if (text.length > l.maxChars) {
		text = `${text.slice(0, l.maxChars - 1)}…`;
	}

	return { text, counts, now, facts };
}

/**
 * The persona prompt, plus grounding when there is any, plus an explicit
 * language instruction.
 *
 * Language is stated rather than left to the model to infer: detection works
 * often enough to look fine and fail unpredictably, and the app knows the
 * user's configured language.
 */
export function composeSystemPrompt(options: {
	basePrompt: string;
	context?: string;
	/**
	 * What the assistant can *do* this turn (the write tools it is being
	 * offered). Omitted on routes that do not pass `tools` to the provider, so
	 * the model is never told it can call something it cannot.
	 */
	capabilities?: string;
	language?: string;
	languageName?: string;
	languageNative?: string;
	/**
	 * Set when the reply will be spoken rather than read.
	 *
	 * Speech synthesis mangles colon clock times — measured against ElevenLabs
	 * Flash, "5:00" came back as a nonsense word in Tamil and "7:30" was read as
	 * "seven hundred and thirty" (and, in a Tamil sentence, in English). Digits
	 * are right for a screen and wrong for a voice, so the two are asked for
	 * differently rather than sharing one instruction.
	 */
	spoken?: boolean;
}): string {
	const parts = [options.basePrompt];

	if (options.language && options.language !== 'auto') {
		const name = options.languageName ?? options.language;
		const native = options.languageNative ? ` (${options.languageNative})` : '';
		parts.push(
			`The user's language is ${name}${native}. Reply in ${name} by default, using its ` +
				'script. If they write to you in a different language, follow their lead and ' +
				'answer in that language instead. Keep names, numbers and technical terms as-is.'
		);
	} else {
		parts.push(
			'Always reply in the same language the user wrote to you in. If they mix ' +
				'languages (for example Tamil and English), match that mix naturally.'
		);
	}

	if (options.context) {
		parts.push(options.context);
	}

	// Overrides the "keep numbers as-is" line above, so it has to come after it.
	if (options.spoken) {
		parts.push(
			'Your reply is going to be read aloud, so write clock times and dates as ' +
				'words rather than digits: say "tomorrow at half past seven in the ' +
				'evening", not "tomorrow 7:30 pm". The speech model reads colon times ' +
				'wrongly even when the rest of the sentence is correct — it turns ' +
				'"7:30" into "seven hundred and thirty" and, in Tamil, "5:00" into a ' +
				'word that means nothing. Ordinary counts and quantities are fine as ' +
				'digits.'
		);
	}

	// Last, so the "you can create these" instruction is the model's most
	// recent framing before it answers.
	if (options.capabilities) {
		parts.push(options.capabilities);
	}

	return parts.join('\n\n');
}
