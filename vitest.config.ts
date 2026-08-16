import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/test-setup.ts'],
    // Integration tests share one PostgreSQL database and truncate between
    // cases, so files must not run concurrently against each other.
    fileParallelism: false,
    // Integration tests touch a real Postgres; keep them serial and give
    // them room beyond the default timeout.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/types.ts'],
    },
  },
});
