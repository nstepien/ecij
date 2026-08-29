import { defineConfig } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';

export default defineConfig({
  input: './src/index.ts',
  output: {
    cleanDir: true,
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
      build: true,
      tsconfig: 'tsconfig.src.json',
    }),
  ],
});
