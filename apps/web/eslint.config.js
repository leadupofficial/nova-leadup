/**
 * ESLint flat configuration for apps/web.
 *
 * `next lint` is deprecated in Next 16 and crashed here with "Converting circular
 * structure to JSON" while it tried to serialize the retired root `.eslintrc.js`.
 * The monorepo is on flat config now, so this app lints through the ESLint CLI and
 * layers Next's `core-web-vitals` rules on top of the shared root config.
 *
 * This app pins `eslint-config-next@15`, whose `core-web-vitals` entry is still a
 * legacy `.eslintrc`-style object; `FlatCompat` is the supported bridge for it.
 * (apps/admin resolves the root's v16 config, which is already flat and needs no
 * translation — see its own config.)
 */
const { FlatCompat } = require('@eslint/eslintrc');
const rootConfig = require('../../eslint.config.js');

const compat = new FlatCompat({ baseDirectory: __dirname });

module.exports = [
  ...rootConfig,
  ...compat.extends('next/core-web-vitals'),
];
