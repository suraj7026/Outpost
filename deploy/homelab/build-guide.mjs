import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = path => readFileSync(new URL(path, import.meta.url));
const fonts = [
  [400, 'Geist-Regular.ttf'],
  [500, 'Geist-Medium.ttf'],
  [600, 'Geist-Semibold.ttf'],
].map(([weight, name]) => {
  const bytes = read(`../../clients/Shared/Resources/${name}`).toString('base64');
  return `@font-face{font-family:Geist;font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/ttf;base64,${bytes}) format('truetype')}`;
}).join('\n');
const escapeHTML = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const html = read('./guide.template.html').toString()
  .replace('/* FONT_EMBED */', fonts)
  .replace('FONT_LICENSE', escapeHTML(read('../../clients/Shared/Resources/Geist-OFL.txt').toString()));
const output = new URL('./cluster-guide.html', import.meta.url);
writeFileSync(output, html);
console.log(`Built ${fileURLToPath(output)} (${Math.round(Buffer.byteLength(html) / 1024)} KiB; no external assets)`);
