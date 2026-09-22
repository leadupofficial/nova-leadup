/**
 * Administrator sessions — state derivation and route guards.
 *
 * `admin_sessions` had no writer from migration 0006 until now, so nothing here could be tested
 * against real rows: the table was permanently empty and `touchAdminSession()` updated a row that
 * could not exist. Two things are pinned in this file, and both are about the *decision* rather
 * than the storage:
 *
 *  1. **What a row means.** `revoked_at IS NULL` alone would call a session whose token expired an
 *     hour ago a live operator. The three states are derived on the server so the console cannot
 *     re-invent them, and the precedence between "ended" and "expired" is a deliberate choice.
 *  2. **Who may end one.** The listing is `admin_users.read` and the revocation is
 *     `admin_users.manage`, so a read-only administrator can see that a session exists and cannot
 *     end it.
 *
 * The revocation path itself — that the token is refused on its next request — is verified live in
 * `scripts/verify-platform-roles.py` section 14, because it depends on the in-process denylist and
 * a real token. A mocked database cannot show it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import './setup.js';
import express from 'express';
import request from 'supertest';

import { adminSessionState } from '../admin/admin-sessions.js';
import adminSessionsRouter from '../routes/admin/admin-sessions.js';
import { errorHandler } from '../middleware/error-handler.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');
const MINUTE = 60 * 1000;

function record(overrides: { revokedAt?: Date | null; expiresAt?: Date } = {}) {
	return {
		revokedAt: null,
		expiresAt: new Date(NOW.getTime() + 10 * MINUTE),
		...overrides,
	};
}

describe('administrator session state', () => {
	it('calls an unrevoked, unexpired session active', () => {
		expect(adminSessionState(record(), NOW)).toBe('active');
	});

	it('calls an unrevoked session past its expiry expired, not active', () => {
		// The bug this guards: a token that died an hour ago counted as a signed-in operator.
		expect(adminSessionState(record({ expiresAt: new Date(NOW.getTime() - MINUTE) }), NOW)).toBe('expired');
	});

	it('treats an expiry exactly now as expired', () => {
		expect(adminSessionState(record({ expiresAt: new Date(NOW.getTime()) }), NOW)).toBe('expired');
	});

	it('prefers revoked over expired when a session is both', () => {
		// The revocation is an operator's decision and the more useful fact, so it wins. The
		// reverse would report an ended session as merely stale.
		const both = record({
			revokedAt: new Date(NOW.getTime() - 2 * MINUTE),
			expiresAt: new Date(NOW.getTime() - MINUTE),
		});
		expect(adminSessionState(both, NOW)).toBe('revoked');
	});
});

// ─── Route guards ────────────────────────────────────────────────────────────

/**
 * Mounts the real router behind a stubbed actor.
 *
 * `requirePermission` reads `req.adminActor` and `req.adminPermissions`, which `resolveAdmin`
 * normally sets from a verified token. Stubbing them here exercises the real middleware chain, the
 * real validation and the real error handler while leaving the database to the suite-wide mock —
 * which answers no rows, so every session lookup is a miss.
 */
function appWith(permissions: string[], jti = 'verify-self') {
	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		(req as unknown as Record<string, unknown>).adminActor = {
			id: '99999999-9999-4999-8999-999999999999',
			email: 'owner@example.com',
			platformRole: 'owner',
			adminRole: 'SUPER_ADMIN',
			ipAddress: null,
			userAgent: null,
			requestId: null,
		};
		(req as unknown as Record<string, unknown>).adminPermissions = permissions;
		(req as unknown as Record<string, unknown>).user = { id: '99999999-9999-4999-8999-999999999999', email: 'owner@example.com', role: 'owner', jti };
		next();
	});
	app.use('/control', adminSessionsRouter);
	app.use(errorHandler);
	return app;
}

describe('administrator session routes', () => {
	beforeAll(() => {
		process.env.NOVA_CONFIG_ENCRYPTION_KEY ??= 'a'.repeat(64);
	});

	it('answers the list with a pagination envelope and a state tally', async () => {
		const res = await request(appWith(['admin_users.read'])).get('/control/admin-sessions?status=all');
		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data.data).toEqual([]);
		expect(res.body.data.totalItems).toBe(0);
		expect(res.body.data.counts).toEqual({ active: 0, revoked: 0, expired: 0 });
		// The page states how a revocation propagates rather than implying a global instant end.
		expect(res.body.data.notes.join(' ')).toContain('denylist');
	});

	it('refuses the list without the read permission', async () => {
		const res = await request(appWith([])).get('/control/admin-sessions');
		expect(res.status).toBe(403);
		expect(res.body.code).toBe('FORBIDDEN');
	});

	it('refuses a revocation for a caller who may read but not manage administrators', async () => {
		// `admin_users.read` is held by more than one role; `admin_users.manage` is SUPER_ADMIN
		// only. Ending an operator's session must need the stronger one.
		const res = await request(appWith(['admin_users.read']))
			.post('/control/admin-sessions/11111111-1111-4111-8111-111111111111/revoke')
			.send({ reason: 'suspected token theft' });
		expect(res.status).toBe(403);
		expect(res.body.code).toBe('FORBIDDEN');
	});

	it('rejects an unknown status filter instead of ignoring it', async () => {
		const res = await request(appWith(['admin_users.read'])).get('/control/admin-sessions?status=live');
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('VALIDATION_ERROR');
	});

	it('400s a revoke with a non-uuid id rather than reaching the database', async () => {
		const res = await request(appWith(['admin_users.manage']))
			.post('/control/admin-sessions/not-a-uuid/revoke')
			.send({ reason: 'suspected token theft' });
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('BAD_REQUEST');
	});

	it('requires a reason before it will end a session', async () => {
		const res = await request(appWith(['admin_users.manage']))
			.post('/control/admin-sessions/11111111-1111-4111-8111-111111111111/revoke')
			.send({});
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('VALIDATION_ERROR');
	});

	it('404s a revoke for a session that does not exist', async () => {
		const res = await request(appWith(['admin_users.manage']))
			.post('/control/admin-sessions/11111111-1111-4111-8111-111111111111/revoke')
			.send({ reason: 'suspected token theft' });
		expect(res.status).toBe(404);
		expect(res.body.code).toBe('NOT_FOUND');
	});
});
