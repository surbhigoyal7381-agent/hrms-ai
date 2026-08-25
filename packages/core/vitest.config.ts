import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    // Integration tests share a Postgres instance and create/drop databases.
    // Running files in parallel makes them fight over the same database names.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
