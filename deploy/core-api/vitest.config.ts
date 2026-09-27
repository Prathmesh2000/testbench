import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // One shared database: run files one after another so fixtures from different files never interleave.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
