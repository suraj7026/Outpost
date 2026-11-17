import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Isolated visual proposal: synthetic records, no native bridge or live server.
const output = dirname(fileURLToPath(import.meta.url));
const production = process.argv.includes('--production');
const imagePath = name => resolve(output, `${production ? 'implemented-' : ''}${name}.png`);
const root = resolve(output, '../../desktop/dist');
const epoch = Date.parse('2026-11-16T10:30:00Z');
const row = (kind, id, second, data) => ({ kind, id, revision: 1, updatedAt: new Date(epoch + second * 1000).toISOString(), data: { taskId: 'preview-task', startedAt: epoch + second * 1000, ...data } });
const fixture = {
  snapshot: { cursor: 1, protocolVersion: 1, records: [
    row('task', 'preview-task', 0, { goal: 'Check the development server', profile: 'operations', state: 'completed', model: 'qwen3.5:cloud' }),
    row('policy', 'preview-task', 0, { mode: 'ask_permission' }),
    row('message', 'owner', 1, { author: 'owner', text: 'Check the development server and summarize anything that needs my attention.' }),
    row('message', 'intro', 2, { author: 'assistant', text: 'I’ll check service health, disk usage, and recent logs without making any changes.' }),
    row('action', 'inspect', 3, { tool: 'command.run', state: 'succeeded', arguments: { argv: ['systemctl', '--failed'] }, result: { stdout: '0 loaded units listed.', exitCode: 0 } }),
    row('message', 'summary', 4, { author: 'assistant', text: '## Everything is running normally\n\nThe development server is healthy. No failed services or recent application errors were found.\n\n| Check | Result |\n| --- | --- |\n| Services | All services running |\n| Disk usage | 42% used · 116 GB available |\n| Memory | 6.2 GB of 16 GB in use |\n| Recent logs | No critical errors |\n\nNo action is needed right now. The next scheduled check will run tomorrow morning.\n\n*Sample results for this visual mock—not a live server inspection.*' }),
    row('task', 'preview-old-1', -3600, { taskId: 'preview-old-1', goal: 'Review the deployment logs', profile: 'operations', state: 'completed' }),
    row('task', 'preview-old-2', -7200, { taskId: 'preview-old-2', goal: 'Plan the next release', profile: 'code', state: 'completed' }),
  ] },
  runtime: { configured: true, model: 'qwen3.5:cloud' },
  models: { models: ['qwen3.5:cloud'], defaultModel: 'qwen3.5:cloud' },
};
const light = `
:root, .composer-context, .composer-context-run {
  color-scheme: light;
  --bg: #f1f2f4; --sidebar: #f1f2f4; --surface: #ffffff;
  --raised: #f1f2f4; --active: #e4e6ea; --line: #dde0e5;
  --control: #b9bec7; --text: #24272d; --muted: #5c626d; --subtle: #646b76;
  --positive: #37694b; --warning: #805a1c; --danger: #ad3c36;
  --keyboard-focus-bg: #e2e8f0;
}
.composer-context { background: #e6e8ec; color: var(--text); }
.composer-context .composer-terminal, .composer-connection-label { color: var(--muted); }
.composer-context .composer-terminal:is(:hover, [aria-expanded="true"]), .composer-context .new-task-server > summary:hover { background: #d9dde3; color: var(--text); }
.composer-connection-label.online > span { background: var(--positive); }
`;
const server = createServer((request, response) => {
  const file = resolve(root, new URL(request.url, 'http://local').pathname.slice(1) || 'index.html');
  if (!file.startsWith(root + sep) || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream');
  response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, colorScheme: 'light', reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.addInitScript(fixture => { window.__OUTPOST_RECORDED_PREVIEW__ = fixture; }, fixture);
  await page.goto(origin);
  await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  if (!production) await page.addStyleTag({ content: light });
  await page.waitForTimeout(300);
  await page.locator('.conversation').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: imagePath('conversation') });
  await page.getByRole('button', { name: 'New task', exact: false }).click();
  await page.getByRole('textbox', { name: 'Task goal' }).waitFor();
  await page.screenshot({ path: imagePath('new-task') });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('a[href="#settings/appearance"]').click();
  await page.getByRole('heading', { name: 'Appearance', exact: true, level: 1 }).waitFor();
  await page.screenshot({ path: imagePath('appearance') });
  assert.deepEqual(errors, [], 'No browser runtime errors');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
  console.log('Created conversation.png, new-task.png, appearance.png. No runtime errors. No live connections.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
