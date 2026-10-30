import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium, webkit } from 'playwright';

const root = resolve('desktop/dist');
const server = createServer((request, response) => {
  const file = resolve(root, new URL(request.url, 'http://local').pathname.slice(1) || 'index.html');
  if (!file.startsWith(root + '/') || !existsSync(file)) { response.writeHead(404).end(); return; }
  response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' }[extname(file)] || 'application/octet-stream');
  response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
const row = (kind, id, data, updatedAt = '2026-10-30T12:00:00Z') => ({ kind, id, data, updatedAt, revision: 1 });
const longText = '## Host inspection\n\n' + Array.from({ length: 80 }, (_, i) => `### Recorded section ${i + 1}\n\nRead-only inspection evidence.\n\n\`\`\`text\n${'host memory cpu disk output\n'.repeat(5)}\`\`\`\n`).join('\n');
const fixture = { snapshot: { cursor: 1, protocolVersion: 1, records: [
  row('task', 'main-task', { goal: 'Read-only host inspection', profile: 'operations', state: 'running' }),
  row('message', 'long-message', { taskId: 'main-task', author: 'assistant', text: longText, thinking: 'Recorded reasoning.\n'.repeat(100) }),
  ...Array.from({ length: 20 }, (_, i) => row('task', `task-${i}`, { goal: `Previous inspection ${i}`, profile: 'operations', state: 'completed' }, '2026-10-29T12:00:00Z')),
  ...Array.from({ length: 30 }, (_, i) => row('artifact', `artifact-${i}`, { taskId: 'main-task', name: `Inspection report ${i}.txt`, mime: 'text/plain', hash: 'fixture' })),
] }, runtime: { model: 'fixture:cloud' }, models: { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' } };
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const errors = [];
const frame = page => page.evaluate(() => {
  const selectors = ['html', 'body', '#root', '.app-shell', '.main-shell', '.task-view', '.task-columns', '.conversation-column', '.web-sidebar'];
  const locked = Object.fromEntries(selectors.map(selector => {
    const node = document.querySelector(selector);
    return [selector, [node.scrollLeft, node.scrollTop]];
  }));
  const bounds = selector => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value * 100) / 100);
  };
  return { locked, window: [scrollX, scrollY], header: bounds('.task-heading'), composer: bounds('.reply-composer'), brand: bounds('.brand'), footer: bounds('.sidebar-bottom'), main: bounds('.main-shell') };
});
async function assertLocked(page, label, initial) {
  const current = await frame(page);
  check(current.window.every(value => value === 0), `${label}: window never scrolls`);
  check(Object.values(current.locked).every(values => values.every(value => value === 0)), `${label}: layout containers never scroll: ${JSON.stringify(current.locked)}`);
  if (initial) for (const name of ['header', 'composer', 'brand', 'footer', 'main']) {
    assert.deepEqual(current[name], initial[name], `${label}: ${name} stays fixed`); checks++;
  }
  return current;
}
async function wheel(page, selector, delta) {
  const rect = await page.locator(selector).boundingBox();
  await page.mouse.move(rect.x + Math.min(40, rect.width / 2), rect.y + Math.min(40, rect.height / 2));
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(120);
}
try {
  for (const width of [1440, 900, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 900 ? 600 : 900 }, colorScheme: 'dark' });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ fixture }) => {
      const callbacks = new Map(); let sequence = 0, channel, index = 0;
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = {
        transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; }, unregisterCallback(id) { callbacks.delete(id); },
        async invoke(command, args) {
          if (command === 'set_sidebar_window_controls') return;
          if (command === 'sidebar_pointer_inside') return false;
          if (command === 'connection_info') return { endpoint: 'Synthetic transport', deviceId: 'fixture', publicKey: '', pending: false, nativeSidebar: false };
          if (command === 'query') return args.kind === 'events' ? { events: [], hasMore: false, nextCursor: 1 } : structuredClone(fixture[args.kind]);
          if (command === 'stream_events') { channel = args.channel; return new Promise(() => {}); }
          throw new Error(`Unexpected mutation: ${command}`);
        },
      };
      window.__emit = message => callbacks.get(channel.id)({ index: index++, message });
    }, { fixture });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('textbox', { name: 'Message Outpost' }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    const containment = await page.evaluate(() => ({
      rootPosition: getComputedStyle(document.querySelector('#root')).position,
      documentOverscroll: getComputedStyle(document.documentElement).overscrollBehavior,
      mainOverflow: getComputedStyle(document.querySelector('.main-shell')).overflow,
      paneOverscroll: getComputedStyle(document.querySelector('.conversation')).overscrollBehavior,
    }));
    check(containment.rootPosition === 'fixed', 'App root is anchored to the viewport');
    check(containment.documentOverscroll === 'none', 'WebKit document rubber-banding is disabled');
    check(containment.mainOverflow === 'clip', 'Workspace cannot be scrolled by focus or scrollIntoView');
    check(containment.paneOverscroll === 'contain', 'Pane wheel events do not chain to the document');
    let initial = await assertLocked(page, `${width} initial tail follow`);
    check(initial.main[1] === (width <= 780 ? 8 : 12), `${width}: top inset survives automatic tail follow`);
    check(await page.locator('.conversation').evaluate(node => node.scrollHeight > node.clientHeight), 'Long conversation really overflows its pane');
    await wheel(page, '.task-heading', 1000);
    await assertLocked(page, `${width} header wheel`, initial);
    await page.locator('.conversation').evaluate(node => { node.scrollTop = 0; });
    await wheel(page, '.conversation', 500);
    check(await page.locator('.conversation').evaluate(node => node.scrollTop > 0), 'Conversation independently scrolls');
    await assertLocked(page, `${width} conversation wheel`, initial);
    await page.locator('.conversation').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await wheel(page, '.conversation', 1500);
    await assertLocked(page, `${width} conversation end overscroll`, initial);
    await page.evaluate(() => window.__emit({ type: 'live', record: { kind: 'message', id: 'streamed', revision: 0, updatedAt: '2026-10-30T13:00:00Z', data: { taskId: 'main-task', author: 'assistant', text: 'New streamed content\n\n'.repeat(30), streaming: true } } }));
    await page.getByText(/New streamed content/).first().waitFor();
    await assertLocked(page, `${width} streamed tail follow`, initial);
    await page.locator('.conversation').evaluate(node => { node.scrollTop = 0; });
    await page.locator('.thinking-block summary').click();
    await assertLocked(page, `${width} thinking disclosure`, initial);
    if (width <= 780) await page.getByRole('button', { name: /^Evidence \(/ }).click();
    const evidenceInitial = await assertLocked(page, `${width} evidence tab`);
    await page.locator('.evidence-column').evaluate(node => { node.scrollTop = 0; });
    await wheel(page, '.evidence-column', 500);
    check(await page.locator('.evidence-column').evaluate(node => node.scrollTop > 0), 'Evidence independently scrolls');
    await page.locator('.evidence-column').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await wheel(page, '.evidence-column', 1500);
    await assertLocked(page, `${width} evidence end overscroll`, evidenceInitial);
    if (width > 900) {
      await wheel(page, '.sidebar-sessions', 500);
      check(await page.locator('.sidebar-sessions').evaluate(node => node.scrollTop > 0), 'Recent-task list independently scrolls');
      await assertLocked(page, 'Sidebar list scroll', evidenceInitial);
    }
    await page.evaluate(() => {
      window.scrollTo(400, 400);
      for (const selector of ['#root', '.app-shell', '.main-shell', '.task-view', '.task-columns', '.conversation-column', '.web-sidebar']) {
        const node = document.querySelector(selector); node.scrollTop = 200; node.scrollLeft = 200;
      }
    });
    await assertLocked(page, `${width} programmatic root scroll`, evidenceInitial);
    await page.setViewportSize({ width, height: 720 });
    const resized = await assertLocked(page, `${width} window resize`);
    check(Math.abs(720 - resized.main[1] - resized.main[3] - (width <= 780 ? 8 : 12)) < 1, 'Bottom inset stays inside the resized viewport');
    if (width <= 780) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
    await page.getByRole('button', { name: /New task/ }).click();
    await page.getByRole('heading', { name: 'What should run next?', exact: true }).waitFor();
    await wheel(page, '.home', 900);
    check(await page.locator('.home').evaluate(node => node.scrollTop > 0), 'New-task page content remains independently scrollable');
    check(await page.evaluate(() => scrollY === 0 && document.querySelector('.main-shell').scrollTop === 0 && document.querySelector('#root').scrollTop === 0), 'Page navigation does not unlock outer scrolling');
    await page.close();
  }
  check(errors.length === 0, errors.join('\n'));
  console.log(`PASS: ${checks} scroll containment checks (${engine.name()}). Long content, wheel boundaries, stream/disclosure and fixed chrome.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
