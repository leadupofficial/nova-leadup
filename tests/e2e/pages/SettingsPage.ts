import { type Page, expect, type Locator } from '@playwright/test';

export class SettingsPage {
 readonly heading: Locator;
 readonly voiceSection: Locator;
 readonly memorySection: Locator;

 constructor(private readonly page: Page) {
 this.heading = page.getByRole('heading', { level: 1 });
 this.voiceSection = page.getByText('Voice & Language');
 this.memorySection = page.getByText('Memory');
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

 /** Read the speed label text (e.g. "Speech Speed: 1.5x"). */
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
 const labelMap: Record<string, string> = { short: 'Brief', medium: 'Standard', long: 'Detailed' };
 const button = this.page.getByRole('button', { name: labelMap[length] });
 await button.click();
 }

 /** Navigate to the Privacy Center via link. */
 async navigateToPrivacyCenter(): Promise<void> {
 const link = this.page.getByText('Privacy Center');
 if (await link.count()) {
 await link.click();
 await this.page.waitForURL(/\/dashboard\/privacy/);
 }
 }

 /** Get the companion name input value. */
 async getCompanionName(): Promise<string | null> {
 const input = this.page.locator('input[type="text"]').first();
 try {
 await input.waitFor({ state: 'visible', timeout: 3_000 });
 return (await input.inputValue()) ?? null;
 } catch {
 return null;
 }
 }

 /** Verify the settings page heading is the companion name. */
 async hasCompanionHeading(): Promise<boolean> {
 try {
 await this.heading.first().waitFor({ state: 'visible', timeout: 3_000 });
 return true;
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
