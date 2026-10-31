import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium, webkit } from 'playwright';

const root = resolve('desktop/dist'), types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const server = createServer((req, res) => {
  const path = resolve(root, new URL(req.url, 'http://local').pathname.slice(1) || 'index.html');
  if (!path.startsWith(root + '/') || !existsSync(path)) { res.writeHead(404).end(); return; }
  res.setHeader('content-type', types[extname(path)] || 'application/octet-stream'); res.end(readFileSync(path));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch(); let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const row = (kind, id, minute, data) => ({ kind, id, revision: 1, updatedAt: `2026-10-31T05:${String(minute).padStart(2, '0')}:00Z`, data: { taskId: 'fixture-task', ...data } });
const records = [
  row('task', 'fixture-task', 0, { goal: 'Review the execution evidence', profile: 'code', state: 'verifying' }),
  row('policy', 'fixture-task', 0, { mode: 'ask_permission' }),
  row('tool_stream', 'old-command', 1, { name: 'outpost_action', state: 'error', streaming: false, actionId: null, arguments: { tool: 'command.run', arguments: { command: 'pwd' } }, output: '' }),
  row('tool_stream', 'old-write', 2, { name: 'outpost_action', state: 'error', streaming: false, actionId: null, arguments: { tool: 'file.write', arguments: { path: 'MEMORY.md', text: 'Large old attempt\n'.repeat(300) } }, output: 'invalid_tool_arguments: expectedHash is required.' }),
  row('action', 'command-success', 3, { state: 'succeeded', tool: 'command.run', arguments: { argv: ['/bin/pwd'], cwd: '.' }, result: { exitCode: 0, stdout: '/synthetic/workspace' } }),
  row('tool_stream', 'linked-command', 3, { state: 'finished', streaming: false, actionId: 'command-success', arguments: { tool: 'command.run', arguments: { argv: ['/bin/pwd'] } } }),
  row('action', 'nonzero', 4, { state: 'succeeded', tool: 'command.run', arguments: { argv: ['/bin/false'] }, result: { exitCode: 1 } }),
  row('action', 'write-success', 5, { state: 'succeeded', tool: 'file.write', arguments: { path: 'MEMORY.md', text: 'Verified note', expectedHash: null }, result: { path: 'MEMORY.md', hash: 'synthetic-hash' } }),
];
try {
  mkdirSync('/tmp/outpost-execution-evidence', { recursive: true });
  for (const scheme of ['dark', 'light']) for (const width of [1440, 900, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(records => {
      window.isTauri = true; window.__mutations = [];
      window.__TAURI_INTERNALS__ = { transformCallback: () => 1, unregisterCallback() {}, async invoke(command, args) {
        if (command === 'set_sidebar_window_controls') return;
        if (command === 'sidebar_pointer_inside') return false;
        if (command === 'connection_info') return { endpoint: 'Synthetic transport', deviceId: 'fixture', pending: false, nativeSidebar: false };
        if (command === 'query') {
          if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 1, records };
          if (args.kind === 'runtime') return { configured: true, model: 'fixture:cloud' };
          if (args.kind === 'models') return { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' };
          if (args.kind === 'events') return { events: [], nextCursor: 1, hasMore: false };
        }
        if (command === 'stream_events') return new Promise(() => {});
        if (command.startsWith('plugin:')) return;
        window.__mutations.push(command); throw new Error('Unexpected mutation');
      } };
    }, records);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
    if (width <= 780) await page.getByRole('button', { name: /^Evidence \(/ }).click();
    check(await page.getByText('2 failed tool attempts recorded.', { exact: false }).isVisible(), 'Overview retains a count without presenting old errors as current activity');
    check(await page.locator('.live-tool').count() === 0, 'Settled failed attempts are not live tools in Overview');
    check(await page.locator('.handoff-spine').getByRole('img', { name: 'Succeeded', exact: true }).count() === 2, 'Overview also shows accessible success dots');
    check(await page.locator('.handoff-spine').getByRole('img', { name: 'Needs review', exact: true }).count() === 1, 'Overview retains the nonzero exit as a review dot');
    check(await page.locator('.handoff-step small').count() === 0, 'Settled overview outcomes have no text badges');
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    const ordered = await page.locator('#evidence-panel .action').evaluateAll(nodes => nodes.map(n => n.dataset.recordId));
    assert.deepEqual(ordered, ['write-success', 'nonzero', 'command-success', 'old-write', 'old-command']); checks++;
    check(await page.locator('[data-record-id="write-success"]').getByRole('img', { name: 'Succeeded', exact: true }).isVisible(), 'Success dot has an accessible outcome');
    check(await page.locator('[data-record-id="nonzero"]').getByRole('img', { name: 'Needs review', exact: true }).isVisible(), 'Nonzero exit is never shown as success');
    check(await page.locator('[data-record-id="old-write"]').getByRole('img', { name: 'Failed attempt', exact: true }).isVisible(), 'Historical failures are not rewritten');
    check((await page.locator('#evidence-panel .action-state').allTextContents()).every(text => text.trim() === ''), 'Settled status is only a dot, without visible outcome labels');
    check(await page.locator('[data-record-id="write-success"] .outcome-dot').getAttribute('title') === 'Succeeded', 'Hover reveals outcome');
    check(await page.locator('[data-record-id="write-success"] .outcome-dot').evaluate(el => {
      const expected = document.createElement('span'); expected.style.background = 'var(--positive)'; el.append(expected);
      const matches = getComputedStyle(el).backgroundColor === getComputedStyle(expected).backgroundColor;
      expected.remove(); return matches;
    }), 'Success dot is green');
    check(await page.locator('.live-tool[open]').count() === 0, 'Historical argument dumps start collapsed');
    check(await page.locator('[data-record-id="linked-command"]').count() === 0, 'Linked action and tool stream are deduplicated');
    check(await page.locator('#evidence-panel time').count() === 5, 'Each outcome has a timestamp');
    const old = page.locator('[data-record-id="old-write"]');
    await old.locator('summary').focus(); await page.keyboard.press('Enter');
    check(await old.getByText('invalid_tool_arguments: expectedHash is required.', { exact: true }).isVisible(), 'Keyboard disclosure reveals the recorded explanation');
    check(await old.locator('.outcome-dot').evaluate(el => {
      const expected = document.createElement('span'); expected.style.background = 'var(--danger)'; el.append(expected);
      const matches = getComputedStyle(el).backgroundColor === getComputedStyle(expected).backgroundColor;
      expected.remove(); return matches;
    }), 'Failed attempt dot is red');
    check(await old.locator('.outcome-dot').evaluate(el => getComputedStyle(el).backgroundColor) === await page.locator('[data-record-id="nonzero"] .outcome-dot').evaluate(el => getComputedStyle(el).backgroundColor), 'Nonzero exit uses the same red dot');
    await old.locator('summary').click();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    check(await page.evaluate(() => __mutations.length) === 0, 'Viewing history never retries commands');
    check(errors.length === 0, errors.join('\n'));
    await page.screenshot({ path: `/tmp/outpost-execution-evidence/${engine.name()}-${width}-${scheme}.png` });
    await page.close();
  }
  console.log(`${checks} execution evidence checks passed (${engine.name()})`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
