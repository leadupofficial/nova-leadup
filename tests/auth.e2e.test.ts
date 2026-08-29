import { test, expect } from './helpers';
import type { ApiClient } from './helpers';

test.describe('API health endpoints', () => {
 test.describe('GET /health', () => {
 test('returns 200 with health status', async ({ api }: { api: ApiClient }) => {
 const res = await api.get('/health');
 expect(res.ok()).toBe(true);
 const body = await res.json();
 expect(body.status).toBe('healthy');
 expect(body).toHaveProperty('timestamp');
 expect(body).toHaveProperty('version');
 expect(body.dependencies).toHaveProperty('database');
 expect(body.dependencies).toHaveProperty('redis');
 expect(body.dependencies).toHaveProperty('storage');
 });

 test('response matches HealthCheckSchema', async ({ api }: { api: ApiClient }) => {
 const res = await api.get('/health');
 expect(res.ok()).toBe(true);
 const body = await res.json();
 expect(['healthy', 'degraded', 'unhealthy']).toContain(body.status);
 expect(typeof body.timestamp).toBe('string');
 expect(typeof body.version).toBe('string');
 expect(body.dependencies.database.status).toBe('up');
 expect(body.dependencies.redis.status).toBe('up');
 expect(body.dependencies.storage.status).toBe('up');
 });
 });

 test.describe('GET /health/ready', () => {
 test('returns 200 when service is ready', async ({ api }: { api: ApiClient }) => {
 const res = await api.get('/health/ready');
 expect(res.ok()).toBe(true);
 const body = await res.json();
 expect(body.status).toBe('ready');
 });
 });

 test.describe('GET /health/live', () => {
 test('returns 200 when service is alive', async ({ api }: { api: ApiClient }) => {
 const res = await api.get('/health/live');
 expect(res.ok()).toBe(true);
 const body = await res.json();
 expect(body.status).toBe('alive');
 });
 });

 test.describe('Security headers', () => {
 test('sets security headers on health endpoint', async ({ api }: { api: ApiClient }) => {
 const res = await api.get('/health');
 const headers = res.headers();
 expect(headers['x-content-type-options']).toBe('nosniff');
 expect(headers['x-frame-options']).toBe('DENY');
 expect(headers['x-xss-protection']).toBe('1; mode=block');
 expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
 });
 });
});

test.describe('Auth service health', () => {
 test.describe('GET /health/live', () => {
 test('returns alive status', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.get('/health/live');
 expect(res.ok()).toBe(true);
 const body = await res.json();
 expect(body.status).toBe('alive');
 });
 });

 test.describe('GET /health/service', () => {
 test('returns 401 without API key', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.get('/health/service');
 expect(res.status()).toBe(401);
 const body = await res.json();
 expect(body).toHaveProperty('type');
 expect(body).toHaveProperty('title');
 expect(body.status).toBe(401);
 });
 });
});

test.describe('Admin service health', () => {
 test.describe('GET /health', () => {
 test('returns health status', async ({ admin }: { admin: ApiClient }) => {
 const res = await admin.get('/health');
 expect(res.ok()).toBe(true);
 const body = await res.json();
 expect(body.status).toBe('healthy');
 expect(body.service).toBe('admin');
 expect(body).toHaveProperty('timestamp');
 });
 });

 test.describe('GET /health/live', () => {
 test('returns alive status', async ({ admin }: { admin: ApiClient }) => {
 const res = await admin.get('/health/live');
 expect(res.ok()).toBe(true);
 const body = await res.json();
 expect(body.status).toBe('alive');
 });
 });
});

test.describe('User registration flow', () => {
 test.describe('POST /auth/register', () => {
 test('returns 400 for invalid email', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.post('/auth/register', {
 email: 'not-an-email',
 password: 'secure-password-123',
 name: 'Test User',
 });
 expect(res.status()).toBe(400);
 const body = await res.json();
 expect(body.title).toBe('Validation Error');
 expect(body.status).toBe(400);
 });

 test('returns 400 for short password', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.post('/auth/register', {
 email: 'test@example.com',
 password: 'sh',
 name: 'Test User',
 });
 expect(res.status()).toBe(400);
 });

 test('returns 400 for missing name', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.post('/auth/register', {
 email: 'test@example.com',
 password: 'secure-password-123',
 name: '',
 });
 expect(res.status()).toBe(400);
 });

 test('creates user and returns tokens on valid input', async ({ auth }: { auth: ApiClient }) => {
 const uniqueEmail = `e2e-${Date.now()}@test.example.com`;
 const res = await auth.post('/auth/register', {
 email: uniqueEmail,
 password: 'secure-password-123',
 name: 'E2E Test User',
 });
 expect(res.status()).toBe(201);
 const body = await res.json();
 expect(body).toHaveProperty('user');
 expect(body).toHaveProperty('tokens');
 expect(body.user).toHaveProperty('id');
 expect(body.user.email).toBe(uniqueEmail);
 expect(body.user.role).toBe('owner');
 expect(body.user.hasMfa).toBe(false);
 expect(body.tokens).toHaveProperty('accessToken');
 expect(body.tokens).toHaveProperty('refreshToken');
 expect(typeof body.tokens.accessToken).toBe('string');
 expect(body.tokens.accessToken.length).toBeGreaterThan(20);
 });
 });
});

test.describe('User login flow', () => {
 test.describe('POST /auth/login', () => {
 test('returns 401 for non-existent user', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.post('/auth/login', {
 email: 'nonexistent@example.com',
 password: 'any-password',
 });
 expect(res.status()).toBe(401);
 const body = await res.json();
 expect(body.title).toBe('Unauthorized');
 expect(body.type).toBe('https://api.nova.leadup.in/problems/invalid-credentials');
 });

 test('returns 401 for wrong password', async ({ auth }: { auth: ApiClient }) => {
 const reg = await auth.post('/auth/register', {
 email: `e2e-login-${Date.now()}@test.example.com`,
 password: 'correct-password-123',
 name: 'Login Test',
 });
 expect(reg.status()).toBe(201);

 const regBody = await reg.json();
 const res = await auth.post('/auth/login', {
 email: regBody.user.email,
 password: 'wrong-password',
 });
 expect(res.status()).toBe(401);
 const body = await res.json();
 expect(body.title).toBe('Unauthorized');
 });

 test('returns tokens for valid credentials', async ({ auth }: { auth: ApiClient }) => {
 const reg = await auth.post('/auth/register', {
 email: `e2e-login-ok-${Date.now()}@test.example.com`,
 password: 'correct-password-123',
 name: 'Login Success Test',
 });
 expect(reg.status()).toBe(201);

 const regBody = await reg.json();
 const res = await auth.post('/auth/login', {
 email: regBody.user.email,
 password: 'correct-password-123',
 });
 expect(res.status()).toBe(200);
 const body = await res.json();
 expect(body).toHaveProperty('user');
 expect(body).toHaveProperty('tokens');
 expect(body.user.email).toBe(regBody.user.email);
 expect(body.tokens.accessToken.length).toBeGreaterThan(20);
 });
 });
});

test.describe('Token refresh flow', () => {
 test('refreshes access token with valid refresh token', async ({ auth }: { auth: ApiClient }) => {
 const reg = await auth.post('/auth/register', {
 email: `e2e-refresh-${Date.now()}@test.example.com`,
 password: 'secure-password-123',
 name: 'Refresh Test',
 });
 expect(reg.status()).toBe(201);

 const regBody = await reg.json();
 const refreshToken = regBody.tokens.refreshToken;
 const res = await auth.post('/auth/refresh', { refreshToken });
 expect(res.status()).toBe(200);
 const body = await res.json();
 expect(body).toHaveProperty('accessToken');
 expect(body.accessToken.length).toBeGreaterThan(20);
 expect(body).toHaveProperty('expiresIn');
 });

 test('returns 401 for invalid refresh token', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.post('/auth/refresh', { refreshToken: 'not-a-real-token' });
 expect(res.status()).toBe(401);
 const body = await res.json();
 expect(body.title).toBe('Unauthorized');
 });
});

test.describe('Protected route — GET /auth/me', () => {
 test('returns 401 without token', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.get('/auth/me');
 expect(res.status()).toBe(401);
 });

 test('returns user profile with valid token', async ({ auth }: { auth: ApiClient }) => {
 const reg = await auth.post('/auth/register', {
 email: `e2e-me-${Date.now()}@test.example.com`,
 password: 'secure-password-123',
 name: 'Me Test User',
 });
 expect(reg.status()).toBe(201);

 const regBody = await reg.json();
 const accessToken = regBody.tokens.accessToken;
 const res = await auth.get('/auth/me', {
 headers: { Authorization: `Bearer ${accessToken}` },
 });
 expect(res.status()).toBe(200);
 const body = await res.json();
 expect(body.id).toBe(regBody.user.id);
 expect(body.email).toBe(regBody.user.email);
 expect(body.role).toBe('owner');
 expect(Array.isArray(body.permissions)).toBe(true);
 expect(body.permissions.length).toBeGreaterThan(0);
 });
});

test.describe('Phone OTP flow', () => {
 test.describe('POST /auth/phone/otp/request', () => {
 test('returns 400 for invalid phone number', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.post('/auth/phone/otp/request', {
 phoneNumber: 'not-a-phone',
 channel: 'sms',
 });
 expect(res.status()).toBe(400);
 const body = await res.json();
 expect(body.title).toBe('Validation Error');
 });

 test('returns 202 for valid E.164 phone number', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.post('/auth/phone/otp/request', {
 phoneNumber: '+14155551234',
 channel: 'sms',
 });
 expect(res.status()).toBe(202);
 const body = await res.json();
 expect(body.message).toBe('OTP sent');
 expect(body.expiresIn).toBe(300);
 });
 });
});

test.describe('Password reset flow', () => {
 test.describe('POST /auth/password-reset/request', () => {
 test('returns 202 even for unknown email', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.post('/auth/password-reset/request', {
 email: 'unknown@example.com',
 });
 expect(res.status()).toBe(202);
 const body = await res.json();
 expect(body.message).toContain('reset');
 });
 });

 test.describe('POST /auth/password-reset/confirm', () => {
 test('returns 400 without a valid token', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.post('/auth/password-reset/confirm', {
 token: 'not-a-valid-token',
 newPassword: 'new-secure-pw-123',
 });
 expect(res.status()).toBe(400);
 });
 });
});

test.describe('MFA endpoints', () => {
 test.describe('POST /auth/mfa/enroll', () => {
 test('returns 401 without authentication', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.post('/auth/mfa/enroll', { method: 'totp' });
 expect(res.status()).toBe(401);
 });
 });

 test.describe('POST /auth/mfa/verify', () => {
 test('returns 401 without authentication', async ({ auth }: { auth: ApiClient }) => {
 const res = await auth.post('/auth/mfa/verify', { code: '123456' });
 expect(res.status()).toBe(401);
 });
 });
});

test.describe('RFC 7807 error format', () => {
 test('all error responses follow ProblemDetails shape', async ({ auth }: { auth: ApiClient }) => {
 const endpoints = [
 { method: 'get' as const, path: '/auth/me' },
 { method: 'post' as const, path: '/auth/login', body: { email: 'bad', password: 'x' } },
 ];

 for (const ep of endpoints) {
 const res = ep.method === 'get'
 ? await auth.get(ep.path)
 : await auth.post(ep.path, ep.body);
 expect(res.status()).toBeGreaterThanOrEqual(400);
 const body = await res.json();
 expect(typeof body.type).toBe('string');
 expect(typeof body.title).toBe('string');
 expect(typeof body.status).toBe('number');
 expect(body.status).toBe(res.status());
 }
 });
});

test.describe('Cross-service: auth → admin', () => {
 test('admin routes require authentication', async ({ admin }: { admin: ApiClient }) => {
 const res = await admin.get('/admin/organizations');
 expect(res.status()).toBe(401);
 });

 test('admin routes reject invalid tokens', async ({ admin }: { admin: ApiClient }) => {
 const res = await admin.get('/admin/organizations', {
 headers: { Authorization: 'Bearer invalid-token-xyz' },
 });
 expect(res.status()).toBe(401);
 });
});

test.describe('Admin — 404 handling', () => {
 test('returns 404 for unknown route', async ({ admin }: { admin: ApiClient }) => {
 const res = await admin.get('/admin/nonexistent-route-xyz');
 expect(res.status()).toBe(404);
 const body = await res.json();
 expect(body.title).toBe('Not Found');
 expect(body.type).toContain('problems');
 });
});
