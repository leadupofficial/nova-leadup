import { defineConfig } from 'vitest/config';
import path from 'node:path';

const repoRoot = path.resolve(__dirname);

export default defineConfig({
 test: {
  include: ['services/**/src/__tests__/**/*.test.ts', 'packages/**/src/__tests__/**/*.test.ts'],
  exclude: ['**/node_modules/**', '**/dist/**'],
  passWithNoTests: true,
  globals: true,
  environment: 'node',
  testTimeout: 30_000,
  hookTimeout: 30_000,
  coverage: {
   provider: 'v8',
   reporter: ['text', 'json', 'html'],
   exclude: ['node_modules/', 'dist/', '**/*.d.ts', '**/__tests__/', '**/*.test.ts', '**/*.spec.ts'],
  },
 },
 resolve: {
  alias: {
   '@nova/types': path.join(repoRoot, 'packages/types/src'),
   '@nova/utils': path.join(repoRoot, 'packages/utils/src'),
   '@nova/auth-types': path.join(repoRoot, 'packages/auth-types/src'),
   '@nova/shared-types': path.join(repoRoot, 'packages/shared-types/src'),
  },
 },
});
