/**
 * @file E2E tests for the Settings page.
 *
 * Settings are stored client-side via Zustand persist middleware.
 * Prerequisites: onboarding must be complete.
 */
import { test, expect, type Page } from '@playwright/test';
import { SettingsPage } from '../pages/SettingsPage';
import { SETTINGS_TEXT } from '../fixtures/test-data';

function getFreshSettings(page: Page): SettingsPage {
 return new SettingsPage(page);
}

async function ensureLoggedIn(page: Page): Promise<void> {
 await page.goto('/');
 await page.evaluate(() => localStorage.setItem('nova-onboarding-complete', 'true'));
 await page.reload();
}

test.describe('Settings page', () => {
 test.beforeEach(async ({ page }) => {
 await ensureLoggedIn(page);
 });

 test('loads the Settings page', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 await expect(page).toHaveURL(/\/dashboard\/settings/);
 expect(await settings.hasCompanionHeading()).toBe(true);
 });

 test('displays the companion name heading', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 const name = await settings.getCompanionName();
 expect(name).not.toBeNull();
 expect(name!.length).toBeGreaterThan(0);
 });

 test('has all major sections', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 expect(await settings.hasSection(SETTINGS_TEXT.profileSection)).toBe(true);
 expect(await settings.hasSection(SETTINGS_TEXT.voiceSection)).toBe(true);
 expect(await settings.hasSection(SETTINGS_TEXT.featuresSection)).toBe(true);
 expect(await settings.hasSection(SETTINGS_TEXT.memorySection)).toBe(true);
 expect(await settings.hasSection(SETTINGS_TEXT.privacySection)).toBe(true);
 });

 test.describe('Voice settings', () => {
 test('shows the Voice & Language section', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 await expect(settings.voiceSection).toBeVisible();
 });

 test('voice speed slider is present', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 const speedLabel = await settings.getVoiceSpeedLabel();
 expect(speedLabel).not.toBeNull();
 expect(speedLabel).toMatch(/Speech Speed/);
 });

 test('voice dropdown has options', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 const selects = page.locator('select');
 const count = await selects.count();
 expect(count).toBeGreaterThanOrEqual(1);
 });
 });

 test.describe('AI response length', () => {
 test('shows Brief / Standard / Detailed options', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 await expect(page.getByRole('button', { name: 'Brief' })).toBeVisible();
 await expect(page.getByRole('button', { name: 'Standard' })).toBeVisible();
 await expect(page.getByRole('button', { name: 'Detailed' })).toBeVisible();
 });

 test('can switch response length to "Detailed"', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 await settings.setResponseLength('long');
 await expect(page.getByRole('button', { name: 'Detailed' })).toHaveClass(
 /bg-emerald|border-emerald/,
 );
 });
 });

 test.describe('Navigation from settings', () => {
 test('can navigate to Privacy Center', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 await settings.navigateToPrivacyCenter();
 await expect(page).toHaveURL(/\/dashboard\/privacy/);
 });
 });

 test.describe('Feature toggles', () => {
 test('Notifications toggle is present', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 await expect(page.getByLabel('Notifications')).toBeVisible();
 });

 test('Wake Word toggle is present', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 await expect(page.getByLabel('Wake Word')).toBeVisible();
 });

 test('Proactive Assistance toggle is present', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 await expect(page.getByLabel('Proactive Assistance')).toBeVisible();
 });

 test('Memory toggle is present', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 await expect(page.getByLabel('Memory')).toBeVisible();
 });
 });

 test.describe('Data actions', () => {
 test('Export My Data button is present', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 await expect(page.getByRole('button', { name: /Export My Data/ })).toBeVisible();
 });

 test('Clear all memory button is present', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 await expect(page.getByRole('button', { name: /Clear all memory/ })).toBeVisible();
 });
 });

 test.describe('Version footer', () => {
 test('shows NOVA version in the footer', async ({ page }) => {
 const settings = getFreshSettings(page);
 await settings.goto();

 await expect(page.getByText(/NOVA v0\.1\.0/)).toBeVisible();
 });
 });
});
