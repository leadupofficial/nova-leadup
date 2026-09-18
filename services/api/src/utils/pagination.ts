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
