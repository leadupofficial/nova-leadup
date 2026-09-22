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
import { rankMemoriesForTurn, type MemoryRankingMode } from './memory.js';
import { nextOccurrence, parseRepeatRule, describeRepeatRule } from './reminder-recurrence.js';
import type { EmbeddingResult } from './ai.js';

export interface UserContextLimits {
	maxTasks: number;
	recentlyCompletedTasks: number;
	maxReminders: number;
	maxMemories: number;
	/** Per-item character cap, so one long memory cannot crowd out the rest. */
	maxCharsPerItem: number;
	/** Overall cap on the rendered block. */
	maxChars: number;
}

const DEFAULT_LIMITS: UserContextLimits = {
	maxTasks: 12,
	/** How many recently-completed tasks stay visible so they can be reopened. */
	recentlyCompletedTasks: 5,
	maxReminders: 12,
	maxMemories: 12,
	maxCharsPerItem: 180,
	maxChars: 4000,
};

/**
 * How the memory section was ordered on this call.
 *
 * `importance` is the pre-existing behaviour: the top rows by importance. It is
 * also what a relevance ranking falls back to, and when it does the
 * `degradedReason` travels with it — a ranking that quietly stopped ranking reads
 * to the user as "NOVA ignored what I told it", which is exactly the bug the
 * relevance path exists to fix.
 */
export interface MemoryRetrievalInfo {
	mode: MemoryRankingMode;
	/** Set when a relevance ranking was wanted but could not run. */
	degradedReason?: string;
}

/**
 * The turn-specific input, separate from `UserContextLimits` because none of it is
 * a limit: `limits` bounds how much is rendered, this changes *which* memories are
 * chosen.
 */
export interface UserContextOptions {
	/**
	 * The user's message for this turn. Absent on a caller that has no turn — the
	 * briefing sweep and the follow-up engine, which snapshot the user's data on a
	 * schedule — and that path keeps the importance ordering byte-for-byte.
	 */
	userTurn?: string;
	/**
	 * The embedder the relevance ranking uses. Defaults to the platform provider;
	 * exposed so a test (or a deployment with its own provider) can drive the
	 * ranking without changing the process environment.
	 */
	embed?: (text: string) => Promise<EmbeddingResult>;
}

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

/**
 * How far back an undismissed reminder stays in the grounding snapshot.
 *
 * Bounded so a year-old reminder does not nag on every turn, but wide enough
 * that "yesterday" and "last week" are still visible. The previous bound was
 * one day, which silently hid everything older from both the model and the
 * briefing.
 */
export const REMINDER_LOOKBACK_DAYS = 30;

/**
 * The handle the model uses to name one row to a tool.
 *
 * Without this the grounding block listed titles and times but no ids, so the
 * management tools (`update_reminder`, `cancel_reminder`, `complete_task`,
 * `reopen_task`) had nothing to target: the model was told to "use the id from
 * the list" and the list did not contain one. The full id is emitted rather
 * than a prefix because it is the value the executor matches on, and a prefix
 * would only work through fuzzy matching — which is how the wrong row gets
 * edited.
 */
function idTag(id: string): string {
	return `[id: ${id}]`;
}

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
export function isoDateInUserZone(date: Date): string {
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
	/**
	 * When the row was created and when it was finished, present so a caller that
	 * must reason about *age* rather than *deadline* can — the follow-up engine asks
	 * "has this been pending well past the point it was written down?".
	 *
	 * Optional because a fact assembled by hand (a test, a replay) may not carry
	 * them; an absent value means "unknown", and the rules that read them decline to
	 * fire rather than guessing.
	 */
	createdAt?: Date | null;
	completedAt?: Date | null;
}

/** One undismissed reminder inside the grounding window. */
export interface ReminderFact {
	id: string;
	title: string;
	triggerAt: Date;
	/**
	 * Optional for the same reason as [TaskFact.createdAt]. The query already
	 * excludes dismissed reminders, so this is only ever `true` for a fact assembled
	 * outside `buildUserContext` — and the caller that must not name a dismissed
	 * reminder checks it anyway.
	 */
	dismissed?: boolean;
	/**
	 * The stored recurrence, or null/absent for a one-shot reminder.
	 *
	 * Needed here because **the stored `triggerAt` of a recurring reminder goes
	 * stale the moment it first fires**: nothing server-side advances it — the
	 * phone repeats the alarm itself — so a monthly reminder that fired last month
	 * still reads as a row in the past forever. Without the rule the grounding
	 * block told the model a perfectly live recurring reminder had already been
	 * missed, and never showed it the rule at all. See [resolvedReminderAt].
	 */
	repeatRule?: string | null;
	/** The reminder's own IANA zone, used to resolve the next occurrence. */
	timezone?: string;
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
	/**
	 * How the memory section was ordered, and why not by relevance if it was not.
	 * Reported rather than inferred from the rendered text: "twelve memories by
	 * importance" and "twelve memories ranked against this turn" look identical in
	 * the prompt, and only one of them is honest when no provider is configured.
	 */
	memoryRetrieval: MemoryRetrievalInfo;
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
	//
	// A *recurring* reminder is the exception, and it is why this partitions on
	// [resolvedReminderAt] rather than on `triggerAt`. Its stored time is the first
	// occurrence and the phone repeats it from there, so the raw column is in the
	// past for every occurrence after the first: classifying on it put a live
	// weekly reminder permanently in `pastReminders`, where the briefing counts it
	// as missed and the assistant describes it as overdue.
	facts.upcomingReminders = facts.reminders.filter((r) => resolvedReminderAt(r, now).getTime() > now.getTime());
	facts.pastReminders = facts.reminders.filter((r) => resolvedReminderAt(r, now).getTime() <= now.getTime());
	facts.nextReminder = facts.upcomingReminders[0] ?? null;
	return facts;
}

/**
 * When this reminder is actually next due.
 *
 * For a one-shot reminder that is the stored `triggerAt`, unchanged. For a
 * recurring one whose stored time has already passed, it is the next occurrence
 * of the rule, resolved in the reminder's own zone.
 *
 * Never throws and never guesses: a rule this module cannot parse, an occurrence
 * that cannot be computed, or an invalid zone all fall back to the stored time,
 * so a bad rule costs the model a stale timestamp rather than the whole grounding
 * block. The reminder still appears, which matters more than the timestamp being
 * perfect.
 */
export function resolvedReminderAt(
	fact: Pick<ReminderFact, 'triggerAt' | 'repeatRule' | 'timezone'>,
	now: Date,
): Date {
	const stored = fact.triggerAt;
	if (!fact.repeatRule || stored.getTime() > now.getTime()) return stored;
	try {
		const parsed = parseRepeatRule(fact.repeatRule);
		if (!parsed.ok) return stored;
		return nextOccurrence(parsed.rule, stored, now, fact.timezone || USER_TIMEZONE);
	} catch {
		return stored;
	}
}

/** `(every Monday)` and friends, or '' when the reminder does not repeat. */
function recurrenceSuffix(fact: Pick<ReminderFact, 'repeatRule'>): string {
	if (!fact.repeatRule) return '';
	try {
		const parsed = parseRepeatRule(fact.repeatRule);
		return parsed.ok ? ` (repeats ${describeRepeatRule(parsed.rule)})` : '';
	} catch {
		return '';
	}
}

/**
 * Builds the grounding block. Never throws: a failure to read one section
 * degrades that section to a note rather than breaking the user's chat turn —
 * losing grounding is bad, losing the reply is worse.
 *
 * `now` is the instant the snapshot is classified against and the instant the prompt
 * header states. It is a parameter rather than a `new Date()` inside the function
 * because a caller that already holds a settled "now" — the follow-up engine, which
 * is handed one so a sweep can be replayed or backfilled — must not classify against
 * a *different* clock than the one it reasons with. When the two disagree, a task can
 * be overdue to the classifier and not yet due to the caller, and a rule silently
 * stops firing.
 */
export async function buildUserContext(
	userId: string,
	limits: Partial<UserContextLimits> = {},
	now: Date = new Date(),
	options: UserContextOptions = {},
): Promise<UserContext> {
	const l: UserContextLimits = { ...DEFAULT_LIMITS, ...limits };
	const db = getDb();

	const counts = { tasks: 0, reminders: 0, memories: 0 };
	const sections: string[] = [];
	const facts = emptyFacts();
	// "importance" until a relevance ranking actually runs. A caller with no turn
	// gets today's ordering and no degradation claim, because none was attempted.
	let memoryRetrieval: MemoryRetrievalInfo = { mode: 'importance' };
	// The three reads are independent, so they run together. Sequentially they
	// sat directly in the latency path of every spoken turn — this runs before
	// the model is even called — and three round trips where one would do is
	// pure added delay.
	const [taskSection, reminderSection, memorySection] = await Promise.all([
		(async () => {
			try {
				// `tasks` has no priority column — CreateTaskSchema accepts one, but
				// the table does not store it, so selecting it would be a lie.
				const columns = {
					id: tasks.id,
					title: tasks.title,
					status: tasks.status,
					dueAt: tasks.dueAt,
					createdAt: tasks.createdAt,
					completedAt: tasks.completedAt,
				};
				const openRows = await db
					.select(columns)
					.from(tasks)
					.where(and(eq(tasks.userId, userId), inArray(tasks.status, ['pending', 'in_progress'])))
					.orderBy(asc(tasks.dueAt), desc(tasks.createdAt))
					.limit(l.maxTasks);
				// Recently completed tasks, on their own bounded query.
				//
				// They used to be excluded entirely, and the assistant could not
				// reopen one by voice: it is shown task ids in this context, so a task
				// that is not here has no id it can send. Measured — "actually reopen
				// it" was answered with "I don't have the task ID … in my list", and
				// on another run the model bound a *pending* task's id instead and
				// silently reopened the wrong record. The reminder section directly
				// above carries the same lesson: hiding a row the user can ask about
				// makes the assistant answer wrongly about it.
				//
				// Bounded by count and ordered by completion time, so this is the
				// recent past rather than a permanent list of everything ever done.
				const doneRows = await db
					.select(columns)
					.from(tasks)
					.where(and(eq(tasks.userId, userId), eq(tasks.status, 'completed')))
					.orderBy(desc(tasks.completedAt))
					.limit(l.recentlyCompletedTasks);
				const rows = [...openRows, ...doneRows];
				counts.tasks = rows.length;
				facts.tasks = rows.map((t) => ({
					id: t.id,
					title: t.title,
					status: t.status,
					dueAt: t.dueAt ?? null,
					createdAt: t.createdAt ?? null,
					completedAt: t.completedAt ?? null,
				}));
				if (!rows.length) return null;
				const line = (t: (typeof rows)[number]) => {
					const due = t.dueAt ? ` (due ${formatWhen(t.dueAt)})` : ' (no due date)';
					// `completed` has to be named. The old branch fell through to
					// "pending" for anything that was not in progress, which would now
					// describe a finished task as outstanding.
					const state =
						t.status === 'in_progress'
							? 'in progress'
							: t.status === 'completed'
								? 'completed'
								: 'pending';
					return `- ${truncate(t.title, l.maxCharsPerItem)} — ${state}${due} ${idTag(t.id)}`;
				};
				const blocks: string[] = [];
				if (openRows.length) blocks.push(`Open tasks:\n${openRows.map(line).join('\n')}`);
				if (doneRows.length) {
					blocks.push(`Recently completed tasks:\n${doneRows.map(line).join('\n')}`);
				}
				return blocks.join('\n\n');
			} catch {
				return 'Open tasks: unavailable right now.';
			}
		})(),
		(async () => {
			try {
				// Reminders are read from a *bounded* window, wide enough that
				// yesterday's and last week's items are still visible. It used to be
				// 24 hours, which made anything overdue by more than a day invisible
				// to the assistant and to the briefing: with reminders 1 and 2 days
				// overdue in the database, "What is overdue?" answered "none of your
				// reminders are overdue" and the briefing reported `missedReminders:
				// 0`. An overdue reminder is exactly the thing a proactive assistant
				// exists to surface, so the window is 30 days — still bounded, so a
				// year-old reminder is history rather than a permanent nag.
				//
				// Ordered *descending* on purpose. The window and the limit together
				// decide what survives: ascending would spend the budget on the oldest
				// backlog and drop today's item, which is backwards. Because the whole
				// rendered block is also truncated at `maxChars`, least-recent items
				// are dropped before recent ones.
				const since = new Date(now.getTime() - REMINDER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
				const rows = await db
					.select({
						id: reminders.id,
						title: reminders.title,
						triggerAt: reminders.triggerAt,
						dismissed: reminders.dismissed,
						repeatRule: reminders.repeatRule,
						timezone: reminders.timezone,
					})
					.from(reminders)
					.where(and(eq(reminders.userId, userId), eq(reminders.dismissed, false), gte(reminders.triggerAt, since)))
					.orderBy(desc(reminders.triggerAt))
					.limit(l.maxReminders);
				counts.reminders = rows.length;
				facts.reminders = rows.map((r) => ({
					id: r.id,
					title: r.title,
					triggerAt: r.triggerAt,
					dismissed: r.dismissed ?? false,
					repeatRule: r.repeatRule ?? null,
					timezone: r.timezone ?? undefined,
				}));
				if (!rows.length) return null;
				// Rendered oldest-first so the list still reads as a timeline, even
				// though the query selected newest-first. The heading names overdue
				// items too: since the window widened, an item whose time has passed
				// is a missed reminder — the most important thing in this block — and
				// calling the whole section "Upcoming" told the model to ignore it.
				// Rendered at the effective time, so a recurring reminder is named at
				// the occurrence the user will actually be reminded on rather than at
				// the first one it ever had, and the rule is stated so the model knows
				// it comes back.
				const chronological = [...rows].sort(
					(a, b) =>
						resolvedReminderAt({ triggerAt: a.triggerAt, repeatRule: a.repeatRule, timezone: a.timezone ?? undefined }, now).getTime() -
						resolvedReminderAt({ triggerAt: b.triggerAt, repeatRule: b.repeatRule, timezone: b.timezone ?? undefined }, now).getTime(),
				);
				return `Reminders (overdue ones are missed and still not dismissed):\n${chronological
					.map((r) => {
						const at = resolvedReminderAt(
							{ triggerAt: r.triggerAt, repeatRule: r.repeatRule, timezone: r.timezone ?? undefined },
							now,
						);
						return `- ${formatWhen(at)} — ${truncate(r.title, l.maxCharsPerItem)}${recurrenceSuffix(r)} ${idTag(r.id)}`;
					})
					.join('\n')}`;
			} catch {
				return 'Upcoming reminders: unavailable right now.';
			}
		})(),
		(async () => {
			try {
				// A turn was supplied, so the memories are chosen by relevance to it
				// rather than by importance alone. `rankMemoriesForTurn` does not throw
				// when the ranking itself cannot run: it hands back today's ordering
				// plus the reason, so this section still renders and the caller can see
				// that no relevance was applied instead of mistaking the fallback for a
				// ranking.
				const turn = options.userTurn?.trim();
				if (turn) {
					const ranked = await rankMemoriesForTurn(userId, turn, l.maxMemories, options.embed);
					memoryRetrieval = ranked.degradedReason
						? { mode: ranked.mode, degradedReason: ranked.degradedReason }
						: { mode: ranked.mode };
					counts.memories = ranked.memories.length;
					facts.memories = ranked.memories.map((m) => ({
						id: m.id,
						category: m.category,
						content: m.content,
						importance: m.importance ?? null,
					}));
					if (!ranked.memories.length) return null;
					return `Things you remember about the user:\n${ranked.memories
						.map((m) => `- [${m.category}] ${truncate(m.content, l.maxCharsPerItem)}`)
						.join('\n')}`;
				}

				// No turn to rank against — a briefing sweep. This stays exactly as it
				// was: the top rows by importance, and nothing about the ranking path
				// is consulted.
				//
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

	// The header is *not* a fact about the user and it is not conditional on
	// there being something to say. It is the only place the model is told what
	// "now" is, so it is emitted even when every section is empty.
	//
	// It used to sit below an early `return { text: '' }` for the no-rows case,
	// which meant a brand-new account was grounded in nothing at all. Asked to
	// "remind me tomorrow", the model had no year to anchor on, resolved it to a
	// 2025 date, and had every `create_reminder` refused as "in the past" — the
	// loop then burned all three iterations and the reply contradicted itself.
	const header =
		`What you know about this user right now (current time: ${formatNow(now)}, ` +
		`today's date is ${isoDateInUserZone(now)} in ${USER_TIMEZONE}):`;

	const body = sections.length
		? sections.join('\n\n')
		: 'They currently have no open tasks, no upcoming reminders and nothing saved to memory.';

	let text = `${header}\n\n${body}`;
	if (sections.length) {
		text +=
			'\n\nUse this when they ask what they have coming up or want to be reminded of something. ' +
			'Never claim you cannot see their tasks, reminders or memories — they are listed above. ' +
			'If something they ask about is not listed, say you do not have it saved.';
	}

	if (text.length > l.maxChars) {
		text = `${text.slice(0, l.maxChars - 1)}…`;
	}

	return { text, counts, now, facts, memoryRetrieval };
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

	// Very last, and said a second time on purpose.
	//
	// The language clause above already states the user's language, and on a
	// spoken turn a model reads it and then drops it exactly where it matters
	// most: the three-word acknowledgement after a tool call. Measured through the
	// live voice route on claude-haiku-4-5 — a Tanglish reminder request was
	// answered *"Done. I've set a reminder for you to call the client tomorrow at
	// nine in the morning."* in English, while that same session's non-tool turns
	// came back in Tamil script. The user asked in Tamil and was answered in
	// English by the one reply that confirms what happened, so the instruction is
	// restated here, after the capability framing, as the model's final read.
	// A one-script rule, and only because the failure is measured rather than
	// theoretical. Scanning every reply the spoken route produced across five
	// models, one of them put **55 letters from other writing systems inside a
	// Tamil answer** — 51 Malayalam, 2 Devanagari, 1 Bengali and one CJK
	// ideograph (U+51E0), in sentences a Tamil user would hear read aloud. The
	// four other models produced none. Asking in the model's own terms is the only
	// cheap remedy: there is no deterministic repair, because a Malayalam letter
	// standing in for a Tamil one cannot be mapped back to what was meant.
	//
	// Placed *before* the language check below, which says "following the language
	// and script rules above" and so has to stay last.
	if (options.spoken && options.language && options.language !== 'en' && options.language !== 'auto') {
		parts.push(
			'Use one writing system for the whole reply. If you are writing in Tamil, ' +
				'every Tamil word must be in Tamil script — do not substitute letters from ' +
				'Malayalam, Devanagari, Bengali, Telugu, Kannada or Chinese, and do not ' +
				'switch a word into another script part-way through. English words stay in ' +
				'Latin script, as above. If you cannot recall a word\'s spelling in the ' +
				'right script, use the English word instead.'
		);
	}

	if (options.spoken && options.language && options.language !== 'auto') {
		const name = options.languageName ?? options.language;
		parts.push(
			`Language check for every reply of this turn: write in ${name}, following ` +
				'the language and script rules above. This includes a short ' +
				'acknowledgement that you have just performed an action — a one-line ' +
				'"done" must be in the same language as the request, not in plain English.'
		);
	}

	return parts.join('\n\n');
}
