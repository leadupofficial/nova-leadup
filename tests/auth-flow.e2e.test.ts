import { test, expect } from '@playwright/test';
import type { ApiClient } from './helpers';

test.describe('Full auth lifecycle', () => {
 test('register → login → access protected → refresh → access protected again', async ({ auth }: { auth: ApiClient }) => {
 // 1. Register
 const reg = await auth.post('/auth/register', {
 email: `e2e-lifecycle-${Date.now()}@test.example.com`,
 password: 'lifecycle-pw-123',
 name: 'Lifecycle User',
 });
 expect(reg.status()).toBe(201);
 const userId = reg.body().user.id;
 const accessToken = reg.body().tokens.accessToken;
 const refreshToken = reg.body().tokens.refreshToken;

 // 2. Access protected route with initial token
 let res = await auth.get('/auth/me', {
 headers: { Authorization: `Bearer ${accessToken}` },
 });
 expect(res.status()).toBe(200);
 expect(res.body().id).toBe(userId);

 // 3. Refresh access token
 res = await auth.post('/auth/refresh', { refreshToken });
 expect(res.status()).toBe(200);
 const newAccessToken = res.body().accessToken;
 expect(newAccessToken).not.toBe(accessToken);

 // 4. Access protected route with refreshed token
 res = await auth.get('/auth/me', {
 headers: { Authorization: `Bearer ${newAccessToken}` },
 });
 expect(res.status()).toBe(200);
 expect(res.body().id).toBe(userId);
 });
});

test.describe('Web application — homepage', () => {
 const webURL = process.env.WEB_URL || 'http://localhost:3000';

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
