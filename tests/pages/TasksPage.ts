import { type Page, expect, type Locator } from '@playwright/test';

type TabType = 'tasks' | 'reminders';
type TaskFilter = 'all' | 'active' | 'completed';

export class TasksPage {
 readonly heading: Locator;
 readonly addButton: Locator;
 readonly taskInput: Locator;
 readonly addTaskButton: Locator;

 constructor(private readonly page: Page) {
 this.heading = page.getByRole('heading', { level: 1, name: /Tasks/ });
 this.addButton = page.getByLabel('Add task');
 this.taskInput = page.getByPlaceholder("What needs to be done?");
 this.addTaskButton = page.getByRole('button', { name: /Add/ });
 }

 async goto(): Promise<void> {
 await this.page.goto('/dashboard/tasks');
 await this.page.waitForURL(/\/dashboard\/tasks/);
 }

 /** Switch between the Tasks and Reminders tab. */
 async switchTab(tab: TabType): Promise<void> {
 const tabButton = this.page.getByRole('button', { name: new RegExp(`^${tab === 'tasks' ? 'Tasks' : 'Reminders'}`) });
 await tabButton.click();
 }

 /** Filter the task list by the given filter button. */
 async filterBy(filter: TaskFilter): Promise<void> {
 const label = filter === 'all' ? 'All' : filter === 'active' ? 'Active' : 'Done';
 const filterBtn = this.page.getByRole('button', { name: new RegExp(`^${label}`) });
 await filterBtn.click();
 }

 /** Open the add task form and type a title. */
 async openAddTaskForm(): Promise<void> {
 await this.addButton.click();
 await this.taskInput.waitFor({ state: 'visible', timeout: 3_000 });
 }

 /** Fill in the new task input. */
 async typeTaskTitle(title: string): Promise<void> {
 await this.taskInput.fill(title);
 }

 /** Click the "Add" button to create the task. */
 async confirmAddTask(): Promise<void> {
 await this.addTaskButton.click();
 }

 /** Create a task in one flow: open form, type, confirm. */
 async createTask(title: string): Promise<void> {
 await this.openAddTaskForm();
 await this.typeTaskTitle(title);
 await this.confirmAddTask();
 }

 /** Get the number of visible task items. */
 async getTaskCount(): Promise<number> {
 const taskItems = this.page.locator(
 '[class*="GlassPanel"], [class*="rounded-xl"]',
 ).filter({
 hasText: /[a-zA-Z]/,
 });
 return await taskItems.count();
 }

 /** Toggle the completion of a task by its title text. */
 async toggleTaskByTitle(title: string): Promise<void> {
 const taskRow = this.page.locator(
 `[class*="GlassPanel"], [class*="rounded-xl"]`,
 ).filter({ hasText: title });
 const checkbox = taskRow.locator(
 '[role="checkbox"], button[aria-label*="Mark"]',
 ).first();
 await checkbox.click();
 }

 /** Delete a task by its title text. */
 async deleteTaskByTitle(title: string): Promise<void> {
 const taskRow = this.page.locator(
 '[class*="GlassPanel"], [class*="rounded-xl"]',
 ).filter({ hasText: title });
 const deleteBtn = taskRow.getByLabel('Delete task');
 await deleteBtn.click();
 }

 /** Get the text of the active filter button to verify current filter. */
 async getActiveFilterLabel(): Promise<string | null> {
 const active = this.page.locator(
 'button:has([class*="border-indigo"])',
 );
 try {
 await active.first().waitFor({ state: 'visible', timeout: 2_000 });
 return (await active.first().textContent())?.trim() ?? null;
 } catch {
 return null;
 }
 }

 /** Check if a task with the given title is visible. */
 async hasTask(title: string): Promise<boolean> {
 try {
 await this.page.getByText(title, { exact: false }).waitFor({ state: 'visible', timeout: 3_000 });
 return true;
 } catch {
 return false;
 }
 }
}
