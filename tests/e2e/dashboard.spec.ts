import { test, expect, type Page } from '@playwright/test';
import { DashboardPage } from '../pages/DashboardPage';
import { DASHBOARD_TEXT } from '../fixtures/test-data';

function getFreshDashboard(page: Page): DashboardPage {
 return new DashboardPage(page);
}

async function ensureLoggedIn(page: Page): Promise<void> {
 await page.goto('/');
 await page.evaluate(() => localStorage.setItem('nova-onboarding-complete', 'true'));
 await page.reload();
 await page.waitForURL(/\/dashboard/, { timeout: 5_000 });
}

test.describe('Dashboard', () => {
 test.beforeEach(async ({ page }) => {
 await ensureLoggedIn(page);
 });

 test('loads the dashboard page', async ({ page }) => {
 const dashboard = getFreshDashboard(page);
 await dashboard.goto();

 await expect(page).toHaveURL(/\/dashboard/);
 await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
 });

 test('displays a time-based greeting', async ({ page }) => {
 const dashboard = getFreshDashboard(page);
 await dashboard.goto();

 const greeting = await dashboard.getGreetingText();
 expect(greeting).not.toBeNull();
 expect(greeting).toMatch(DASHBOARD_TEXT.greetingPattern);
 });

 test('shows the four quick stat cards', async ({ page }) => {
 const dashboard = getFreshDashboard(page);
 await dashboard.goto();

 await page.waitForTimeout(800); // framer-motion staggered entrance
 const count = await dashboard.getStatsCount();
 expect(count).toBeGreaterThanOrEqual(4);
 });

 test('displays the suggested actions section', async ({ page }) => {
 const dashboard = getFreshDashboard(page);
 await dashboard.goto();

 await page.waitForTimeout(800);
 expect(await dashboard.hasSuggestedActions()).toBe(true);
 });

 test('displays the recent activity section', async ({ page }) => {
 const dashboard = getFreshDashboard(page);
 await dashboard.goto();

 await page.waitForTimeout(800);
 expect(await dashboard.hasRecentActivity()).toBe(true);
 });

 test('has all five bottom nav items', async ({ page }) => {
 const dashboard = getFreshDashboard(page);
 await dashboard.goto();

 expect(await dashboard.hasBottomNavItems()).toBe(true);
 });

 test.describe('Navigation', () => {
 test('navigates to Converse via bottom nav', async ({ page }) => {
 const dashboard = getFreshDashboard(page);
 await dashboard.goto();

 await dashboard.navigateToConverse();
 await expect(page).toHaveURL(/\/dashboard\/converse/);
 });

 test('navigates to Tasks via bottom nav', async ({ page }) => {
 const dashboard = getFreshDashboard(page);
 await dashboard.goto();

 await dashboard.navigateToTasks();
 await expect(page).toHaveURL(/\/dashboard\/tasks/);
 });

 test('navigates to Settings via bottom nav', async ({ page }) => {
 const dashboard = getFreshDashboard(page);
 await dashboard.goto();

 await dashboard.navigateToSettings();
 await expect(page).toHaveURL(/\/dashboard\/settings/);
 });

 test('opens settings via header gear button', async ({ page }) => {
 const dashboard = getFreshDashboard(page);
 await dashboard.goto();

 await dashboard.openSettingsViaHeader();
 await expect(page).toHaveURL(/\/dashboard\/settings/);
 });
 });

 test.describe('Notifications button', () => {
 test('notifications button is present and clickable', async ({ page }) => {
 const dashboard = getFreshDashboard(page);
 await dashboard.goto();

 await expect(dashboard.notificationButton).toBeVisible();
 await dashboard.notificationButton.click();
 await expect(page).toHaveURL(/\/dashboard/);
 });
 });
});
