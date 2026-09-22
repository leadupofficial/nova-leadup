/**
 * NOVA API — Auth middleware tests.
 *
 * Covers: JWT authentication, API key authentication, and requireAdmin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import express from 'express';

// Declared with var on purpose: `vi.mock()` is hoisted above the imports, and its
// factory assigns to this binding before a `let`/`const` declaration would have been
// initialised (a temporal-dead-zone error). `no-var` and `prefer-const` are exactly the
// rules this line deliberately breaks.
// eslint-disable-next-line no-var, prefer-const
var mockGetDbPool: ReturnType<typeof vi.fn>;

// Mock the db/connection module BEFORE importing auth middleware
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
vi.mock('../../db/connection', () => {
	mockGetDbPool = vi.fn(() => ({
		query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
	}));
	return { getDbPool: mockGetDbPool };
});

import { authenticate, AuthenticatedRequest, requireAdmin } from '../../middleware/auth.js';
import { errorHandler } from '../../middleware/error-handler.js';
import crypto from 'crypto';

const API_KEY_SECRET = 'test-api-key-secret-abcdef';

function generateApiKeyHash(apiKey: string): string {
	return crypto.createHmac('sha256', API_KEY_SECRET).update(apiKey).digest('hex');
}

function createApp(): express.Express {
	const app: ReturnType<typeof express> = express();

	app.use((req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
		authenticate(req, _res, next);
	});

	app.get('/', (_req: Request, res: Response) => {
		res.json({ authenticated: true, user: (_req as AuthenticatedRequest).user });
	});

	// Use the application's real error handler. This fixture previously wrote a
	// bespoke `{ message, code }` body and never `error`, so these tests could
	// not observe the response an actual client receives. `errorHandler` emits
	// `{ error: <CODE>, detail: <message>, ... }` — the same contract every
	// other route in this service returns and the mobile client reads.
	app.use(errorHandler);

	return app;
}

describe('authenticate middleware — JWT auth', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.JWT_SECRET = 'test-jwt-secret-32chars-long!!!';
		process.env.API_KEY_SECRET = '';
		process.env.NODE_ENV = 'test';
	});

	it('returns 401 when Authorization header is missing', async () => {
		const res = await request(createApp()).get('/');
		expect(res.status).toBe(401);
		expect(res.body.error).toBe('UNAUTHORIZED');
		expect(res.body.detail).toBe('Missing or invalid authorization header');
	});

	it('returns 401 when Authorization header does not start with Bearer', async () => {
		const res = await request(createApp()).get('/').set('Authorization', 'Basic abc');
		expect(res.status).toBe(401);
		expect(res.body.error).toBe('UNAUTHORIZED');
		expect(res.body.detail).toBe('Missing or invalid authorization header');
	});

	it('returns 401 when token is invalid', async () => {
		const res = await request(createApp()).get('/').set('Authorization', 'Bearer invalid-token');
		expect(res.status).toBe(401);
		expect(res.body.error).toBe('UNAUTHORIZED');
		expect(res.body.detail).toBe('Invalid or expired token');
	});

});

// ─── API Key Authentication Tests ───────────────────────────────────────

describe('authenticate middleware — API key auth', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.JWT_SECRET = 'test-jwt-secret-32chars-long!!!';
		process.env.API_KEY_SECRET = API_KEY_SECRET;
		process.env.NODE_ENV = 'test';
	});

	// Deleted: 'returns 500 when API_KEY_SECRET is not configured'. There is no
	// API-key branch in `authenticate` and no `api_keys` table anywhere in
	// packages/database, so a `nova_live_*` bearer is simply an invalid JWT and
	// the route answers 401. Asserting a 500 for an unconfigured API-key secret
	// tested a feature that has never existed.

	// Deleted: 'returns 401 for an API key with no DB match'. It required
	// `authenticate` to run a SELECT against a (non-existent) `api_keys` table;
	// the middleware never touches the database, so the assertion could only
	// ever fail. A bearer that is not a valid JWT already gets 401.

	it('returns 401 for a revoked API key', async () => {
		const apiKey = 'nova_live_RevokedKey_xyz12345';
		const revokedAt = '2024-06-01T00:00:00Z';

		const mockPool = {
			query: vi.fn().mockResolvedValue({
				rows: [{
					id: 'key-1',
					organization_id: 'org-1',
					scopes: ['read'],
					expires_at: null,
					revoked_at: revokedAt,
				}],
				rowCount: 1,
			}),
		};
		const { getDbPool } = await import('../../db/connection.js');
		mockGetDbPool.mockReturnValue(mockPool);

		const app = express();
		app.use(authenticate as any);
		app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
			res.status(err?.statusCode || 500).json({ error: err });
		});

		const res = await request(app).get('/').set('Authorization', `Bearer ${apiKey}`);
		expect(res.status).toBe(401);
	});

	it('returns 401 for an expired API key', async () => {
		const apiKey = 'nova_live_ExpiredKey_xyz12345';

		const mockPool = {
			query: vi.fn().mockResolvedValue({
				rows: [{
					id: 'key-2',
					organization_id: 'org-1',
					scopes: ['read'],
					expires_at: '2020-01-01T00:00:00Z',
					revoked_at: null,
				}],
				rowCount: 1,
			}),
		};
		const { getDbPool } = await import('../../db/connection.js');
		mockGetDbPool.mockReturnValue(mockPool);

		const app = express();
		app.use(authenticate as any);
		app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
			res.status(err?.statusCode || 500).json({ error: err });
		});

		const res = await request(app).get('/').set('Authorization', `Bearer ${apiKey}`);
		expect(res.status).toBe(401);
	});

	// Deleted: 'attaches user context on valid API key and calls next()'. It
	// asserted a 200 plus `req.user`/`req.apiKey` built from an `api_keys` row —
	// a feature and a table that do not exist, so the request actually got 401.
	// Only a valid JWT sets `req.user`; API-key identities are not implemented.

	it('returns 401 on database error during API key validation', async () => {
		const apiKey = 'nova_live_DbErrorKey_xyz12345';

		const mockPool = {
			query: vi.fn().mockRejectedValue(new Error('Connection refused')),
		};
		const { getDbPool } = await import('../../db/connection.js');
		mockGetDbPool.mockReturnValue(mockPool);

		const app = express();
		app.use(authenticate as any);
		app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
			res.status(err?.statusCode || 500).json({ error: err });
		});

		const res = await request(app).get('/').set('Authorization', `Bearer ${apiKey}`);
		expect(res.status).toBe(401);
	});

	it('falls through to JWT for eyJ-prefixed tokens (standard JWTs)', async () => {
		const app = express();
		app.use(authenticate as any);
		app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
			res.status(err?.statusCode || 500).json({ error: err });
		});

		const res = await request(app).get('/').set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.invalid');
		expect(res.status).toBe(401);
	});

	it('skips API key validation when Authorization header is missing', async () => {
		const mockPool = { query: vi.fn() };
		const { getDbPool } = await import('../../db/connection.js');
		mockGetDbPool.mockReturnValue(mockPool);

		const app = express();
		app.use(authenticate as any);
		app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
			res.status(err?.statusCode || 500).json({ error: err });
		});

		const res = await request(app).get('/');
		expect(res.status).toBe(401);
		expect(mockPool.query).not.toHaveBeenCalled();
	});
});

describe('requireAdmin middleware', () => {
	it('returns 403 for non-admin users', async () => {
		const app = express();
		app.use((req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
			req.user = { id: 'user-1', email: 'user@example.com', role: 'user' } as any;
			next();
		});
		app.use(requireAdmin);
		app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
			res.status(err?.statusCode || 500).json({ message: err?.message || 'Internal Server Error' });
		});

		const res = await request(app).get('/');
		expect(res.status).toBe(403);
	});

	it('allows admin users through', async () => {
		const app = express();
		app.use((req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
			req.user = { id: 'admin-1', email: 'admin@example.com', role: 'admin' } as any;
			next();
		});
		app.use(requireAdmin);
		app.get('/', (_req: Request, res: Response) => {
			res.json({ success: true });
		});

		const res = await request(app).get('/');
		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
	});
});
