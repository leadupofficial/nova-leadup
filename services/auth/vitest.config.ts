import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// `__dirname` is services/auth/, so the repo root is TWO levels up. These aliases
// pointed at ../packages/, i.e. services/packages/, which does not exist — so every
// test importing @nova/auth-types died with "Cannot find module" rather than running.
const repoRoot = resolve(__dirname, '../..');

export default defineConfig({
	test: {
		include: ['src/__tests__/**/*.test.{ts,tsx,js}'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		passWithNoTests: true,
		globals: true,
		environment: 'node',
		// Several suites import src/env.ts, which validates the environment at module
		// load and throws "Required environment variables are not configured". These
		// are test-only values sized to satisfy that schema (JWT/API keys >= 32 chars,
		// AUTH_ENCRYPTION_KEY >= 44 as base64 for 32 bytes); nothing here reaches a
		// real service.
		env: {
			NODE_ENV: 'test',
			PORT: '3001',
			DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/test',
			REDIS_URL: 'redis://127.0.0.1:6379',
			JWT_SECRET: 'test-jwt-secret-that-is-at-least-32-characters-long',
			JWT_REFRESH_SECRET: 'test-refresh-secret-that-is-at-least-32-characters-long',
			API_KEY_SECRET: 'test-api-key-secret-that-is-at-least-32-characters',
			AUTH_ENCRYPTION_KEY: 'MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=',
		},
	},
	resolve: {
		alias: {
			'@nova/types': resolve(repoRoot, 'packages/types/src'),
			'@nova/utils': resolve(repoRoot, 'packages/utils/src'),
			'@nova/auth-types': resolve(repoRoot, 'packages/auth-types/src'),
		},
	},
});

