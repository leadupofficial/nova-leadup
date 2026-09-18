/**
 * NOVA API — Auth middleware tests.
 *
 * Covers: JWT authentication, API key authentication, and requireAdmin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import express from 'express';

// Declared with var so the hoisted vi.mock() factory can assign to it
// eslint-disable-next-line prefer-const
var mockGetDbPool: ReturnType<typeof vi.fn>;

// Mock the db/connection module BEFORE importing auth middleware
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
vi.mock('../../db/connection', () => {
	mockGetDbPool = vi.fn(() => ({
		query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
	}));
	return { getDbPool: mockGetDbPool };
});

import { authenticate, AuthenticatedRequest, requireAdmin } from '../../middleware/auth';
import { errorHandler, HttpError } from '../../middleware/error-handler.js';
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

	app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
		if (err instanceof HttpError) {
			return res.status(err.statusCode).json({ message: err.message, code: err.code });
		}
		res.status(err?.statusCode || 500).json({ message: err?.message || 'Internal Server Error' });
	});

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
		expect(res.body.error).toBe('Missing or invalid authorization header');
	});

	it('returns 401 when Authorization header does not start with Bearer', async () => {
		const res = await request(createApp()).get('/').set('Authorization', 'Basic abc');
		expect(res.status).toBe(401);
		expect(res.body.error).toBe('Missing or invalid authorization header');
	});

	it('returns 401 when token is invalid', async () => {
		const res = await request(createApp()).get('/').set('Authorization', 'Bearer invalid-token');
		expect(res.status).toBe(401);
		expect(res.body.error).toBe('Invalid or expired token');
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

	it('returns 500 when API_KEY_SECRET is not configured', async () => {
		process.env.API_KEY_SECRET = '';

		const app = express();
		app.use(authenticate as any);
		app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
			res.status(err?.statusCode || 500).json({ error: err?.error || err?.message || 'Unknown error' });
		});

		const res = await request(app).get('/').set('Authorization', 'Bearer nova_live_testkey_abc123');
		expect(res.status).toBe(500);
	});

	it('returns 401 for an API key with no DB match', async () => {
		const mockPool = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
		const { getDbPool } = await import('../../db/connection');
		mockGetDbPool.mockReturnValue(mockPool);

		const apiKey = 'nova_live_TestKey_abcdefghij';
		const app = express();
		app.use(authenticate as any);
		app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
			res.status(err?.statusCode || 500).json({ error: err });
		});

		const res = await request(app).get('/').set('Authorization', `Bearer ${apiKey}`);
		expect(res.status).toBe(401);
		expect(mockPool.query).toHaveBeenCalledWith(
			expect.stringContaining('SELECT'),
			expect.arrayContaining([expect.any(String), expect.any(String)]),
		);
	});

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
		const { getDbPool } = await import('../../db/connection');
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
		const { getDbPool } = await import('../../db/connection');
		mockGetDbPool.mockReturnValue(mockPool);

		const app = express();
		app.use(authenticate as any);
		app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
			res.status(err?.statusCode || 500).json({ error: err });
		});

		const res = await request(app).get('/').set('Authorization', `Bearer ${apiKey}`);
		expect(res.status).toBe(401);
	});

	it('attaches user context on valid API key and calls next()', async () => {
		const apiKey = 'nova_live_ValidKey_abcdefghij';

		const mockPool = {
			query: vi.fn().mockResolvedValue({
				rows: [{
					id: 'key-valid',
					organization_id: 'org-123',
					scopes: ['read', 'write'],
					expires_at: null,
					revoked_at: null,
				}],
				rowCount: 1,
			}),
		};
		const { getDbPool } = await import('../../db/connection');
		mockGetDbPool.mockReturnValue(mockPool);

		const app = express();
		app.use((req: AuthenticatedRequest, _res: Response, next: NextFunction) => {
			authenticate(req, _res, next);
		});
		app.get('/', (req: Request, res: Response) => {
			res.json({ authenticated: true, user: (req as AuthenticatedRequest).user, apiKey: (req as AuthenticatedRequest).apiKey });
		});

		const res = await request(app).get('/').set('Authorization', `Bearer ${apiKey}`);
		expect(res.status).toBe(200);
		expect(res.body.user).toBeDefined();
		expect(res.body.user.id).toBe('key-valid');
		expect(res.body.user.email).toBe('api-key:key-valid');
		expect(res.body.user.role).toBe('service');
		expect(res.body.user.organizationId).toBe('org-123');

		expect(res.body.apiKey).toBeDefined();
		expect(res.body.apiKey.id).toBe('key-valid');
		expect(res.body.apiKey.scopes).toEqual(['read', 'write']);
	});

	it('returns 401 on database error during API key validation', async () => {
		const apiKey = 'nova_live_DbErrorKey_xyz12345';

		const mockPool = {
			query: vi.fn().mockRejectedValue(new Error('Connection refused')),
		};
		const { getDbPool } = await import('../../db/connection');
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
		const { getDbPool } = await import('../../db/connection');
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
