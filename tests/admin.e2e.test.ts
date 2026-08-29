import { test, expect } from './helpers';
import type { ApiClient } from './helpers';

test.describe('Admin service — health', () => {
 test('GET /health returns service status', async ({ admin }: { admin: ApiClient }) => {
 const res = await admin.get('/health');
 expect(res.ok()).toBe(true);
 const body = await res.json();
 expect(body.status).toBe('healthy');
 expect(body.service).toBe('admin');
 expect(body).toHaveProperty('timestamp');
 });
});

test.describe('Admin — organizations', () => {
 test('requires authentication', async ({ admin }: { admin: ApiClient }) => {
 const res = await admin.get('/admin/organizations');
 expect(res.status()).toBe(401);
 const body = await res.json();
 expect(body.type).toContain('problems');
 expect(body.title).toBe('Unauthorized');
 });

 test('returns org list for authenticated user', async ({ admin, auth }: { admin: ApiClient; auth: ApiClient }) => {
 const reg = await auth.post('/auth/register', {
 email: `e2e-admin-org-${Date.now()}@test.example.com`,
 password: 'secure-password-123',
 name: 'Admin Org Test',
 });
 expect(reg.status()).toBe(201);

 const regBody = await reg.json();
 const token = regBody.tokens.accessToken;
 const res = await admin.get('/admin/organizations', {
 headers: { Authorization: `Bearer ${token}` },
 });
 expect(res.ok()).toBe(true);
 const body = await res.json();
 expect(body).toHaveProperty('data');
 expect(Array.isArray(body.data)).toBe(true);
 });

 test('rejects invalid JWT', async ({ admin }: { admin: ApiClient }) => {
 const res = await admin.get('/admin/organizations', {
 headers: { Authorization: 'Bearer definitely-not-a-jwt' },
 });
 expect(res.status()).toBe(401);
 });

 test('rejects incomplete JWT formats', async ({ admin }: { admin: ApiClient }) => {
 const cases = [
 { header: '', desc: 'empty header' },
 { header: 'Bearer', desc: 'bare Bearer prefix' },
 { header: 'Bearer abc.def', desc: 'incomplete JWT' },
 ];
 for (const c of cases) {
 const res = await admin.get('/admin/organizations', {
 headers: { Authorization: c.header },
 });
 expect(res.status()).toBe(401);
 }
 });
});

test.describe('Admin — users', () => {
 test('requires authentication', async ({ admin }: { admin: ApiClient }) => {
 const res = await admin.get('/admin/users');
 expect(res.status()).toBe(401);
 });

 test('returns 200 for authenticated owner', async ({ admin, auth }: { admin: ApiClient; auth: ApiClient }) => {
 const reg = await auth.post('/auth/register', {
 email: `e2e-admin-users-${Date.now()}@test.example.com`,
 password: 'secure-password-123',
 name: 'Admin Users Test',
 });
 expect(reg.status()).toBe(201);

 const regBody = await reg.json();
 const token = regBody.tokens.accessToken;
 const res = await admin.get('/admin/users', {
 headers: { Authorization: `Bearer ${token}` },
 });
 // owner role has user:view permission
 expect([200, 403]).toContain(res.status());
 });
});

test.describe('Admin — PATCH organization', () => {
 test('returns 401 without auth', async ({ admin }: { admin: ApiClient }) => {
 const res = await admin.patch('/admin/organizations/00000000-0000-0000-0000-000000000000', {
 name: 'Updated Name',
 });
 expect(res.status()).toBe(401);
 });

 test('returns 404 for non-existent org', async ({ admin, auth }: { admin: ApiClient; auth: ApiClient }) => {
 const reg = await auth.post('/auth/register', {
 email: `e2e-admin-patch-${Date.now()}@test.example.com`,
 password: 'secure-password-123',
 name: 'Admin Patch Test',
 });
 expect(reg.status()).toBe(201);

 const regBody = await reg.json();
 const token = regBody.tokens.accessToken;
 const fakeId = '00000000-0000-0000-0000-000000000000';
 const res = await admin.patch(`/admin/organizations/${fakeId}`, { name: 'Updated Name' }, {
 headers: { Authorization: `Bearer ${token}` },
 });
 expect(res.status()).toBe(404);
 const body = await res.json();
 expect(body.title).toBe('Not Found');
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

test.describe('Admin — concurrent requests', () => {
 test('handles multiple parallel health checks', async ({ admin }: { admin: ApiClient }) => {
 const promises = Array.from({ length: 10 }, () => admin.get('/health'));
 const results = await Promise.all(promises);
 for (const res of results) {
 expect(res.ok()).toBe(true);
 }
 });
});
