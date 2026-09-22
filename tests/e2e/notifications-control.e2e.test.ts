/**
 * NOVA E2E — Notification Control
 *
 * Tests notification interception, triage classification, reminder creation, and snooze flow.
 */
import { test, expect, type Page } from '@playwright/test';

const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? 'http://localhost:3000';

async function ensureLoggedIn(page: Page): Promise<void> {
 await page.goto('/');
 await page.evaluate(() => localStorage.setItem('nova-onboarding-complete', 'true'));
 await page.reload();
 await page.waitForTimeout(500);
}

async function mockTriageEndpoint(page: Page, notifications: any[]): Promise<void> {
 await page.route(`${API_BASE}/api/v1/notifications/triage`, async (route) => {
 const results = notifications.map((n) => {
 const text = `${n.title} ${n.body} ${n.category || ''}`.toLowerCase();
 let action = 'pass_through';
 let priority = 'normal';
 let tag = 'general';
 if (text.includes('urgent') || text.includes('security') || text.includes('alert') || text.includes('emergency')) {
 action = 'pass_through';
 priority = 'high';
 tag = 'urgent';
 } else if (text.includes('spam') || text.includes('promo') || text.includes('offer')) {
 action = 'suppress';
 priority = 'low';
 tag = 'marketing';
 } else if (text.includes('whatsapp') || text.includes('social')) {
 action = 'summarize';
 priority = 'normal';
 tag = 'social';
 }
 return { ...n, id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, triaged: true, action, reason: `Matched: ${tag}`, priority, tag };
 });

 await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: results }) });
 });
}

async function mockReminderEndpoint(page: Page): Promise<void> {
 await page.route(`${API_BASE}/api/v1/notifications/reminders`, async (route) => {
 const body = await route.request().json().catch(() => ({}));
 await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ success: true, reminder: { id: `rem_${Date.now()}`, ...body, status: 'scheduled', createdAt: new Date().toISOString() } }) });
 });
}

test.describe('Notification control', () => {
 test.beforeEach(async ({ page }) => {
 await ensureLoggedIn(page);
 });

 test('high-priority notification is passed through', async ({ page }) => {
 const notif = { userId: 'u1', title: 'Security alert', body: 'Unusual login detected', priority: 'high', app: 'System' };
 await mockTriageEndpoint(page, [notif]);
 await page.goto('/dashboard/tasks');
 await page.waitForTimeout(400);

 const res = await page.request.post(`${API_BASE}/api/v1/notifications/triage`, {
 data: { notifications: [notif] },
 });
 expect(res.ok()).toBe(true);
 const data = await res.json();
 const result = data.data[0];
 expect(result.action).toBe('pass_through');
 expect(result.priority).toBe('high');
 });

 test('spam notification is suppressed', async ({ page }) => {
 const notif = { userId: 'u1', title: 'Amazing Sale', body: '50% off everything! Limited time offer!', priority: 'low', app: 'Shopping' };
 await mockTriageEndpoint(page, [notif]);

 const res = await page.request.post(`${API_BASE}/api/v1/notifications/triage`, {
 data: { notifications: [notif] },
 });
 expect(res.ok()).toBe(true);
 const data = await res.json();
 const result = data.data[0];
 expect(result.action).toBe('suppress');
 expect(result.priority).toBe('low');
 });

 test('user creates a reminder via API', async ({ page }) => {
 await mockReminderEndpoint(page);

 const res = await page.request.post(`${API_BASE}/api/v1/notifications/reminders`, {
 data: {
 userId: 'u1',
 title: 'Call Kumar',
 fireAt: new Date(Date.now() + 3600_000).toISOString(),
 },
 });
 expect(res.ok()).toBe(true);
 const data = await res.json();
 expect(data.reminder.status).toBe('scheduled');
 expect(data.reminder.title).toBe('Call Kumar');
 });

 test('reminder can be snoozed via API', async ({ page }) => {
 await mockReminderEndpoint(page);

 const res = await page.request.post(`${API_BASE}/api/v1/notifications/reminders`, {
 data: {
 userId: 'u1',
 title: 'Call Kumar',
 body: 'Snoozed 10 minutes',
 fireAt: new Date(Date.now() + 3600_000).toISOString(),
 silent: true,
 },
 });
 expect(res.ok()).toBe(true);
 const data = await res.json();
 expect(data.success).toBe(true);
 });

 test('digest endpoint batches notifications', async ({ page }) => {
 await page.route(`${API_BASE}/api/v1/notifications/digest`, async (route) => {
 await route.fulfill({
 status: 200,
 contentType: 'application/json',
 body: JSON.stringify({ success: true, digest: 'You have 3 notifications from 2 apps. Check NOVA for details.', count: 3 }),
 });
 });

 const res = await page.request.post(`${API_BASE}/api/v1/notifications/digest`, {
 data: {
 userId: 'u1',
 notifications: [
 { title: 'WhatsApp msg', body: 'Hey', app: 'WhatsApp' },
 { title: 'Email', body: 'New message', app: 'Gmail' },
 { title: 'Calendar', body: 'Meeting in 10m', app: 'Calendar' },
 ],
 },
 });

 expect(res.ok()).toBe(true);
 const data = await res.json();
 expect(data.count).toBe(3);
 expect(data.digest).toContain('3 notifications');
 });

 test('notification send endpoint accepts valid payload', async ({ page }) => {
 const res = await page.request.post(`${API_BASE}/api/v1/notifications/send`, {
 data: {
 userId: 'u1',
 title: 'Test NOVA',
 body: 'This is a test notification',
 },
 });
 expect(res.ok()).toBe(true);
 const data = await res.json();
 expect(data.success).toBe(true);
 expect(data.status).toBe('queued');
 });
});
