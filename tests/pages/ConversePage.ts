import { type Page, expect, type Locator } from '@playwright/test';

export class ConversePage {
 readonly heading: Locator;
 readonly messageInput: Locator;
 readonly sendButton: Locator;
 readonly voiceButton: Locator;
 readonly messagesContainer: Locator;
 readonly clearButton: Locator;

 constructor(private readonly page: Page) {
 this.heading = page.getByRole('heading', { level: 1, name: /Converse/ });
 this.messageInput = page.getByPlaceholder('Type a message...');
 this.sendButton = page.getByLabel('Send message');
 this.voiceButton = page.getByLabel('Start listening');
 this.messagesContainer = page.locator('.space-y-3, [class*="space-y"]');
 this.clearButton = page.getByLabel('Clear conversation');
 }

 async goto(): Promise<void> {
 await this.page.goto('/dashboard/converse');
 await this.page.waitForURL(/\/dashboard\/converse/);
 }

 /** Type text into the message input field. */
 async typeMessage(text: string): Promise<void> {
 await this.messageInput.fill(text);
 }

 /** Click the send button. */
 async sendMessage(): Promise<void> {
 await this.sendButton.click();
 }

 /** Send a message in one step (type + send). */
 async sendTextMessage(text: string): Promise<void> {
 await this.typeMessage(text);
 await this.sendMessage();
 }

 /** Return the count of message bubbles currently displayed. */
 async getMessageCount(): Promise<number> {
 const bubbles = this.page.locator(
 '[class*="rounded-xl"], [class*="GlassPanel"]',
 );
 // Filter for message bubbles (those containing "You" or "NOVA" labels)
 const withLabels = bubbles.filter({
 has: this.page.locator(':text-matches("You|NOVA")'),
 });
 return await withLabels.count();
 }

 /** Get the content of the last user message. */
 async getLastUserMessage(): Promise<string | null> {
 const userBubbles = this.page.locator('p:has-text("You") >> .. >> p.text-matches("^(?!You|NOVA$).*")');
 try {
 const last = userBubbles.last();
 await last.waitFor({ state: 'visible', timeout: 10_000 });
 return (await last.textContent())?.trim() ?? null;
 } catch {
 return null;
 }
 }

 /** Get the content of the last assistant message. */
 async getLastAssistantMessage(): Promise<string | null> {
 const assistantBubbles = this.page.locator('p:has-text("NOVA") >> .. >> p.text-matches("^(?!You|NOVA$).*")');
 try {
 const last = assistantBubbles.last();
 await last.waitFor({ state: 'visible', timeout: 15_000 });
 return (await last.textContent())?.trim() ?? null;
 } catch {
 return null;
 }
 }

 /** Clear the current conversation. */
 async clearConversation(): Promise<void> {
 const clearBtn = this.clearButton;
 if (await clearBtn.count()) {
 await clearBtn.click();
 }
 }

 /** Click the voice input button to start listening. */
 async clickVoiceButton(): Promise<void> {
 await this.voiceButton.click();
 }

 /** Check if the listening overlay/indicator is visible. */
 async isListening(): Promise<boolean> {
 try {
 const indicator = this.page.locator(
 '[class*="Listening"], [class*="listening"]',
 );
 await indicator.first().waitFor({ state: 'visible', timeout: 3_000 });
 return true;
 } catch {
 return false;
 }
 }

 /** Return the current transcript text if voice is active. */
 async getTranscript(): Promise<string | null> {
 const transcriptEl = this.page.locator('[class*="transcript"], p:has-text("Hearing you") >> xpath=following-sibling::p').first();
 try {
 await transcriptEl.waitFor({ state: 'visible', timeout: 5_000 });
 return (await transcriptEl.textContent())?.trim() ?? null;
 } catch {
 return null;
 }
 }

 /** Click the "Cancel" button in the voice overlay to stop listening. */
 async stopListening(): Promise<void> {
 const cancelBtn = this.page.getByRole('button', { name: 'Cancel' });
 if (await cancelBtn.count()) {
 await cancelBtn.click();
 }
 }

 /** Check whether the empty state is shown (no messages). */
 async isEmptyStateVisible(): Promise<boolean> {
 try {
 const emptyHeading = this.page.getByRole('heading', { name: /How can I help/ });
 await emptyHeading.waitFor({ state: 'visible', timeout: 3_000 });
 return true;
 } catch {
 return false;
 }
 }

 /** Wait for the "NOVA is speaking..." streaming indicator. */
 async isStreaming(): Promise<boolean> {
 try {
 const indicator = this.page.getByText('NOVA is speaking...');
 await indicator.waitFor({ state: 'visible', timeout: 5_000 });
 return true;
 } catch {
 return false;
 }
 }
}
