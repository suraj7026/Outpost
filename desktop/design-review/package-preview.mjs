import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
let html = readFileSync(resolve(root, 'build/index.html'), 'utf8');
html = html.replace(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g, (_, path) => {
  const script = readFileSync(resolve(root, 'build', path), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script type="module">${script}</script>`;
});
html = html.replace(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g, (_, path) => `<style>${readFileSync(resolve(root, 'build', path), 'utf8')}</style>`);
const destination = resolve(root, 'Outpost-review.html');
writeFileSync(destination, html);
console.log(`Offline preview: ${destination}`);
