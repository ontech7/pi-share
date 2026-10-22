import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/server/**', 'src/shared/**'],
      exclude: ['src/server/bin/**'],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: { statements: 85, branches: 72, functions: 85, lines: 88 },
    },
  },
});
