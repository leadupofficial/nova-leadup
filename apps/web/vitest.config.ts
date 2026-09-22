import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.{ts,tsx,js}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
    globals: true,
    environment: 'node',
  },
});
