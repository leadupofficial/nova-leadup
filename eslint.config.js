/**
 * NOVA-Leadup — ESLint flat configuration (ESLint 9).
 *
 * The repository previously pinned only `.eslintrc.js`, which ESLint 9 no longer
 * reads: every `eslint src/` task failed with "couldn't find an
 * eslint.config.(js|mjs|cjs) file", and `next lint` crashed trying to serialize the
 * legacy config ("Converting circular structure to JSON"). This file is the flat
 * equivalent of that legacy config, so the root `pnpm run lint` task works again.
 *
 * It is discovered by walking up from each workspace package, so the per-package
 * `eslint src/` scripts all use it without further wiring. The two Next.js apps add
 * their own `eslint.config.js` on top to pull in `next/core-web-vitals`.
 */
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

/** Build output, generated code, and things that are not ours to lint. */
const IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/.turbo/**',
  '**/playwright-report/**',
  '**/test-results/**',
  // The Flutter app is analysed by `flutter analyze`, not ESLint. Its `android/`
  // tree contains generated Gradle/Kotlin/Java output.
  'apps/mobile/android/**',
  'apps/mobile/ios/**',
  'apps/mobile/build/**',
  'apps/mobile/.dart_tool/**',
  // Dead Expo/React Native leftovers in apps/mobile are not built (see CLAUDE.md).
  'apps/mobile/app/**',
  'apps/mobile/src/**',
  // Vendored/third-party JS that we do not own.
  '**/*.min.js',
];

/**
 * Minimal Node globals. `typescript-eslint` turns `no-undef` off for TypeScript
 * files (the compiler already checks it), so this only covers plain `.js` files
 * such as configs and scripts. Kept inline rather than pulling in `globals`,
 * which is not a declared dependency of this repository.
 */
const NODE_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  global: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  performance: 'readonly',
};

module.exports = [
  { ignores: IGNORES },

  js.configs.recommended,

  ...tseslint.configs.recommended,

  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: {
      // Carried over from the retired `.eslintrc.js`, except that
      // `no-explicit-any` is a warning rather than an error. The legacy config never
      // ran (ESLint 9 could not read it), so the ~127 existing `any`s were never
      // surfaced; making them hard errors now would block `pnpm run lint` on
      // pre-existing code rather than on anything new. They stay visible as warnings.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],

      // The codebase predates the recommended set and uses these deliberately in
      // boundary layers. Downgraded rather than disabled so they stay visible.
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-namespace': 'warn',

      // `no-undef` is off for TypeScript via typescript-eslint; this keeps plain
      // JS honest without flagging TS type-only references.
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
    },
  },

  {
    // Test files may reach for `any` and stub helpers freely.
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/__tests__/**/*.ts', '**/__tests__/**/*.tsx', '**/test/**/*.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-this-alias': 'off',
    },
  },
];
