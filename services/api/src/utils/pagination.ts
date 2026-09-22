/**
 * NOVA API — Pagination utilities.
 *
 * Provides cursor-based pagination helpers that work with PostgreSQL
 * primary keys (UUIDv7 or UUIDv4). Uses the cursor as the last-seen
 * primary key value, encoded in base64url to avoid leaking DB structure.
 */
import { sql, SQL, type AnyColumn } from 'drizzle-orm';
import { z } from 'zod';

export const CursorPaginationSchema = z.object({
	cursor: z.string().base64url().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
	direction: z.enum(['forward', 'backward']).default('forward'),
});

export type CursorPaginationInput = z.infer<typeof CursorPaginationSchema>;
export type CursorPage<T> = {
	data: T[];
	nextCursor: string | null;
	prevCursor: string | null;
	hasMore: boolean;
	limit: number;
};

const encodeCursor = (value: string): string =>
	Buffer.from(value, 'utf-8').toString('base64url');

const decodeCursor = (encoded: string): string => {
	try {
		return Buffer.from(encoded, 'base64url').toString('utf-8');
	} catch {
		throw new Error('Invalid pagination cursor');
	}
};

/**
 * Build a WHERE clause for cursor-based pagination on a primary key column.
 *
 * For forward pagination: WHERE id > :cursor
 * For backward pagination: WHERE id < :cursor
 *
 * @param column - The drizzle-orm column to paginate on (typically the PK)
 * @param cursor - The decoded cursor value (raw DB value)
 * @param direction - Pagination direction
 */
export function buildCursorWhere(
	column: AnyColumn,
	cursor: string | undefined,
	direction: 'forward' | 'backward' = 'forward'
): SQL<unknown> {
	if (!cursor) {
		return sql`true`;
	}

	if (direction === 'backward') {
		return sql`${column} < ${cursor}`;
	}
	return sql`${column} > ${cursor}`;
}

/**
 * Apply cursor-based pagination to a drizzle-orm query builder.
 *
 * Returns the paginated query parameters that can be used with the builder.
 */
export function applyCursorPagination<T extends { id: string }>(
	items: T[],
	limit: number
): CursorPage<T> {
	const hasMore = items.length >= limit;
	const trimmed = hasMore ? items.slice(0, limit) : items;

	const lastItem = trimmed[trimmed.length - 1];
	const firstItem = trimmed[0];

	const nextCursor = lastItem && hasMore ? encodeCursor(lastItem.id) : null;
	const prevCursor = firstItem && items.length > 0 ? encodeCursor(firstItem.id) : null;

	return {
		data: trimmed,
		nextCursor,
		prevCursor,
		hasMore,
		limit,
	};
}

/**
 * Express middleware that parses cursor pagination parameters from the query string.
 */
export function parseCursorPagination(req: Request): CursorPaginationInput {
	const raw = (req as unknown as Record<string, unknown>).validatedQuery as Record<string, unknown> | undefined;
	if (raw) {
		return raw as CursorPaginationInput;
	}
	return CursorPaginationSchema.parse((req as any).query);
}

/**
 * Build a standard cursor-based pagination response envelope.
 */
export function cursorMeta<T>(page: CursorPage<T>, extra?: Record<string, unknown>): Record<string, unknown> {
	return {
		pagination: {
			nextCursor: page.nextCursor,
			prevCursor: page.prevCursor,
			hasMore: page.hasMore,
			limit: page.limit,
			count: page.data.length,
			...(extra || {}),
		},
	};
}

// ─── Keyset (created-at) cursors ──────────────────────────────────────────────
//
// The four list routes ordered by `created_at` while filtering on `id`, which is not a
// keyset at all: with UUID primary keys, `id > cursor` selects an arbitrary subset of the
// remaining rows, so walking a list **skips and duplicates rows**. Measured on a live
// API: 9 tasks returned 4 rows across pages with 5 missing; 7 reminders returned 2.
//
// A keyset cursor must carry the same values it is ordered by, so this one is
// `(createdAt, id)`. The id is the tie-break for rows written in the same millisecond —
// without it a page boundary inside a batch loses the rest of that batch.

/** The payload of a keyset cursor, before encoding. */
export interface KeysetCursor {
	createdAt: Date;
	id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeKeysetCursor(createdAt: Date | string, id: string): string {
	const iso = createdAt instanceof Date ? createdAt.toISOString() : new Date(createdAt).toISOString();
	return Buffer.from(JSON.stringify({ t: iso, id }), 'utf-8').toString('base64url');
}

/**
 * Decodes a keyset cursor, rejecting anything malformed.
 *
 * The id is validated as a UUID here rather than being handed to Postgres: an
 * unvalidated one reached the driver and produced `22P02`, which the error handler
 * rendered as a **500 with the Postgres code in the problem document**. Validating here
 * turns a malformed cursor into a 400 at the boundary, where it belongs.
 */
export function decodeKeysetCursor(cursor: string): KeysetCursor {
	let parsed: { t?: unknown; id?: unknown };
	try {
		parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
	} catch {
		throw new Error('Invalid cursor');
	}
	if (typeof parsed?.t !== 'string' || typeof parsed?.id !== 'string' || !UUID_RE.test(parsed.id)) {
		throw new Error('Invalid cursor');
	}
	const createdAt = new Date(parsed.t);
	if (Number.isNaN(createdAt.getTime())) throw new Error('Invalid cursor');
	return { createdAt, id: parsed.id };
}

/**
 * The row-value comparison a keyset needs.
 *
 * **The operator is the opposite of the one the old id-based code used, and that is the
 * whole point.** These routes order `DESC` for `forward` and `ASC` for `backward`
 * (`orderBy = direction === 'backward' ? asc(...) : desc(...)`), so the *next* page of a
 * forward walk is the rows **smaller** than the cursor row:
 *
 *   forward  (DESC)  →  (created_at, id) < (cursor)
 *   backward (ASC)   →  (created_at, id) > (cursor)
 *
 * Postgres evaluates the parenthesised form as a tuple comparison, which is exactly
 * "everything after this row in this ordering" — unlike `id < $1`, which is "everything
 * with a smaller random uuid" and has nothing to do with the ordering.
 *
 * Getting this backwards is not subtle in effect: paging forward then returns rows the
 * previous page already showed. That is how the first version of this helper behaved, and
 * a live walk caught it (page 2 re-served page 1's newest row).
 */
export function keysetWhere(
	createdAtColumn: AnyColumn,
	idColumn: AnyColumn,
	cursor: KeysetCursor,
	direction: 'forward' | 'backward' = 'forward',
): SQL<unknown> {
	const operator = direction === 'backward' ? sql`>` : sql`<`;
	return sql`(${createdAtColumn}, ${idColumn}) ${operator} (${cursor.createdAt.toISOString()}::timestamp, ${cursor.id}::uuid)`;
}
