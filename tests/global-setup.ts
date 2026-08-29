import { chromium } from 'playwright';
import http from 'http';
import { execSync } from 'child_process';

export default async function globalSetup(): Promise<void> {
 // Reset the test database before the first test runs.
 // This ensures a clean slate for E2E tests.
 try {
 // Run migrations on the e2e database
 execSync('DATABASE_URL=postgres://postgres:postgres@localhost:5433/nova_test REDIS_URL=redis://localhost:6380 pnpm --filter @nova/auth run db:migrate', {
 cwd: process.cwd(),
 stdio: 'pipe',
 timeout: 30_000,
 });
 } catch {
 // Database may not be running yet (global-setup runs before docker-compose up).
 // The test environment script handles migration.
 }
}
