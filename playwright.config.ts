import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration for Nova Leadup.
 *
 * Base URLs are set via environment variables so CI can override them.
 * Defaults assume docker-compose.e2e.override.yml ports.
 */
export default defineConfig({
 testDir: './tests',
 fullyParallel: true,
 forbidOnly: !!process.env.CI,
 retries: process.env.CI ? 2 : 0,
 workers: process.env.CI ? 1 : undefined,
 reporter: [
 [ 'html', { open: 'never' }],
 [ 'list' ],
 ],
 use: {
 baseURL: process.env.WEB_URL || 'http://localhost:3000',
 trace: 'on-first-retry',
 screenshot: 'only-on-failure',
 video: 'retain-on-failure',
 },
 projects: [
 {
 name: 'chromium',
 use: { ...devices['Desktop Chrome'] },
 },
 // Uncomment when API tests don't need a browser:
 // {
 // name: 'api',
 // use: { ...devices['Desktop Chrome'] },
 // grep: /@api/,
 // },
 ],
});
