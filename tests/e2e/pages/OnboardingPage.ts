import { type Page, expect, type Locator } from '@playwright/test';

/**
 * Page Object for the onboarding wizard at /onboarding.
 *
 * The onboarding is a 5-step animated flow:
 * 1. Welcome — name input + "Get Started"
 * 2. Features — feature cards + "Continue"
 * 3. Voice — voice selector + "Continue"
 * 4. Privacy — privacy level + "Complete Setup"
 * 5. Complete — "Enter NOVA" button
 */
export class OnboardingPage {
 readonly heading: Locator;
 readonly nameInput: Locator;
 readonly primaryButton: Locator;

 constructor(private readonly page: Page) {
 this.heading = page.getByRole('heading', { level: 1 });
 this.nameInput = page.locator('input[type="text"]').first();
 this.primaryButton = page.getByRole('button', {
 name: /Get Started|Continue|Complete Setup|Enter NOVA/,
 });
 }

 /** Navigate to /onboarding and wait for it to load. */
 async goto(): Promise<void> {
 await this.page.goto('/onboarding');
 await this.page.waitForURL(/\/onboarding/);
 await this.page.waitForLoadState('networkidle');
 }

 /** Fill in the name field on the welcome step. */
 async enterName(name: string): Promise<void> {
 await this.nameInput.fill(name);
 }

 /** Click the primary CTA button to advance. */
 async clickPrimaryButton(): Promise<void> {
 await this.primaryButton.click();
 }

 /** Wait for the URL to change to /dashboard. Returns true on success. */
 async isOnDashboard(): Promise<boolean> {
 try {
 await this.page.waitForURL(/\/dashboard/, { timeout: 3_000 });
 return true;
 } catch {
 return false;
 }
 }

 /** Read the greeting text on the dashboard. */
 async getUserGreeting(): Promise<string | null> {
 try {
 const greeting = this.page.locator('h1').first();
 await greeting.waitFor({ state: 'visible', timeout: 3_000 });
 return (await greeting.textContent())?.trim() ?? null;
 } catch {
 return null;
 }
 }

 /**
 * Walk through the entire onboarding wizard and land on /dashboard.
 * @param name — the name to enter on step 1
 */
 async completeOnboarding(name: string): Promise<void> {
 await this.goto();

 // Step 1: Welcome
 await expect(this.heading).toContainText('NOVA');
 await this.enterName(name);
 await this.clickPrimaryButton();

 // Step 2: Features
 await this.page.waitForTimeout(500);
 const featuresHeading = this.page.getByRole('heading', { level: 2, name: /What NOVA can do/ });
 await expect(featuresHeading).toBeVisible({ timeout: 5_000 });
 await this.clickPrimaryButton();

 // Step 3: Voice
 await this.page.waitForTimeout(500);
 await this.clickPrimaryButton();

 // Step 4: Privacy
 await this.page.waitForTimeout(500);
 await this.clickPrimaryButton();

 // Step 5: Complete
 await this.page.waitForTimeout(500);
 await this.clickPrimaryButton();

 // Should redirect to dashboard
 await this.page.waitForURL(/\/dashboard/, { timeout: 10_000 });
 }
}
