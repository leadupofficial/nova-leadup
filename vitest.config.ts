import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import path from 'node:path';

const repoRoot = path.resolve(__dirname);

// Populate the API package's test environment here, before Vitest imports anything.
//
// `services/api/vitest.config.ts` does this so that API modules which read
// `process.env` at module scope (services/api/src/utils/env.ts, routes/biometric.ts)
// see a complete environment. Running from the repository root used to skip it, so
// the API suites picked up the root `.env` instead — where e.g. `REDIS_URL=` is empty
// and `envSchema.parse` rejects it — and aborted with
// "Invalid url ... path: [REDIS_URL]" before collecting a single test.
//
// Same order, same semantics as the package config: `.env` fills gaps (dotenv does not
// override what is already exported in your shell), then `.env.test` wins so the
// suites stay pointed at the test database.
//
// `dotenv` is deliberately resolved out of `services/api` (the workspace that declares
// it) rather than added as a root dependency.
const apiRequire = createRequire(path.join(repoRoot, 'services/api/package.json'));
const { config: loadEnv } = apiRequire('dotenv') as { config: (options: { path: string; override?: boolean }) => unknown };
loadEnv({ path: path.join(repoRoot, 'services/api/.env') });
loadEnv({ path: path.join(repoRoot, 'services/api/.env.test'), override: true });

export default defineConfig({
 test: {
  globals: true,
  environment: 'node',
  testTimeout: 30_000,
  hookTimeout: 30_000,
  exclude: ['**/node_modules/**', '**/dist/**'],
  // Deliberately NOT `passWithNoTests: true`.
  //
  // With it, `npx vitest run services/api/src/__tests__/typo.test.ts` printed
  // "No test files found, exiting with code 0" — the other half of this config's
  // defect: a root invocation that collected nothing was indistinguishable from a
  // passing one. A path that matches no test file is now an error, so a future change
  // that excludes, renames or fails to collect the API suites cannot report green.
  //
  // The per-package configs keep their own `passWithNoTests`; `turbo run test` and CI
  // use those, not this file.
  coverage: {
   provider: 'v8',
   reporter: ['text', 'json', 'html'],
   exclude: ['node_modules/', 'dist/', '**/*.d.ts', '**/__tests__/', '**/*.test.ts', '**/*.spec.ts'],
  },
  // Declaring `projects` makes this file a container: it collects the projects below
  // and runs no test files of its own, so the per-package settings each package's
  // config relies on can be reproduced for the root invocation.
  projects: [
   {
    // `services/api/vitest.config.ts` runs `src/__tests__/setup.ts` as a setupFile.
    // That file registers the module mocks the API suites depend on
    // (`vi.mock('../services/ai.js')`, `'../db/connection'`, `'../redis'`, ...), and
    // not every suite imports it: src/__tests__/llm-fallback.test.ts calls
    // `vi.mocked(chatCompletion)` with no `vi.mock` of its own, so from the root it
    // failed with "mocked.mockReset is not a function" while passing per-package.
    //
    // A single flat `setupFiles` cannot express that: it would also run the API
    // bootstrap — which imports `../server.js` and mocks the API's database — for
    // every packages/** suite. One project per package scopes it to API files.
    test: {
     name: 'services/api',
     include: ['services/api/src/__tests__/**/*.test.{ts,tsx,js}'],
     setupFiles: ['services/api/src/__tests__/setup.ts'],
    },
   },
   {
    // Everything else the root config covers, with the API files removed (they belong
    // to the project above) and no API setupFile.
    test: {
     name: 'workspace',
     include: ['services/**/src/__tests__/**/*.test.ts', 'packages/**/src/__tests__/**/*.test.ts'],
     exclude: ['**/node_modules/**', '**/dist/**', 'services/api/**'],
    },
   },
  ],
 },
 resolve: {
  alias: {
   '@nova/types': path.join(repoRoot, 'packages/types/src'),
   '@nova/utils': path.join(repoRoot, 'packages/utils/src'),
   '@nova/auth-types': path.join(repoRoot, 'packages/auth-types/src'),
   // Point at the package's built entry, NOT `packages/shared-types/src`.
   //
   // `src/` still contains emitted CommonJS from an older build (`index.js`,
   // `types.js`). Vite resolves a directory alias to `index.js` before `index.ts`,
   // so the alias used to load that stale stub — which has no re-exports at all —
   // and `import { SUPPORTED_LANGUAGES } from '@nova/shared-types'` produced
   // `undefined`. Every API suite then aborted during collection with
   // `TypeError: Cannot read properties of undefined (reading 'map')`
   // (services/api/src/routes/voice.ts) and reported 0 tests.
   //
   // `services/api/vitest.config.ts` deliberately has no alias for this package, so
   // it resolves through the workspace symlink and package.json `exports` →
   // `./dist/index.js`. Aliasing to `dist` makes the root invocation load exactly
   // the same file as `vitest run --root services/api`.
   '@nova/shared-types': path.join(repoRoot, 'packages/shared-types/dist'),
  },
 },
});
