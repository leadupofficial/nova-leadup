import { type Page, expect, type Locator } from '@playwright/test';

export class VoiceChatPage {
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

 async clickVoiceButton(): Promise<void> {
 await this.voiceButton.click();
 }

 async isListening(): Promise<boolean> {
 try {
 const indicator = this.page.getByText('Listening...');
 await indicator.waitFor({ state: 'visible', timeout: 3_000 });
 return true;
 } catch {
 return false;
 }
 }

 async getTranscript(): Promise<string | null> {
 const transcriptEl = this.page.locator('text=Hearing you...');
 try {
 await transcriptEl.waitFor({ state: 'visible', timeout: 5_000 });
 const parent = transcriptEl.locator('..');
 return (await parent.locator('p').last().textContent())?.trim() ?? null;
 } catch {
 return null;
 }
 }

 async stopListening(): Promise<void> {
 const cancelBtn = this.page.getByRole('button', { name: 'Cancel' });
 if (await cancelBtn.count()) {
 await cancelBtn.click();
 }
 }

 async getAssistantState(): Promise<string> {
 return await this.page.evaluate(() => {
 const stateEl = document.querySelector('[class*="listening"], [class*="bg-cyan"]');
 return stateEl ? 'listening' : 'idle';
 });
 }
}
