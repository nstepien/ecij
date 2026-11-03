import { defineConfig } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';

export default defineConfig({
  input: './src/index.ts',
  output: {
    cleanDir: true,
    // Lets coverage report src/index.ts lines when CI tests the build
    sourcemap: true,
  },
  platform: 'node',
  treeshake: {
    moduleSideEffects: false,
    propertyReadSideEffects: false,
    propertyWriteSideEffects: false,
    unknownGlobalSideEffects: false,
  },
  external: (id) => !id.startsWith('.'),
  plugins: [
    dts({
      sourcemap: true,
      tsconfig: 'tsconfig.src.json',
    }),
  ],
});
