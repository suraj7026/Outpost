import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openInitialTestChat } from './chat-test-navigation.mjs';

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
  return { locked, window: [scrollX, scrollY], headers: document.querySelectorAll('.topbar, .task-heading, .task-title').length, terminalHeadingCount: document.querySelectorAll('.task-terminal-heading').length, heading: bounds('.task-terminal-heading'), terminal: document.querySelector('.server-terminal-pane') ? bounds('.server-terminal-pane') : null, content: bounds('.task-columns'), composer: bounds('.reply-composer'), sidebarBrandCount: document.querySelectorAll('#app-sidebar .brand').length, footer: bounds('.sidebar-bottom'), main: bounds('.main-shell') };
});
async function assertLocked(page, label, initial) {
  const current = await frame(page);
  check(current.window.every(value => value === 0), `${label}: window never scrolls`);
  check(Object.values(current.locked).every(values => values.every(value => value === 0)), `${label}: layout containers never scroll: ${JSON.stringify(current.locked)}`);
  check(current.headers === 0, `${label}: obsolete global/task header DOM is absent`);
  check(current.sidebarBrandCount === 0, `${label}: sidebar brand DOM is absent`);
  check(current.terminalHeadingCount === 1 && current.heading[3] > 0, `${label}: exactly one visible chat terminal header`);
  check(Math.abs(current.heading[1] - current.main[1]) <= 1, `${label}: chat header starts at the workspace top`);
  check(Math.abs(current.content[1] - current.heading[1] - current.heading[3]) <= 1, `${label}: content begins immediately after the chat header`);
  check(Math.abs(current.content[1] + current.content[3] - current.composer[1] - current.composer[3] - 12) <= 1, `${label}: composer stays pinned to the conversation area bottom`);
  const workspaceBottom = current.main[1] + current.main[3];
  if (current.terminal) {
    check(Math.abs(current.content[1] + current.content[3] - current.terminal[1]) <= 1, `${label}: terminal follows the conversation area without overlap`);
    check(Math.abs(current.terminal[1] + current.terminal[3] - workspaceBottom) <= 1, `${label}: terminal stays pinned to the workspace bottom`);
  } else check(Math.abs(current.content[1] + current.content[3] - workspaceBottom) <= 1, `${label}: closed terminal reserves no bottom space`);
  if (initial) for (const name of ['heading', 'terminal', 'content', 'composer', 'footer', 'main']) {
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
      window.__terminalReads = 0;
      const terminalTarget = { setupId: 'synthetic-scroll-setup', label: 'Stream fixture', host: 'scroll.fixture.invalid', user: 'fixture', port: 22, fingerprint: 'SHA256:synthetic-scroll' };
      const terminalOutput = Array.from({ length: 160 }, (_, i) => `Terminal output line ${i}`).join('\r\n') + '\r\n';
      window.isTauri = true;
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; }, unregisterCallback(id) { callbacks.delete(id); },
        async invoke(command, args) {
          if (command === 'plugin:window|set_theme' && args?.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
        const environmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const bound = command.startsWith('environment_');
        if (command === 'environment_list') return { registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: environmentId, environments: { [environmentId]: { environmentId, label: 'Stream fixture', activeRoute: 'https://fixture.example', routes: ['https://fixture.example'] } } }, legacy: { endpoint: null, pending: false } };
        if (command === 'terminal_target' || command === 'terminal_open') {
          if (args.environmentId !== environmentId) throw new Error('Wrong terminal owner');
          return command === 'terminal_target' ? terminalTarget : { sessionId: 'synthetic-scroll-shell', target: terminalTarget };
        }
        if (['terminal_read', 'terminal_resize', 'terminal_close'].includes(command)) {
          if (args.sessionId !== 'synthetic-scroll-shell') throw new Error('Wrong terminal session');
          if (command !== 'terminal_read') return;
          window.__terminalReads++;
          return { data: args.offset === 0 ? btoa(terminalOutput) : '', nextOffset: terminalOutput.length, dropped: false, exited: false, exitCode: null };
        }
        if (command === 'environment_disconnect') return;
        if (command.startsWith('environment_')) {
          if (args.environmentId !== environmentId) throw new Error('Wrong stream owner');
          command = command.slice('environment_'.length);
        }
          if (command === 'disconnect') return;
          if (command === 'set_sidebar_window_controls') return;
          if (command === 'sidebar_pointer_inside') return false;
          if (command === 'connection_info') return { endpoint: 'Synthetic transport', deviceId: 'fixture', publicKey: '', pending: false, nativeSidebar: false };
          if (command === 'query') return args.kind === 'events' ? { events: [], hasMore: false, nextCursor: 1 } : structuredClone(fixture[args.kind]);
          if (command === 'stream_events' && !bound) return new Promise(() => {});
          if (command === 'stream_events') { channel = args.channel; return new Promise(() => {}); }
          throw new Error(`Unexpected mutation: ${command}`);
        },
      };
      window.__emit = message => callbacks.get(channel.id)({ index: index++, message });
    }, { fixture });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await openInitialTestChat(page);
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
    await wheel(page, '.reply-composer .composer-toolbar', 1000);
    await assertLocked(page, `${width} composer toolbar wheel`, initial);
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
    await page.getByRole('button', { name: 'Files, changes and browser', exact: true }).click();
    await page.locator('.task-resources').waitFor();
    const resourcesInitial = await assertLocked(page, `${width} resource panel`);
    await page.locator('.task-resources').evaluate(node => { node.scrollTop = 0; });
    await wheel(page, '.task-resources', 500);
    check(await page.locator('.task-resources').evaluate(node => node.scrollTop > 0), 'Resources independently scroll');
    await page.locator('.task-resources').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await wheel(page, '.task-resources', 1500);
    await assertLocked(page, `${width} resource panel end overscroll`, resourcesInitial);
    if (width > 900) {
      await wheel(page, '.sidebar-sessions', 500);
      check(await page.locator('.sidebar-sessions').evaluate(node => node.scrollTop > 0), 'Recent-task list independently scrolls');
      await assertLocked(page, 'Sidebar list scroll', resourcesInitial);
    }
    await page.evaluate(() => {
      window.scrollTo(400, 400);
      for (const selector of ['#root', '.app-shell', '.main-shell', '.task-view', '.task-columns', '.conversation-column', '.web-sidebar']) {
        const node = document.querySelector(selector); node.scrollTop = 200; node.scrollLeft = 200;
      }
    });
    await assertLocked(page, `${width} programmatic root scroll`, resourcesInitial);
    await page.getByRole('button', { name: 'Close files and changes', exact: true }).click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByText('Shell connected', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.xterm-screen')?.textContent.includes('Terminal output line 159'));
    const terminalInitial = await assertLocked(page, `${width} terminal open`);
    check(terminalInitial.content[3] < initial.content[3], 'Terminal takes its own space rather than covering the chat or composer');
    await page.locator('.conversation').evaluate(node => { node.scrollTop = 0; });
    await wheel(page, '.conversation', 500);
    check(await page.locator('.conversation').evaluate(node => node.scrollTop > 0), 'Conversation still independently scrolls with terminal open');
    await assertLocked(page, `${width} conversation wheel with terminal open`, terminalInitial);
    const conversationScroll = await page.locator('.conversation').evaluate(node => node.scrollTop);
    const terminalTail = await page.locator('.xterm-screen').textContent();
    await wheel(page, '.xterm-screen', -500);
    await page.waitForFunction(tail => document.querySelector('.xterm-screen')?.textContent !== tail, terminalTail);
    check(await page.locator('.conversation').evaluate(node => node.scrollTop) === conversationScroll, 'Terminal scrolling never scrolls the conversation');
    await assertLocked(page, `${width} terminal independent scroll`, terminalInitial);
    await wheel(page, '.xterm-screen', -100000);
    await wheel(page, '.xterm-screen', -1000);
    await assertLocked(page, `${width} terminal boundary overscroll`, terminalInitial);
    await wheel(page, '.reply-composer .composer-toolbar', 1000);
    await assertLocked(page, `${width} composer wheel with terminal open`, terminalInitial);
    const readsBeforeCollapse = await page.evaluate(() => window.__terminalReads);
    await page.getByRole('button', { name: 'Collapse terminal', exact: true }).click();
    await page.waitForFunction(reads => window.__terminalReads > reads, readsBeforeCollapse);
    await assertLocked(page, `${width} terminal collapsed`, initial);
    await page.setViewportSize({ width, height: 720 });
    const resized = await assertLocked(page, `${width} window resize`);
    check(Math.abs(720 - resized.main[1] - resized.main[3] - (width <= 780 ? 8 : 12)) < 1, 'Bottom inset stays inside the resized viewport');
    if (width <= 780) await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
    await page.getByRole('button', { name: /New task/ }).click();
    await page.getByRole('heading', { name: 'What should run next?', exact: true }).waitFor();
    check(await page.locator('.topbar, .task-heading, .task-title').count() === 0, 'Home has no global or task header DOM');
    check(await page.locator('.home').evaluate(node => Math.abs(node.getBoundingClientRect().top - document.querySelector('.main-shell').getBoundingClientRect().top) <= 1), 'Home starts at the workspace top without a reserved strip');
    await wheel(page, '.home', 900);
    check(await page.locator('.home').evaluate(node => node.scrollTop > 0), 'New-task page content remains independently scrollable');
    check(await page.evaluate(() => scrollY === 0 && document.querySelector('.main-shell').scrollTop === 0 && document.querySelector('#root').scrollTop === 0), 'Page navigation does not unlock outer scrolling');
    await page.close();
  }
  check(errors.length === 0, errors.join('\n'));
  console.log(`PASS: ${checks} scroll containment checks (${engine.name()}). Long content, wheel boundaries, stream/disclosure and fixed chrome.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
