import { type Page, expect, type Locator } from '@playwright/test';

/**
 * Page Object for the onboarding flow at /onboarding.
 *
 * The onboarding is a multi-step wizard:
 * 1. Welcome — name input + "Get Started"
 * 2. Features — feature cards + "Continue"
 * 3. Voice — voice selector + "Continue"
 * 4. Privacy — privacy level + "Complete Setup"
 * 5. Complete — "Enter NOVA" button
 */
export class OnboardingPage {
 /** Primary heading element on the current step. */
 readonly heading: Locator;
 /** Name input (visible on welcome step). */
 readonly nameInput: Locator;
 /** The "Get Started" / primary CTA button. */
 readonly primaryButton: Locator;
 /** The avatar orb rendered in steps. */
 readonly avatar: Locator;

 constructor(private readonly page: Page) {
 this.heading = page.getByRole('heading', { level: 1 });
 this.nameInput = page.locator('input[type="text"]').first();
 this.primaryButton = page.getByRole('button', { name: /Get Started|Continue|Complete Setup|Enter NOVA/ });
 this.avatar = page.locator('[class*="Avatar"], [class*="avatar"]').first();
 }

 /** Navigate to the onboarding page. */
 async goto(): Promise<void> {
 await this.page.goto('/onboarding');
 await this.page.waitForURL(/\/onboarding/);
 }

 /** Fill in the name field on the welcome step. */
 async enterName(name: string): Promise<void> {
 await this.nameInput.fill(name);
 }

 /** Click the current primary CTA and advance to the next step. */
 async clickPrimaryButton(): Promise<void> {
 await this.primaryButton.click();
 }

 /** Return true when the dashboard is visible (post-onboarding). */
 async isOnDashboard(): Promise<boolean> {
 try {
 await this.page.waitForURL(/\/dashboard/, { timeout: 3_000 });
 return true;
 } catch {
 return false;
 }
 }

 /** Read the greeting text that appears on the dashboard. */
 async getUserGreeting(): Promise<string | null> {
 try {
 const greeting = this.page.locator('h1').first();
 await greeting.waitFor({ state: 'visible', timeout: 3_000 });
 return (await greeting.textContent())?.trim() ?? null;
 } catch {
 return null;
 }
 }

 /** Complete the entire onboarding wizard in one call. */
 async completeOnboarding(name: string): Promise<void> {
 await this.goto();
 await this.page.waitForLoadState('networkidle');

 // Step 1: Welcome
 await expect(this.heading).toContainText('NOVA');
 await this.enterName(name);
 await this.clickPrimaryButton();

 // Step 2: Features
 await this.page.waitForTimeout(400); // framer-motion transition
 await expect(this.page.getByRole('heading', { level: 2 })).toContainText('What NOVA can do');
 await this.clickPrimaryButton();

 // Step 3: Voice
 await this.page.waitForTimeout(400);
 await this.clickPrimaryButton();

 // Step 4: Privacy
 await this.page.waitForTimeout(400);
 await this.clickPrimaryButton();

 // Step 5: Complete
 await this.page.waitForTimeout(400);
 await this.clickPrimaryButton();

 // Should redirect to dashboard
 await this.page.waitForURL(/\/dashboard/);
 }
}
