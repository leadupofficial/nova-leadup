import { defineConfig } from 'vitest/config';

export default defineConfig({
 test: {
 include: ['services/**/src/__tests__/**/*.test.ts', 'packages/**/src/__tests__/**/*.test.ts'],
 exclude: ['**/node_modules/**', '**/dist/**'],
 globals: true,
 environment: 'node',
 coverage: {
 reporter: ['text', 'json', 'html'],
 exclude: ['node_modules/', 'dist/', '**/*.d.ts', '**/__tests__/'],
 },
 },
 resolve: {
 alias: {
 '@nova/types': '/home/paperclip/.paperclip/instances/default/workspaces/9356d596-4b7e-4d3e-b4cb-5a65f2466d71/packages/types/src',
 '@nova/utils': '/home/paperclip/.paperclip/instances/default/workspaces/9356d596-4b7e-4d3e-b4cb-5a65f2466d71/packages/utils/src',
 '@nova/auth-types': '/home/paperclip/.paperclip/instances/default/workspaces/9356d596-4b7e-4d3e-b4cb-5a65f2466d71/packages/auth-types/src',
 },
 },
});
