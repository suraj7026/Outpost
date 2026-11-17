import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const output = fileURLToPath(new URL('./', import.meta.url));
const server = createServer((request, response) => {
  const path = resolve(root, '.' + new URL(request.url, 'http://local').pathname);
  if (!path.startsWith(root + sep)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('content-type', { '.html': 'text/html', '.woff2': 'font/woff2' }[extname(path)] || 'application/octet-stream');
    response.end(readFileSync(path));
  } catch { response.writeHead(404).end(); }
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1140 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(`${origin}/mock/chat-activity/index.html`);
  await page.evaluate(() => document.fonts.ready);
  const centered = await page.evaluate(() => {
    const chat = document.querySelector('.conversation').getBoundingClientRect();
    const image = document.querySelector('.media').getBoundingClientRect();
    return Math.abs(chat.x + chat.width / 2 - image.x - image.width / 2) < 1;
  });
  assert.ok(centered, 'Image card must be centered in conversation');
  assert.equal(await page.locator('#tool-stack .step').count(), 5);
  await page.screenshot({ path: resolve(output, 'overview.png'), fullPage: true });
  await page.locator('.workspace').screenshot({ path: resolve(output, 'live.png') });
  await page.getByRole('button', { name: 'Expanded step', exact: true }).click();
  assert.ok(await page.locator('#capture-step').evaluate(node => node.open), JSON.stringify({ errors, mode: await page.locator('body').getAttribute('data-mode') }));
  await page.locator('.activity').screenshot({ path: resolve(output, 'expanded.png') });
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  assert.ok(await page.locator('#tool-stack').isHidden());
  await page.locator('.conversation').screenshot({ path: resolve(output, 'completed.png') });
  await page.getByRole('button', { name: /5 actions completed/ }).click();
  assert.ok(await page.locator('#tool-stack').isVisible());
  await page.getByRole('button', { name: 'Enlarge illustrative capture' }).click();
  assert.ok(await page.getByRole('dialog').isVisible());
  await page.keyboard.press('Escape');
  assert.ok(await page.getByRole('dialog').isHidden());
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.getByRole('button', { name: 'During a run', exact: true }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
  await page.screenshot({ path: resolve(output, 'narrow.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Mock verified: centered media, expandable rows, completed summary, image preview, narrow layout. No app files modified.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
