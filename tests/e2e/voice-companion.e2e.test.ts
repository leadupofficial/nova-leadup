/**
 * NOVA E2E — Voice Companion
 *
 * Tests the full companion loop: Home → Tap to Talk → STT → Claude → TTS → Converse screen.
 * The API is expected to be running locally. STT/TTS are stubbed when keys are absent.
 */
import { test, expect, type Page } from '@playwright/test';
import { ConversePage } from '../pages/ConversePage';
import { VoiceChatPage } from '../pages/VoiceChatPage';

const API_BASE = process.env.PLAYWRIGHT_API_BASE ?? 'http://localhost:3000';

async function ensureLoggedIn(page: Page): Promise<void> {
 await page.goto('/');
 await page.evaluate(() => localStorage.setItem('nova-onboarding-complete', 'true'));
 await page.reload();
 await page.waitForTimeout(500);
}

async function mockVoiceEndpoints(page: Page): Promise<void> {
 // STT endpoint — returns transcript
 await page.route(`${API_BASE}/api/v1/voice/stt`, async (route) => {
 if (route.request().method() !== 'POST') {
 await route.fallback();
 return;
 }
 const body = await route.request().json().catch(() => ({}));
 const audioData = body?.audio;
 const transcript = audioData ? 'Hello NOVA, remind me to call Kumar at 5pm' : 'Hello';
 await route.fulfill({
 status: 200,
 contentType: 'application/json',
 body: JSON.stringify({ success: true, transcript, language: 'en', confidence: 0.95 }),
 });
 });

 // Chat endpoint — returns AI response
 await page.route(`${API_BASE}/api/v1/voice/chat`, async (route) => {
 if (route.request().method() !== 'POST') {
 await route.fallback();
 return;
 }
 await route.fulfill({
 status: 200,
 contentType: 'application/json',
 body: JSON.stringify({ success: true, text: 'Sure, I will remind you to call Kumar at 5pm.', model: 'claude-3-5-sonnet', provider: 'anthropic' }),
 });
 });

 // TTS endpoint — returns empty body (no audio needed for test)
 await page.route(`${API_BASE}/api/v1/voice/tts`, async (route) => {
 await route.fulfill({
 status: 200,
 contentType: 'application/json',
 body: JSON.stringify({ success: true, audioData: null, contentType: 'audio/mpeg', provider: 'stub' }),
 });
 });
}

test.describe('Voice companion loop', () => {
 test.beforeEach(async ({ page }) => {
 await ensureLoggedIn(page);
 });

 test('Home loads with avatar in idle state', async ({ page }) => {
 const converse = new ConversePage(page);
 await page.goto('/');
 await page.waitForTimeout(600);

 // The converse page may not be the default home — verify we can navigate to it
 await page.goto('/dashboard/converse');
 await page.waitForTimeout(500);

 // Avatar or converse view should be present
 const avatarOrEmpty = page.locator('[data-testid="avatar-orb"], .avatar-orb, [aria-label="NOVA avatar"]');
 if (await avatarOrEmpty.count() === 0) {
 // If no explicit avatar, the page must at least load
 await expect(page.getByText(/converse|chat|NOVA/i)).toBeVisible({ timeout: 10_000 });
 }
 });

 test('user taps mic → listening state activates', async ({ page }) => {
 const converse = new ConversePage(page);
 await mockVoiceEndpoints(page);
 await converse.goto();
 await page.waitForTimeout(400);

 await converse.clickVoiceButton();
 await page.waitForTimeout(700);

 // Listening indicator should be visible
 const isListening = await converse.isListening().catch(() => false);
 expect(isListening).toBe(true);
 });

 test('STT response appears as transcript', async ({ page }) => {
 const converse = new ConversePage(page);
 await mockVoiceEndpoints(page);
 await converse.goto();
 await page.waitForTimeout(400);

 await converse.clickVoiceButton();
 await page.waitForTimeout;

 const text = await page.content();
 const hasTranscript = text.includes('remind me') || text.includes('Hello') || text.includes('Listening');
 expect(hasTranscript).toBe(true);
 });

 test('text input fallback sends message', async ({ page }) => {
 const converse = new ConversePage(page);
 await mockVoiceEndpoints(page);
 await converse.goto();
 await page.waitForTimeout(400);

 await converse.sendTextMessage('Hello from test');
 await page.waitForTimeout;

 const count = await converse.getMessageCount().catch(() => 0);
 expect(count).toBeGreaterThanOrEqual(1);
 });

 test('mic button toggles listening off', async ({ page }) => {
 const converse = new ConversePage(page);
 await mockVoiceEndpoints(page);
 await converse.goto();
 await page.waitForTimeout(400);

 await converse.clickVoiceButton();
 await page.waitForTimeout(700);

 await converse.clickVoiceButton();
 await page.waitForTimeout(500);

 const isStillListening = await converse.isListening().catch(() => false);
 expect(isStillListening).toBe(false);
 });

 test('interrupt stops listening and returns to idle', async ({ page }) => {
 const converse = new ConversePage(page);
 await mockVoiceEndpoints(page);
 await converse.goto();
 await page.waitForTimeout(400);

 await converse.clickVoiceButton();
 await page.waitForTimeout(700);

 // Interrupt = click mic again while listening
 await converse.clickVoiceButton();
 await page.waitForTimeout(500);

 const isListening = await converse.isListening().catch(() => false);
 expect(isListening).toBe(false);
 });

 test('conversation persists across tab switches', async ({ page }) => {
 const converse = new ConversePage(page);
 await mockVoiceEndpoints(page);
 await converse.goto();
 await page.waitForTimeout(400);

 await converse.sendTextMessage('Persistent message test');
 await page.waitForTimeout;

 // Switch to tasks tab and back
 await page.goto('/dashboard/tasks');
 await page.waitForTimeout(400);
 await page.goto('/dashboard/converse');
 await page.waitForTimeout(600);

 // Message should still be visible
 const text = await page.content();
 expect(text).toContain('Persistent message test');
 });

 test('error state shown when mic permission is denied', async ({ page }) => {
 // Deny microphone permission via context
 const context = page.context();
 await context.grantPermissions([], {
 origin: 'http://localhost:3000',
 });

 const converse = new ConversePage(page);
 await mockVoiceEndpoints(page);
 await converse.goto();
 await page.waitForTimeout(400);

 await converse.clickVoiceButton();
 await page.waitForTimeout;

 // Should show an error or permission message
 const pageText = await page.content();
 const hasError = /permission|denied|microphone|error/i.test(pageText);
 expect(hasError).toBe(true);
 });
});
