/**
 * The permission catalogue and the caller's own authority.
 *
 * The console carried its own copy of the role→permission matrix and of the catalogue, resolved from
 * the JWT's role claim in the browser. Its comment called that acceptable because the failure mode is a
 * visible 403. That was true and it missed the defect: **the console resolved the claim, and the API
 * resolves the database grant first**, so an operator whose grant differed from their token saw
 * destinations for the claim — some they could not open, some they could have.
 *
 * These tests pin the two properties that make the replacement work: the caller's answer is the set the
 * gate actually enforced, and the catalogue is the same list the enforcement reads.
 */
import { describe, it, expect } from 'vitest';
import './setup.js';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import app from '../server.js';
import { PERMISSION_METADATA, ROLE_PERMISSIONS, ADMIN_ROLES } from '../admin/permissions.js';

function auth(role: string) {
	const token = jwt.sign(
		{ sub: 'user-1', email: 'verify@nova.test', role },
		process.env.JWT_SECRET!,
		{ expiresIn: '1h', jwtid: `verify-${Date.now()}-${role}` },
	);
	return { Authorization: `Bearer ${token}` };
}

describe('GET /control/me/permissions', () => {
	it('answers the caller with the set the gate enforced', async () => {
		// Not a second resolution: the route reads what `adminGate` already resolved, so it cannot
		// disagree with what the same request was allowed to do.
		const res = await request(app).get('/api/v1/control/me/permissions').set(auth('owner'));
		expect(res.status).toBe(200);
		expect(res.body.data.adminRole).toBe('SUPER_ADMIN');
		expect(res.body.data.permissions.length).toBeGreaterThan(0);
	});

	it('answers a weaker role with strictly fewer permissions', async () => {
		const owner = await request(app).get('/api/v1/control/me/permissions').set(auth('owner'));
		const readOnly = await request(app).get('/api/v1/control/me/permissions').set(auth('read_only'));
		expect(readOnly.status).toBe(200);
		expect(readOnly.body.data.permissions).toEqual(['analytics.read', 'services.read', 'config.read', 'feature_flags.read']);
		expect(readOnly.body.data.permissions.length).toBeLessThan(owner.body.data.permissions.length);
	});

	it('needs no permission of its own', async () => {
		// Requiring one would mean an operator could not see what they hold — and every admin role can
		// reach this, including the weakest.
		for (const role of ['owner', 'admin', 'support', 'operations', 'analytics', 'developer', 'read_only']) {
			const res = await request(app).get('/api/v1/control/me/permissions').set(auth(role));
			expect(res.status, role).toBe(200);
		}
	});

	it('refuses a caller with no admin role at all', async () => {
		const res = await request(app).get('/api/v1/control/me/permissions').set(auth('user'));
		expect(res.status).toBe(403);
	});
});

describe('GET /control/permissions', () => {
	it('returns the catalogue the enforcement reads', async () => {
		const res = await request(app).get('/api/v1/control/permissions').set(auth('owner'));
		expect(res.status).toBe(200);
		expect(res.body.data.catalog).toHaveLength(PERMISSION_METADATA.length);
		expect(res.body.data.catalog[0]).toMatchObject({
			permission: expect.any(String),
			group: expect.any(String),
			label: expect.any(String),
			description: expect.any(String),
			dangerous: expect.any(Boolean),
		});
	});

	it('returns every role with the permissions it holds', async () => {
		const res = await request(app).get('/api/v1/control/permissions').set(auth('owner'));
		const roles = res.body.data.roles as Array<{ role: string; permissions: string[] }>;
		expect(roles.map((entry) => entry.role)).toEqual([...ADMIN_ROLES]);
		for (const entry of roles) {
			expect(entry.permissions, entry.role).toEqual(ROLE_PERMISSIONS[entry.role as keyof typeof ROLE_PERMISSIONS]);
		}
	});

	it('every permission a role holds is in the catalogue', async () => {
		// A role granting something the catalogue does not describe is a permission an operator cannot
		// see, which is how a matrix and its documentation drift apart.
		const known = new Set(PERMISSION_METADATA.map((entry) => entry.permission));
		for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
			for (const permission of permissions) {
				expect(known.has(permission), `${role} holds "${permission}", absent from the catalogue`).toBe(true);
			}
		}
	});

	it('is bounded by admin_users.read rather than open to every admin', async () => {
		const res = await request(app).get('/api/v1/control/permissions').set(auth('read_only'));
		expect(res.status).toBe(403);
	});

	it('carries no account or grant information', async () => {
		// Metadata about permissions, not about people: the same list for every caller.
		const res = await request(app).get('/api/v1/control/permissions').set(auth('owner'));
		const serialised = JSON.stringify(res.body.data);
		expect(serialised).not.toMatch(/@nova\.test|user-1|grantedBy/);
	});
});
