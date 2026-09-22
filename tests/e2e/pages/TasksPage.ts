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
 this.taskInput = page.getByPlaceholder('What needs to be done?');
 this.addTaskButton = page.getByRole('button', { name: /Add/ });
 }

 async goto(): Promise<void> {
 await this.page.goto('/dashboard/tasks');
 await this.page.waitForURL(/\/dashboard\/tasks/);
 }

 /** Switch to the given tab (tasks or reminders). */
 async switchTab(tab: TabType): Promise<void> {
 const tabBtn = this.page.getByRole('button', {
 name: new RegExp(`^${tab === 'tasks' ? 'Tasks' : 'Reminders'}`),
 });
 await tabBtn.click();
 }

 /** Click a filter button: all / active / completed. */
 async filterBy(filter: TaskFilter): Promise<void> {
 const label = filter === 'all' ? 'All' : filter === 'active' ? 'Active' : 'Done';
 const filterBtn = this.page.getByRole('button', { name: new RegExp(`^${label}`) });
 await filterBtn.click();
 }

 /** Open the add-task form by clicking the floating button. */
 async openAddTaskForm(): Promise<void> {
 await this.addButton.click();
 await this.taskInput.waitFor({ state: 'visible', timeout: 3_000 });
 }

 /** Type a title into the new-task input. */
 async typeTaskTitle(title: string): Promise<void> {
 await this.taskInput.fill(title);
 }

 /** Click the "Add" button to create the task. */
 async confirmAddTask(): Promise<void> {
 await this.addTaskButton.click();
 }

 /** Create a task end-to-end: open form, type title, confirm. */
 async createTask(title: string): Promise<void> {
 await this.openAddTaskForm();
 await this.typeTaskTitle(title);
 await this.confirmAddTask();
 }

 /** Count visible task items. */
 async getTaskCount(): Promise<number> {
 const items = this.page.locator(
 '[class*="GlassPanel"], [class*="rounded-xl"]',
 ).filter({ hasText: /[a-zA-Z]/ });
 return await items.count();
 }

 /** Check if a task with the given title is visible. */
 async hasTask(title: string): Promise<boolean> {
 try {
 await this.page.getByText(title, { exact: false }).waitFor({
 state: 'visible',
 timeout: 3_000,
 });
 return true;
 } catch {
 return false;
 }
 }
}
