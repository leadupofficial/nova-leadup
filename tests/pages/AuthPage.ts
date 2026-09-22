import { type Page, expect, type Locator } from '@playwright/test';

export class AuthPage {
 readonly emailInput: Locator;
 readonly passwordInput: Locator;
 readonly nameInput: Locator;
 readonly submitButton: Locator;

 constructor(private readonly page: Page) {
 this.emailInput = page.getByPlaceholder(/email/i);
 this.passwordInput = page.getByPlaceholder(/password/i);
 this.nameInput = page.getByPlaceholder(/name/i);
 this.submitButton = page.getByRole('button', { name: /Sign in|Log in|Sign up|Register/ });
 }

 async gotoLogin(): Promise<void> {
 await this.page.goto('/login');
 await this.page.waitForURL(/\/login/);
 }

 async gotoRegister(): Promise<void> {
 await this.page.goto('/register');
 await this.page.waitForURL(/\/register/);
 }

 async login(email: string, password: string): Promise<void> {
 await this.emailInput.fill(email);
 await this.passwordInput.fill(password);
 await this.submitButton.click();
 }

 async register(name: string, email: string, password: string): Promise<void> {
 await this.nameInput.fill(name);
 await this.emailInput.fill(email);
 await this.passwordInput.fill(password);
 await this.submitButton.click();
 }

 async logout(): Promise<void> {
 await this.page.evaluate(() => localStorage.clear());
 await this.page.goto('/');
 }

 async isLoggedIn(): Promise<boolean> {
 const hasToken = await this.page.evaluate(() => !!localStorage.getItem('nova-access-token'));
 const hasOnboarded = await this.page.evaluate(() => localStorage.getItem('nova-onboarding-complete') === 'true');
 return hasToken && hasOnboarded;
 }
}
