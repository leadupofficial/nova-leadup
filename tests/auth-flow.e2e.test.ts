import { test, expect } from './helpers';
import type { ApiClient } from './helpers';

test.describe('Full auth lifecycle', () => {
 // This exercises the live auth API: services/api's /api/v1/auth/*. (The file used
 // to point at services/auth's /auth/* contract — `tokens.accessToken`, role
 // 'owner' — but that service's repositories reference columns the canonical
 // packages/database schema doesn't create, so it cannot serve. ApiClient wraps
 // Playwright's APIResponse, so response bodies come from await .json(), not
 // .body(), which is the raw Buffer.)
 test('register → login → access protected → refresh → access protected again', async ({ api }: { api: ApiClient }) => {
 // 1. Register
 const reg = await api.post('/api/v1/auth/register', {
 email: `e2e-lifecycle-${Date.now()}@test.example.com`,
 password: 'lifecycle-pw-123',
 name: 'Lifecycle User',
 });
 expect(reg.status()).toBe(201);
 const regBody = await reg.json();
 const userId = regBody.data.user.id;
 const accessToken = regBody.data.access_token;
 const refreshToken = regBody.data.refresh_token;

 // 2. Access protected route with initial token
 let res = await api.get('/api/v1/auth/me', {
 headers: { Authorization: `Bearer ${accessToken}` },
 });
 expect(res.status()).toBe(200);
 const meBody = await res.json();
 expect(meBody.data.user.id).toBe(userId);
 expect(meBody.data.user.email).toContain('@test.example.com');

 // 3. Refresh access token
 res = await api.post('/api/v1/auth/refresh', { refresh_token: refreshToken });
 expect(res.status()).toBe(200);
 const refreshBody = await res.json();
 const newAccessToken = refreshBody.data.access_token;
 const newRefreshToken = refreshBody.data.refresh_token;
 expect(newAccessToken).not.toBe(accessToken);

 // 4. Access protected route with refreshed token
 res = await api.get('/api/v1/auth/me', {
 headers: { Authorization: `Bearer ${newAccessToken}` },
 });
 expect(res.status()).toBe(200);

 // 5. Logout revokes the refresh token
 const logout = await api.post('/api/v1/auth/logout', { refresh_token: newRefreshToken }, {
 headers: { Authorization: `Bearer ${newAccessToken}` },
 });
 expect(logout.status()).toBe(204);
 const reuse = await api.post('/api/v1/auth/refresh', { refresh_token: newRefreshToken });
 expect(reuse.status()).toBe(401);
 });
});

test.describe('Web application — homepage', () => {
 // Nothing in this repo serves the consumer marketing/app homepage: apps/web is
 // absent (apps are mobile=Flutter and admin=Next.js console). These tests only run
 // when WEB_URL is explicitly pointed at a running deployment.
 const webURL = process.env.WEB_URL;
 test.beforeEach(() => {
 test.skip(!webURL, 'WEB_URL not set — no consumer web app exists in this repo to serve a homepage (apps/web is absent)');
 });

 test('homepage loads with correct title', async ({ page }) => {
 await page.goto(webURL);
 await expect(page).toHaveTitle(/NOVA/);
 });

 test('homepage shows main heading', async ({ page }) => {
 await page.goto(webURL);
 const heading = page.locator('h1');
 await expect(heading).toContainText('NOVA');
 });

 test('homepage shows description', async ({ page }) => {
 await page.goto(webURL);
 const body = page.locator('main');
 await expect(body).toContainText('Voice and Visual Companion');
 });
});

test.describe('Service availability', () => {
 test('all services respond on health endpoints', async ({ api, auth, admin }: { api: ApiClient; auth: ApiClient; admin: ApiClient }) => {
 const apiRes = await api.get('/health');
 expect(apiRes.ok()).toBe(true);

 const authRes = await auth.get('/health/live');
 expect(authRes.ok()).toBe(true);

 const adminRes = await admin.get('/health');
 expect(adminRes.ok()).toBe(true);
 });
});
