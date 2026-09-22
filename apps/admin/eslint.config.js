/**
 * ESLint flat configuration for apps/admin.
 *
 * Same reasoning as apps/web: `next lint` is deprecated and the retired root
 * `.eslintrc.js` broke it. This app has no local `eslint-config-next`, so it resolves
 * the workspace root's v16 config, which already exports a flat array.
 */
const rootConfig = require('../../eslint.config.js');

module.exports = [
  ...rootConfig,
  ...require('eslint-config-next/core-web-vitals'),
];
