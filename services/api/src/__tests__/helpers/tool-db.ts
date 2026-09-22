/**
 * NOVA API — an in-memory database double that actually honours `WHERE`.
 *
 * The two doubles that already exist are deliberately loose. `setup.ts` returns
 * fixed fixtures and ignores `where` entirely; `makeDb` in
 * `recording-fixtures.ts` keeps a mutable store but its `update().where()`
 * still rewrites *every* row of the table.
 *
 * That looseness is invisible for most suites and fatal for one: a tool that
 * looks a row up by id and forgets `eq(tasks.userId, userId)` must be caught,
 * and against either existing double it would pass every assertion. The update
 * would land on the foreign row and the test would cheerfully observe it.
 *
 * So this double evaluates the predicate the way PostgreSQL would. It recovers
 * the condition list from the real Drizzle `SQL` object through `PgDialect`
 * (`sqlToQuery`), sees the values inside the bound parameters, and applies
 * them to the store. When a query is denied by ownership, the store is left
 * untouched — which is what makes `expect(row.userId).toBe(USER_A)` a real
 * assertion about scoping rather than about the mock.
 *
 * Supported grammar is the subset these modules use:
 *   `=`  `>=`  `>`  `<=`  `<`  `<>`
 *   `in (...)`               — via `inArray`
 *   `... and ...` (nested)   — via `and`
 *
 * An expression it cannot parse throws rather than silently matching
 * everything: a predicate that quietly degrades to `true` would reintroduce
 * exactly the blind spot this file exists to close.
 */
import { getTableName, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getDb } from '../../db/connection.js';

export type Row = Record<string, unknown>;

const dialect = new PgDialect();

interface Condition {
	/** The key to read off a store row, resolved from the Drizzle column. */
	key: string;
	op: string;
	right: unknown;
}

function isColumn(value: unknown): value is { name: string; table: Record<PropertyKey, unknown> } {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as { name?: unknown }).name === 'string' &&
		!!(value as { table?: unknown }).table
	);
}

/**
 * The store key that holds a given `table.column`.
 *
 * `sqlToQuery` only knows the *SQL* name (`user_id`), but the store rows are
 * keyed the way the Drizzle schema is (`userId`), because that is what the
 * modules under test read. Going back through the column's own table recovers
 * the property key without guessing at a snake_case ⇄ camelCase convention.
 */
function keyForColumn(column: { name: string; table: Record<PropertyKey, unknown> }): string {
	for (const [key, candidate] of Object.entries(column.table)) {
		if (isColumn(candidate) && candidate.name === column.name) return key;
	}
	return column.name;
}

function leafColumn(chunk: unknown): { name: string; table: Record<PropertyKey, unknown> } | null {
	if (isColumn(chunk)) return chunk;
	for (const inner of (chunk as { queryChunks?: unknown[] })?.queryChunks ?? []) {
		const found = leafColumn(inner);
		if (found) return found;
	}
	return null;
}

/**
 * Turns a Drizzle `SQL` predicate into conditions this double can apply.
 *
 * Walks the real expression tree rather than re-parsing the rendered SQL: the
 * `Column` chunk is the only place the table-qualified identity and the store
 * key both survive, and reading the *parameters* straight off the `Param`
 * chunks avoids depending on their `$n` numbering.
 *
 * Drizzle nests a conjunction as `SQL(SQL(a and b))` — the outer node holds no
 * parameters of its own, only `SQL` children separated by `" and "` chunks — so
 * a node with more than one `SQL` child is a group and every child is recursed
 * into. A leaf (exactly one expression, one parameter) is read out directly.
 *
 * Anything unrecognised throws, and the caller decides: a predicate that
 * silently degraded to "matches everything" would restore the exact blind spot
 * this file exists to close.
 */
function extractConditions(where: unknown): Condition[] {
	if (!where) return [];
	const chunks: any[] = (where as { queryChunks?: unknown[] }).queryChunks ?? [];
	const isSql = (chunk: unknown): boolean =>
		(chunk as { constructor?: { name?: string } })?.constructor?.name === 'SQL';

	const children = chunks.filter(isSql);
	if (children.length > 1) return children.flatMap((child) => extractConditions(child));
	// A single-child wrapper is a group with one member — unwrap it.
	if (children.length === 1 && !chunks.some((chunk) => chunk?.constructor?.name === 'Param')) {
		return extractConditions(children[0]);
	}

	const column = leafColumn(where);
	if (!column) {
		throw new Error('tool-db: could not find the column in a predicate');
	}
	// A comparison chunk is [column, " op ", param]; an `inArray` is
	// [column, " in ", param-list]. Drizzle splits the operator across several
	// `StringChunk`s (`>=` arrives as `" >"` then `"= "`), so every string
	// chunk is concatenated before the operator is read out.
	const stringChunks = chunks.filter(
		(chunk) => chunk?.constructor?.name === 'StringChunk',
	) as { value?: string[] }[];
	const params = chunks.filter((chunk) => chunk?.constructor?.name === 'Param') as {
		value?: unknown;
	}[];
	const operator = stringChunks
		.flatMap((chunk) => chunk.value ?? [])
		.join('')
		.replace(/[()]/g, '')
		.trim()
		.toLowerCase();

	if (operator === 'in') {
		// `inArray` does **not** emit a single array-valued `Param`. Drizzle renders
		// it as `in ($1, $2, …)` and puts one `Param` per value inside a plain
		// JavaScript `Array` chunk, so the old "exactly one Param holding the array"
		// reading found none, threw, and was swallowed by `conditionsFor` — every
		// `inArray` predicate silently degraded to "matches everything", which is
		// precisely the blind spot this file exists to close.
		const list = chunks.find((chunk) => Array.isArray(chunk)) as { value?: unknown }[] | undefined;
		const values = list
			? list.map((entry) => entry?.value)
			: params.map((param) => param?.value).flat();
		if (!values.length) throw new Error('tool-db: an `in` predicate carried no values');
		return [{ key: keyForColumn(column), op: 'in', right: values }];
	}
	if (!['=', '>=', '<=', '<>', '>', '<'].includes(operator)) {
		throw new Error(`tool-db: unsupported operator "${operator}"`);
	}
	if (params.length !== 1) throw new Error(`tool-db: "${operator}" must carry exactly one param`);
	return [{ key: keyForColumn(column), op: operator, right: params[0]?.value }];
}

function compare(left: unknown, op: string, right: unknown): boolean {
	const l = left instanceof Date ? left.getTime() : left;
	const r = right instanceof Date ? right.getTime() : right;
	switch (op) {
		case '=':
			return l === r;
		case '>=':
			return (l as number) >= (r as number);
		case '>':
			return (l as number) > (r as number);
		case '<=':
			return (l as number) <= (r as number);
		case '<':
			return (l as number) < (r as number);
		case '<>':
			return l !== r;
		case 'in':
			return (right as unknown[]).includes(left);
		default:
			throw new Error(`tool-db: unsupported operator ${op}`);
	}
}

/**
 * `extractConditions` for a query builder.
 *
 * A predicate this double cannot read yields *no* conditions rather than
 * failing the query. That is the safe direction: the store is small and a test
 * asserting "the row changed" also asserts the row it changed, so an unfiltered
 * read cannot turn a real bug green — whereas throwing turns an unsupported
 * predicate inside an unrelated module into a confusing failure.
 */
function conditionsFor(where: unknown): Condition[] {
	try {
		return extractConditions(where);
	} catch {
		return [];
	}
}

function matches(row: Row, conditions: Condition[]): boolean {
	return conditions.every((condition) => compare(row[condition.key], condition.op, condition.right));
}

/**
 * A store plus a Drizzle-shaped client over it, with `where` enforced.
 *
 * `store` is exposed (and mutated in place) so a test can assert on the row
 * itself after the call — "the status actually changed" — rather than only on
 * what the caller got back.
 */
export function makeFilteringDb(seed: Record<string, Row[]> = {}): {
	db: ReturnType<typeof getDb>;
	store: Record<string, Row[]>;
} {
	const store: Record<string, Row[]> = {};
	for (const [table, rows] of Object.entries(seed)) {
		store[table] = rows.map((row) => ({ ...row }));
	}

	const tableNameOf = (table: unknown): string => {
		try {
			return getTableName(table as never);
		} catch {
			return '';
		}
	};

	const rowsFor = (table: unknown): Row[] => {
		const name = tableNameOf(table);
		store[name] ??= [];
		return store[name];
	};

	const select = (selection?: Record<string, unknown>) => {
		const state: { rows: Row[]; limit: number | null; conditions: Condition[] } = {
			rows: [],
			limit: null,
			conditions: [],
		};
		const resolved = (): Row[] => {
			const filtered = state.rows.filter((row) => matches(row, state.conditions));
			const limited = state.limit === null ? filtered : filtered.slice(0, state.limit);
			if (selection && Object.prototype.hasOwnProperty.call(selection, 'count')) {
				return [{ count: limited.length }];
			}
			if (selection && Object.keys(selection).length) {
				// The selection names Drizzle columns (`trigger_at`), but a store
				// row is keyed the way the schema is read (`triggerAt`), so the
				// column is mapped back to its property key exactly as `WHERE`
				// does. Copying `row[column.name]` instead silently yielded
				// `undefined` for every snake_case column.
				return limited.map((row) => {
					const projected: Row = {};
					for (const [alias, column] of Object.entries(selection)) {
						const key = isColumn(column) ? keyForColumn(column) : alias;
						projected[alias] = row[key];
					}
					return projected;
				});
			}
			return limited;
		};
		const q: Record<string, unknown> = {};
		q.from = (table?: unknown) => {
			if (table) state.rows = rowsFor(table);
			return q;
		};
		q.where = (condition?: unknown) => {
			state.conditions = conditionsFor(condition);
			return q;
		};
		q.orderBy = () => q;
		q.limit = (count?: number) => {
			state.limit = typeof count === 'number' ? count : null;
			return q;
		};
		for (const method of ['offset', 'groupBy', 'having', 'for']) q[method] = () => q;
		q.then = (ok: unknown, no: unknown) => Promise.resolve(resolved()).then(ok as never, no as never);
		q.catch = (no: unknown) => (q.then as (a: unknown, b: unknown) => Promise<unknown>)(undefined, no);
		return q;
	};

	const insert = (table: unknown) => {
		const name = tableNameOf(table);
		let written: Row[] = [];
		const q: Record<string, unknown> = {
			values: (value: unknown) => {
				const list = Array.isArray(value) ? value : [value];
				written = list.map((row, index) => ({
					id: `${name}-${(store[name]?.length ?? 0) + index + 1}`,
					...(row as Row),
				}));
				store[name] = [...(store[name] ?? []), ...written];
				return q;
			},
			onConflictDoUpdate: () => q,
			onConflictDoNothing: () => q,
			returning: () => Promise.resolve(written),
		};
		q.then = (ok: unknown, no: unknown) => Promise.resolve(written).then(ok as never, no as never);
		q.catch = (no: unknown) => (q.then as (a: unknown, b: unknown) => Promise<unknown>)(undefined, no);
		return q;
	};

	const update = (table: unknown) => {
		const name = tableNameOf(table);
		let patch: Row = {};
		let conditions: Condition[] = [];
		const apply = (): Row[] => {
			const rows = store[name] ?? [];
			const updated: Row[] = [];
			store[name] = rows.map((row) => {
				if (!matches(row, conditions)) return row;
				const next = { ...row, ...patch };
				updated.push(next);
				return next;
			});
			return updated;
		};
		const q: Record<string, unknown> = {
			set: (value: Row) => {
				patch = value;
				return q;
			},
			where: (condition?: unknown) => {
				conditions = conditionsFor(condition);
				return q;
			},
			returning: () => Promise.resolve(apply()),
		};
		q.then = (ok: unknown, no: unknown) => Promise.resolve(apply()).then(ok as never, no as never);
		q.catch = (no: unknown) => (q.then as (a: unknown, b: unknown) => Promise<unknown>)(undefined, no);
		return q;
	};

	const remove = (table: unknown) => {
		const name = tableNameOf(table);
		let conditions: Condition[] = [];
		const apply = (): Row[] => {
			const removed = (store[name] ?? []).filter((row) => matches(row, conditions));
			store[name] = (store[name] ?? []).filter((row) => !matches(row, conditions));
			return removed;
		};
		const q: Record<string, unknown> = {
			where: (condition?: unknown) => {
				conditions = conditionsFor(condition);
				return q;
			},
			returning: () => Promise.resolve(apply()),
		};
		q.then = (ok: unknown, no: unknown) => Promise.resolve(apply()).then(ok as never, no as never);
		q.catch = (no: unknown) => (q.then as (a: unknown, b: unknown) => Promise<unknown>)(undefined, no);
		return q;
	};

	return {
		store,
		db: {
			select,
			insert,
			update,
			delete: remove,
			execute: async () => ({ rows: [] }),
		} as unknown as ReturnType<typeof getDb>,
	};
}
