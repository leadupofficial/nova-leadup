/**
 * Integration tests for @nova/auth routes.
 * vi.mock() factories are hoisted — must be self-contained (no top-level var refs).
 * Each vi.mock for a module must include ALL exports needed from that module,
 * since later vi.mock calls for the same module overwrite earlier ones.
 */
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { authenticateJwt, errorHandler } from '../middleware';
import authRoutes from '../routes/authRoutes';
import orgRoutes from '../routes/orgRoutes';

// ---- vi.mock factories (hoisted, self-contained) ----

vi.mock('../repositories/users', () => ({
 findUserByEmail: vi.fn(() => Promise.resolve(null)),
 createUser: vi.fn(() => Promise.resolve({ id: 'u1', primary_organization_id: 'o1', primary_workspace_id: 'w1', email_verified: true })),
 verifyEmail: vi.fn(() => Promise.resolve(true)),
 updatePassword: vi.fn(() => Promise.resolve(true)),
 findUserById: vi.fn((id) => id === 'usr_abc' ? Promise.resolve({ id: 'usr_abc', email: 't@e.com', name: 'Test User', primary_organization_id: 'org_123', primary_workspace_id: 'ws_456' }) : Promise.resolve(null)),
}));

vi.mock('../repositories/organizations', () => ({
 createOrganization: vi.fn(() => Promise.resolve({ id: 'o1', name: 'Test', slug: 'test', plan: 'free' })),
 findOrganizationById: vi.fn(() => Promise.resolve({ id: 'o1' })),
 findWorkspacesByOrg: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../repositories/workspaces', () => ({ createWorkspace: vi.fn(() => Promise.resolve({ id: 'w1', organization_id: 'o1', name: 'Default' })) }));

vi.mock('../repositories/roles', () => ({
 findRoleByKey: vi.fn(() => Promise.resolve({ id: 'r1', key: 'owner', is_system: true })),
 assignRoleToUser: vi.fn(() => Promise.resolve({ id: 'b1' })),
}));

vi.mock('../repositories/sessions', () => ({
 createSession: vi.fn(() => Promise.resolve({ id: 's1', status: 'active' })),
 findSessionByToken: vi.fn((token) => token === 'valid_token_abc' ? Promise.resolve({ id: 's1', user_id: 'usr_abc', organization_id: 'org_123', workspace_id: 'ws_456', status: 'active' }) : Promise.resolve(null)),
 findSessionByRefreshToken: vi.fn(() => Promise.resolve(null)),
 rotateRefreshToken: vi.fn(() => Promise.resolve({ id: 's2', status: 'active' })),
}));

vi.mock('../repositories/otp', () => ({
 createOtpRecord: vi.fn(() => Promise.resolve({ id: 'o1' })),
 findActiveOtp: vi.fn(() => Promise.resolve(null)),
 markOtpConsumed: vi.fn(() => Promise.resolve(true)),
 incrementOtpAttempts: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../repositories/audit', () => ({ logAudit: vi.fn(() => Promise.resolve({ id: 'a1' })) }));
vi.mock('../repositories/db', () => ({ q: vi.fn(() => Promise.resolve({ rows: [] })) }));

vi.mock('../crypto', () => ({
 hashPassword: vi.fn(() => 'hashed_pw'),
 verifyPassword: vi.fn(() => true),
 generateOtp: vi.fn(() => '123456'),
 encryptToken: (v: string) => v,
 decryptToken: (v: string) => v,
 hmacSha256: vi.fn(() => 'hmac_digest'),
 generateApiKey: vi.fn(() => ({ prefix: 'nova_live_abc', key: 'secret', hash: 'hashed' })),
}));

vi.mock('../jwt', () => ({
 signAccessToken: vi.fn(() => ({ token: 'at_mock', expiresIn: 900 })),
 signRefreshToken: vi.fn(() => ({ token: 'rt_mock', expiresAt: new Date() })),
 verifyAccessToken: vi.fn((token) => token === 'valid_token_abc' ? ({ sub: 'usr_abc', orgId: 'org_123', workspaceId: 'ws_456', role: 'member' }) : (() => { throw new Error('invalid') })(),),
}));

function createApp(): express.Express {
 const app = express();
 app.use(express.json({ limit: '10kb' }));
 app.use('/auth', authRoutes);
 app.use('/orgs', authenticateJwt, orgRoutes);
 app.use(errorHandler);
 return app;
}

describe('POST /auth/register', () => {
 beforeEach(() => { vi.clearAllMocks(); });

 it('returns 400 for invalid email', async () => {
 const app = createApp();
 const res = await request(app).post('/auth/register').send({ email: 'not-an-email', password: 'secure-password-123', name: 'Test' });
 expect(res.status).toBe(400);
 expect(res.body.title).toBe('Validation Error');
 });

 it('returns 400 for short password', async () => {
 const app = createApp();
 const res = await request(app).post('/auth/register').send({ email: 'test@example.com', password: 'sh', name: 'Test' });
 expect(res.status).toBe(400);
 });

 it('creates user and returns tokens', async () => {
 const { findUserByEmail: f1 } = await import('../repositories/users');
 const { createUser: f2 } = await import('../repositories/users');
 const { createOrganization: f3 } = await import('../repositories/organizations');
 const { createWorkspace: f4 } = await import('../repositories/workspaces');
 const { findRoleByKey: f5 } = await import('../repositories/roles');
 const { assignRoleToUser: f6 } = await import('../repositories/roles');
 const { createSession: f7 } = await import('../repositories/sessions');
 const { signAccessToken: f8 } = await import('../jwt');
 const { signRefreshToken: f9 } = await import('../jwt');
 f1.mockResolvedValue(null);
 f2.mockResolvedValue({ id: 'u1', primary_organization_id: 'o1', primary_workspace_id: 'w1', email_verified: true });
 f3.mockResolvedValue({ id: 'o1', name: 'Test', slug: 'test', plan: 'free' });
 f4.mockResolvedValue({ id: 'w1', organization_id: 'o1', name: 'Default' });
 f5.mockResolvedValue({ id: 'r1', key: 'owner', is_system: true });
 f6.mockResolvedValue({ id: 'b1' });
 f7.mockResolvedValue({ id: 's1', status: 'active' });
 f8.mockReturnValue({ token: 'at_abc', expiresIn: 900 });
 f9.mockReturnValue({ token: 'rt_xyz', expiresAt: new Date() });

 const app = createApp();
 const res = await request(app).post('/auth/register').send({ email: 'new@example.com', password: 'secure-password-123', name: 'New User' });
 expect(res.status).toBe(201);
 expect(res.body.user).toHaveProperty('id');
 expect(res.body.tokens).toHaveProperty('accessToken', 'at_abc');
 expect(res.body.tokens).toHaveProperty('refreshToken', 'rt_xyz');
 });
});

describe('POST /auth/login', () => {
 beforeEach(() => { vi.clearAllMocks(); });

 it('returns 401 for non-existent user', async () => {
 const { findUserByEmail: f1 } = await import('../repositories/users');
 f1.mockResolvedValue(null);
 const app = createApp();
 const res = await request(app).post('/auth/login').send({ email: 'noone@example.com', password: 'any' });
 expect(res.status).toBe(401);
 expect(res.body.title).toBe('Unauthorized');
 });

 it('returns 401 for wrong password', async () => {
 const { findUserByEmail: f1 } = await import('../repositories/users');
 const { verifyPassword: f2 } = await import('../crypto');
 f1.mockResolvedValue({ id: 'u1', email: 't@e.com', password_hash: 'hash', primary_organization_id: 'o1', primary_workspace_id: 'w1', email_verified: true });
 f2.mockResolvedValue(false);
 const app = createApp();
 const res = await request(app).post('/auth/login').send({ email: 't@e.com', password: 'wrong' });
 expect(res.status).toBe(401);
 });

 it('returns tokens on valid credentials', async () => {
 const { findUserByEmail: f1 } = await import('../repositories/users');
 const { verifyPassword: f2 } = await import('../crypto');
 const { createSession: f3 } = await import('../repositories/sessions');
 const { signAccessToken: f4 } = await import('../jwt');
 f1.mockResolvedValue({ id: 'u1', email: 't@e.com', password_hash: 'hash', primary_organization_id: 'o1', primary_workspace_id: 'w1', email_verified: true });
 f2.mockResolvedValue(true);
 f3.mockResolvedValue({ id: 's1', status: 'active' });
 f4.mockReturnValue({ token: 'at_abc', expiresIn: 900 });
 const app = createApp();
 const res = await request(app).post('/auth/login').send({ email: 't@e.com', password: 'pw' });
 expect(res.status).toBe(200);
 expect(res.body.tokens.accessToken).toBe('at_abc');
 expect(res.body.user.id).toBe('u1');
 });
});

describe('POST /auth/phone/otp/request', () => {
 beforeEach(() => { vi.clearAllMocks(); });

 it('returns 400 for invalid phone', async () => {
 const app = createApp();
 const res = await request(app).post('/auth/phone/otp/request').send({ phoneNumber: 'not-a-phone', channel: 'sms' });
 expect(res.status).toBe(400);
 });

 it('returns 202 for valid E.164 phone', async () => {
 const { createOtpRecord: f } = await import('../repositories/otp');
 f.mockResolvedValue({ id: 'o1' });
 const app = createApp();
 const res = await request(app).post('/auth/phone/otp/request').send({ phoneNumber: '+14155551234', channel: 'sms' });
 expect(res.status).toBe(202);
 expect(res.body.message).toBe('OTP sent');
 });
});

describe('POST /auth/password-reset/request', () => {
 beforeEach(() => { vi.clearAllMocks(); });

 it('returns 202 for unknown email', async () => {
 const app = createApp();
 const res = await request(app).post('/auth/password-reset/request').send({ email: 'unknown@example.com' });
 expect(res.status).toBe(202);
 expect(res.body.message).toContain('reset');
 });
});

describe('GET /auth/me', () => {
 beforeEach(() => { vi.clearAllMocks(); });

 it('returns 401 without token', async () => {
 const app = createApp();
 const res = await request(app).get('/auth/me');
 expect(res.status).toBe(401);
 });

 it('returns user with valid token', async () => {
 const { verifyAccessToken: f1 } = await import('../jwt');
 const { findSessionByToken: f2 } = await import('../repositories/sessions');
 const { findUserById: f3 } = await import('../repositories/users');
 f1.mockImplementation((t: string) => {
 if (t === 'valid_token_abc') return { sub: 'usr_abc', orgId: 'org_123', workspaceId: 'ws_456', role: 'member' };
 throw new Error('invalid');
 });
 f2.mockResolvedValue({ id: 's1', user_id: 'usr_abc', organization_id: 'org_123', workspace_id: 'ws_456', status: 'active' });
 f3.mockResolvedValue({ id: 'usr_abc', email: 't@e.com', name: 'Test User', primary_organization_id: 'org_123', primary_workspace_id: 'ws_456' });

 const app = createApp();
 const res = await request(app).get('/auth/me').set('Authorization', 'Bearer valid_token_abc');
 expect(res.status).toBe(200);
 expect(res.body.id).toBe('usr_abc');
 });
});

describe('RFC 7807 compliance', () => {
 beforeEach(() => { vi.clearAllMocks(); });

 it('errors have required fields', async () => {
 const app = createApp();
 const res = await request(app).get('/auth/me');
 expect(res.body).toHaveProperty('type');
 expect(res.body).toHaveProperty('title');
 expect(res.body).toHaveProperty('status');
 expect(res.body.status).toBe(401);
 expect(res.body.type).toContain('problems');
 });

 it('error body matches ProblemDetails shape', async () => {
 const app = createApp();
 const res = await request(app).get('/auth/me');
 expect(typeof res.body.type).toBe('string');
 expect(typeof res.body.title).toBe('string');
 expect(typeof res.body.status).toBe('number');
 });
});
