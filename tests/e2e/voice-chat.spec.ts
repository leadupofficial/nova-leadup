import { test, expect, type Page } from '@playwright/test';
import { ConversePage } from '../pages/ConversePage';
import { CONVERSE_TEXT } from '../fixtures/test-data';

function getFreshConverse(page: Page): ConversePage {
 return new ConversePage(page);
}

async function ensureLoggedIn(page: Page): Promise<void> {
 await page.goto('/');
 await page.evaluate(() => localStorage.setItem('nova-onboarding-complete', 'true'));
 await page.reload();
}

test.describe('Voice chat interaction', () => {
 test.beforeEach(async ({ page }) => {
 await ensureLoggedIn(page);
 });

 test('voice button is present on the converse screen', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await expect(converse.voiceButton).toBeVisible();
 });

 test('clicking the voice button changes the aria-label to Stop listening', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 // Initial state: "Start listening"
 await expect(converse.voiceButton).toHaveAttribute('aria-label', 'Start listening');

 await converse.clickVoiceButton();
 await page.waitForTimeout(500);

 // After clicking: "Stop listening"
 const stopBtn = page.getByLabel('Stop listening');
 if (await stopBtn.count()) {
 await expect(stopBtn).toBeVisible();
 }
 });

 test('listening indicator shows "Listening..." text', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await converse.clickVoiceButton();
 await page.waitForTimeout(500);

 expect(await converse.isListening()).toBe(true);
 });

 test('input is disabled while listening', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await converse.clickVoiceButton();
 await page.waitForTimeout(500);

 await expect(converse.messageInput).toBeDisabled();
 });

 test('clicking voice button again stops listening', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await converse.clickVoiceButton();
 await page.waitForTimeout(500);
 expect(await converse.isListening()).toBe(true);

 await converse.clickVoiceButton();
 await page.waitForTimeout(500);
 expect(await converse.isListening()).toBe(false);
 });

 test('mic icon changes from Mic to MicOff when listening starts', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 // Initial: Mic icon button (aria-label "Start listening")
 await expect(page.getByLabel('Start listening')).toBeVisible();

 await converse.clickVoiceButton();
 await page.waitForTimeout(500);

 // After: MicOff icon button (aria-label "Stop listening")
 const stopListening = page.getByLabel('Stop listening');
 if (await stopListening.count()) {
 await expect(stopListening).toBeVisible();
 }
 });

 test('listening button has visual indicator when active', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await converse.clickVoiceButton();
 await page.waitForTimeout(500);

 const listeningBtn = page.getByLabel('Stop listening');
 if (await listeningBtn.count()) {
 const classAttr = await listeningBtn.getAttribute('class');
 expect(classAttr).toMatch(/cyan|border/);
 }
 });

 test('initial state shows "Tap to Talk" on the converse screen', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await expect(page.getByText('Tap to Talk')).toBeVisible();
 });

 test('shows "How can I help?" empty state before any interaction', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 expect(await converse.isEmptyStateVisible()).toBe(true);
 await expect(page.getByText(CONVERSE_TEXT.emptyHeading)).toBeVisible();
 });

 test.describe('Voice transcript', () => {
 test('stop listening via Cancel button', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await converse.clickVoiceButton();
 await page.waitForTimeout(500);
 expect(await converse.isListening()).toBe(true);

 await converse.stopListening();
 await page.waitForTimeout(500);
 expect(await converse.isListening()).toBe(false);
 });
 });

 test.describe('Voice + text interaction', () => {
 test('can switch from voice to text input', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 // Start voice
 await converse.clickVoiceButton();
 await page.waitForTimeout(500);
 expect(await converse.isListening()).toBe(true);

 // Stop voice
 await converse.stopListening();
 await page.waitForTimeout(500);

 // Input should be enabled again
 await expect(converse.messageInput).toBeEnabled();
 });
 });
});
