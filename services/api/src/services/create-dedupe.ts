/**
 * NOVA API — create idempotency for reminders and tasks (P0-5).
 *
 * Measured defect: five identical concurrent `POST /api/v1/reminders` produced
 * five rows, and two identical assistant asks produced two reminders at the same
 * `triggerAt`. A network retry, a double-tap or a repeated voice command filed
 * the reminder twice and NOVA then notified the user twice.
 *
 * Two guards, both wanted:
 *
 *   1. A caller-supplied idempotency key (`Idempotency-Key` header, or
 *      `idempotencyKey` in the body). A retry of the *same* request carries the
 *      same key, so it is absorbed — even a retry that arrives minutes later.
 *   2. A content guard that needs nothing from the client: for 60 seconds after
 *      a reminder is filed, the same (user, normalised title, `triggerAt`) is
 *      the same reminder; for a task, the same (user, normalised title).
 *      "Normalised" is trimmed, case-folded and whitespace-collapsed.
 *
 * The window is enforced by the database, not by this module: the key below is
 * stored in `reminders.dedupe_key` / `tasks.dedupe_key`, which carry unique
 * indexes (`drizzle/0005_curvy_maestro.sql`), and the routes insert with
 * `ON CONFLICT (dedupe_key) DO UPDATE`. A "SELECT then INSERT" would not have
 * fixed the concurrency half of the defect — it is a race and still produced
 * five rows.
 *
 * The window is deliberately short and part of the key: "Call Kumar" today at
 * 10:00 and again tomorrow at 10:00 differ by `triggerAt`, so both are kept.
 *
 * ## Why the bucket, and what it does and does not promise
 *
 * The key carries a 60-second wall-clock bucket rather than an exact "created
 * within the last 60s" test, because a unique index cannot express a rolling
 * window (index predicates must be immutable, and `now()` is not). So two
 * identical creates inside the same bucket collapse — which is the defect — and
 * two identical creates straddling a bucket boundary do not. The worst case is
 * therefore a 60-second window and the mean is 30 seconds. Widening the window
 * would start absorbing reminders the user genuinely made separately, which is
 * the more expensive mistake. The migration's trigger closes the boundary gap
 * for writers that do not compute a key at all (the assistant's tool executor).
 */
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { and, desc, eq, gte } from 'drizzle-orm';
import { reminders, tasks } from '@nova/database';
import { getDb } from '../db/connection.js';

/** How long two identical creates are considered the same create. */
export const CREATE_DEDUPE_WINDOW_MS = 60_000;

/**
 * How far back the "which row did the database just refuse to duplicate" scan
 * looks. Wider than the window on purpose: the trigger decides with the
 * database's clock and this lookup uses Node's, and the only cost of looking too
 * far back is reading a few extra rows for one user.
 */
const LOOKBACK_MS = 5 * 60_000;

type Db = ReturnType<typeof getDb>;
export type Reminder = typeof reminders.$inferSelect;
export type Task = typeof tasks.$inferSelect;

/**
 * The form two titles must share to count as the same content: trimmed,
 * case-folded, internal whitespace collapsed to single spaces.
 *
 * `nova_normalise_title` in `drizzle/0005_curvy_maestro.sql` is the SQL twin of
 * this function, and the two are deliberately independent: the trigger compares
 * SQL-normalised titles against SQL-normalised titles, and this one is only ever
 * compared against values it normalised itself. They do not have to agree byte
 * for byte (and do not, for U+00A0, which JavaScript counts as whitespace and
 * PostgreSQL's `[[:space:]]` does not) — they only have to agree with themselves
 * for the same intent to be recognised on either side of the boundary.
 */
export function normalizeTitle(title: string): string {
	return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The 60-second window a create falls in, as a whole number. */
export function windowBucket(now: Date = new Date()): number {
	return Math.floor(now.getTime() / CREATE_DEDUPE_WINDOW_MS);
}

function hashKey(parts: string[]): string {
	return createHash('md5').update(parts.join('|')).digest('hex');
}

/**
 * The identity of a content-identical reminder create. `userId` is part of it
 * because the unique index is global: without it, two users filing the same
 * reminder in the same minute would collide across accounts.
 */
export function reminderDedupeKey(
	userId: string,
	title: string,
	triggerAt: Date,
	now: Date = new Date(),
): string {
	return hashKey([userId, normalizeTitle(title), String(triggerAt.getTime()), String(windowBucket(now))]);
}

/** The identity of a content-identical task create — see `reminderDedupeKey`. */
export function taskDedupeKey(userId: string, title: string, now: Date = new Date()): string {
	return hashKey([userId, 'task', normalizeTitle(title), String(windowBucket(now))]);
}

/**
 * The identity of one request, for a caller that sent an idempotency key.
 *
 * No window: the client is asserting "this is the same request", so a retry is
 * absorbed for as long as the row exists.
 */
export function idempotencyDedupeKey(userId: string, idempotencyKey: string): string {
	return hashKey([userId, 'idem', idempotencyKey]);
}

/**
 * The idempotency key for this request: the `Idempotency-Key` header if present,
 * otherwise the validated body field. Both are accepted because a retrying
 * client library sets the header and NOVA's own callers send the field.
 *
 * An empty or whitespace-only value is ignored rather than treated as a key,
 * so a client that always sets the header to `""` does not collapse every one of
 * its creates onto a single row.
 */
export function readIdempotencyKey(
	req: Request,
	body?: { idempotencyKey?: string | undefined },
): string | undefined {
	const raw = req.get('Idempotency-Key') ?? body?.idempotencyKey;
	const key = raw?.trim();
	return key ? key.slice(0, 200) : undefined;
}

/** The existing reminder carrying this exact key, if any. */
export async function findReminderByDedupeKey(
	db: Db,
	userId: string,
	dedupeKey: string,
): Promise<Reminder | undefined> {
	const [row] = await db
		.select()
		.from(reminders)
		.where(and(eq(reminders.userId, userId), eq(reminders.dedupeKey, dedupeKey)))
		.limit(1);
	return row;
}

/** The existing task carrying this exact key, if any. */
export async function findTaskByDedupeKey(
	db: Db,
	userId: string,
	dedupeKey: string,
): Promise<Task | undefined> {
	const [row] = await db
		.select()
		.from(tasks)
		.where(and(eq(tasks.userId, userId), eq(tasks.dedupeKey, dedupeKey)))
		.limit(1);
	return row;
}

/**
 * The reminder the database refused to duplicate, found by content rather than
 * by key: the row may have been written by a writer using the trigger's own key
 * formula (the assistant) or before this module existed.
 *
 * The comparison is done here instead of in SQL so that it is the *same*
 * `normalizeTitle` the key is built from, with the same Unicode behaviour, rather
 * than a second implementation that can drift.
 */
export async function findRecentReminder(
	db: Db,
	userId: string,
	title: string,
	triggerAt: Date,
	now: Date = new Date(),
): Promise<Reminder | undefined> {
	const rows = await db
		.select()
		.from(reminders)
		.where(and(eq(reminders.userId, userId), gte(reminders.createdAt, new Date(now.getTime() - LOOKBACK_MS))))
		.orderBy(desc(reminders.createdAt));

	const wantedTitle = normalizeTitle(title);
	const wantedTime = triggerAt.getTime();
	return rows.find(
		(row) => normalizeTitle(row.title) === wantedTitle && row.triggerAt.getTime() === wantedTime,
	);
}

/** The task the database refused to duplicate — see `findRecentReminder`. */
export async function findRecentTask(
	db: Db,
	userId: string,
	title: string,
	now: Date = new Date(),
): Promise<Task | undefined> {
	const rows = await db
		.select()
		.from(tasks)
		.where(and(eq(tasks.userId, userId), gte(tasks.createdAt, new Date(now.getTime() - LOOKBACK_MS))))
		.orderBy(desc(tasks.createdAt));

	const wantedTitle = normalizeTitle(title);
	return rows.find((row) => normalizeTitle(row.title) === wantedTitle);
}
