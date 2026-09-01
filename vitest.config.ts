import { defineConfig } from 'vitest/config';

const isCI = process.env.CI === 'true';

export default defineConfig({
  resolve: {
    // In CI, test files will import the built plugin to validate the published package.
    // Locally, alias the plugin to the source code for easier debugging.
    alias: isCI ? undefined : { 'ecij/plugin': './src/index.ts' },
  },
  test: {
    dir: 'test',
    include: ['./**/*.test.*'],
    coverage: {
      enabled: true,
    },
    sequence: {
      shuffle: true,
    },
    printConsoleTrace: false,
  },
});
