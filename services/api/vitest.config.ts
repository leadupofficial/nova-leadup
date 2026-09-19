import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';

// Populate the test environment here, before Vitest imports anything else.
//
// `setupFiles` is too late: `src/__tests__/setup.ts` imports the Express app,
// and ES import evaluation is hoisted above that file's body, so
// `src/routes/biometric.ts` reads `process.env.JWT_SECRET` before the bootstrap
// can set it — collection then aborts with "JWT_SECRET must be set to a strong
// value in production" before a single test runs, unless the developer happens
// to have exported the variables in their shell. Loading `.env` (for provider
// keys) and then `.env.test` (which wins, so the suite points at a test
// database) makes the suite self-contained.
loadEnv({ path: fileURLToPath(new URL('.env', import.meta.url)) });
loadEnv({ path: fileURLToPath(new URL('.env.test', import.meta.url)), override: true });

export default defineConfig({
 test: {
 include: ['src/__tests__/**/*.test.{ts,tsx,js}'],
 exclude: ['**/node_modules/**', '**/dist/**'],
 passWithNoTests: true,
 globals: true,
 environment: 'node',
 // Vitest's 5s default is too tight for this suite when anything else is using the
 // machine. Two independent runs failed on different tests (recording-pipeline, chat)
 // purely while a build was running alongside, and both passed in isolation and on
 // every unloaded re-run. A flaky suite is worse than a slow one: it teaches people
 // to re-run rather than to read the failure.
 testTimeout: 30000,
 hookTimeout: 30000,
 setupFiles: ['src/__tests__/setup.ts'],
 },
 resolve: {
 alias: {
 '@nova/types': fileURLToPath(new URL('../packages/types/src', import.meta.url)),
 '@nova/utils': fileURLToPath(new URL('../packages/utils/src', import.meta.url)),
 '@nova/auth-types': fileURLToPath(new URL('../packages/auth-types/src', import.meta.url)),
 },
 },
});
