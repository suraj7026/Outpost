import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(root, '../../desktop');
const require = createRequire(resolve(desktop, 'package.json'));
const { build } = await import(require.resolve('vite'));
const outDir = resolve(root, '.build');
await build({ configFile: false, root: desktop, logLevel: 'warn', define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: { outDir, emptyOutDir: true, cssCodeSplit: false, lib: { entry: resolve(root, 'entry.js'), name: 'OutpostConsistencyPreview', formats: ['iife'], fileName: () => 'app.js' } },
});
const css = readdirSync(outDir).filter(name => name.endsWith('.css')).map(name => readFileSync(resolve(outDir, name), 'utf8')).join('\n');
const js = readFileSync(resolve(outDir, 'app.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
writeFileSync(resolve(root, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Outpost — Consistent workspace preview</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`);
console.log('Built offline actual-app preview: mock/workspace-consistency/index.html');
