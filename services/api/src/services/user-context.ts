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

export interface UserContext {
	/** The rendered block, or '' when the user has nothing worth injecting. */
	text: string;
	counts: { tasks: number; reminders: number; memories: number };
	/** The shared "now" the snapshot was taken at, for the prompt. */
	now: Date;
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

	try {
		// `tasks` has no priority column — CreateTaskSchema accepts one, but the
		// table does not store it, so selecting it would be a lie.
		const rows = await db
			.select({
				title: tasks.title,
				status: tasks.status,
				dueAt: tasks.dueAt,
			})
			.from(tasks)
			.where(
				and(
					eq(tasks.userId, userId),
					inArray(tasks.status, ['pending', 'in_progress'])
				)
			)
			.orderBy(asc(tasks.dueAt), desc(tasks.createdAt))
			.limit(l.maxTasks);

		counts.tasks = rows.length;
		if (rows.length) {
			sections.push(
				`Open tasks:\n${rows
					.map((t) => {
						const due = t.dueAt ? ` (due ${formatWhen(t.dueAt)})` : ' (no due date)';
						const state = t.status === 'in_progress' ? 'in progress' : 'pending';
						return `- ${truncate(t.title, l.maxCharsPerItem)} — ${state}${due}`;
					})
					.join('\n')}`
			);
		}
	} catch {
		sections.push('Open tasks: unavailable right now.');
	}

	try {
		// Only reminders that have not been dismissed and are not in the past by
		// more than a day, so the block stays about what is actually coming up.
		const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
		const rows = await db
			.select({
				title: reminders.title,
				triggerAt: reminders.triggerAt,
				dismissed: reminders.dismissed,
			})
			.from(reminders)
			.where(
				and(
					eq(reminders.userId, userId),
					eq(reminders.dismissed, false),
					gte(reminders.triggerAt, since)
				)
			)
			.orderBy(asc(reminders.triggerAt))
			.limit(l.maxReminders);

		counts.reminders = rows.length;
		if (rows.length) {
			sections.push(
				`Upcoming reminders:\n${rows
					.map((r) => `- ${formatWhen(r.triggerAt)} — ${truncate(r.title, l.maxCharsPerItem)}`)
					.join('\n')}`
			);
		}
	} catch {
		sections.push('Upcoming reminders: unavailable right now.');
	}

	try {
		// `memories` has no deletedAt; it is archived through `status`. New
		// memories default to 'proposed', so excluding archived/rejected is the
		// right filter rather than demanding 'approved'.
		const rows = await db
			.select({
				content: memories.content,
				category: memories.category,
				importance: memories.importance,
			})
			.from(memories)
			.where(
				and(
					eq(memories.userId, userId),
					inArray(memories.status, ['proposed', 'approved', 'active', 'corrected'])
				)
			)
			.orderBy(desc(memories.importance), desc(memories.createdAt))
			.limit(l.maxMemories);

		counts.memories = rows.length;
		if (rows.length) {
			sections.push(
				`Things you remember about the user:\n${rows
					.map((m) => `- [${m.category}] ${truncate(m.content, l.maxCharsPerItem)}`)
					.join('\n')}`
			);
		}
	} catch {
		sections.push('Saved memories: unavailable right now.');
	}

	if (!sections.length) {
		return { text: '', counts, now };
	}

	const header =
		`What you know about this user right now (current time: ${formatWhen(now)}, ` +
		`timezone ${USER_TIMEZONE}):`;

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

	return { text, counts, now };
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
	language?: string;
	languageName?: string;
	languageNative?: string;
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

	return parts.join('\n\n');
}
