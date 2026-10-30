import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Explicit, read-only preview input. No fixtures or credentials ship in the application.
const root = dirname(fileURLToPath(import.meta.url));
const input = process.argv[2];
if (!input) throw new Error('Usage: node desktop/test-ui.mjs /path/to/recorded-preview.json');
const preview = JSON.parse(readFileSync(input, 'utf8'));
assert.ok(preview.snapshot.records && preview.runtime && preview.models);
const out = '/tmp/outpost-desktop-ui'; mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const server = createServer((req, res) => {
  const path = resolve(root, 'dist', new URL(req.url, 'http://local').pathname.slice(1) || 'index.html');
  if (!path.startsWith(resolve(root, 'dist') + '/') || !existsSync(path)) { res.writeHead(404); res.end(); return; }
  res.setHeader('content-type', types[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
let checks = 0;
try {
  const address = `http://127.0.0.1:${server.address().port}`;
  for (const [width, height] of [[1440, 900], [1050, 800], [768, 1024], [390, 844]]) {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme: 'dark' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => { window.__OUTPOST_RECORDED_PREVIEW__ = value; }, preview);
    await page.goto(address); await page.getByText('Recorded server preview', { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'What should run next?' }).waitFor(); checks++;
    assert.equal(await page.locator('.session-row').count(), Math.min(8, preview.snapshot.records.filter(record => record.kind === 'task').length)); checks++;
    assert.equal(await page.getByRole('combobox', { name: 'Control mode', exact: true }).inputValue(), 'full_control'); checks++;
    assert.ok(await page.getByRole('button', { name: 'Start task', exact: true }).isDisabled()); checks++;
    await page.screenshot({ path: `${out}/home-${width}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); checks++;
    if (await page.locator('.session-row').count()) {
      await page.locator('.session-row').first().click(); await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor(); checks++;
      if (width <= 780) await page.getByRole('button', { name: /^Evidence \(/ }).click();
      await page.getByRole('heading', { name: 'Execution evidence' }).waitFor(); checks++;
      await page.screenshot({ path: `${out}/task-${width}.png`, fullPage: true });
    }
    if (width <= 590) await page.getByRole('button', { name: 'Toggle navigation' }).click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Servers', exact: true }).click();
    await page.getByRole('heading', { name: 'Your servers' }).waitFor(); checks++;
    assert.equal(await page.locator('.server-row').count(), 2); checks++;
    await page.getByRole('button', { name: 'Connection settings' }).click();
    await page.getByRole('textbox', { name: 'Server URL' }).waitFor(); checks++;
    assert.equal(errors.length, 0, errors.join('\n')); checks++;
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, colorScheme: 'light' });
  await page.addInitScript(value => { window.__OUTPOST_RECORDED_PREVIEW__ = value; }, preview);
  await page.goto(address); await page.getByRole('heading', { name: 'What should run next?' }).waitFor();
  await page.screenshot({ path: `${out}/home-light.png` });
  const background = await page.locator('html').evaluate(element => getComputedStyle(element).backgroundColor);
  assert.equal(background, 'rgb(250, 250, 250)'); checks++;
  await page.getByRole('textbox', { name: 'Task goal' }).fill('Read-only preview must never dispatch a real command.');
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Read-only recorded preview' }).waitFor(); checks++;
  await page.close();
  const offline = await browser.newPage(); await offline.goto(address);
  await offline.getByRole('alert').filter({ hasText: 'Open the installed Outpost Desktop app' }).waitFor(); checks++;
  assert.ok(await offline.getByRole('button', { name: 'Start task', exact: true }).isDisabled()); checks++;
  console.log(`${checks} UI checks passed. Recorded-data screenshots: ${out}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
