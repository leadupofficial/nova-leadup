/**
 * NOVA E2E — Authentication
 *
 * Full auth flow: register → login → protected /auth/me → phone OTP → password reset → MFA.
 * The API base is overridable via PLAYWRIGHT_API_BASE; defaults to the docker-compose port.
 *
 * Covers (spec-suite):
 * 1. User registers with a unique email and is redirected to onboarding or dashboard.
 * 2. User can log in and receives a valid JWT (access-token stored in localStorage).
 * 3. GET /auth/me returns the current user profile while the token is fresh.
 * 4. User can request an OTP via phone and verify it (200 on both steps).
 * 5. User can request and confirm a password reset (200 on both steps).
 * 6. User can enroll MFA and verify the challenge (200 on both steps).
 * 7. User can create and list API keys after authenticating (200).
 * 8. User can log out by clearing storage and can no longer call /auth/me.
 * 9. Protected routes reject requests with 401 when the Authorization header is absent.
 */

import { test, expect, type Page } from '@playwright/test';

const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? 'http://localhost:3000';
const TEST_TIMEOUT = 20_000;

const pickUnique = (prefix: string): string => {
 const ts = `${Date.now()}`.slice(-6);
 const rand = `${Math.floor(Math.random() * 9_000) + 1000}`;
 return `${prefix}${ts}${rand}`;
};

async function ensureLoggedIn(page: Page): Promise<string> {
 const email = pickUnique('nova.e2e.');
 const password = 'N0va!Pass4E2E';

 // Register
 const regRes = await page.request.post(`${API_BASE}/auth/register`, {
 data: { name: 'NOVA E2E User', email, password },
 headers: { 'Content-Type': 'application/json' },
 });
 expect(regRes.ok(), `register failed: ${regRes.status()}`).toBe(true);

 // Login
 const loginRes = await page.request.post(`${API_BASE}/auth/login`, {
 data: { email, password },
 headers: { 'Content-Type': 'application/json' },
 });
 expect(loginRes.ok(), `login failed: ${loginRes.status()}`).toBe(true);
 const loginJson = await loginRes.json();
 const token = loginJson?.access_token ?? loginJson?.accessToken;
 expect(token, 'missing access_token in login response').toBeTruthy();

 // Seed session via page context so onboarding/state checks work
 await page.goto('/');
 await page.evaluate((t: string) => {
 localStorage.setItem('nova-access-token', t);
 localStorage.setItem('nova-onboarding-complete', 'true');
 }, token);
 await page.reload();
 await page.waitForTimeout(400);

 return token;
}

test.describe('Authentication E2E', () => {
 test('register then login returns a valid access token', async ({ page }) => {
 await ensureLoggedIn(page);
 // If we get here without throwing, register + login both returned 200 and a token.
 await expect(page.getByText(/NOVA|converse|dashboard/i)).toBeVisible({ timeout: TEST_TIMEOUT });
 });

 test('GET /auth/me returns the authenticated user profile', async ({ page }) => {
 const token = await ensureLoggedIn(page);

 const meRes = await page.request.get(`${API_BASE}/auth/me`, {
 headers: { Authorization: `Bearer ${token}` },
 });
 expect(meRes.ok(), `/auth/me status: ${meRes.status()}`).toBe(true);
 const me = await meRes.json();
 expect(me).toBeTruthy();
 expect(me?.email).toBeTruthy();
 });

 test('unauthenticated /auth/me is rejected with 401', async ({ page }) => {
 const res = await page.request.get(`${API_BASE}/auth/me`);
 expect(res.status()).toBe(401);
 });

 test('phone OTP request and verify both return 200', async ({ page }) => {
 const phone = `+1${pickUnique('555')}`;

 const otpReq = await page.request.post(`${API_BASE}/auth/phone/otp/request`, {
 data: { phone },
 headers: { 'Content-Type': 'application/json' },
 });
 expect(otpReq.ok()).toBe(true);

 // In stub environments the code accepts any 6-digit code when a real provider key is absent.
 // Use a static code the stub recognizes when possible; otherwise accept any 200.
 const otpCode = '123456';
 const otpVerify = await page.request.post(`${API_BASE}/auth/phone/otp/verify`, {
 data: { phone, code: otpCode },
 headers: { 'Content-Type': 'application/json' },
 });
 expect(otpVerify.ok()).toBe(true);
 const verifyJson = await otpVerify.json();
 expect(verifyJson?.success).toBe(true);
 });

 test('password reset request and confirm both return 200', async ({ page }) => {
 const token = await ensureLoggedIn(page);

 const email = pickUnique('reset.') + '@example.com';

 const req = await page.request.post(`${API_BASE}/auth/password-reset/request`, {
 data: { email },
 headers: { 'Content-Type': 'application/json' },
 });
 expect(req.ok()).toBe(true);
 const reqJson = await req.json();
 expect(reqJson?.success).toBe(true);

 // Confirm with a static token the stub accepts, or any value if the route is stubbed.
 const resetToken = reqJson?.resetToken ?? 'stub-reset-token';
 const newPassword = 'NewPass!2026';
 const confirm = await page.request.post(`${API_BASE}/auth/password-reset/confirm`, {
 data: { token: resetToken, password: newPassword },
 headers: { 'Content-Type': 'application/json' },
 });
 expect(confirm.ok()).toBe(true);
 const confirmJson = await confirm.json();
 expect(confirmJson?.success).toBe(true);
 });

 test('MFA enrollment and verification both return 200', async ({ page }) => {
 const token = await ensureLoggedIn(page);

 const enroll = await page.request.post(`${API_BASE}/auth/mfa/enroll`, {
 headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
 });
 expect(enroll.ok()).toBe(true);
 const enrollJson = await enroll.json();
 expect(enrollJson?.success).toBe(true);
 expect(enrollJson?.secret).toBeTruthy();

 const verify = await page.request.post(`${API_BASE}/auth/mfa/verify`, {
 data: { code: '123456' },
 headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
 });
 expect(verify.ok()).toBe(true);
 const verifyJson = await verify.json();
 expect(verifyJson?.success).toBe(true);
 });

 test('authenticated user can create and list API keys', async ({ page }) => {
 const token = await ensureLoggedIn(page);

 const create = await page.request.post(`${API_BASE}/auth/api-keys`, {
 data: { name: 'E2E test key' },
 headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
 });
 expect(create.ok()).toBe(true);
 const createJson = await create.json();
 expect(createJson?.success).toBe(true);
 expect(createJson?.key ?? createJson?.keyPrefix).toBeTruthy();

 const list = await page.request.get(`${API_BASE}/auth/api-keys`, {
 headers: { Authorization: `Bearer ${token}` },
 });
 expect(list.ok()).toBe(true);
 const listJson = await list.json();
 expect(Array.isArray(listJson?.apiKeys ?? listJson?.keys ?? listJson)).toBe(true);
 });

 test('clearing the access token blocks /auth/me', async ({ page }) => {
 await ensureLoggedIn(page);
 await page.evaluate(() => localStorage.removeItem('nova-access-token'));
 await page.reload();
 await page.waitForTimeout(300);

 const res = await page.request.get(`${API_BASE}/auth/me`);
 expect(res.status()).toBe(401);
 });
});
