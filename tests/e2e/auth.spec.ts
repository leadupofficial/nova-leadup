import { test, expect, type Page } from '@playwright/test';
import { OnboardingPage } from '../pages/OnboardingPage';
import { ONBOARDING_TEXT } from '../fixtures/test-data';

function getOnboardingPage(page: Page): OnboardingPage {
 return new OnboardingPage(page);
}

test.describe('Auth flow — UI behavior', () => {
 test.describe('Unauthenticated access', () => {
 test('homepage redirects to onboarding for new users', async ({ page }) => {
 await page.goto('/');
 await page.evaluate(() => localStorage.removeItem('nova-onboarding-complete'));
 await page.reload();
 await page.waitForURL(/\/onboarding/, { timeout: 5_000 });

 const onboarding = getOnboardingPage(page);
 await expect(onboarding.heading).toContainText('NOVA');
 });

 test('can access onboarding page directly', async ({ page }) => {
 const onboarding = getOnboardingPage(page);
 await onboarding.goto();

 await expect(page).toHaveURL(/\/onboarding/);
 await expect(onboarding.heading).toContainText('NOVA');
 });

 test('dashboard redirects unauthenticated users to onboarding', async ({ page }) => {
 await page.goto('/dashboard');
 await page.waitForURL(/\/onboarding/, { timeout: 5_000 });
 await expect(page).toHaveURL(/\/onboarding/);
 });

 test('can access settings page directly (client-side only guard)', async ({ page }) => {
 await page.goto('/');
 await page.evaluate(() => localStorage.setItem('nova-onboarding-complete', 'true'));
 await page.goto('/dashboard/settings');
 await page.waitForURL(/\/dashboard\/settings/, { timeout: 5_000 });
 });
 });

 test.describe('Onboarding session state', () => {
 test('completing onboarding prevents re-access to /onboarding', async ({ page }) => {
 const onboarding = getOnboardingPage(page);
 await onboarding.completeOnboarding('E2E User');

 await page.goto('/onboarding');
 await page.waitForURL(/\/dashboard/, { timeout: 5_000 });
 await expect(page).toHaveURL(/\/dashboard/);
 });

 test('clearing onboarding flag returns user to onboarding', async ({ page }) => {
 const onboarding = getOnboardingPage(page);
 await onboarding.completeOnboarding('Reset Test');
 await expect(page).toHaveURL(/\/dashboard/);

 await page.evaluate(() => localStorage.removeItem('nova-onboarding-complete'));
 await page.goto('/');
 await page.waitForURL(/\/onboarding/, { timeout: 5_000 });
 await expect(page).toHaveURL(/\/onboarding/);
 });
 });

 test.describe('Onboarding form validation', () => {
 test('does not advance past welcome step with empty name', async ({ page }) => {
 const onboarding = getOnboardingPage(page);
 await onboarding.goto();

 const getStartedBtn = page.getByRole('button', { name: 'Get Started' });
 await expect(getStartedBtn).toBeDisabled();
 });

 test('accepts a single-character name', async ({ page }) => {
 const onboarding = getOnboardingPage(page);
 await onboarding.goto();

 await onboarding.enterName('A');
 const getStartedBtn = page.getByRole('button', { name: 'Get Started' });
 await expect(getStartedBtn).toBeEnabled();
 });

 test('accepts names with spaces and special characters', async ({ page }) => {
 const onboarding = getOnboardingPage(page);
 await onboarding.goto();

 await onboarding.enterName("O'Brien-Smith Jr.");
 const getStartedBtn = page.getByRole('button', { name: 'Get Started' });
 await expect(getStartedBtn).toBeEnabled();
 });
 });

 test.describe('Protected routes', () => {
 test('converse page redirects without onboarding completion', async ({ page }) => {
 await page.goto('/dashboard/converse');
 await page.waitForURL(/\/onboarding/, { timeout: 5_000 });
 });

 test('tasks page redirects without onboarding completion', async ({ page }) => {
 await page.goto('/dashboard/tasks');
 await page.waitForURL(/\/onboarding/, { timeout: 5_000 });
 });

 test('settings page redirects without onboarding completion', async ({ page }) => {
 await page.goto('/dashboard/settings');
 await page.waitForURL(/\/onboarding/, { timeout: 5_000 });
 });
 });
});
