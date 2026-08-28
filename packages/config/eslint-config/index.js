const base = require('@eslint/js');
const tseslint = require('typescript-eslint');
const eslintConfigPrettier = require('eslint-config-prettier');
const eslintPluginPrettier = require('eslint-plugin-prettier');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
 base.configs.recommended,
 ...tseslint.configs.recommended,
 eslintConfigPrettier,
 {
 plugins: {
 prettier: eslintPluginPrettier,
 },
 languageOptions: {
 parser: tseslint.parser,
 parserOptions: {
 ecmaVersion: 2024,
 sourceType: 'module',
 },
 },
 rules: {
 'prettier/prettier': 'error',
 '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
 '@typescript-eslint/explicit-module-boundary-types': 'off',
 '@typescript-eslint/no-explicit-any': 'warn',
 },
 },
 {
 ignores: ['node_modules/**', 'dist/**', 'build/**', '.next/**', 'coverage/**'],
 },
];
