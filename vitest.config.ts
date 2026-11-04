import { defineConfig } from 'vitest/config';

const isCI = process.env.CI === 'true';

export default defineConfig({
  resolve: {
    // In CI, test files will import the built plugin to validate the published package.
    // Locally, alias the plugin to the source code for easier debugging.
    alias: isCI ? undefined : { 'ecij/plugin': import.meta.resolve('./src/index.ts') },
  },
  test: {
    dir: 'test',
    injectCjsGlobals: false,
    include: ['./**/*.test.*'],
    coverage: {
      enabled: true,
    },
    sequence: {
      shuffle: true,
    },
    printConsoleTrace: true,
  },
});
