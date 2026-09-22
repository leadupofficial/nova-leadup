import { describe, it, expect } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requirePermission, errorHandler, HttpError, createError } from '../src/middleware.js';

/**
 * These tests previously imported `authenticateJwt` and `requireRole` — neither of
 * which has ever existed in `services/admin/src/middleware.ts` (the exports are
 * `authenticateAdmin`, `requirePermission`, `errorHandler`, `HttpError`,
 * `createError`). Every test failed with "is not a function", and the failure went
 * unseen because the package had no `test` script, so `turbo run test` skipped it.
 *
 * `authenticateAdmin` has since been deleted (it trusted an unsigned base64 payload),
 * so authentication itself is covered where it lives: `@nova/auth`'s
 * `authenticateJwt`, exercised by `services/auth`'s suite and by the live admin API
 * check. What is covered here is what this package actually owns.
 */

function mockReq(overrides: Partial<Request> = {}): Request {
	return { headers: {}, ...overrides } as unknown as Request;
}

function nextFn(calls: unknown[]) {
	return (arg?: unknown) => {
		calls.push(arg);
	};
}

describe('requirePermission', () => {
	it('forbids when no admin context is attached', () => {
		const calls: unknown[] = [];
		requirePermission('users:read')(mockReq(), {} as Response, nextFn(calls) as NextFunction);

		expect(calls).toHaveLength(1);
		expect((calls[0] as HttpError).status).toBe(403);
	});

	it('forbids when the permission is absent', () => {
		const calls: unknown[] = [];
		const req = mockReq() as Request & { auth?: { userId: string; role: string; permissions: string[] } };
		req.auth = { userId: 'u1', role: 'admin', permissions: ['orgs:read'] };

		requirePermission('users:read')(req, {} as Response, nextFn(calls) as NextFunction);

		expect(calls).toHaveLength(1);
		expect((calls[0] as HttpError).status).toBe(403);
	});

	it('allows when the permission is present', () => {
		const calls: unknown[] = [];
		const req = mockReq() as Request & { auth?: { userId: string; role: string; permissions: string[] } };
		req.auth = { userId: 'u1', role: 'admin', permissions: ['users:read'] };

		requirePermission('users:read')(req, {} as Response, nextFn(calls) as NextFunction);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toBeUndefined();
	});
});

describe('errorHandler', () => {
	function mockRes() {
		const res = {
			statusCode: 0,
			body: undefined as unknown,
			status(code: number) {
				res.statusCode = code;
				return res;
			},
			json(payload: unknown) {
				res.body = payload;
				return res;
			},
		};
		return res as unknown as Response & { statusCode: number; body: Record<string, unknown> };
	}

	it('maps an HttpError to its status and RFC 7807 shape', () => {
		const res = mockRes();
		errorHandler(new HttpError(403, 'Missing permission: users:read'), mockReq(), res, (() => {}) as NextFunction);

		expect(res.statusCode).toBe(403);
		expect(res.body).toMatchObject({ status: 403, title: 'Missing permission: users:read' });
	});

	it('maps an unknown error to 500', () => {
		const res = mockRes();
		errorHandler(new Error('boom'), mockReq(), res, (() => {}) as NextFunction);

		expect(res.statusCode).toBe(500);
		expect(res.body).toMatchObject({ status: 500 });
	});
});

describe('createError', () => {
	it('builds an HttpError', () => {
		const err = createError(401, 'Missing authorization token');
		expect(err).toBeInstanceOf(HttpError);
		expect(err.status).toBe(401);
	});
});
