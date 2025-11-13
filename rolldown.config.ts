import { defineConfig } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';

export default defineConfig({
  input: './src/index.ts',
  output: {
    cleanDir: true,
  },
  platform: 'node',
  external: (id) => !id.startsWith('.'),
  plugins: [dts()],
});
