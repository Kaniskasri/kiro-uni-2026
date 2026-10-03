import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Vitest config for Lambda unit + property-based tests.
 * Runs from infrastructure/ using its working vitest installation.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Allow lambda src imports to resolve relative to lambda/src
    },
  },
  test: {
    globals: true,
    environment: 'node',
    root: path.resolve(__dirname, '../infrastructure/lambda'),
    include: ['src/__tests__/**/*.test.ts'],
    reporters: ['verbose'],
  },
});
