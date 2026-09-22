import { test, expect, type Page } from '@playwright/test';
import { TasksPage } from '../pages/TasksPage';
import { TASKS_TEXT } from '../fixtures/test-data';

function getFreshTasks(page: Page): TasksPage {
 return new TasksPage(page);
}

async function ensureLoggedIn(page: Page): Promise<void> {
 await page.goto('/');
 await page.evaluate(() => localStorage.setItem('nova-onboarding-complete', 'true'));
 await page.reload();
}

test.describe('Tasks screen', () => {
 test.beforeEach(async ({ page }) => {
 await ensureLoggedIn(page);
 });

 test('loads the Tasks page', async ({ page }) => {
 const tasks = getFreshTasks(page);
 await tasks.goto();

 await expect(page).toHaveURL(/\/dashboard\/tasks/);
 await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tasks');
 });

 test('shows tab switcher for Tasks and Reminders', async ({ page }) => {
 const tasks = getFreshTasks(page);
 await tasks.goto();

 await expect(page.getByRole('button', { name: /^Tasks/ })).toBeVisible();
 await expect(page.getByRole('button', { name: /^Reminders/ })).toBeVisible();
 });

 test.describe('Creating tasks', () => {
 test('opens the add task form via the floating button', async ({ page }) => {
 const tasks = getFreshTasks(page);
 await tasks.goto();

 await tasks.openAddTaskForm();
 await expect(tasks.taskInput).toBeVisible();
 await expect(tasks.taskInput).toHaveAttribute('placeholder', TASKS_TEXT.newTaskPlaceholder);
 });

 test('creates a new task and it appears in the list', async ({ page }) => {
 const tasks = getFreshTasks(page);
 await tasks.goto();

 await tasks.createTask('E2E Test Task');
 await page.waitForTimeout(500);

 expect(await tasks.hasTask('E2E Test Task')).toBe(true);
 });

 test('shows no active tasks message initially', async ({ page }) => {
 const tasks = getFreshTasks(page);
 await tasks.goto();

 await expect(page.getByText('No active tasks!')).toBeVisible();
 });
 });

 test.describe('Task count', () => {
 test('returns 0 when no tasks exist', async ({ page }) => {
 const tasks = getFreshTasks(page);
 await tasks.goto();

 const count = await tasks.getTaskCount();
 expect(count).toBe(0);
 });
 });

 test.describe('Tab switching', () => {
 test('can switch to the Reminders tab', async ({ page }) => {
 const tasks = getFreshTasks(page);
 await tasks.goto();

 await tasks.switchTab('reminders');
 await expect(page.getByText('No reminders set')).toBeVisible();
 });

 test('can switch back to the Tasks tab', async ({ page }) => {
 const tasks = getFreshTasks(page);
 await tasks.goto();

 await tasks.switchTab('reminders');
 await tasks.switchTab('tasks');
 await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tasks');
 });
 });

 test.describe('Filter buttons', () => {
 test('shows All / Active / Done filter buttons', async ({ page }) => {
 const tasks = getFreshTasks(page);
 await tasks.goto();

 await expect(page.getByRole('button', { name: /All/ })).toBeVisible();
 await expect(page.getByRole('button', { name: /Active/ })).toBeVisible();
 await expect(page.getByRole('button', { name: /Done/ })).toBeVisible();
 });

 test('Active filter is selected by default', async ({ page }) => {
 const tasks = getFreshTasks(page);
 await tasks.goto();

 const activeLabel = await tasks.getActiveFilterLabel();
 expect(activeLabel).not.toBeNull();
 expect(activeLabel).toMatch(/Active/);
 });
 });

 test.describe('Floating add button', () => {
 test('floating add button is visible', async ({ page }) => {
 const tasks = getFreshTasks(page);
 await tasks.goto();

 await expect(page.getByLabel('Add task')).toBeVisible();
 });
 });
});
