import { type Page, expect, type Locator } from '@playwright/test';

export class SettingsPage {
 readonly heading: Locator;
 readonly voiceSection: Locator;
 readonly featuresSection: Locator;
 readonly memorySection: Locator;
 readonly privacySection: Locator;

 constructor(private readonly page: Page) {
 this.heading = page.getByRole('heading', { level: 1 });
 this.voiceSection = page.getByText('Voice & Language');
 this.featuresSection = page.getByText('Features');
 this.memorySection = page.getByText('Memory');
 this.privacySection = page.getByText('Privacy');
 }

 async goto(): Promise<void> {
 await this.page.goto('/dashboard/settings');
 await this.page.waitForURL(/\/dashboard\/settings/);
 }

 /** Change the voice speed slider to the given value (0.5 – 2.0). */
 async setVoiceSpeed(speed: number): Promise<void> {
 const slider = this.page.locator('input[type="range"]').first();
 await slider.fill(String(speed));
 }

 /** Read the current speed label text (e.g. "1.5x"). */
 async getVoiceSpeedLabel(): Promise<string | null> {
 const label = this.page.locator('label:has-text("Speech Speed")');
 try {
 await label.waitFor({ state: 'visible', timeout: 3_000 });
 return (await label.textContent())?.trim() ?? null;
 } catch {
 return null;
 }
 }

 /** Select a response length option (short / medium / long). */
 async setResponseLength(length: 'short' | 'medium' | 'long'): Promise<void> {
 const labelMap: Record<string, string> = {
 short: 'Brief',
 medium: 'Standard',
 long: 'Detailed',
 };
 const button = this.page.getByRole('button', { name: labelMap[length] });
 await button.click();
 }

 /** Toggle the Memory feature switch. */
 async toggleMemory(enabled: boolean): Promise<void> {
 const memoryToggle = this.page.getByLabel('Memory');
 if (await memoryToggle.count()) {
 await memoryToggle.click();
 }
 }

 /** Navigate to the Privacy Center via link. */
 async navigateToPrivacyCenter(): Promise<void> {
 const privacyLink = this.page.getByText('Privacy Center');
 if (await privacyLink.count()) {
 await privacyLink.click();
 await this.page.waitForURL(/\/dashboard\/privacy/);
 }
 }

 /** Get the companion name input value. */
 async getCompanionName(): Promise<string | null> {
 const input = this.page.locator('input[value="NOVA"], input[type="text"]').first();
 try {
 await input.waitFor({ state: 'visible', timeout: 3_000 });
 return (await input.inputValue()) ?? null;
 } catch {
 return null;
 }
 }

 /** Check that the settings page heading is the companion name "NOVA". */
 async hasCompanionHeading(): Promise<boolean> {
 try {
 await this.heading.first().waitFor({ state: 'visible', timeout: 3_000 });
 const text = (await this.heading.first().textContent())?.trim();
 return text !== null && text.length > 0;
 } catch {
 return false;
 }
 }

 /** Verify a section heading exists on the page. */
 async hasSection(sectionName: string): Promise<boolean> {
 try {
 await this.page.getByText(sectionName).waitFor({ state: 'visible', timeout: 3_000 });
 return true;
 } catch {
 return false;
 }
 }
}
