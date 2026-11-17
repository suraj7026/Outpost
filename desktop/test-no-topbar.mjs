import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { openInitialTestChat } from './chat-test-navigation.mjs';
import { openSettings } from './settings-test-navigation.mjs';

// Existing production dist only; no build, real Tauri, live server, or native effects.
// OUTPOST_TEST_BROWSER=chromium|webkit (default: both), OUTPOST_TEST_FILTER=<substring>.
// OUTPOST_TEST_PHASE=before|after labels screenshots only; assertions never change.
// OUTPOST_TEST_FILTER=assistant-byline targets assistant headers across task/owner switches.
const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const out = '/tmp/outpost-no-topbar';
const phase = process.env.OUTPOST_TEST_PHASE || 'after';
const engines = process.env.OUTPOST_TEST_BROWSER ? [({ chromium, webkit })[process.env.OUTPOST_TEST_BROWSER]] : [chromium, webkit];
assert.ok(engines.every(Boolean), 'OUTPOST_TEST_BROWSER must be chromium or webkit');
assert.ok(['before', 'after'].includes(phase), 'OUTPOST_TEST_PHASE must be before or after');
assert.ok(existsSync(resolve(root, 'index.html')), 'An existing desktop/dist build is required; this test does not build it');
mkdirSync(out, { recursive: true });
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const taskId = 'same-task';
const epoch = Date.parse('2026-11-15T12:00:00Z');
const row = (kind, id, data, revision = 1, second = 0) => ({ kind, id, data, revision, updatedAt: new Date(epoch + second * 1000).toISOString() });
function records(label, revision, state = 'running') {
  return [
    row('task', taskId, { goal: `${label} task`, profile: 'code', state, model: 'fixture:cloud' }, revision),
    row('policy', taskId, { mode: 'ask_permission' }, 3),
    row('task', 'second-task', { goal: `${label} second task`, profile: 'code', state: 'paused' }, 11, -10),
    row('message', 'second-message', { taskId: 'second-task', author: 'assistant', text: `${label} separate task history` }),
    row('message', 'owner-message', { taskId, author: 'owner', text: `${label}: inspect this synthetic workspace without dispatching actions.` }, 1, 1),
    row('message', 'reply', { taskId, author: 'assistant', text: `${label} private history\n\n` + Array.from({ length: 36 }, (_, i) => `Recorded paragraph ${i + 1}. Synthetic inspection evidence, not production observations.`).join('\n\n'), thinking: 'Synthetic reasoning only.\n'.repeat(70) }, 1, 2),
    row('action', 'approval', { taskId, tool: 'file.write', target: `${label}.txt`, state: 'pending', nonce: `${label}-nonce`, actionDigest: `${label}-digest`, arguments: { path: `${label}.txt`, content: 'Synthetic review only' } }, revision === 41 ? 17 : 27, 3),
    ...Array.from({ length: 18 }, (_, i) => row('artifact', `report-${i}`, { taskId, name: `${label}-report-${i}.txt`, mime: 'text/plain', hash: 'synthetic' }, 1, 4 + i)),
    ...Array.from({ length: 24 }, (_, i) => row('task', `past-${i}`, { goal: `${label} previous task ${i}`, profile: 'code', state: 'completed' }, 1, -20 - i)),
    row('automation', 'schedule', { title: `${label} synthetic schedule`, enabled: true }),
    row('memory', 'note', { title: `${label} synthetic note`, text: 'No production records used.' }),
  ];
}

// Same channel/owner model as test-unified-conversation and test-environments;
// kept local rather than importing either auto-running test.
function installTransport({ A, B, states }) {
  const callbacks = new Map(), streams = {};
  let sequence = 0, pointerX = -1, pointerY = -1;
  const environment = (environmentId, label) => ({ environmentId, label, activeRoute: `https://${label.toLowerCase()}.invalid`, routes: [`https://${label.toLowerCase()}.invalid`] });
  const registry = { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: A, environments: { [A]: environment(A, 'Alpha'), [B]: environment(B, 'Beta') } };
  const control = window.__noTopbar = {
    states, commands: [], calls: [], unexpected: [], hold: false, releases: [],
    emit(owner, record) {
      const state = states[owner];
      state.records = [...state.records.filter(item => item.kind !== record.kind || item.id !== record.id), record];
      state.cursor++;
      const stream = streams[owner];
      if (!stream) throw new Error('Synthetic owner has no stream');
      callbacks.get(stream.channel.id)({ index: stream.index++, message: { type: 'records', records: [record], cursor: state.cursor } });
    },
    offline(owner) { states[owner].offline = true; streams[owner]?.resolve(); },
    release() { this.releases.splice(0).forEach(resolve => resolve()); },
  };
  document.addEventListener('pointermove', event => { pointerX = event.clientX; pointerY = event.clientY; });
  const unexpected = message => { control.unexpected.push(message); throw new Error(message); };
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(wireCommand, args = {}) {
      if (wireCommand === 'plugin:window|set_theme' && args?.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
      if (['set_sidebar_window_controls', 'set_window_blur', 'update_sidebar'].includes(wireCommand)) return;
      if (wireCommand === 'sidebar_pointer_inside') return pointerX >= 0 && pointerX <= args.width && pointerY >= 0 && pointerY <= innerHeight;
      if (wireCommand.startsWith('plugin:event|')) return 1;
      control.calls.push({ command: wireCommand, args: structuredClone(args) });
      if (wireCommand === 'environment_list') return { registry: structuredClone(registry), legacy: { endpoint: null, pending: false } };
      if (wireCommand === 'setup_list') return [];
      if (wireCommand === 'environment_select') { registry.selectedEnvironmentId = args.environmentId; return structuredClone(registry); }
      const bound = wireCommand.startsWith('environment_');
      const command = bound ? wireCommand.slice('environment_'.length) : wireCommand;
      if (!bound) {
        if (command === 'disconnect') return;
        if (command === 'connection_info') return { endpoint: null, pending: false, nativeSidebar: false };
        return unexpected(`Unscoped IPC: ${wireCommand}`);
      }
      const state = states[args.environmentId];
      if (!state) return unexpected(`Unknown owner: ${args.environmentId}`);
      if (command === 'disconnect') { streams[args.environmentId]?.resolve(); delete streams[args.environmentId]; return; }
      if (command === 'connection_info') return { environmentId: args.environmentId, endpoint: registry.environments[args.environmentId].activeRoute, deviceId: 'synthetic-device', publicKey: '', pending: !!state.pending, pendingError: state.pendingError ?? null, nativeSidebar: false };
      if (command === 'query') {
        if (state.offline) throw new Error('Synthetic offline owner');
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: state.cursor, records: structuredClone(state.records) };
        if (args.kind === 'runtime') return { configured: true, model: 'fixture:cloud', piManagement: false, browserDirect: !!state.browserDirect, hostAdministration: false, unrestrictedCommands: false };
        if (args.kind === 'models') return { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' };
        if (args.kind === 'events') return { events: [], nextCursor: state.cursor, hasMore: false };
      }
      if (command === 'stream_events') return new Promise(resolve => {
        const stream = streams[args.environmentId] = { channel: args.channel, index: 0, resolve };
        callbacks.get(stream.channel.id)({ index: stream.index++, message: { type: 'snapshot', cursor: state.cursor, records: structuredClone(state.records), live: [] } });
        state.ready = true;
      });
      if (command === 'send_command') {
        control.commands.push({ command: wireCommand, args: structuredClone(args) });
        if (state.offline || state.pending || state.pendingError) return unexpected('Mutation escaped read-only gating');
        const kind = args.kind === 'approval.decide' ? 'action' : 'task';
        const previous = state.records.find(record => record.kind === kind && record.id === args.id);
        if (!previous || args.revision !== previous.revision) return unexpected(`Wrong owner/task revision: ${JSON.stringify(args)}`);
        if (!['task.pause', 'task.resume', 'task.cancel', 'approval.decide'].includes(args.kind)) return unexpected(`Unexpected mutation: ${args.kind}`);
        if (control.hold) await new Promise(resolve => control.releases.push(resolve));
        const next = structuredClone(previous); next.revision++;
        next.data.state = args.kind === 'task.pause' ? 'paused' : args.kind === 'task.resume' ? 'running' : args.kind === 'task.cancel' ? 'cancelled' : args.payload.decision === 'approve' ? 'authorized' : 'denied';
        state.records = [...state.records.filter(record => record !== previous), next]; state.cursor++;
        return next;
      }
      return unexpected(`Unexpected IPC: ${wireCommand}`);
    },
  };
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const path = resolve(root, new URL(request.url, 'http://fixture').pathname.slice(1) || 'index.html');
  if (request.method !== 'GET' || !path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) return response.writeHead(404).end();
  response.setHeader('content-type', mime[extname(path)] || 'application/octet-stream');
  response.end(readFileSync(path));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, checks = 0, cases = 0, shots = 0;
const failures = [];
const deadline = setTimeout(() => { console.error('No-topbar suite exceeded 240 seconds'); process.exitCode = 1; void browser?.close(); server.closeAllConnections(); server.close(); }, 240_000);
deadline.unref();
const check = (value, label) => { assert.ok(value, label); checks++; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const near = (actual, expected, label) => check(Math.abs(actual - expected) <= 1, `${label}: ${actual} vs ${expected}`);
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const commands = page => page.evaluate(() => window.__noTopbar.commands);
const command = (owner, kind, id, revision, payload = {}) => ({ command: 'environment_send_command', args: { environmentId: owner, kind, id, revision, payload } });
const runHeaderLayout = page => page.locator('.conversation-run').evaluateAll(runs => runs.map(run => {
  const byline = run.querySelector(':scope > .run-byline.message-byline');
  const content = run.querySelector(':scope > .run-content');
  return { run: run.dataset.runId,
    bylineCount: run.querySelectorAll(':scope > .run-byline.message-byline').length,
    avatarCount: byline?.querySelectorAll(':scope > .message-avatar.assistant-avatar .outpost-mark').length ?? 0,
    name: byline?.querySelector(':scope > span:not(.message-avatar)')?.textContent,
    timeCount: byline?.querySelectorAll(':scope > time').length ?? 0,
    bylineIsFirst: !!byline && run.firstElementChild === byline,
    contentFollowsByline: !!byline && byline.nextElementSibling === content,
    contentInset: content ? parseFloat(getComputedStyle(content).marginLeft) : null,
    contentBelowByline: !!byline && !!content && content.getBoundingClientRect().top >= byline.getBoundingClientRect().bottom - 1,
    nestedBylineCount: content?.querySelectorAll('.message-byline').length ?? 0 };
}));
async function noHeaders(page) {
  equal(await page.locator('.topbar, .task-heading, .task-title, .task-terminal-heading').count(), 0, 'Global/task headers must be removed from DOM, not display:none');
  equal(await page.locator('#app-sidebar .brand').count(), 0, 'Sidebar brand is removed from the DOM');
  equal(await page.locator('.conversation').getByRole('article', { name: /Outpost/i }).count(), await page.locator('.conversation-run').count(), 'Assistant articles retain accessible Outpost attribution');
  for (const run of await runHeaderLayout(page)) {
    equal(run.bylineCount, 1, `${run.run}: one direct assistant byline`);
    equal(run.avatarCount, 1, `${run.run}: assistant avatar contains the Outpost mark`);
    equal(run.name, 'Outpost', `${run.run}: assistant name is visible`);
    equal(run.timeCount, 1, `${run.run}: assistant timestamp is retained`);
    check(run.bylineIsFirst && run.contentFollowsByline && run.contentBelowByline, `${run.run}: content follows the assistant byline`);
    near(run.contentInset, 0, `${run.run}: content uses the whole text column with avatars outside`);
    equal(run.nestedBylineCount, 0, `${run.run}: chunks do not repeat the run byline`);
  }
}
async function screenshot(page, engine, name) {
  const path = `${out}/${phase}-${engine.name()}-${name}.png`;
  await page.screenshot({ path, animations: 'disabled', timeout: 5000 }); shots++;
  console.log(`SCREENSHOT ${path}`);
}
async function reveal(page) {
  if (await page.locator('#app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await page.locator('#app-sidebar[data-motion="open"]').waitFor();
}
async function selectTask(page, owner, id = taskId) {
  await reveal(page);
  await page.locator(`.chat-server-group[data-server-id="${owner}"] [data-task-id="${id}"]`).click();
  await page.waitForFunction(({ owner, id }) => document.querySelector('.main-shell')?.dataset.ownerId === owner && document.querySelector(`.chat-server-group[data-server-id="${owner}"] [data-task-id="${id}"][aria-current="page"]`) && document.querySelector('.task-view'), { owner, id });
  await frames(page);
}
const bounds = page => page.evaluate(() => Object.fromEntries(['.main-shell', '.task-view', '.task-columns', '.conversation', '.reply-composer'].map(selector => {
  const { top, bottom, left, right, height } = document.querySelector(selector).getBoundingClientRect();
  return [selector, { top, bottom, left, right, height }];
})));
async function locked(page) {
  check(await page.evaluate(() => scrollX === 0 && scrollY === 0 && ['html', 'body', '#root', '.app-shell', '.main-shell', '.task-view', '.task-columns', '.conversation-column'].every(selector => { const node = document.querySelector(selector); return !node || (node.scrollTop === 0 && node.scrollLeft === 0); })), 'Window/body/root/layout containers remain scroll-locked');
  equal(await page.locator('#root').evaluate(node => getComputedStyle(node).position), 'fixed', 'Root remains viewport anchored');
  equal(await page.locator('.main-shell').evaluate(node => getComputedStyle(node).overflow), 'clip', 'Main shell cannot scroll on focus');
}
async function focusWithoutEdges(page, engine, target) {
  await page.mouse.move(page.viewportSize().width - 2, 2);
  await page.evaluate(() => document.activeElement?.blur()); await frames(page);
  const style = node => { const s = getComputedStyle(node); return { border: s.border, shadow: s.boxShadow, outline: s.outlineStyle, fill: s.backgroundColor, active: node === document.activeElement, visible: node.matches(':focus-visible') }; };
  const before = await target.evaluate(style);
  await target.focus();
  await page.keyboard.press(engine === webkit ? 'Alt+Tab' : 'Tab');
  await page.keyboard.press(engine === webkit ? 'Alt+Shift+Tab' : 'Shift+Tab');
  await frames(page);
  const after = await target.evaluate(style);
  check(after.active && after.visible, 'Moved control retains actual sequential keyboard focus');
  equal(after.outline, 'none', 'Moved control has no focus outline');
  equal([after.border, after.shadow], [before.border, before.shadow], 'Focus adds no border or shadow ring');
  check(after.fill !== before.fill, 'Keyboard focus is still indicated by fill');
}
async function scenario(engine, name, options, run) {
  if (process.env.OUTPOST_TEST_FILTER && !name.includes(process.env.OUTPOST_TEST_FILTER)) return;
  cases++;
  const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 }, colorScheme: options.scheme ?? 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [], external = [], dialogs = [], confirmation = { accept: false };
  page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); if (confirmation.accept) await dialog.accept(); else await dialog.dismiss(); });
  try {
    await context.route('**/*', route => {
      const request = route.request();
      if (new URL(request.url()).origin === origin && request.method() === 'GET') return route.continue();
      external.push(request.url()); return route.abort();
    });
    await context.routeWebSocket('**/*', socket => { external.push(socket.url()); socket.close(); });
    await context.addInitScript(installTransport, { A, B, states: { [A]: { cursor: 1, records: records('Alpha', 41, options.state), pending: options.pending, pendingError: options.pendingError, browserDirect: options.browserDirect }, [B]: { cursor: 1, records: records('Beta', 71) } } });
    await page.goto(origin);
    await openInitialTestChat(page);
    await page.locator('.task-unified .conversation').waitFor();
    await page.waitForFunction(({ A, B }) => window.__noTopbar.states[A].ready && window.__noTopbar.states[B].ready, { A, B });
    await page.evaluate(() => document.fonts.ready); await frames(page);
    await run(page, dialogs, confirmation);
    equal(errors, [], 'No browser runtime errors');
    equal(external, [], 'No off-origin network or WebSocket requests');
    equal(await page.evaluate(() => window.__noTopbar.unexpected), [], 'No unexpected IPC, unscoped commands or native/live operations');
    console.log(`PASS ${engine.name()} / ${name}`);
  } catch (error) {
    failures.push(`${engine.name()} / ${name}: ${error.message.split('\n')[0]}`);
    console.error(`FAIL ${engine.name()} / ${name}\n${error.stack}`);
    console.error('FIXTURE', await page.evaluate(() => ({ errors: window.__noTopbar?.unexpected, commands: window.__noTopbar?.commands, status: document.querySelector('.composer-run-label')?.textContent })).catch(() => null));
    if (errors.length) console.error('PAGE ERRORS', errors);
    if (!page.isClosed()) await screenshot(page, engine, `failure-${name}`).catch(() => {});
  } finally { await context.close(); }
}

try {
  for (const engine of engines) {
    browser = await engine.launch();
    try {
      await scenario(engine, 'assistant-byline-owner-task-switching', {}, async page => {
        for (const [owner, id, history] of [
          [A, taskId, 'Alpha private history'], [A, 'second-task', 'Alpha separate task history'],
          [B, taskId, 'Beta private history'], [B, 'second-task', 'Beta separate task history'],
          [A, taskId, 'Alpha private history'],
        ]) {
          await selectTask(page, owner, id);
          check((await page.locator('.conversation').textContent()).includes(history), 'Selected owner/task renders its own history');
          equal(await page.locator('.conversation-run').count(), 1, 'Selected task has one mounted assistant run, including ownerless history');
          await noHeaders(page);
        }
        equal(await commands(page), [], 'Header inspection and task/owner switches never dispatch');

        await noHeaders(page);
      });

      for (const scheme of ['dark', 'light']) for (const width of [1440, 768, 390]) {
        await scenario(engine, `layout-${width}-${scheme}`, { width, scheme }, async page => {
          await screenshot(page, engine, `task-${width}-${scheme}`);
          await noHeaders(page);
          equal(await page.locator('.conversation .owner > .owner-content > .message-byline').count(), 1, 'Owner message byline remains intact');
          equal(await page.locator('.conversation .owner > .owner-content > .message-byline time').count(), 1, 'Owner timestamp remains intact');
          const geometry = await bounds(page), main = geometry['.main-shell'];
          near(geometry['.task-view'].top, main.top, 'Task starts at main-shell top');
          check(geometry['.conversation'].top - main.top >= 0 && geometry['.conversation'].top - main.top <= 32, 'Conversation has normal padding only, not a reserved 66px row');
          near(main.bottom - geometry['.reply-composer'].bottom, 12, 'Composer remains bottom pinned');
          const heading = page.getByRole('heading', { name: 'Alpha task', level: 1, exact: true });
          equal(await heading.count(), 1, 'Task heading remains in the accessibility tree');
          check(await heading.evaluate(node => { const style = getComputedStyle(node), box = node.getBoundingClientRect(); return style.position === 'absolute' && box.width <= 1 && box.height <= 1 && style.display !== 'none' && style.visibility !== 'hidden'; }), 'Task h1 is screen-reader-only and reserves no space');
          equal(await page.getByRole('region', { name: 'Alpha: Alpha task', exact: true }).count(), 1, 'Task region has the exact accessible owner/task name');
          for (const name of ['Pause task', 'Files, changes and browser']) check(await page.locator('.reply-composer .composer-toolbar').getByRole('button', { name, exact: true }).isVisible(), `${name} moved into existing composer toolbar`);
          check(await page.locator('.composer-run-status').getByRole('button', { name: 'Review (1)', exact: true }).isVisible(), 'Review lives in run status, not an extra banner');
          for (const selector of ['.app-shell', '.composer-context']) equal(await page.locator(selector).getAttribute('data-tauri-drag-region') !== null, true, `${selector} retains drag-region semantics`);
          const paragraph = page.locator('.message-markdown p').first();
          await paragraph.scrollIntoViewIfNeeded();
          const textBox = await paragraph.boundingBox();
          await page.mouse.move(textBox.x + 2, textBox.y + 10); await page.mouse.down();
          await page.mouse.move(textBox.x + Math.min(120, textBox.width - 2), textBox.y + 10, { steps: 5 }); await page.mouse.up();
          check(await paragraph.evaluate(node => { const selection = getSelection(), selected = selection.toString(); selection.removeAllRanges(); return selected.length > 3 && node.textContent.includes(selected) && getComputedStyle(node).userSelect !== 'none'; }), 'Real pointer drag still selects conversation text inside draggable app frame');
          await focusWithoutEdges(page, engine, page.getByRole('button', { name: 'Pause task', exact: true }));
          await locked(page);
          check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No narrow horizontal overflow');
          if (width > 780) await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
          await page.locator('#app-sidebar[aria-hidden="true"]').waitFor({ state: 'attached' });
          await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
          await page.locator('#app-sidebar[data-motion="open"]').waitFor();
          await page.keyboard.press('Escape');
          await page.locator('#app-sidebar[aria-hidden="true"]').waitFor({ state: 'attached' });
          await page.keyboard.press('Meta+k');
          await page.getByRole('textbox', { name: 'Find a task', exact: true }).waitFor();
          await page.waitForFunction(() => document.activeElement === document.querySelector('#task-search'));
          check(await page.locator('#task-search').evaluate(node => node === document.activeElement), 'Keyboard search reveals and focuses sidebar');
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => document.activeElement === document.querySelector('.main-shell'));
          check(await page.locator('.main-shell').evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle === 'none'), 'Dismissal restores border-free workspace focus');
          await locked(page);
          equal(await commands(page), [], 'Layout, focus, sidebar navigation do not dispatch');
        });
        await scenario(engine, `pages-${width}-${scheme}`, { width, scheme }, async page => {
          const layouts = [];
          const inspectPage = name => page.evaluate(name => ({ name, headers: document.querySelectorAll('.topbar, .task-heading, .task-title').length,
            startsAtTop: [...document.querySelectorAll('.main-shell > main, .main-shell > .settings-workspace')].some(node => Math.abs(node.getBoundingClientRect().top - document.querySelector('.main-shell').getBoundingClientRect().top) <= 1) }), name);
          let reconnectInContext = false;
          for (const [name, heading] of [['Tasks', 'What should run next?'], ['Approvals', 'Approvals'], ['Machines', 'Servers'], ['Library', 'Library'], ['Automations', 'Automations'], ['Memory', 'Memory'], ['All chats', 'All chats']]) {
            await reveal(page);
            await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: name === 'Approvals' ? /^Approvals\s*\d*$/ : name, exact: true }).click();
            await page.getByRole('heading', { name: heading, level: 1, exact: true }).waitFor();
            if (name === 'Tasks' || (width === 1440 && scheme === 'dark')) await screenshot(page, engine, `${name.toLowerCase().replaceAll(' ', '-')}-${width}-${scheme}`);
            layouts.push(await inspectPage(name));
            if (name === 'Tasks') {
              const reconnect = page.getByRole('button', { name: 'Reconnect', exact: true });
              reconnectInContext = await reconnect.evaluate(node => node.parentElement.contains(document.querySelector('.composer-settings')) && !!node.closest('.composer-context'));
              const calls = await page.evaluate(() => window.__noTopbar.calls.length);
              await reconnect.click();
              await page.waitForFunction(({ A, calls }) => window.__noTopbar.calls.slice(calls).some(call => call.command === 'environment_query' && call.args.environmentId === A && call.args.kind === 'snapshot'), { A, calls });
            }
            if (width <= 780) {
              await page.locator('#app-sidebar[aria-hidden="true"]').waitFor({ state: 'attached' });
              equal(await page.locator('#app-sidebar').getAttribute('aria-hidden'), 'true', 'Narrow page navigation dismisses the sidebar');
            }
            await locked(page);
          }
          for (const destination of ['home', 'appearance', 'servers', 'server']) {
            await openSettings(page, { page: destination, server: A });
            if (destination === 'appearance' || (width === 1440 && scheme === 'dark')) await screenshot(page, engine, `settings-${destination}-${width}-${scheme}`);
            layouts.push(await inspectPage(`settings-${destination}`));
            check(await page.locator('.settings-workspace h1').isVisible(), 'Settings retain their body page title');
            await locked(page);
          }
          equal(await commands(page), [], 'Page/settings navigation and reconnect never dispatch task/action mutations');
          equal(layouts, layouts.map(({ name }) => ({ name, headers: 0, startsAtTop: true })), 'Every non-task page has no header DOM or reserved top row');
          check(reconnectInContext, 'Home Reconnect shares existing context action group with Settings');
        });
        // Exercise the production BrowserViewer empty state without a session,
        // frame polling, or browser-control IPC.
        await scenario(engine, `resources-${width}-${scheme}`, { width, scheme, browserDirect: true }, async page => {
          const narrow = width <= 1000;
          const trigger = page.locator('.reply-composer button[aria-label="Files, changes and browser"]');
          const drawer = page.locator('.task-resources');
          const close = drawer.getByRole('button', { name: 'Close files and changes', exact: true });
          const column = page.locator('.conversation-column');
          const openWithKeyboard = async () => {
            await trigger.focus();
            await page.keyboard.press('Enter');
            await drawer.waitFor();
            await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Close files and changes');
            check(await close.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle === 'none'), 'Keyboard opening focuses the border-free drawer Close button');
            equal(await trigger.getAttribute('aria-expanded'), 'true', 'Resources trigger announces the open drawer');
            equal(await column.evaluate(node => node.inert), narrow, 'Only the narrow overlay makes the conversation column inert');
          };
          const assertClosed = async () => {
            await drawer.waitFor({ state: 'detached' });
            await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Files, changes and browser');
            check(await trigger.evaluate(node => node === document.activeElement), 'Drawer dismissal returns focus to its exact composer trigger');
            equal(await trigger.getAttribute('aria-expanded'), 'false', 'Resources trigger announces the closed drawer');
            equal(await column.evaluate(node => node.inert), false, 'Closing restores conversation interactivity');
          };
          await openWithKeyboard();
          await screenshot(page, engine, `resources-open-${width}-${scheme}`);
          if (narrow) {
            await page.locator('.reply-composer textarea').evaluate(node => node.focus());
            check(await close.evaluate(node => node === document.activeElement), 'Inert conversation cannot steal drawer focus');
            for (let step = 0; step < 3; step++) {
              await page.keyboard.press(engine === webkit ? 'Alt+Tab' : 'Tab');
              check(await column.evaluate(node => !node.contains(document.activeElement)), 'Sequential keyboard navigation skips the inert conversation');
            }
          } else {
            const input = page.getByRole('textbox', { name: 'Message Outpost', exact: true });
            await input.fill('Local draft while resources stay open');
            equal(await input.inputValue(), 'Local draft while resources stay open', 'Wide drawer leaves the composer editable');
            check(await drawer.isVisible(), 'Editing the wide conversation does not dismiss resources');
            const conversation = page.locator('.conversation');
            const previousTop = await conversation.evaluate(node => node.scrollTop);
            check(previousTop > 100, 'Wide conversation fixture starts with scrollable history');
            const box = await conversation.boundingBox();
            await page.mouse.move(box.x + 30, box.y + 100); await page.mouse.wheel(0, -350);
            await page.waitForFunction(previous => document.querySelector('.conversation').scrollTop < previous - 100, previousTop);
            check(await drawer.isVisible(), 'Wide conversation scrolls independently while resources remain open');
            await input.fill('');
          }
          await locked(page);
          await close.press('Enter');
          await assertClosed();
          await openWithKeyboard();
          const enlarge = drawer.getByRole('button', { name: 'Enlarge browser view', exact: true });
          await enlarge.press('Enter');
          const viewer = page.getByRole('dialog', { name: 'Server browser', exact: true });
          await viewer.waitFor();
          check(await viewer.evaluate(node => node.open && !!node.closest('.task-resources') && node.contains(document.activeElement)), 'The real nested browser dialog is open and owns focus');
          await screenshot(page, engine, `resources-viewer-${width}-${scheme}`);
          await page.keyboard.press('Escape');
          await viewer.waitFor({ state: 'detached' });
          check(await drawer.isVisible(), 'First Escape closes the nested viewer, not the resource drawer');
          equal(await trigger.getAttribute('aria-expanded'), 'true', 'Nested viewer dismissal leaves the drawer expanded');
          equal(await column.evaluate(node => node.inert), narrow, 'Nested viewer dismissal preserves narrow/wide interactivity');
          await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Enlarge browser view');
          check(await enlarge.evaluate(node => node === document.activeElement), 'Nested viewer Escape restores its own opener focus');
          await page.keyboard.press('Escape');
          await assertClosed();
          equal(await page.locator('dialog[open]').count(), 0, 'Second Escape leaves no open viewer or drawer');
          await noHeaders(page);
          await locked(page);
          equal(await commands(page), [], 'Drawer, draft, scroll and nested Escape interactions never dispatch');
        });
      }
      await scenario(engine, 'controls-review-files-cancel', {}, async (page, dialogs, confirmation) => {
        await page.getByRole('button', { name: 'Pause task', exact: true }).click();
        await page.getByRole('button', { name: 'Resume task', exact: true }).waitFor();
        equal(await commands(page), [command(A, 'task.pause', taskId, 41)], 'Pause uses exact owner and task revision');
        await page.getByRole('button', { name: 'Resume task', exact: true }).click();
        await page.getByRole('button', { name: 'Pause task', exact: true }).waitFor();
        equal((await commands(page))[1], command(A, 'task.resume', taskId, 42), 'Resume uses updated revision');
        await page.getByRole('button', { name: 'Review (1)', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Review the exact action', exact: true });
        await dialog.waitFor();
        check(await dialog.locator('.action-body > pre').first().textContent() === JSON.stringify({ path: 'Alpha.txt', content: 'Synthetic review only' }, null, 2), 'Review retains exact displayed arguments');
        check(await page.evaluate(() => !!document.activeElement?.closest('dialog')), 'Review owns focus');
        await page.keyboard.press('Escape');
        equal((await commands(page)).length, 2, 'Opening/closing review never dispatches');
        await page.getByRole('button', { name: 'Review (1)', exact: true }).click();
        await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
        await dialog.getByRole('status').waitFor();
        equal((await commands(page))[2], command(A, 'approval.decide', 'approval', 17, { nonce: 'Alpha-nonce', actionDigest: 'Alpha-digest', decision: 'approve' }), 'Approval keeps exact owner/revision/nonce/digest');
        await dialog.getByRole('button', { name: 'Close review', exact: true }).click();
        equal(await page.getByRole('button', { name: 'Review (1)', exact: true }).count(), 0, 'Review shortcut disappears after approval, without dispatching the action');
        await page.getByRole('button', { name: 'Files, changes and browser', exact: true }).click();
        await page.locator('.task-resources').getByRole('button', { name: 'Alpha-report-0.txt', exact: true }).click();
        await page.locator('.task-resources').waitFor({ state: 'detached' });
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Download Alpha-report-0.txt');
        check(await page.getByRole('button', { name: 'Download Alpha-report-0.txt', exact: true }).evaluate(node => node === document.activeElement), 'Files navigation focuses the conversation artifact without downloading');
        equal((await commands(page)).length, 3, 'Resource navigation never dispatches');
        await page.getByRole('button', { name: 'Stop task', exact: true }).click();
        equal((await commands(page)).length, 3, 'Dismissing cancel confirmation is mutation-free');
        confirmation.accept = true;
        await page.evaluate(() => { window.__noTopbar.hold = true; });
        await page.getByRole('button', { name: 'Stop task', exact: true }).click();
        await page.waitForFunction(() => window.__noTopbar.commands.length === 4);
        equal((await commands(page))[3], command(A, 'task.cancel', taskId, 43), 'Cancel uses latest task revision and correct owner');
        await page.waitForFunction(() => document.querySelector('.composer-run-stop').getAttribute('aria-disabled') === 'true');
        check(await page.getByRole('button', { name: 'Pause task', exact: true }).isDisabled(), 'In-flight cancel also gates Pause');
        await page.locator('.composer-run-stop').evaluate(node => node.click());
        equal((await commands(page)).length, 4, 'Busy Stop cannot dispatch twice');
        equal(dialogs, Array.from({ length: 2 }, () => ({ type: 'confirm', message: 'Cancel this task? Completed changes will not be undone.' })), 'Cancel still confirms exact irreversible-work semantics');
        await page.evaluate(() => window.__noTopbar.release());
        await page.waitForFunction(() => document.querySelector('.composer-run-label').textContent === 'Cancelled');
        check(await page.getByRole('textbox', { name: 'Message Outpost' }).isDisabled(), 'Cancelled composer is read-only');
        check(await page.locator('.composer-run-stop').evaluate(node => node.hidden), 'Cancelled Stop retires');
        await screenshot(page, engine, 'cancelled');
      });
      await scenario(engine, 'owner-and-task-switching', {}, async page => {
        await selectTask(page, A, 'second-task');
        await noHeaders(page);
        await page.getByRole('button', { name: 'Resume task', exact: true }).click();
        await page.getByRole('button', { name: 'Pause task', exact: true }).waitFor();
        await selectTask(page, B);
        await noHeaders(page);
        check((await page.locator('.conversation').textContent()).includes('Beta private history') && !(await page.locator('.conversation').textContent()).includes('Alpha private history'), 'Same task ID does not leak the previous owner history');
        await page.getByRole('button', { name: 'Pause task', exact: true }).click();
        await page.getByRole('button', { name: 'Resume task', exact: true }).waitFor();
        await selectTask(page, A);
        await noHeaders(page);
        check(await page.getByRole('button', { name: 'Pause task', exact: true }).isVisible(), 'Alpha task remained running when Beta paused');
        await page.getByRole('button', { name: 'Pause task', exact: true }).click();
        await page.getByRole('button', { name: 'Resume task', exact: true }).waitFor();
        equal(await commands(page), [command(A, 'task.resume', 'second-task', 11), command(B, 'task.pause', taskId, 71), command(A, 'task.pause', taskId, 41)], 'Task/server switching preserves scoped commands and separate revisions with no navigation dispatch');
      });
      await scenario(engine, 'nested-scroll-and-follow', {}, async page => {
        const initial = await bounds(page), conversation = page.locator('.conversation');
        const box = await conversation.boundingBox();
        await page.mouse.move(box.x + 30, box.y + 100); await page.mouse.wheel(0, -700);
        await page.waitForFunction(() => document.querySelector('.composer-follow').getAttribute('aria-disabled') === 'false');
        const paused = await conversation.evaluate(node => node.scrollTop);
        await page.evaluate(({ A, record }) => window.__noTopbar.emit(A, record), { A, record: row('message', 'new-output', { taskId, author: 'assistant', text: 'Synthetic new output\n\n'.repeat(12) }, 1, 90) });
        await page.waitForFunction(() => document.querySelector('.composer-follow').dataset.unseen === 'true');
        near(await conversation.evaluate(node => node.scrollTop), paused, 'New output preserves reader position');
        await page.locator('.composer-follow').click();
        await page.waitForFunction(() => { const node = document.querySelector('.conversation'); return node.scrollHeight - node.clientHeight - node.scrollTop < 4; });
        equal(await page.locator('.composer-follow').getAttribute('aria-disabled'), 'true', 'Jump restores following');
        await noHeaders(page);
        const current = await bounds(page);
        near(current['.reply-composer'].top, initial['.reply-composer'].top, 'Follow/stream updates do not move pinned composer');
        await page.getByRole('button', { name: 'Files, changes and browser', exact: true }).click();
        const resource = page.locator('.task-resources');
        check(await resource.evaluate(node => node.scrollHeight > node.clientHeight), 'Resource fixture actually overflows');
        const resources = await resource.boundingBox();
        await page.mouse.move(resources.x + 40, resources.y + 100); await page.mouse.wheel(0, 500);
        await page.waitForFunction(() => document.querySelector('.task-resources').scrollTop > 0);
        await locked(page);
        await page.getByRole('button', { name: 'Close files and changes', exact: true }).click();
        await page.locator('.sidebar-sessions').evaluate(node => { node.scrollTop = 100; });
        check(await page.locator('.sidebar-sessions').evaluate(node => node.scrollTop > 0), 'Sidebar list remains independently scrollable');
        await page.evaluate(() => { window.scrollTo(100, 100); for (const selector of ['html', 'body', '#root', '.app-shell', '.main-shell', '.task-view', '.task-columns']) { const node = document.querySelector(selector); node.scrollTop = 100; node.scrollLeft = 100; } });
        await locked(page);
        await page.setViewportSize({ width: 1440, height: 720 }); await frames(page);
        const resized = await bounds(page);
        near(resized['.main-shell'].bottom - resized['.reply-composer'].bottom, 12, 'Resize retains composer bottom inset');
        equal(await commands(page), [], 'Scrolling, following and opening resources never dispatch');
      });
      for (const [name, options] of [['cancelled', { state: 'cancelled' }], ['completed', { state: 'completed' }], ['offline', {}], ['pending', { pending: true }], ['pending-error', { pendingError: 'Synthetic unresolved recovery' }]]) {
        await scenario(engine, `gating-${name}`, options, async (page, dialogs) => {
          if (name === 'offline') {
            await page.evaluate(A => window.__noTopbar.offline(A), A);
            await page.waitForFunction(() => document.querySelector('.composer-run-label').textContent === 'Offline · read-only');
          }
          const stopped = !!options.state;
          if (stopped) {
            equal(await page.getByRole('button', { name: /^(Pause|Resume) task$/ }).count(), 0, `${name} has no pause/resume control`);
            check(await page.getByRole('textbox', { name: 'Message Outpost' }).isDisabled(), `${name} disables composer input`);
          } else {
            check(await page.getByRole('button', { name: 'Pause task', exact: true }).isDisabled(), `${name} blocks pause`);
            equal(await page.locator('.composer-run-stop').getAttribute('aria-disabled'), 'true', `${name} blocks Stop`);
            await page.getByRole('textbox', { name: 'Message Outpost' }).fill('Must not dispatch');
            await page.getByRole('textbox', { name: 'Message Outpost' }).press('Meta+Enter');
            await page.getByRole('button', { name: 'Review (1)', exact: true }).click();
            for (const name of ['Approve', 'Deny']) check(await page.getByRole('dialog').getByRole('button', { name, exact: true }).isDisabled(), 'Read-only review blocks mutation');
            await page.getByRole('button', { name: 'Close review', exact: true }).click();
          }
          await page.locator('.composer-run-stop').evaluate(node => node.click());
          check(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), 'Sending remains gated');
          check(await page.getByRole('button', { name: 'Attach file', exact: true }).isDisabled(), 'Uploading remains gated');
          await page.getByRole('button', { name: 'Files, changes and browser', exact: true }).click();
          check(await page.locator('.task-resources').isVisible(), 'Read-only files remain inspectable');
          equal(await commands(page), [], 'Stopped/offline/pending controls cannot dispatch');
          equal(dialogs, [], 'Blocked Stop never asks for confirmation');
          check(await page.locator('.composer-follow').isVisible(), 'Follow remains local and available');
        });
      }
    } finally { await browser.close(); browser = null; }
  }
} finally { clearTimeout(deadline); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log(`${failures.length ? 'FAIL' : 'PASS'}: ${checks} checks, ${cases} cases, ${failures.length} failed, ${shots} screenshots (${phase}); ${out}`);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
