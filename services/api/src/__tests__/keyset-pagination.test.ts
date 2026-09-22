/**
 * The keyset cursor, which is what makes list pagination correct.
 *
 * The six list routes used a cursor that carried only an `id` while ordering by a
 * timestamp. With UUID keys that is not a keyset: `id > cursor` picks an arbitrary subset
 * of the remaining rows, so walking a list skipped rows and repeated others. Measured
 * live before the fix — 9 tasks returned 4 rows with 5 missing; 7 recordings returned 8
 * rows of which 6 were unique.
 *
 * Two properties have to hold, and the second is the one that is easy to get backwards:
 *
 *   1. the cursor round-trips the values the query is ordered by;
 *   2. a **forward** walk moves *backwards* in a `DESC` ordering, so the filter operator
 *      is `<` for forward and `>` for backward. Inverting them makes page two re-serve
 *      page one, which is what the first version of this helper did.
 */
import { describe, it, expect } from 'vitest';
import {
	decodeKeysetCursor,
	encodeKeysetCursor,
	keysetWhere,
} from '../utils/pagination.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const AT = new Date('2026-09-20T08:16:56.904Z');

/**
 * Renders a drizzle `SQL` object to its text.
 *
 * Recursive, because a nested `sql` fragment (the operator) arrives as a child `SQL`
 * instance rather than a string chunk — a flat render drops it, which is exactly what an
 * earlier version of this helper did, making the operator assertions vacuous.
 */
function render(query: unknown): { text: string } {
	let text = '';

	const walk = (node: unknown): void => {
		const c = node as { queryChunks?: unknown[]; value?: unknown[]; name?: string };
		if (node && typeof node === 'object' && Array.isArray(c.queryChunks)) {
			for (const child of c.queryChunks) walk(child);
			return;
		}
		if (Array.isArray(c.value)) {
			text += String(c.value[0]);
			return;
		}
		if (c.name) text += `:${c.name}`;
	};

	walk(query);
	return { text };
}

describe('a keyset cursor', () => {
	it('round-trips the ordering values', () => {
		const decoded = decodeKeysetCursor(encodeKeysetCursor(AT, UUID));
		expect(decoded.id).toBe(UUID);
		expect(decoded.createdAt.toISOString()).toBe(AT.toISOString());
	});

	it('accepts a string timestamp, which is what a row gives back', () => {
		const decoded = decodeKeysetCursor(encodeKeysetCursor(AT.toISOString(), UUID));
		expect(decoded.createdAt.toISOString()).toBe(AT.toISOString());
	});

	it('is opaque base64url, so it survives a query string unescaped', () => {
		const cursor = encodeKeysetCursor(AT, UUID);
		expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});

describe('a malformed cursor', () => {
	it.each([
		['not base64 at all', '!!!not-base64!!!'],
		['base64 of a non-object', Buffer.from('"hello"').toString('base64url')],
		['a legacy id-only cursor', Buffer.from(JSON.stringify({ id: UUID })).toString('base64url')],
		['a non-uuid id', Buffer.from(JSON.stringify({ t: AT.toISOString(), id: 'not-a-uuid' })).toString('base64url')],
		['an unparseable timestamp', Buffer.from(JSON.stringify({ t: 'yesterday', id: UUID })).toString('base64url')],
	])('is rejected: %s', (_label, cursor) => {
		// Rejecting here is what turns a malformed cursor into a 400 at the boundary.
		// Before this, `tasks` and `reminders` handed the value to Postgres, which raised
		// 22P02 and the error handler rendered a 500 with the Postgres code in the body.
		expect(() => decodeKeysetCursor(cursor)).toThrow(/Invalid cursor/);
	});
});

describe('the keyset comparison', () => {
	const columns = {
		createdAt: { name: 'created_at' },
		id: { name: 'id' },
	} as never;

	it('filters forward with `<` because a forward walk is a DESC ordering', () => {
		const { text } = render(keysetWhere(columns, columns, { createdAt: AT, id: UUID }, 'forward'));
		expect(text).toContain('<');
		expect(text).not.toContain('>');
	});

	it('filters backward with `>`', () => {
		const { text } = render(keysetWhere(columns, columns, { createdAt: AT, id: UUID }, 'backward'));
		expect(text).toContain('>');
	});

	it('binds both ordering values rather than inlining them', () => {
		// Asserted by absence: if the values were interpolated as literals they would
		// appear in the SQL text. They do not, and the casts are present — which is the
		// property that matters, without depending on drizzle's internal chunk shape.
		const { text } = render(keysetWhere(columns, columns, { createdAt: AT, id: UUID }, 'forward'));
		expect(text).toContain('::timestamp');
		expect(text).toContain('::uuid');
		expect(text).not.toContain(AT.toISOString());
		expect(text).not.toContain(UUID);
	});
});
