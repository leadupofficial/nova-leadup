import { type Page, expect, type Locator } from '@playwright/test';

export class DashboardPage {
 readonly heading: Locator;
 readonly bottomNav: Locator;
 readonly settingsButton: Locator;
 readonly notificationButton: Locator;

 constructor(private readonly page: Page) {
 this.heading = page.getByRole('heading', { level: 1 });
 this.bottomNav = page.locator('nav[aria-label="Main navigation"]');
 this.settingsButton = page.getByLabel('Settings');
 this.notificationButton = page.getByLabel('Notifications');
 }

 async goto(): Promise<void> {
 await this.page.goto('/dashboard');
 await this.page.waitForURL(/\/dashboard/);
 }

 /** Read the dashboard heading (greeting text like "Good morning"). */
 async getGreetingText(): Promise<string | null> {
 try {
 await this.heading.waitFor({ state: 'visible', timeout: 5_000 });
 return (await this.heading.textContent())?.trim() ?? null;
 } catch {
 return null;
 }
 }

 /** Count the quick stat cards visible (Tasks, Memories, Reminders, Chats). */
 async getStatsCount(): Promise<number> {
 const statCards = this.page.locator('text=/Tasks Today|Memories|Reminders|Chats/');
 return await statCards.count();
 }

 /** Check if the "Suggested" section is visible. */
 async hasSuggestedActions(): Promise<boolean> {
 try {
 await this.page.getByText('Suggested').waitFor({ state: 'visible', timeout: 3_000 });
 return true;
 } catch {
 return false;
 }
 }

 /** Check if the "Recent Activity" section is visible. */
 async hasRecentActivity(): Promise<boolean> {
 try {
 await this.page.getByText('Recent Activity').waitFor({ state: 'visible', timeout: 3_000 });
 return true;
 } catch {
 return false;
 }
 }

 /** Navigate to the Converse page via the bottom nav. */
 async navigateToConverse(): Promise<void> {
 await this.page.getByLabel('Converse').click();
 await this.page.waitForURL(/\/dashboard\/converse/);
 }

 /** Navigate to the Tasks page via the bottom nav. */
 async navigateToTasks(): Promise<void> {
 await this.page.getByLabel('Tasks').click();
 await this.page.waitForURL(/\/dashboard\/tasks/);
 }

 /** Navigate to Settings via the bottom nav. */
 async navigateToSettings(): Promise<void> {
 await this.page.getByLabel('Profile').click();
 await this.page.waitForURL(/\/dashboard\/settings/);
 }

 /** Open settings using the header gear button. */
 async openSettingsViaHeader(): Promise<void> {
 await this.settingsButton.click();
 await this.page.waitForURL(/\/dashboard\/settings/);
 }

 /** Verify all five bottom nav labels exist. */
 async hasBottomNavItems(): Promise<boolean> {
 const expectedLabels = ['Home', 'Converse', 'Tasks', 'Memory', 'Profile'];
 for (const label of expectedLabels) {
 if (!(await this.page.getByLabel(label).count())) return false;
 }
 return true;
 }
}
