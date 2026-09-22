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

 /** Read the dashboard heading (greeting text). */
 async getGreetingText(): Promise<string | null> {
 try {
 await this.heading.waitFor({ state: 'visible', timeout: 5_000 });
 return (await this.heading.textContent())?.trim() ?? null;
 } catch {
 return null;
 }
 }

 /** Return the count of quick stat cards visible (should be 4). */
 async getStatsCount(): Promise<number> {
 const statCards = this.page.locator('[class*="rounded-lg"]').filter({
 hasText: /Tasks Today|Memories|Reminders|Chats/,
 });
 return await statCards.count();
 }

 /** Return true if the suggested actions section is visible. */
 async hasSuggestedActions(): Promise<boolean> {
 const section = this.page.getByText('Suggested');
 try {
 await section.waitFor({ state: 'visible', timeout: 3_000 });
 return true;
 } catch {
 return false;
 }
 }

 /** Return true if recent activity section is visible. */
 async hasRecentActivity(): Promise<boolean> {
 const section = this.page.getByText('Recent Activity');
 try {
 await section.waitFor({ state: 'visible', timeout: 3_000 });
 return true;
 } catch {
 return false;
 }
 }

 /** Navigate to conversations via the bottom nav. */
 async navigateToConverse(): Promise<void> {
 const converseLink = this.page.getByLabel('Converse');
 await converseLink.click();
 await this.page.waitForURL(/\/dashboard\/converse/);
 }

 /** Navigate to tasks via the bottom nav. */
 async navigateToTasks(): Promise<void> {
 const tasksLink = this.page.getByLabel('Tasks');
 await tasksLink.click();
 await this.page.waitForURL(/\/dashboard\/tasks/);
 }

 /** Navigate to settings via the bottom nav. */
 async navigateToSettings(): Promise<void> {
 const profileLink = this.page.getByLabel('Profile');
 await profileLink.click();
 await this.page.waitForURL(/\/dashboard\/settings/);
 }

 /** Open the settings gear button from the dashboard header. */
 async openSettingsViaHeader(): Promise<void> {
 await this.settingsButton.click();
 await this.page.waitForURL(/\/dashboard\/settings/);
 }

 /** Verify the bottom nav has all expected items. */
 async hasBottomNavItems(): Promise<boolean> {
 const expectedLabels = ['Home', 'Converse', 'Tasks', 'Memory', 'Profile'];
 for (const label of expectedLabels) {
 const item = this.page.getByLabel(label);
 if (!(await item.count())) return false;
 }
 return true;
 }

 /** Get the text content of the "View all" link in the conversations preview. */
 async getViewAllConversationsText(): Promise<string | null> {
 const link = this.page.getByText('View all').first();
 try {
 await link.waitFor({ state: 'visible', timeout: 3_000 });
 return (await link.textContent())?.trim() ?? null;
 } catch {
 return null;
 }
 }
}
