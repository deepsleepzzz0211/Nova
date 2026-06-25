import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.tsx'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  sourcemap: true,
  dts: true,
  bundle: true,
  external: ['react', 'react-dom', 'ink'],
});
