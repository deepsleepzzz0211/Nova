import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { version: string };

export default defineConfig({
  entry: ['src/index.tsx'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  sourcemap: true,
  dts: true,
  bundle: true,
  external: ['react', 'react-dom', 'ink'],
  define: {
    __NOVA_VERSION__: JSON.stringify(pkg.version),
  },
});
