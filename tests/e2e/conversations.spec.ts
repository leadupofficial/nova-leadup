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

test.describe('Converse screen', () => {
 test.beforeEach(async ({ page }) => {
 await ensureLoggedIn(page);
 });

 test('loads the Converse page', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await expect(page).toHaveURL(/\/dashboard\/converse/);
 await expect(converse.heading).toBeVisible();
 await expect(converse.heading).toHaveText('Converse');
 });

 test('shows the empty state when no messages exist', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 expect(await converse.isEmptyStateVisible()).toBe(true);
 await expect(page.getByText('How can I help?')).toBeVisible();
 });

 test('message input is present with correct placeholder', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await expect(converse.messageInput).toBeVisible();
 await expect(converse.messageInput).toHaveAttribute('placeholder', CONVERSE_TEXT.placeholder);
 });

 test('send button is present', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await expect(converse.sendButton).toBeVisible();
 });

 test.describe('Sending messages', () => {
 test('adds a user message to the conversation', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await converse.sendTextMessage('Hello NOVA');
 await page.waitForTimeout(500);

 expect(await converse.isEmptyStateVisible()).toBe(false);
 });

 test('clears the input after sending', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await converse.typeMessage('Test message');
 await expect(converse.messageInput).toHaveValue('Test message');

 await converse.sendMessage();
 await expect(converse.messageInput).toHaveValue('');
 });

 test('does not send empty messages', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await expect(converse.sendButton).toBeDisabled();
 });

 test('displays at least one message bubble after sending', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await converse.sendTextMessage('Hello there');
 await page.waitForTimeout(500);

 const count = await converse.getMessageCount();
 expect(count).toBeGreaterThanOrEqual(1);
 });
 });

 test.describe('Clear conversation', () => {
 test('clear button is visible after sending a message', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await converse.sendTextMessage('Message to clear');
 await page.waitForTimeout(500);

 await expect(converse.clearButton).toBeVisible();
 });

 test('clear button returns the screen to empty state', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await converse.sendTextMessage('Message to clear');
 await page.waitForTimeout(500);
 await converse.clearConversation();

 expect(await converse.isEmptyStateVisible()).toBe(true);
 });
 });

 test.describe('Voice input UI', () => {
 test('voice button is present', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await expect(converse.voiceButton).toBeVisible();
 });

 test('clicking voice button does not navigate away', async ({ page }) => {
 const converse = getFreshConverse(page);
 await converse.goto();

 await converse.clickVoiceButton();
 await expect(page).toHaveURL(/\/dashboard\/converse/);
 });
 });
});
