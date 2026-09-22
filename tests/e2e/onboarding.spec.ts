import { test, expect, type Page } from '@playwright/test';
import { OnboardingPage } from '../pages/OnboardingPage';
import { ONBOARDING_TEXT } from '../fixtures/test-data';

function getFreshOnboardingPage(page: Page): OnboardingPage {
 return new OnboardingPage(page);
}

async function forceOnboarding(page: Page): Promise<void> {
 await page.goto('/');
 await page.evaluate(() => localStorage.removeItem('nova-onboarding-complete'));
}

test.describe('Onboarding flow', () => {
 test.beforeEach(async ({ page }) => {
 await forceOnboarding(page);
 });

 test.describe('Step 1 — Welcome', () => {
 test('renders the NOVA heading and welcome text', async ({ page }) => {
 const onboarding = getFreshOnboardingPage(page);
 await onboarding.goto();
 await page.waitForLoadState('networkidle');

 await expect(page.getByRole('heading', { level: 1 })).toContainText('NOVA');
 await expect(page.getByText(ONBOARDING_TEXT.welcome)).toBeVisible();
 });

 test('name input is present and initially empty', async ({ page }) => {
 const onboarding = getFreshOnboardingPage(page);
 await onboarding.goto();
 await page.waitForLoadState('networkidle');

 await expect(onboarding.nameInput).toBeVisible();
 await expect(onboarding.nameInput).toBeEmpty();
 });

 test('Get Started button is disabled when name is empty', async ({ page }) => {
 const onboarding = getFreshOnboardingPage(page);
 await onboarding.goto();
 await page.waitForLoadState('networkidle');

 const getStartedBtn = page.getByRole('button', { name: 'Get Started' });
 await expect(getStartedBtn).toBeDisabled();
 });

 test('Get Started button enables after entering a name', async ({ page }) => {
 const onboarding = getFreshOnboardingPage(page);
 await onboarding.goto();
 await page.waitForLoadState('networkidle');

 await onboarding.enterName('Abishek');
 const getStartedBtn = page.getByRole('button', { name: 'Get Started' });
 await expect(getStartedBtn).toBeEnabled();
 });

 test('Get Started button stays disabled with whitespace-only name', async ({ page }) => {
 const onboarding = getFreshOnboardingPage(page);
 await onboarding.goto();
 await page.waitForLoadState('networkidle');

 await onboarding.enterName(' ');
 const getStartedBtn = page.getByRole('button', { name: 'Get Started' });
 await expect(getStartedBtn).toBeDisabled();
 });
 });

 test.describe('Full onboarding wizard', () => {
 test('completes all steps and redirects to dashboard', async ({ page }) => {
 const onboarding = getFreshOnboardingPage(page);
 await onboarding.completeOnboarding('Abishek');

 await expect(page).toHaveURL(/\/dashboard/);
 await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
 });

 test('persists onboarding completion flag in localStorage', async ({ page }) => {
 const onboarding = getFreshOnboardingPage(page);
 await onboarding.completeOnboarding('Test User');

 const flag = await page.evaluate(() => localStorage.getItem('nova-onboarding-complete'));
 expect(flag).not.toBeNull();
 });
 });

 test.describe('Navigation guard', () => {
 test('homepage redirects uncompleted users to /onboarding', async ({ page }) => {
 await forceOnboarding(page);
 await page.goto('/');
 await page.waitForURL(/\/onboarding/, { timeout: 5_000 });
 await expect(page).toHaveURL(/\/onboarding/);
 });

 test('homepage redirects completed users to /dashboard', async ({ page }) => {
 await page.goto('/');
 await page.evaluate(() => localStorage.setItem('nova-onboarding-complete', 'true'));
 await page.reload();
 await page.waitForURL(/\/dashboard/, { timeout: 5_000 });
 await expect(page).toHaveURL(/\/dashboard/);
 });
 });
});
