import { type Page, expect, type Locator } from '@playwright/test';

export class ConversePage {
 readonly heading: Locator;
 readonly messageInput: Locator;
 readonly sendButton: Locator;
 readonly voiceButton: Locator;
 readonly clearButton: Locator;

 constructor(private readonly page: Page) {
 this.heading = page.getByRole('heading', { level: 1, name: /Converse/ });
 this.messageInput = page.getByPlaceholder('Type a message...');
 this.sendButton = page.getByLabel('Send message');
 this.voiceButton = page.getByLabel('Start listening');
 this.clearButton = page.getByLabel('Clear conversation');
 }

 async goto(): Promise<void> {
 await this.page.goto('/dashboard/converse');
 await this.page.waitForURL(/\/dashboard\/converse/);
 }

 /** Fill the message input. */
 async typeMessage(text: string): Promise<void> {
 await this.messageInput.fill(text);
 }

 /** Click the send button. */
 async sendMessage(): Promise<void> {
 await this.sendButton.click();
 }

 /** Type and send in one step. */
 async sendTextMessage(text: string): Promise<void> {
 await this.typeMessage(text);
 await this.sendMessage();
 }

 /** Count visible message bubbles (filter by "You" or "NOVA" labels). */
 async getMessageCount(): Promise<number> {
 const bubbles = this.page.locator('p:has-text("You"), p:has-text("NOVA")');
 return await bubbles.count();
 }

 /** Check if the empty state "How can I help?" is visible. */
 async isEmptyStateVisible(): Promise<boolean> {
 try {
 await this.page.getByRole('heading', { name: /How can I help/ }).waitFor({
 state: 'visible',
 timeout: 3_000,
 });
 return true;
 } catch {
 return false;
 }
 }

 /** Click the voice button to start listening. */
 async clickVoiceButton(): Promise<void> {
 await this.voiceButton.click();
 }

 /** Check if the listening overlay is visible. */
 async isListening(): Promise<boolean> {
 try {
 await this.page.locator('text=Listening...').waitFor({ state: 'visible', timeout: 3_000 });
 return true;
 } catch {
 return false;
 }
 }

 /** Click Cancel to stop voice listening. */
 async stopListening(): Promise<void> {
 const cancelBtn = this.page.getByRole('button', { name: 'Cancel' });
 if (await cancelBtn.count()) {
 await cancelBtn.click();
 }
 }

 /** Check if the streaming indicator "NOVA is speaking..." is visible. */
 async isStreaming(): Promise<boolean> {
 try {
 await this.page.getByText('NOVA is speaking...').waitFor({ state: 'visible', timeout: 5_000 });
 return true;
 } catch {
 return false;
 }
 }

 /** Clear the conversation via the header button. */
 async clearConversation(): Promise<void> {
 if (await this.clearButton.count()) {
 await this.clearButton.click();
 }
 }
}
