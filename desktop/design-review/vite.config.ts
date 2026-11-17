import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  esbuild: { jsx: 'automatic' },
  build: { outDir: 'build', emptyOutDir: true, assetsInlineLimit: 2_000_000, modulePreload: false },
});
