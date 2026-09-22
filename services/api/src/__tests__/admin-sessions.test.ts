/**
 * Admin Control Center — the session inventory.
 *
 * The console linked to `/sessions` while the API had no route behind it and no page
 * rendered it, so the destination 404'd and the browser sweep never noticed because its
 * list of destinations was typed by hand. The route is new; this file pins the two
 * things about it that can be wrong without a database:
 *
 *  1. **The state a row reports.** `revoked_at IS NULL` is not "active" — a session that
 *     expired three weeks ago is finished, and counting it as active overstates how many
 *     people are signed in. The boundary (expires exactly now) is asserted rather than
 *     left to the run time of the suite.
 *
 *  2. **The filter SQL.** Every filter becomes a bind parameter, never a concatenation,
 *     and the parameter order has to match the fragment order or the query silently
 *     compares the wrong column. The placeholder indices are asserted literally.
 *
 * Execution against real rows is covered by `scripts/verify-platform-roles.py`, which
 * drives the mounted route with a real token against a real database — the suite's
 * `DATABASE_URL` is a placeholder no server answers, so a row-level assertion here would
 * pass for the wrong reason.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import './setup.js';
import express from 'express';
import request from 'supertest';

import { toSession, sessionConditions, type SessionRow } from '../routes/admin/sessions.js';
import sessionsRouter from '../routes/admin/sessions.js';
import { errorHandler } from '../middleware/error-handler.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function row(overrides: Partial<SessionRow> = {}): SessionRow {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		user_id: '22222222-2222-4222-8222-222222222222',
		email: 'user@example.com',
		name: 'Test User',
		disabled: false,
		device_id: '33333333-3333-4333-8333-333333333333',
		device_name: 'Pixel 8',
		device_platform: 'android',
		ip_address: '203.0.113.7',
		user_agent: 'Nova/1.4.0 (Android 14)',
		expires_at: new Date(NOW.getTime() + 7 * 24 * HOUR),
		revoked_at: null,
		created_at: new Date(NOW.getTime() - HOUR),
		...overrides,
	};
}

describe('session state derivation', () => {
	it('calls a live, unrevoked session active', () => {
		const s = toSession(row(), NOW);
		expect(s.state).toBe('active');
		expect(s.active).toBe(true);
		expect(s.revokedAt).toBeNull();
	});

	it('calls an unrevoked session past its expiry expired, not active', () => {
		// The bug this guards: treating "not revoked" as "signed in".
		const s = toSession(row({ expires_at: new Date(NOW.getTime() - 1) }), NOW);
		expect(s.state).toBe('expired');
		expect(s.active).toBe(false);
	});

	it('treats an expiry exactly now as expired', () => {
		// `<=` rather than `<`: the session is no longer usable at the instant it expires.
		const s = toSession(row({ expires_at: new Date(NOW.getTime()) }), NOW);
		expect(s.state).toBe('expired');
	});

	it('prefers revoked over expired when a revoked session is also past expiry', () => {
		const s = toSession(
			row({ revoked_at: new Date(NOW.getTime() - 2 * HOUR), expires_at: new Date(NOW.getTime() - HOUR) }),
			NOW,
		);
		expect(s.state).toBe('revoked');
		expect(s.active).toBe(false);
		// The revocation timestamp survives, so the log can answer "when was this killed".
		expect(s.revokedAt).toBe(new Date(NOW.getTime() - 2 * HOUR).toISOString());
	});

	it('reports no device rather than a device with null fields', () => {
		const s = toSession(row({ device_id: null }), NOW);
		expect(s.device).toBeNull();
	});

	it('survives a user row with no name and no email', () => {
		// `users.name` and `users.email` are nullable in the schema; a deleted or
		// never-completed account still has sessions and must not break the page.
		const s = toSession(row({ email: null, name: null, disabled: null }), NOW);
		expect(s.user.email).toBeNull();
		expect(s.user.name).toBeNull();
		expect(s.user.disabled).toBe(false);
	});

	it('serialises timestamps as ISO strings so the console can format them', () => {
		const s = toSession(row(), NOW);
		expect(s.createdAt).toBe(new Date(NOW.getTime() - HOUR).toISOString());
		expect(s.expiresAt).toBe(new Date(NOW.getTime() + 7 * 24 * HOUR).toISOString());
	});
});

describe('session filter SQL', () => {
	it('adds no status predicate for "all"', () => {
		const params: unknown[] = [];
		expect(sessionConditions({ status: 'all' }, params)).toEqual([]);
		expect(params).toEqual([]);
	});

	it('distinguishes active from expired — they are not complements of revoked', () => {
		const active = sessionConditions({ status: 'active' }, []);
		const expired = sessionConditions({ status: 'expired' }, []);
		const revoked = sessionConditions({ status: 'revoked' }, []);
		expect(active[0]).toContain('s.revoked_at IS NULL');
		expect(active[0]).toContain('s.expires_at > now()');
		expect(expired[0]).toContain('s.expires_at <= now()');
		expect(revoked[0]).toBe('s.revoked_at IS NOT NULL');
	});

	it('binds the user id and search as parameters in that order', () => {
		const params: unknown[] = [];
		const conditions = sessionConditions(
			{ status: 'active', userId: '22222222-2222-4222-8222-222222222222', search: 'Example.COM' },
			params,
		);
		expect(conditions).toHaveLength(3);
		expect(conditions[1]).toBe('s.user_id = $1');
		// Lower-cased so a search typed in any case matches; `%` wrapping is the caller's.
		expect(conditions[2]).toContain('$2');
		expect(params).toEqual(['22222222-2222-4222-8222-222222222222', '%example.com%']);
	});

	it('searches email, name, IP and user-agent in one predicate', () => {
		const conditions = sessionConditions({ status: 'all', search: 'pixel' }, []);
		for (const column of ['u.email', 'u.name', 's.ip_address', 's.user_agent']) {
			expect(conditions[0]).toContain(column);
		}
	});

	it('never interpolates a search value into the SQL text', () => {
		// A quote in the search must end up in the parameter array, not the statement.
		const params: unknown[] = [];
		const conditions = sessionConditions({ status: 'all', search: "'; DROP TABLE sessions; --" }, params);
		expect(conditions[0]).not.toContain('DROP TABLE');
		expect(params[0]).toBe("%'; drop table sessions; --%");
	});
});

// ─── Route wiring ────────────────────────────────────────────────────────────

/**
 * Mounts the real router behind a stubbed actor.
 *
 * `requirePermission` reads `req.adminActor` and `req.adminPermissions`, which
 * `resolveAdmin` normally sets from a verified token. Stubbing them here is what lets the
 * route's own decisions — validation, 404, 403, response shape — be asserted without
 * signing in, while still exercising the real middleware chain and the real error
 * handler. The database is the suite-wide mock, so every query answers with no rows.
 */
function appWith(permissions: string[]) {
	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		(req as unknown as Record<string, unknown>).adminActor = {
			id: '99999999-9999-4999-8999-999999999999',
			email: 'admin@example.com',
			platformRole: 'owner',
			adminRole: 'SUPER_ADMIN',
			ipAddress: null,
			userAgent: null,
			requestId: null,
		};
		(req as unknown as Record<string, unknown>).adminPermissions = permissions;
		next();
	});
	app.use('/control', sessionsRouter);
	app.use(errorHandler);
	return app;
}

describe('session routes', () => {
	beforeAll(() => {
		process.env.NOVA_CONFIG_ENCRYPTION_KEY ??= 'a'.repeat(64);
	});

	it('answers the list with a pagination envelope and a status tally', async () => {
		const res = await request(appWith(['users.read'])).get('/control/sessions?status=all');
		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data.data).toEqual([]);
		expect(res.body.data.totalItems).toBe(0);
		expect(res.body.data.totalPages).toBe(1);
		expect(res.body.data.counts).toEqual({ active: 0, revoked: 0, expired: 0 });
		// The page states its own limits rather than implying push-based revocation.
		expect(res.body.data.notes.join(' ')).toContain('refresh token');
	});

	it('refuses the list without the read permission', async () => {
		const res = await request(appWith([])).get('/control/sessions');
		expect(res.status).toBe(403);
		expect(res.body.code).toBe('FORBIDDEN');
	});

	it('rejects an unknown status filter instead of ignoring it', async () => {
		// Silently treating a typo as "all" would show an operator every session while
		// the filter control said "active".
		const res = await request(appWith(['users.read'])).get('/control/sessions?status=live');
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('VALIDATION_ERROR');
	});

	it('404s a revoke for a session that does not exist', async () => {
		const res = await request(appWith(['users.sessions_revoke']))
			.post('/control/sessions/11111111-1111-4111-8111-111111111111/revoke')
			.send({ reason: 'suspected token theft' });
		expect(res.status).toBe(404);
		expect(res.body.code).toBe('NOT_FOUND');
	});

	it('400s a revoke with a non-uuid id rather than reaching the database', async () => {
		const res = await request(appWith(['users.sessions_revoke']))
			.post('/control/sessions/not-a-uuid/revoke')
			.send({ reason: 'suspected token theft' });
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('BAD_REQUEST');
	});

	it('requires a reason before it will revoke', async () => {
		// Every mutation in the control plane is attributable; a revoke without a reason
		// leaves an audit row that cannot answer "why".
		const res = await request(appWith(['users.sessions_revoke']))
			.post('/control/sessions/11111111-1111-4111-8111-111111111111/revoke')
			.send({});
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('VALIDATION_ERROR');
	});

	it('refuses a revoke without the revoke permission', async () => {
		const res = await request(appWith(['users.read']))
			.post('/control/sessions/11111111-1111-4111-8111-111111111111/revoke')
			.send({ reason: 'suspected token theft' });
		expect(res.status).toBe(403);
		expect(res.body.code).toBe('FORBIDDEN');
	});
});
