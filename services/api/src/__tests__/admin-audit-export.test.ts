/**
 * Audit-log export — the CSV document, its escaping, and the route guard.
 *
 * `audit.export` existed as a permission with **no route** since the control-center migration, and
 * the console said so rather than offering a button that did nothing. These tests pin the parts
 * that a working export has to get right, and one of them is a security property rather than a
 * formatting one:
 *
 *  * **CSV injection.** A cell starting `=`, `+`, `-`, `@`, tab or CR is a formula to every
 *    spreadsheet application. Audit rows carry operator-supplied text — a reason, an email — so an
 *    unescaped reason of `=HYPERLINK("http://evil","click")` would run on the auditor's machine.
 *  * **Honest empties.** `null` must be an empty cell, not the text `"null"`.
 *  * **Filters that actually filter.** A filter that silently did nothing would produce a
 *    whole-table file that looks deliberate.
 *  * **Separation of permissions.** Holding `audit.read` must not confer the ability to take a
 *    copy of the log out of the platform.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import './setup.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import {
	AUDIT_EXPORT_COLUMNS,
	auditExportConditions,
	auditExportFilename,
	escapeCsvCell,
	toCsv,
	toCsvRow,
	type AuditExportRow,
} from '../admin/audit-export.js';
import app from '../server.js';

describe('CSV cell escaping', () => {
	it('leaves an ordinary value alone', () => {
		expect(escapeCsvCell('user.suspend')).toBe('user.suspend');
	});

	it('neutralises every formula prefix a spreadsheet honours', () => {
		// The leading apostrophe is what Excel and LibreOffice treat as "literal text". The
		// assertion is on the property rather than an exact string because a CR also forces the
		// cell to be quoted, so `\r` arrives as `"'\rcmd"` — escaped and quoted, both correct.
		for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
			const escaped = escapeCsvCell(`${prefix}cmd`);
			expect(escaped, `prefix ${JSON.stringify(prefix)}`).toContain(`'${prefix}`);
			// Whatever quoting happened, the cell no longer *begins* with the raw prefix.
			expect(escaped.startsWith(prefix)).toBe(false);
		}
	});

	it('neutralises the classic HYPERLINK payload', () => {
		const payload = '=HYPERLINK("http://evil.example","click")';
		const escaped = escapeCsvCell(payload);
		// The apostrophe sits immediately before the `=`, and the cell is quoted because the
		// payload contains quotes and a comma — both escapes, and both necessary.
		expect(escaped).toContain("'=HYPERLINK");
		expect(escaped).toContain('""http://evil.example""');
		// Whatever the quoting, the cell does not begin with `=`, which is what a spreadsheet
		// looks at when it decides whether to evaluate.
		expect(escaped.startsWith('=')).toBe(false);
	});

	it('does not treat a minus in the middle of a value as a formula', () => {
		// Only a *leading* character is dangerous; mangling every hyphen would corrupt user-agent
		// strings and ISO timestamps.
		expect(escapeCsvCell('Nova/1.4.0 (Android 14)')).toBe('Nova/1.4.0 (Android 14)');
		expect(escapeCsvCell('2026-09-21T19:00:00.000Z')).toBe('2026-09-21T19:00:00.000Z');
	});

	it('quotes values containing a comma, quote or newline', () => {
		expect(escapeCsvCell('a,b')).toBe('"a,b"');
		expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
		expect(escapeCsvCell('line one\nline two')).toBe('"line one\nline two"');
	});

	it('writes null and undefined as empty cells, not as words', () => {
		expect(escapeCsvCell(null)).toBe('');
		expect(escapeCsvCell(undefined)).toBe('');
		// An auditor must not read a value the database never held.
		expect(escapeCsvCell(null)).not.toBe('null');
	});

	it('writes a Date as its ISO instant, without JSON quotes', () => {
		// The first version JSON-stringified every non-string, so a timestamp cell arrived as
		// `"""2026-09-21T19:00:00.000Z"""` — quotes from the serialiser leaking into the file.
		expect(escapeCsvCell(new Date('2026-09-21T19:00:00.000Z'))).toBe('2026-09-21T19:00:00.000Z');
	});

	it('serialises an object cell as JSON rather than [object Object]', () => {
		// `before`/`after` are jsonb; the old shape of this bug is a column of "[object Object]".
		const cell = escapeCsvCell({ enabled: false });
		expect(cell).toContain('enabled');
		expect(cell).toContain('false');
		expect(cell).not.toContain('[object Object]');
	});
});

describe('CSV document', () => {
	/** A row with every column present but empty, so a test only states what it cares about. */
	function row(overrides: Partial<AuditExportRow> = {}): AuditExportRow {
		const blank = Object.fromEntries(
			AUDIT_EXPORT_COLUMNS.map((column) => [column, null]),
		) as AuditExportRow;
		return { ...blank, ...overrides };
	}

	function fullRow(overrides: Partial<AuditExportRow> = {}): AuditExportRow {
		return row({ action: 'user.suspend', outcome: 'success', ...overrides });
	}

	it('writes the header in the declared column order', () => {
		const csv = toCsv([]);
		expect(csv.replace('\ufeff', '').split('\r\n')[0]).toBe(AUDIT_EXPORT_COLUMNS.join(','));
	});

	it('starts with a BOM so Excel reads it as UTF-8', () => {
		expect(toCsv([]).startsWith('\ufeff')).toBe(true);
	});

	it('uses CRLF line endings, per RFC 4180', () => {
		expect(toCsv([fullRow()])).toContain('\r\n');
	});

	it('emits one line per row plus the header', () => {
		const csv = toCsv([fullRow(), fullRow()]);
		expect(csv.trimEnd().split('\r\n')).toHaveLength(3);
	});

	it('places values in the columns their names claim', () => {
		const line = toCsvRow(fullRow({ actor_email: 'owner@example.com' }));
		const cells = line.split(',');
		expect(cells[0]).toBe(''); // occurred_at is null in the fixture
		expect(cells[1]).toBe('user.suspend');
		expect(cells[2]).toBe('success');
		expect(cells[3]).toBe('owner@example.com');
	});
});

describe('export filters', () => {
	it('adds no predicate when nothing is filtered', () => {
		const params: unknown[] = [];
		expect(auditExportConditions({}, params)).toEqual([]);
		expect(params).toEqual([]);
	});

	it('binds parameters in the order the fragments appear', () => {
		// A mismatch here compares the wrong column and returns the wrong rows silently.
		const params: unknown[] = [];
		const conditions = auditExportConditions(
			{ action: 'user.suspend', actorId: 'actor-1', outcome: 'denied', targetType: 'user' },
			params,
		);
		expect(conditions).toEqual([
			'action = $1',
			'actor_id = $2',
			'outcome = $3',
			'target_type = $4',
		]);
		expect(params).toEqual(['user.suspend', 'actor-1', 'denied', 'user']);
	});

	it('supports a date range so a truncated export can be narrowed', () => {
		const params: unknown[] = [];
		const conditions = auditExportConditions(
			{ from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' },
			params,
		);
		expect(conditions).toEqual(['occurred_at >= $1', 'occurred_at <= $2']);
		expect(params).toHaveLength(2);
	});

	it('never interpolates a search value into the SQL text', () => {
		const params: unknown[] = [];
		const conditions = auditExportConditions({ search: "'; DROP TABLE admin_audit_logs; --" }, params);
		expect(conditions[0]).not.toContain('DROP TABLE');
		expect(params[0]).toBe("%'; drop table admin_audit_logs; --%");
	});
});

describe('export filename', () => {
	it('is dated, so two exports do not overwrite one another', () => {
		const name = auditExportFilename(new Date('2026-09-21T19:00:00.000Z'));
		expect(name).toBe('nova-admin-audit-2026-09-21.csv');
	});
});

// ─── Route guard ─────────────────────────────────────────────────────────────

/**
 * Driven through the **real app with a real signed token**, not a stubbed actor.
 *
 * `routes/admin/system.ts` mounts `adminGate` at the router root, so `authenticate` runs before any
 * per-route stub could apply — the first version of this file stubbed `req.adminActor` and every
 * request came back 401. Signing a token is also the stronger test: it exercises the gate, the
 * grant/claim resolution and `requirePermission` in the order production uses them.
 */
function auth(role: string) {
	const token = jwt.sign(
		{ sub: 'user-1', email: 'verify@nova.test', role },
		process.env.JWT_SECRET!,
		{ expiresIn: '1h', jwtid: `verify-${Date.now()}-${role}` },
	);
	return { Authorization: `Bearer ${token}` };
}

describe('GET /control/audit-logs/export', () => {
	beforeAll(() => {
		process.env.NOVA_CONFIG_ENCRYPTION_KEY ??= 'a'.repeat(64);
	});

	it('refuses a caller whose role does not hold audit.export', async () => {
		// READ_ONLY is a genuine admin role and holds `config.read` and `analytics.read`, but not
		// the ability to take a copy of the audit log out of the platform.
		const res = await request(app).get('/api/v1/control/audit-logs/export').set(auth('read_only'));
		expect(res.status).toBe(403);
		expect(res.body.code).toBe('FORBIDDEN');
	});

	it('answers CSV for a caller who may export', async () => {
		// The suite-wide pool mock returns no rows, so this is the header-only document — which is
		// still a real CSV and proves the content type, the disposition and the column set.
		const res = await request(app).get('/api/v1/control/audit-logs/export').set(auth('owner'));
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toContain('text/csv');
		expect(res.headers['content-disposition']).toContain('attachment');
		expect(res.text.replace('\ufeff', '').split('\r\n')[0]).toBe(AUDIT_EXPORT_COLUMNS.join(','));
		// The two facts a streaming client needs, since it never renders the body.
		expect(res.headers['x-nova-export-rows']).toBe('0');
		expect(res.headers['x-nova-export-truncated']).toBe('false');
	});

	it('rejects an unknown outcome filter rather than ignoring it', async () => {
		const res = await request(app)
			.get('/api/v1/control/audit-logs/export?outcome=maybe')
			.set(auth('owner'));
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('VALIDATION_ERROR');
	});
});
