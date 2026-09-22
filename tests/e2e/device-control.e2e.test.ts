/**
 * NOVA E2E — Device Control
 *
 * Tests the Device tab: sensors, notifications, haptics, biometrics, battery/network.
 */
import { test, expect, type Page } from '@playwright/test';

const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? 'http://localhost:3000';

async function ensureLoggedIn(page: Page): Promise<void> {
 await page.goto('/');
 await page.evaluate(() => localStorage.setItem('nova-onboarding-complete', 'true'));
 await page.reload();
 await page.waitForTimeout(500);
}

async function mockDeviceEndpoints(page: Page): Promise<void> {
 await page.route(`${API_BASE}/api/v1/notifications/send`, async (route) => {
 if (route.request().method() !== 'POST') { await route.fallback(); return; }
 await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, messageId: `notif_${Date.now()}`, status: 'queued' }) });
 });

 await page.route(`${API_BASE}/api/v1/device/sensors/start`, async (route) => {
 await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, streaming: true, sampleRate: 250 }) });
 });

 await page.route(`${API_BASE}/api/v1/device/sensors/stop`, async (route) => {
 await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, streaming: false }) });
 });

 await page.route(`${API_BASE}/api/v1/device/biometric`, async (route) => {
 await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, authenticated: true, method: 'biometric' }) });
 });

 await page.route(`${API_BASE}/api/v1/device/battery`, async (route) => {
 await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, battery: { level: 87, isCharging: false, health: 'good' } }) });
 });

 await page.route(`${API_BASE}/api/v1/device/network`, async (route) => {
 await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, network: { type: 'wifi', strength: 'excellent', ip: '192.168.1.1' } }) });
 });
}

test.describe('Device control', () => {
 test.beforeEach(async ({ page }) => {
 await ensureLoggedIn(page);
 await mockDeviceEndpoints(page);
 });

 test('device tab loads', async ({ page }) => {
 await page.goto('/dashboard/device');
 await page.waitForTimeout(500);
 const text = await page.content();
 expect(text).toMatch(/sensor|device|system|control|NOVA/i);
 });

 test('sensor start endpoint returns streaming true', async ({ page }) => {
 const res = await page.request.post(`${API_BASE}/api/v1/device/sensors/start`, {
 data: { sampleRate: 250 },
 });
 expect(res.ok()).toBe(true);
 const data = await res.json();
 expect(data.success).toBe(true);
 expect(data.streaming).toBe(true);
 });

 test('sensor stop endpoint returns streaming false', async ({ page }) => {
 const res = await page.request.post(`${API_BASE}/api/v1/device/sensors/stop`, {});
 expect(res.ok()).toBe(true);
 const data = await res.json();
 expect(data.success).toBe(true);
 expect(data.streaming).toBe(false);
 });

 test('notification endpoint queues successfully', async ({ page }) => {
 const res = await page.request.post(`${API_BASE}/api/v1/notifications/send`, {
 data: { userId: 'u1', title: 'Device test', body: 'NOVA device test notification' },
 });
 expect(res.ok()).toBe(true);
 const data = await res.json();
 expect(data.success).toBe(true);
 expect(data.status).toBe('queued');
 });

 test('biometric endpoint responds', async ({ page }) => {
 const res = await page.request.post(`${API_BASE}/api/v1/device/biometric`, {
 data: { prompt: 'Verify identity for NOVA' },
 });
 expect(res.ok()).toBe(true);
 const data = await res.json();
 expect(data.success).toBe(true);
 expect(data.authenticated).toBe(true);
 });

 test('battery endpoint returns valid data', async ({ page }) => {
 const res = await page.request.get(`${API_BASE}/api/v1/device/battery`);
 expect(res.ok()).toBe(true);
 const data = await res.json();
 expect(data.success).toBe(true);
 expect(data.battery.level).toBeGreaterThanOrEqual(0);
 expect(data.battery.level).toBeLessThanOrEqual(100);
 });

 test('network endpoint returns valid data', async ({ page }) => {
 const res = await page.request.get(`${API_BASE}/api/v1/device/network`);
 expect(res.ok()).toBe(true);
 const data = await res.json();
 expect(data.success).toBe(true);
 expect(data.network.type).toBeTruthy();
 });
});
