/**
 * NOVA — audit-log export.
 *
 * The `audit.export` permission has existed since the control-center migration and **no route
 * implemented it**. The console said so rather than showing a button that did nothing, which was
 * the right call at the time and is still the right thing to have said — but it left a real gap:
 * the audit log is the record an operator is asked for after an incident, and the only way to
 * produce it was to read the table directly.
 *
 * ## Why this is not a "god mode"
 *
 * An export is a read, and it is bounded in four ways that matter:
 *
 *  * **A row cap.** `MAX_ROWS` is enforced with a hard `LIMIT`, and the response reports whether it
 *    was reached, so a truncated file can never be mistaken for a complete one.
 *  * **The same filters as the listing.** An operator exports what they were looking at, not the
 *    whole table by default — and the filter set is the one the list route already validates.
 *  * **Permissioned separately** (`audit.export`, held only by SUPER_ADMIN). Reading the log and
 *    taking a copy of it out of the platform are different capabilities, which is why they are
 *    different permissions.
 *  * **Audited itself.** The export writes an `audit_log.export` row *before* the file is
 *    produced, so "who took a copy and when" is answerable from the log they copied.
 *
 * ## CSV injection, which is a real defect and not a nicety
 *
 * A cell beginning `=`, `+`, `-`, `@`, tab or carriage return is interpreted as a **formula** by
 * Excel, LibreOffice and Google Sheets. Audit rows contain operator-supplied text (a reason, an
 * email, a target id), so a reason of `=HYPERLINK("http://evil","click")` would execute on the
 * machine of whoever opens the exported file — the auditor. Every field is therefore prefixed
 * with an apostrophe when it starts with one of those characters, which is the OWASP
 * recommendation and the behaviour Excel treats as literal text.
 */

import type { AuditOutcome } from './audit.js';

/** Columns, in order. Named here so the header row and the cells cannot disagree. */
export const AUDIT_EXPORT_COLUMNS = [
	'occurred_at',
	'action',
	'outcome',
	'actor_email',
	'actor_role',
	'permission',
	'target_type',
	'target_id',
	'reason',
	'request_id',
	'ip_address',
	'user_agent',
	'before',
	'after',
] as const;

export type AuditExportColumn = (typeof AUDIT_EXPORT_COLUMNS)[number];

export type AuditExportRow = Record<AuditExportColumn, unknown>;

/**
 * Rows in one export. A ceiling, not a target.
 *
 * 50 000 rows of this shape is a few tens of megabytes — larger than an operator will read and
 * small enough that the request cannot exhaust memory on a table that is append-only and grows
 * without bound. The response says when it was hit, so the operator narrows the range instead of
 * assuming they have everything.
 */
export const MAX_ROWS = 50_000;

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Escapes one CSV cell.
 *
 * Two separate concerns, and both are needed:
 *
 *  1. **Formula injection** — a leading `=`, `+`, `-`, `@`, tab or CR is neutralised with a
 *     leading apostrophe. Applied before quoting so the apostrophe is inside the quotes.
 *  2. **CSV syntax** — a value containing a quote, comma, newline or CR is wrapped in double
 *     quotes with inner quotes doubled, per RFC 4180.
 *
 * `null` and `undefined` become an empty cell rather than the strings `"null"` or `"undefined"`,
 * because an auditor reading the file must not see a value the database never held.
 */
export function escapeCsvCell(value: unknown): string {
	if (value === null || value === undefined) return '';

	// A `Date` is serialised as its ISO instant, **not** through `JSON.stringify`, which would
	// wrap it in quotes and leave the cell as `"""2026-09-21T19:01:58.116Z"""` — the JSON quotes
	// leaking into the file, so every timestamp an auditor reads carries spurious quote marks.
	// Caught by reading a real export rather than the header row the tests asserted on.
	let text: string;
	if (value instanceof Date) {
		text = value.toISOString();
	} else if (typeof value === 'string') {
		text = value;
	} else {
		text = JSON.stringify(value) ?? String(value);
	}

	if (FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix))) {
		text = `'${text}`;
	}

	if (/[",\r\n]/.test(text)) {
		return `"${text.replace(/"/g, '""')}"`;
	}
	return text;
}

/** Serialises one row, using the column order above. */
export function toCsvRow(row: AuditExportRow): string {
	return AUDIT_EXPORT_COLUMNS.map((column) => escapeCsvCell(row[column])).join(',');
}

/**
 * Builds the whole document, header first.
 *
 * A leading UTF-8 BOM is included: without it Excel on Windows reads the file as the system
 * code page, and an operator's name or a target id containing non-ASCII characters arrives
 * mangled — which is worse than a padding character at the top of the file.
 */
export function toCsv(rows: AuditExportRow[]): string {
	const lines = [AUDIT_EXPORT_COLUMNS.join(','), ...rows.map(toCsvRow)];
	return `\ufeff${lines.join('\r\n')}\r\n`;
}

/** Filter set shared with the listing route, so an export matches what was on screen. */
export type AuditExportFilters = {
	action?: string;
	actorId?: string;
	outcome?: AuditOutcome;
	targetType?: string;
	search?: string;
	from?: string;
	to?: string;
};

/**
 * The `WHERE` fragments for the export, appending bind parameters in order.
 *
 * Extracted and exported so the filter behaviour is unit-testable without a database — the one
 * thing an export must get right is that it returns *what was asked for*, and a filter that
 * silently does nothing would produce a full-table file that looks deliberate.
 */
export function auditExportConditions(filters: AuditExportFilters, params: unknown[]): string[] {
	const conditions: string[] = [];

	if (filters.action) {
		params.push(filters.action);
		conditions.push(`action = $${params.length}`);
	}
	if (filters.actorId) {
		params.push(filters.actorId);
		conditions.push(`actor_id = $${params.length}`);
	}
	if (filters.outcome) {
		params.push(filters.outcome);
		conditions.push(`outcome = $${params.length}`);
	}
	if (filters.targetType) {
		params.push(filters.targetType);
		conditions.push(`target_type = $${params.length}`);
	}
	if (filters.from) {
		params.push(filters.from);
		conditions.push(`occurred_at >= $${params.length}`);
	}
	if (filters.to) {
		params.push(filters.to);
		conditions.push(`occurred_at <= $${params.length}`);
	}
	if (filters.search) {
		params.push(`%${filters.search.toLowerCase()}%`);
		const p = `$${params.length}`;
		conditions.push(
			`(lower(coalesce(actor_email, '')) LIKE ${p} OR lower(action) LIKE ${p} OR lower(coalesce(target_id, '')) LIKE ${p})`,
		);
	}

	return conditions;
}

/** The filename an operator receives. Dated so two exports do not overwrite each other. */
export function auditExportFilename(now: Date = new Date()): string {
	return `nova-admin-audit-${now.toISOString().slice(0, 10)}.csv`;
}
