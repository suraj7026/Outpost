import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { openSettings } from './settings-test-navigation.mjs';

// Run from any directory: node desktop/test-unified-conversation.mjs
// Optional: OUTPOST_TEST_BROWSER=chromium|webkit, OUTPOST_TEST_FILTER=<case substring>, OUTPOST_TEST_SCREENSHOTS=<directory>, OUTPOST_TEST_DIST=<built directory>.
// OUTPOST_TEST_FILTER=assistant-byline runs the assistant header regressions; owner-layout runs owner wrapping regressions.
// All transport data is synthetic and embedded here; this never contacts a server.
const desktop = dirname(fileURLToPath(import.meta.url));
const root = process.env.OUTPOST_TEST_DIST ? resolve(process.env.OUTPOST_TEST_DIST) : resolve(desktop, 'dist');
const screenshots = process.env.OUTPOST_TEST_SCREENSHOTS ?? resolve(desktop, '../.outpost/unified-conversation/screenshots');
const environmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const taskId = 'unified-fixture-task';
const epoch = Date.parse('2026-11-15T12:00:00Z');
const engines = process.env.OUTPOST_TEST_BROWSER
  ? [({ chromium, webkit })[process.env.OUTPOST_TEST_BROWSER]] : [chromium, webkit];
assert.ok(engines.every(Boolean), 'OUTPOST_TEST_BROWSER must be chromium or webkit');
assert.ok(existsSync(resolve(root, 'index.html')), 'Build desktop/dist before running this test');
mkdirSync(screenshots, { recursive: true });

const row = (kind, id, second, data, revision = 1) => ({
  kind, id, revision, updatedAt: new Date(epoch + second * 1000).toISOString(),
  data: { taskId, startedAt: epoch + second * 1000, ...data },
});
const initialOutput = Array.from({ length: 8 }, (_, i) => `phase A: output line ${i + 1}`).join('\n');
const replacementOutput = initialOutput.replaceAll('phase A', 'phase B');
const approval = (revision = 17, state = 'pending') => row('action', 'approval-action', 20, {
  tool: 'host.execute', state, target: 'fixture-host',
  arguments: { host: 'fixture-host', command: `printf approval-${revision}` },
  nonce: `fixture-nonce-${revision}`, actionDigest: `fixture-digest-${revision}`,
}, revision);
function fixture(options = {}) {
  const records = [
    row('task', taskId, 0, { goal: 'Unified conversation production verification', profile: 'code', state: options.state ?? 'running', model: 'fixture:cloud' }, 41),
    row('policy', taskId, 0, { mode: 'ask_permission' }, 3),
    row('message', 'owner-one', 1, { author: 'owner', text: 'Inspect the workspace, then explain the evidence.' }),
    row('message', 'reply-one-a', 2, { author: 'assistant', text: 'First, I will inspect the workspace.', thinking: 'Reasoning segment one: inspect before changing anything.' }),
    row('action', 'historical-action', 3, { tool: 'command.run', state: 'succeeded', arguments: { argv: ['/bin/pwd'] }, result: { stdout: '/fixture/workspace', exitCode: 0 } }),
    row('tool_stream', 'historical-linked', 3.5, { name: 'outpost_action', state: 'finished', actionId: 'historical-action', streaming: false, output: '/fixture/workspace' }),
    row('message', 'reply-one-b', 4, { author: 'assistant', text: 'The workspace inspection is complete.', thinking: 'Reasoning segment two: retain the recorded result.' }),
    row('message', 'owner-two', 5, { author: 'owner', text: 'Now run the installation and retain the output.' }),
    row('message', 'reply-two', 6, { author: 'assistant', text: 'I will retain chronological execution evidence.\n\n' + Array.from({ length: 18 }, (_, i) => `History anchor ${String(i + 1).padStart(2, '0')}. Read-only context for the installation, with recorded results available for inspection.`).join('\n\n'), thinking: 'Second run reasoning stays collapsed until requested.' }),
    row('action', 'active-action', 7, { tool: 'host.execute', state: 'dispatching', target: 'fixture-host', arguments: { host: 'fixture-host', command: 'printf installation-fixture' } }, 7),
    row('tool_stream', 'active-linked', 7.5, { name: 'outpost_action', state: 'running', actionId: 'active-action', streaming: true, output: initialOutput }),
  ];
  if (options.approval) records.push(approval());
  // Deliberately unsorted: the UI must establish chronology, not trust snapshot order.
  return records.reverse();
}

function installTransport({ records, options, environmentId, taskId }) {
  if (options.conversationDetail) localStorage.setItem('outpost.appearance.v1', JSON.stringify({ conversationDetail: options.conversationDetail }));
  const callbacks = new Map();
  let sequence = 0, channel, index = 0, endStream;
  const live = new Map();
  const key = record => `${record.kind}:${record.id}`;
  const control = window.__unified = {
    records, cursor: 1, commands: [], unexpected: [], offline: false,
    holdCommands: false, releases: [],
    emit(frame) {
      if (frame.type === 'settled' || frame.type === 'records') {
        for (const record of frame.type === 'records' ? frame.records : [frame.record]) {
          const previous = this.records.find(item => key(item) === key(record));
          if (!previous || record.revision > previous.revision) this.records = [...this.records.filter(item => key(item) !== key(record)), record];
          if (frame.type === 'settled') live.delete(key(record));
        }
        this.cursor += 1;
        if (frame.type === 'records') frame.cursor = this.cursor;
      } else if (frame.type === 'live') live.set(key(frame.record), frame.record);
      if (!channel || !callbacks.has(channel.id)) throw new Error('Fixture live channel is not attached');
      callbacks.get(channel.id)({ index: index++, message: frame });
    },
    disconnect() { this.offline = true; endStream?.(); },
    release() { this.releases.splice(0).forEach(release => release()); },
  };
  const legacy = options.retired === true;
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(wireCommand, args = {}) {
      if (wireCommand === 'plugin:window|set_theme' && args?.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
      if (wireCommand === 'environment_list') return {
        registry: { version: 1, legacyMutationsRetired: legacy, selectedEnvironmentId: legacy ? null : environmentId,
          environments: legacy ? {} : { [environmentId]: { environmentId, label: 'Unified fixture', activeRoute: 'https://fixture.invalid', routes: ['https://fixture.invalid'] } } },
        legacy: { endpoint: legacy ? 'Synthetic legacy transport' : null, pending: false },
      };
      if (['set_sidebar_window_controls', 'set_window_blur', 'update_sidebar'].includes(wireCommand)) return;
      if (wireCommand === 'sidebar_pointer_inside') return false;
      if (wireCommand.startsWith('plugin:event|')) return 1;
      const bound = wireCommand.startsWith('environment_');
      if (bound && args.environmentId !== environmentId) throw new Error('Wrong environment owner');
      const command = bound ? wireCommand.slice('environment_'.length) : wireCommand;
      const activeOwner = legacy ? !bound : bound;
      if (command === 'disconnect') return;
      if (command === 'connection_info') return {
        endpoint: activeOwner ? 'Synthetic fixture transport' : null, deviceId: 'fixture-device', publicKey: '',
        pending: !!options.pending, pendingError: options.pendingError ?? null, nativeSidebar: false,
      };
      if (command === 'query') {
        if (control.offline) throw new Error('Synthetic fixture is offline');
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: control.cursor, records: structuredClone(control.records) };
        if (args.kind === 'runtime') return { configured: true, model: 'fixture:cloud', hostAdministration: false, unrestrictedCommands: false };
        if (args.kind === 'models') return { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' };
        if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: control.cursor };
      }
      if (command === 'stream_events') {
        if (!activeOwner) return new Promise(() => {});
        channel = args.channel; index = 0;
        callbacks.get(channel.id)({ index: index++, message: { type: 'snapshot', records: structuredClone(control.records), live: [...live.values()], cursor: control.cursor } });
        control.ready = true;
        return new Promise(resolve => { endStream = resolve; });
      }
      if (command === 'send_command') {
        control.commands.push({ command: wireCommand, args: structuredClone(args) });
        if (!options.allowMutations) {
          control.unexpected.push(`Unexpected mutation ${args.kind}`);
          throw new Error('This case does not permit mutations');
        }
        if (control.holdCommands) await new Promise(resolve => control.releases.push(resolve));
        const previous = control.records.find(record => record.id === args.id && record.kind === (args.kind.startsWith('approval.') || args.kind === 'action.dispatch' ? 'action' : args.kind === 'policy.change' ? 'policy' : 'task'));
        if (!previous) throw new Error(`Unknown mutation target ${args.id}`);
        const next = structuredClone(previous);
        next.revision += 1;
        if (args.kind === 'task.cancel') next.data.state = 'cancelled';
        else if (args.kind === 'approval.decide') next.data.state = args.payload.decision === 'approve' ? 'authorized' : 'denied';
        else if (args.kind === 'action.dispatch') next.data.state = 'dispatching';
        else if (args.kind === 'policy.change') next.data.mode = args.payload.mode;
        else if (args.kind !== 'task.steer') throw new Error(`Unsupported test mutation ${args.kind}`);
        control.records = [...control.records.filter(record => key(record) !== key(previous)), next];
        control.cursor += 1;
        return next;
      }
      control.unexpected.push(`${wireCommand} ${JSON.stringify(args)}`);
      throw new Error(`Unexpected fixture IPC: ${wireCommand}`);
    },
  };
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((request, response) => {
  try {
    const path = resolve(root, decodeURIComponent(new URL(request.url, 'http://localhost').pathname).slice(1) || 'index.html');
    if (!path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) { response.writeHead(404).end(); return; }
    response.setHeader('content-type', mime[extname(path)] ?? 'application/octet-stream');
    response.end(readFileSync(path));
  } catch { response.writeHead(400).end(); }
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.keepAliveTimeout = 1000;
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const deadline = setTimeout(() => {
  console.error('Unified conversation suite exceeded its 240-second bound');
  process.exitCode = 1;
  void browser?.close();
  server.closeAllConnections();
  server.close();
}, 240_000);
deadline.unref();
let assertions = 0, cases = 0;
const failures = [];
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const near = (actual, expected, message, tolerance = 1) => check(Math.abs(actual - expected) <= tolerance, `${message}: actual ${actual}, expected ${expected}`);
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const emit = (page, frame) => page.evaluate(frame => window.__unified.emit(frame), frame);
const record = (page, id) => page.evaluate(({ id, kind }) => window.__unified.records.find(record => record.id === id && (!kind || record.kind === kind)), { id, kind: id === taskId ? 'task' : null });
async function update(page, id, data, type = 'settled') {
  const previous = await record(page, id);
  assert.ok(previous, `Fixture record ${id} exists`);
  const next = { ...previous, revision: previous.revision + 1, updatedAt: new Date(epoch + 60_000 + previous.revision * 1000).toISOString(), data: { ...previous.data, ...data } };
  await emit(page, { type, record: next });
  return next;
}
const entry = (page, id) => page.locator(`.conversation [data-record-id="${id}"]`);
async function assistantBylines(page, expectedRuns) {
  const runs = page.locator('.conversation-run');
  equal(await runs.count(), expectedRuns, 'All expected assistant runs are mounted');
  for (const run of await runs.all()) {
    const id = await run.getAttribute('data-run-id');
    const header = run.locator(':scope > .run-byline');
    equal(await run.locator('.run-byline').count(), 1, `${id}: exactly one byline per assistant run, not per message`);
    check(await header.isVisible(), `${id}: assistant byline is visible`);
    const avatar = header.locator('.message-avatar.assistant-avatar');
    equal(await run.locator('.assistant-avatar').count(), 1, `${id}: exactly one assistant avatar per run`);
    check(await avatar.isVisible(), `${id}: assistant avatar is visible in the header`);
    const mark = avatar.locator('svg.outpost-mark');
    equal(await run.locator('.outpost-mark').count(), 1, `${id}: exactly one OutpostMark per run`);
    check(await mark.isVisible(), `${id}: avatar contains the visible OutpostMark`);
    check(await mark.locator('path').count() > 0, `${id}: OutpostMark retains its vector artwork`);
    equal(await header.getByText('Outpost', { exact: true }).count(), 1, `${id}: header names Outpost once`);
    check(await header.getByText('Outpost', { exact: true }).isVisible(), `${id}: Outpost name is visible`);
    equal(await header.locator('time').count(), 1, `${id}: header has one timestamp`);
    check(await header.locator('time').isVisible(), `${id}: assistant timestamp is visible`);
    check(Boolean((await header.locator('time').textContent()).trim()), `${id}: assistant timestamp is populated`);
    equal(await run.locator('.run-content').locator('.run-byline, .message-byline, .assistant-avatar, .outpost-mark, .message-model').count(), 0, `${id}: content has no repeated assistant metadata or model label`);
  }
  equal(await page.locator('.conversation').getByRole('article', { name: /Outpost/i }).count(), expectedRuns, 'Every assistant article retains accessible Outpost attribution');
}
async function runHeaderLayout(page) {
  const runs = await page.locator('.conversation-run').evaluateAll(nodes => nodes.map(run => {
    const header = run.querySelector(':scope > .run-byline');
    const content = run.querySelector(':scope > .run-content');
    const first = [...content.children].find(node => node.getBoundingClientRect().height > 0);
    return { id: run.dataset.runId, headerIsFirst: run.firstElementChild === header,
      contentFollowsHeader: header?.nextElementSibling === content,
      headerBottom: header?.getBoundingClientRect().bottom, contentTop: content.getBoundingClientRect().top,
      firstChildGap: first ? first.getBoundingClientRect().top - content.getBoundingClientRect().top : null,
      marginLeft: parseFloat(getComputedStyle(content).marginLeft),
      avatarRight: header.querySelector('.assistant-avatar').getBoundingClientRect().right,
      contentLeft: content.getBoundingClientRect().left,
      inset: content.getBoundingClientRect().left - run.getBoundingClientRect().left };
  }));
  check(runs.length > 0, 'Header layout regression inspects mounted assistant runs');
  for (const run of runs) {
    equal(run.headerIsFirst, true, `${run.id}: assistant byline is the first run child`);
    equal(run.contentFollowsHeader, true, `${run.id}: run content immediately follows its header in the DOM`);
    check(run.contentTop >= run.headerBottom - 1, `${run.id}: content is below, not overlapping, the header`);
    check(run.firstChildGap !== null, `${run.id}: fixture contains visible run content`);
    near(run.firstChildGap, 0, `${run.id}: first visible content has no extra header spacer`);
    near(run.marginLeft, 0, `${run.id}: response uses the whole text column`);
    near(run.inset, 0, `${run.id}: response aligns to the column edge`);
    check(run.avatarRight <= run.contentLeft - 7, `${run.id}: assistant avatar sits outside the text column`);
  }
}
async function ownerLayout(page, expectedOwners) {
  const owners = page.locator('.conversation .message.owner');
  equal(await owners.count(), expectedOwners, 'All expected owner messages are mounted');
  for (const owner of await owners.all()) {
    const id = await owner.getAttribute('data-record-id');
    const avatar = owner.locator(':scope > .message-avatar.owner-avatar');
    const content = owner.locator(':scope > .owner-content');
    equal(await owner.locator('.message-avatar').count(), 1, `${id}: one owner avatar, outside the byline`);
    check(await avatar.isVisible(), `${id}: direct owner avatar is visible`);
    equal(await content.count(), 1, `${id}: one owner content wrapper`);
    const byline = content.locator(':scope > .message-byline');
    const markdown = content.locator(':scope > .message-markdown');
    equal(await byline.count(), 1, `${id}: owner content contains its byline`);
    equal(await markdown.count(), 1, `${id}: owner content contains its text`);
    check(await byline.getByText('You', { exact: true }).isVisible(), `${id}: owner is labeled You`);
    equal(await byline.locator('time').count(), 1, `${id}: owner has one timestamp`);
    check(await byline.locator('time').isVisible(), `${id}: owner timestamp is visible`);
    check(Boolean((await byline.locator('time').textContent()).trim()), `${id}: owner timestamp is populated`);
    const layout = await owner.evaluate(node => {
      const content = node.querySelector(':scope > .owner-content');
      const byline = content.querySelector('.message-byline');
      const markdown = content.querySelector('.message-markdown');
      const rect = element => { const { left, right, top, bottom, width } = element.getBoundingClientRect(); return { left, right, top, bottom, width }; };
      const style = getComputedStyle(node);
      return { owner: rect(node), parent: rect(node.parentElement), avatar: rect(node.querySelector(':scope > .owner-avatar')),
        content: rect(content), byline: rect(byline), markdown: rect(markdown), bylinePrecedesText: byline.nextElementSibling === markdown,
        textAlign: getComputedStyle(markdown).textAlign,
        divider: { width: parseFloat(style.borderBottomWidth), style: style.borderBottomStyle, color: style.borderBottomColor },
        surfaces: [node, content, markdown, ...markdown.querySelectorAll('p')].map(element => {
          const style = getComputedStyle(element);
          return { background: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow,
            sideBorders: ['Top', 'Left', 'Right'].map(side => parseFloat(style[`border${side}Width`])) };
        }) };
    });
    check(layout.avatar.left >= layout.content.right - 1, `${id}: avatar sits to the right of owner content`);
    near(layout.avatar.left - layout.owner.right, page.viewportSize().width <= 620 ? 8 : 14, `${id}: avatar sits in the outer gutter`);
    near(layout.content.right, layout.owner.right, `${id}: owner text uses the whole column`);
    check(layout.avatar.width > 0, `${id}: owner avatar has a nonzero width`);
    equal(layout.bylinePrecedesText, true, `${id}: You and timestamp precede the plain text`);
    check(layout.byline.bottom <= layout.markdown.top + 1, `${id}: byline is above the text`);
    check(['right', 'end'].includes(layout.textAlign), `${id}: owner text is right aligned`);
    near(layout.owner.left, layout.parent.left, `${id}: divider begins at the full transcript width`);
    near(layout.owner.right, layout.parent.right, `${id}: divider ends at the full transcript width`);
    check(layout.divider.width > 0 && layout.divider.width <= 1 && !['none', 'hidden'].includes(layout.divider.style), `${id}: subtle bottom divider is present`);
    check(!['transparent', 'rgba(0, 0, 0, 0)'].includes(layout.divider.color), `${id}: bottom divider is not transparent`);
    for (const surface of layout.surfaces) {
      check(['transparent', 'rgba(0, 0, 0, 0)'].includes(surface.background), `${id}: owner text surfaces have transparent backgrounds`);
      equal(surface.image, 'none', `${id}: no background image creates a message bubble`);
      equal(surface.shadow, 'none', `${id}: no card shadow around owner text`);
      equal(surface.sideBorders, [0, 0, 0], `${id}: no card borders around owner text`);
    }
  }
}
async function noSidebarBrand(page) {
  equal(await page.locator('.sidebar .brand, #app-sidebar .brand').count(), 0, 'Sidebar logo/wordmark brand block is removed, not hidden');
}
const follow = page => page.locator('.composer-follow');
const gap = page => page.locator('.conversation').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
const geometry = page => page.evaluate(() => Object.fromEntries(['.conversation', '.composer-context-run', '.reply-composer', '.composer-follow'].map(selector => {
  const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
  return [selector, { x, y, width, height }];
})));
function sameGeometry(before, after, label) {
  for (const selector of Object.keys(before)) for (const dimension of ['x', 'y', 'width', 'height']) near(after[selector][dimension], before[selector][dimension], `${label} ${selector}.${dimension}`);
}
async function screenshot(page, name) {
  const path = resolve(screenshots, `${name}.png`);
  await page.screenshot({ path, animations: 'disabled', timeout: 5000 });
  console.log(`SCREENSHOT ${path}`);
}
async function waitClock(page, predicate, message, argument) {
  for (let turn = 0; turn < 100; turn++) {
    if (await page.evaluate(predicate, argument)) return;
    await page.clock.runFor(1);
  }
  assert.fail(message);
}
async function freeze(page) {
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
}
async function scenario(engine, name, options, run) {
  if (process.env.OUTPOST_TEST_FILTER && !name.includes(process.env.OUTPOST_TEST_FILTER)) return;
  cases++;
  const page = await browser.newPage({ viewport: { width: options.width ?? 1440, height: 1000 }, colorScheme: options.scheme ?? 'dark', reducedMotion: 'reduce' });
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(10000);
  const errors = [], dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push({ type: dialog.type(), message: dialog.message() }); await dialog.accept(); });
  try {
    await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    if (options.clock) await page.clock.install({ time: new Date(epoch) });
    await page.addInitScript(installTransport, { records: fixture(options), options, environmentId, taskId });
    await page.goto(origin);
    await page.locator('.task-unified .conversation').waitFor();
    await page.waitForFunction(() => window.__unified.ready === true);
    await page.evaluate(() => document.fonts.ready);
    await frames(page);
    await run(page, dialogs);
    equal(errors, [], 'No browser runtime errors');
    equal(await page.evaluate(() => window.__unified.unexpected), [], 'No unexpected IPC or mutations');
    console.log(`PASS ${engine.name()} / ${name}`);
  } catch (error) {
    failures.push({ browser: engine.name(), name, message: error.message });
    console.error(`FAIL ${engine.name()} / ${name}\n${error.stack}`);
    if (errors.length) console.error('PAGE ERRORS', errors);
    if (!page.isClosed()) {
      console.error('APP STATE', await page.evaluate(() => ({ status: document.querySelector('.composer-run-status')?.outerHTML, commands: window.__unified?.commands, unexpected: window.__unified?.unexpected })).catch(() => null));
      await screenshot(page, `${engine.name()}-failure-${name.replaceAll(/[^a-z0-9-]/gi, '-')}`).catch(error => console.error('Screenshot failed:', error.message));
    }
  } finally { await page.close(); }
}

try {
  for (const engine of engines) {
    browser = await engine.launch();
    try {
      await scenario(engine, 'assistant-byline-initial-dom', {}, async page => {
        await assistantBylines(page, 2);
        await ownerLayout(page, 2);
        await noSidebarBrand(page);
        equal(await entry(page, 'active-action').locator('.execution-meta .action-time').count(), 1, 'Action evidence time is not mistaken for an assistant header');
        equal(await page.evaluate(() => window.__unified.commands), [], 'Checking assistant headers never dispatches');
      });

      await scenario(engine, 'assistant-byline-header-and-responsive-inset', {}, async page => {
        for (const width of [1440, 768, 621, 620, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await frames(page);
          await assistantBylines(page, 2);
          await runHeaderLayout(page);
          if (width === 1440 || width === 390) {
            await page.locator('.conversation').evaluate(node => { node.scrollTop = 0; });
            await frames(page);
            await screenshot(page, `${engine.name()}-transcript-top-${width}`);
          }
        }
      });

      await scenario(engine, 'assistant-byline-streamed-new-runs', {}, async page => {
        const capture = async (stage, expectedRuns) => {
          await frames(page);
          equal(await page.locator('.conversation-run').count(), expectedRuns, `${stage}: every run is mounted`);
          await assistantBylines(page, expectedRuns);
          await runHeaderLayout(page);
          await ownerLayout(page, expectedRuns);
        };
        const live = row('message', 'byline-live-message', 9, {
          author: 'assistant', text: 'Synthetic streaming continuation.', streaming: true, provider: 'fixture', model: 'fixture:streamed',
        }, 0);
        await emit(page, { type: 'live', record: live });
        await entry(page, live.id).waitFor();
        await capture('live continuation in an existing run', 2);
        await emit(page, { type: 'settled', record: row('message', 'byline-new-owner', 10, { author: 'owner', text: 'Start another synthetic run.' }) });
        const next = row('message', 'byline-new-message', 11, {
          author: 'assistant', text: 'Synthetic new run.', streaming: true, provider: 'fixture', model: 'fixture:new-run',
        }, 0);
        await emit(page, { type: 'live', record: next });
        await entry(page, next.id).waitFor();
        await capture('new text-first streamed run', 3);
        const revised = { ...next, data: { ...next.data, text: 'Synthetic revised stream.', thinking: 'New streamed reasoning.' } };
        await emit(page, { type: 'live', record: revised });
        await entry(page, next.id).getByText(revised.data.text, { exact: true }).waitFor();
        await capture('stream revision introduces reasoning', 3);
        await emit(page, { type: 'settled', record: { ...revised, revision: 1, data: { ...revised.data, streaming: false } } });
        await capture('stream settles into durable history', 3);
        await emit(page, { type: 'settled', record: row('message', 'byline-tool-owner', 12, { author: 'owner', text: 'Retain tool-only evidence.' }) });
        const tool = row('tool_stream', 'byline-tool-stream', 13, {
          name: 'outpost_action', actionId: 'byline-tool-action', state: 'running', streaming: true,
          arguments: { tool: 'command.run', arguments: { argv: ['/bin/echo', 'synthetic'] } }, output: 'Synthetic tool-only output.',
        }, 0);
        await emit(page, { type: 'live', record: tool });
        await entry(page, tool.id).waitFor();
        await capture('new tool-only streamed run', 4);
        await emit(page, { type: 'settled', record: row('action', 'byline-tool-action', 14, {
          tool: 'command.run', state: 'succeeded', arguments: { argv: ['/bin/echo', 'synthetic'] }, result: { stdout: tool.data.output, exitCode: 0 },
        }) });
        await emit(page, { type: 'settled', record: { ...tool, revision: 1, data: { ...tool.data, state: 'finished', streaming: false } } });
        await entry(page, 'byline-tool-action').waitFor();
        await capture('tool-only run durable handoff', 4);
        equal(await entry(page, tool.id).count(), 0, 'Tool stream remains deduplicated after handoff');
        equal(await page.evaluate(() => window.__unified.commands), [], 'Synthetic stream updates never execute work');
        await assistantBylines(page, 4);
        await runHeaderLayout(page);
      });

      for (const scheme of ['dark', 'light']) for (const width of [1440, 768, 390]) {
        await scenario(engine, `layout-${width}-${scheme}`, { width, scheme }, async page => {
          equal(await page.locator('.conversation-run').count(), 2, 'Owner messages divide exactly two runs');
          await assistantBylines(page, 2);
          await runHeaderLayout(page);
          await ownerLayout(page, 2);
          await noSidebarBrand(page);
          equal(await page.locator('.conversation .owner-content > .message-byline').count(), 2, 'Both owner bylines remain separate from the assistant run headers');
          equal(await page.locator('.conversation .owner .message-byline time').count(), 2, 'Owner timestamps are preserved');
          equal(await page.locator('.conversation [data-record-id]').evaluateAll(nodes => nodes.map(node => node.dataset.recordId)),
            ['owner-one', 'reply-one-a', 'historical-action', 'reply-one-b', 'owner-two', 'reply-two', 'active-action'], 'Messages/actions remain chronological and linked streams are deduplicated');
          equal(await page.locator('.run-reasoning').count(), 2, 'One aggregated reasoning disclosure per run');
          equal(await page.locator('.run-reasoning[open]').count(), 0, 'Reasoning begins collapsed');
          equal(await page.locator('.run-reasoning').first().locator('.reasoning-segments pre').count(), 2, 'First run retains both reasoning segments');
          check(await gap(page) < 4, 'Initial render is pinned to latest');
          equal(await follow(page).getAttribute('aria-disabled'), 'true', 'Initial follow is armed');
          const activeAction = entry(page, 'active-action');
          check(!(await activeAction.evaluate(node => node.open)), 'Compact starts active execution collapsed');
          await activeAction.locator(':scope > summary').click();
          await frames(page);
          const output = activeAction.locator('.execution-output');
          equal(await output.textContent(), initialOutput.split('\n').slice(-5).join('\n'), 'Output shows exactly the latest five lines');
          const outputBox = await output.evaluate(node => ({ height: node.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(node).lineHeight) }));
          near(outputBox.height, outputBox.lineHeight * 5, 'Output viewport is exactly five lines tall');
          // Inspecting a disclosure pauses follow; restore the tail for layout checks.
          await follow(page).click(); await frames(page);
          equal(await page.locator('.composer-context-run .composer-run-status').count(), 1, 'Status lives inside the composer context, not a separate banner');
          equal(await page.locator('.composer-context-run').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(16, 17, 18)', 'Composer context remains black in both themes');
          for (const label of ['Message Outpost', 'Attach file', 'Task control mode', 'Send message']) check(await page.getByLabel(label, { exact: true }).isVisible(), `Composer retains ${label}`);
          check(await page.locator('.composer-model-control').isVisible(), 'Composer retains model control');
          check(await page.locator('.composer-context-run .environment-navigation').isVisible(), 'Composer retains environment navigation');
          check(await page.getByRole('button', { name: 'Files, changes and browser', exact: true }).isVisible(), 'Resources remain available');
          const bounds = await page.evaluate(() => {
            const selectors = ['.conversation', '.composer-context-run', '.reply-composer', '.composer-follow', '.composer-run-stop'];
            return { overflow: document.documentElement.scrollWidth > innerWidth, pageScroll: [scrollX, scrollY], items: selectors.map(selector => {
              const rect = document.querySelector(selector).getBoundingClientRect();
              return { selector, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
            }), width: innerWidth, height: innerHeight };
          });
          check(!bounds.overflow, 'No document horizontal overflow');
          equal(bounds.pageScroll, [0, 0], 'Only the conversation scrolls, not the page');
          for (const rect of bounds.items) check(rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.right <= bounds.width + 1 && rect.top >= -1 && rect.bottom <= bounds.height + 1, `${rect.selector} fits the ${width}px viewport: ${JSON.stringify(rect)}`);
          if (width === 390) {
            for (const rect of bounds.items.filter(item => ['.composer-follow', '.composer-run-stop'].includes(item.selector))) check(rect.width >= 44 && rect.height >= 44, `${rect.selector} has a mobile-sized target`);
          }
          await screenshot(page, `${engine.name()}-${width}-${scheme}`);
          equal(await page.evaluate(() => window.__unified.commands.length), 0, 'Inspection never executes work');
        });
      }

      for (const scheme of ['dark', 'light']) for (const width of [1440, 768, 390]) {
        await scenario(engine, `owner-layout-plain-text-wrapping-${width}-${scheme}`, { width, scheme }, async page => {
          const prose = 'Keep this owner message as plain transcript text with a right-side avatar and no bubble. '.repeat(8).trim();
          const token = 'unbroken-owner-text-'.repeat(24);
          const text = `${prose}\n\n${token}`;
          await update(page, 'owner-one', { text });
          const markdown = entry(page, 'owner-one').locator('.owner-content > .message-markdown');
          await page.waitForFunction(text => document.querySelector('[data-record-id="owner-one"] .message-markdown')?.textContent.includes(text), token);
          await frames(page);
          await ownerLayout(page, 2);
          await assistantBylines(page, 2);
          const wrapping = await markdown.evaluate(node => ({
            overflow: node.scrollWidth > node.clientWidth + 1,
            paragraphs: [...node.querySelectorAll('p')].map(paragraph => {
              const range = document.createRange();
              range.selectNodeContents(paragraph);
              const bounds = node.getBoundingClientRect();
              const rects = [...range.getClientRects()];
              const style = getComputedStyle(paragraph);
              return { text: paragraph.textContent, lines: new Set(rects.map(rect => Math.round(rect.top))).size,
                fits: rects.every(rect => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1),
                overflowX: style.overflowX, overflowY: style.overflowY, textOverflow: style.textOverflow };
            }),
          }));
          equal(wrapping.paragraphs.map(paragraph => paragraph.text), [prose, token], 'Long prose and unbroken owner text are retained without truncation');
          check(!wrapping.overflow, 'Owner text does not create horizontal overflow');
          for (const paragraph of wrapping.paragraphs) {
            check(paragraph.lines > 1, 'Owner prose and unbroken tokens each wrap onto multiple lines');
            check(paragraph.fits, 'Every owner text line fits inside the content beside the avatar');
            check(!['hidden', 'clip'].includes(paragraph.overflowX) && !['hidden', 'clip'].includes(paragraph.overflowY), 'Wrapping does not hide overflowing owner text');
            check(paragraph.textOverflow !== 'ellipsis', 'Owner text is not ellipsized');
          }
          check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'Long owner text does not overflow the document');
          equal(await page.evaluate(() => window.__unified.commands), [], 'Owner wrapping inspection never dispatches work');
        });
      }

      await scenario(engine, 'conversation-width-preference', { width: 1600 }, async page => {
        for (const [label, value, pixels] of [['Narrow', 'narrow', 672], ['Wide', 'wide', 864], ['Large', 'large', 1056]]) {
          await openSettings(page, { page: 'appearance' });
          await page.getByRole('radio', { name: label, exact: true }).check();
          await page.waitForFunction(value => document.documentElement.dataset.conversationWidth === value, value);
          equal(await page.evaluate(() => JSON.parse(localStorage.getItem('outpost.appearance.v1')).conversationWidth), value, 'Width preference is persisted');
          if (value === 'large') await screenshot(page, `${engine.name()}-conversation-width-settings`);
          await page.locator(`.chat-server-group[data-server-id="${environmentId}"] [data-task-id="${taskId}"]`).evaluate(node => node.click());
          await page.locator('.conversation').waitFor(); await frames(page);
          near(await page.locator('.conversation-content').evaluate(node => node.getBoundingClientRect().width), pixels, `${label} text column has its configured width`);
          near(await page.locator('.reply-composer-stack').evaluate(node => node.getBoundingClientRect().width), pixels, 'Reply composer follows the text width');
          await runHeaderLayout(page); await ownerLayout(page, 2);
          await page.locator('.conversation').evaluate(node => { node.scrollTop = 0; }); await frames(page);
          await screenshot(page, `${engine.name()}-conversation-${value}`);
        }
        await page.reload(); await page.locator('.conversation').waitFor(); await frames(page);
        equal(await page.evaluate(() => document.documentElement.dataset.conversationWidth), 'large', 'Preference survives a reload');
        await page.setViewportSize({ width: 390, height: 1000 }); await frames(page);
        const clipping = await page.locator('.conversation-content').evaluate(node => {
          const viewport = document.querySelector('.conversation').getBoundingClientRect();
          return [...node.querySelectorAll('.message-avatar')].some(avatar => { const box = avatar.getBoundingClientRect(); return box.left < viewport.left || box.right > viewport.right; });
        });
        check(!clipping, 'Large mode clamps to a narrow window and keeps avatars visible');
        check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'No horizontal page overflow');
        equal(await page.evaluate(() => window.__unified.commands), [], 'Width changes do not dispatch server commands');
      });

      await scenario(engine, 'composer-consistency', {}, async page => {
        const measure = async selector => page.locator(selector).evaluate(node => {
          const style = getComputedStyle(node), box = node.getBoundingClientRect();
          return { height: box.height, radius: style.borderRadius, padding: style.padding, appearance: style.appearance, background: style.backgroundColor };
        });
        const permission = page.getByLabel('Task control mode', { exact: true });
        equal(await permission.locator('..').locator('svg').count(), 1, 'Control mode keeps its shield without a dropdown arrow');
                equal(await page.locator('.composer-stack .lucide-chevron-down:visible').count(), 0, 'Composer model control has no visible dropdown arrow');
        equal((await measure('.composer-permission select')).appearance, 'none', 'Native select chrome is removed');
        const unfocused = await measure('.composer-permission');
        await permission.hover();
        check((await measure('.composer-permission')).background !== unfocused.background, 'The entire control highlights on hover');
        const taskComposer = await measure('.reply-composer');
        const taskField = await measure('.composer-permission');
        equal(taskField.height, 36, 'Permission control uses shared 36px height');
        const terminal = page.getByRole('button', { name: 'Terminal', exact: true });
        equal(await terminal.locator('svg.lucide-square-terminal').count(), 1, 'Terminal uses the shared Lucide glyph');
        equal(await page.locator('.new-work').count(), 0, 'Task starts in conversation');
        await page.keyboard.press('Meta+n');
        await page.getByLabel('Task goal').waitFor();
        equal(await page.getByText('What should run next?', { exact: true }).count(), 0, 'Old home heading is removed');
        equal(await page.locator('.home .recent, .home .session-list').count(), 0, 'New task no longer contains the old recent-session table');
        equal(await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Memory', exact: true }).locator('svg.lucide-notebook-pen').count(), 1, 'Memory uses the approved notebook icon, not Sparkles');
        equal(await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Automations', exact: true }).locator('svg.lucide-calendar-clock').count(), 1, 'Automations uses the schedule icon');
        const placement = await page.locator('.new-work').evaluate(node => { const box = node.getBoundingClientRect(), home = node.closest('.home').getBoundingClientRect(); return { width: box.width, difference: Math.abs((box.top + box.bottom - home.top - home.bottom) / 2) }; });
        check(placement.width <= 673 && placement.difference < 60, 'New task is bounded and centered like the approved mock');
        const homeComposer = await measure('.composer');
        equal(homeComposer.padding, taskComposer.padding, 'New task and reply composer padding match');
        equal(homeComposer.radius, taskComposer.radius, 'New task and reply composer roundness match');
        equal((await measure('.composer-permission')).height, taskField.height, 'Control sizing matches across composers');
                equal(await page.locator('.composer-stack .lucide-chevron-down:visible').count(), 0, 'New-task model control has no visible dropdown arrow');
                equal(await page.locator('.new-task-server summary').evaluate(node => getComputedStyle(node, '::after').content), 'none', 'Server selector has no dropdown arrow');
        check(await page.getByRole('button', { name: 'Terminal', exact: true }).isVisible(), 'New task has a real server terminal control');
        for (const width of [1440, 900, 390]) {
          await page.setViewportSize({ width, height: 1000 }); await frames(page);
          const overflow = await page.locator('.composer-stack').evaluate(node => ({ scroll: node.scrollWidth, width: node.clientWidth }));
          check(overflow.scroll <= overflow.width + 1, `Home composer fits at ${width}px`);
        }
        await page.setViewportSize({ width: 1440, height: 1000 }); await frames(page);
        await screenshot(page, `${engine.name()}-refined-new-task`);
        equal(await page.evaluate(() => window.__unified.commands), [], 'Style inspection does not dispatch commands');
      });

      await scenario(engine, 'reasoning-and-disclosure-persistence', {}, async page => {
        const reasoning = page.locator('.run-reasoning').first();
        await reasoning.locator('summary').click();
        await page.waitForFunction(() => document.querySelector('.run-reasoning').open);
        await update(page, 'reply-one-a', { thinking: 'Updated first reasoning segment.' });
        await frames(page);
        check(await reasoning.evaluate(node => node.open), 'User-opened aggregated reasoning survives content updates');
        await reasoning.locator('summary').click();
        await update(page, 'reply-one-b', { thinking: 'Updated second reasoning segment.' });
        await frames(page);
        check(!(await reasoning.evaluate(node => node.open)), 'User-closed aggregated reasoning stays closed');
        const action = entry(page, 'active-action');
        check(!(await action.evaluate(node => node.open)), 'Compact starts active execution collapsed');
        await action.locator(':scope > summary').click();
        check(await action.evaluate(node => node.open), 'Reader can open active execution');
        await action.locator(':scope > summary').click();
        await update(page, 'active-action', { state: 'succeeded', result: { stdout: replacementOutput, exitCode: 0 } });
        await frames(page);
        check(!(await action.evaluate(node => node.open)), 'User-collapsed execution remains collapsed after completion');
        check(!(await action.evaluate(node => !!node.closest('.completed-action-group'))), 'A live row is not remounted inside a historical completion group');
        await action.locator(':scope > summary').click();
        await update(page, 'active-action', { result: { stdout: replacementOutput + '\nfinal result retained', exitCode: 0 } });
        await frames(page);
        check(await action.evaluate(node => node.open), 'User-opened execution remains open on subsequent result revisions');
        const raw = action.locator('.execution-raw');
        await raw.locator('summary').click();
        await raw.locator('pre').first().waitFor();
        check((await raw.textContent()).includes('phase A: output line 1'), 'Deduplicated linked stream retains its full raw output');
        equal(await page.locator('.conversation [data-record-id="active-linked"]').count(), 0, 'Linked stream never becomes a duplicate timeline row');
      });

      await scenario(engine, 'live-stream-durable-handoff-preserves-open', {}, async page => {
        const stream = row('tool_stream', 'handoff-stream', 9, {
          name: 'outpost_action', actionId: 'handoff-action', state: 'running', streaming: true,
          arguments: { tool: 'command.run', arguments: { argv: ['/bin/echo', 'handoff'] } }, output: initialOutput,
        }, 0);
        await emit(page, { type: 'live', record: stream });
        const liveEntry = entry(page, stream.id);
        await liveEntry.waitFor();
        check(!(await liveEntry.evaluate(node => node.open)), 'Compact starts new streams collapsed');
        await liveEntry.locator(':scope > summary').click();
        await liveEntry.locator('.execution-raw > summary').click();
        await liveEntry.locator('.execution-raw pre').first().waitFor();
        await emit(page, { type: 'settled', record: row('action', 'handoff-action', 10, {
          tool: 'command.run', state: 'succeeded', arguments: { argv: ['/bin/echo', 'handoff'] }, result: { stdout: replacementOutput, exitCode: 0 },
        }) });
        await emit(page, { type: 'settled', record: { ...stream, revision: 1, data: { ...stream.data, state: 'finished', streaming: false } } });
        await frames(page);
        const completed = entry(page, 'handoff-action');
        check(await completed.evaluate(node => node.open), 'User-opened stream stays open when replaced by its durable completed action');
        check(await completed.locator('.execution-raw').evaluate(node => node.open), 'Nested raw disclosure survives stream/action handoff');
        equal(await liveEntry.count(), 0, 'Completed action replaces its linked stream without duplication');
      });

      await scenario(engine, 'late-linked-output-preserves-disclosure', {}, async page => {
        await emit(page, { type: 'settled', record: row('action', 'late-action', 9, {
          tool: 'host.execute', state: 'dispatching', arguments: { host: 'fixture-host', command: 'printf late-output' },
        }) });
        const action = entry(page, 'late-action');
        await action.waitFor();
        check(!(await action.evaluate(node => node.open)), 'Compact starts unlinked actions collapsed');
        await action.locator(':scope > summary').click();
        await action.locator(':scope > summary').click();
        check(!(await action.evaluate(node => node.open)), 'Reader collapses action before its first linked stream arrives');
        await emit(page, { type: 'live', record: row('tool_stream', 'late-linked', 10, {
          name: 'outpost_action', actionId: 'late-action', state: 'running', streaming: true, output: initialOutput,
        }, 0) });
        await page.waitForFunction(() => document.querySelector('[data-record-id="late-action"] .execution-output')?.textContent.includes('phase A'));
        await frames(page);
        equal(await entry(page, 'late-linked').count(), 0, 'Late linked output is deduplicated');
        check(!(await action.evaluate(node => node.open)), 'Late linked output must not remount and reopen a user-collapsed action');
      });

      await scenario(engine, 'paused-anchor-after-earlier-message-reflow', {}, async page => {
        const viewport = page.locator('.conversation');
        const rect = await viewport.boundingBox();
        const beforeWheel = await viewport.evaluate(node => node.scrollTop);
        await page.mouse.move(rect.x + 8, rect.y + rect.height / 2);
        await page.mouse.wheel(0, -250);
        await page.waitForFunction(top => document.querySelector('.conversation').scrollTop < top - 100 && document.querySelector('.composer-follow').getAttribute('aria-disabled') === 'false', beforeWheel);
        await frames(page);
        const paragraphs = entry(page, 'reply-two').locator('.message-markdown p');
        const visible = await paragraphs.evaluateAll(nodes => {
          const viewport = document.querySelector('.conversation').getBoundingClientRect();
          return nodes.map((node, index) => ({ index, top: node.getBoundingClientRect().top }))
            .find(item => item.top > viewport.top + 80 && item.top < viewport.bottom - 80);
        });
        assert.ok(visible, 'A body paragraph is visible while paused');
        await update(page, 'reply-one-a', { text: 'Earlier evidence expanded.\n\n'.repeat(6) });
        await frames(page);
        near(await paragraphs.nth(visible.index).evaluate(node => node.getBoundingClientRect().top), visible.top, 'Earlier message reflow preserves the visible body paragraph');
        equal(await follow(page).getAttribute('aria-disabled'), 'false', 'Anchor correction does not rearm follow');
      });

      await scenario(engine, 'live-follow-pause-completion-jump', { conversationDetail: 'extended' }, async page => {
        const liveMessage = row('message', 'tail-message', 9, { author: 'assistant', text: 'Live follow paragraph.\n\n'.repeat(12), streaming: true }, 0);
        await emit(page, { type: 'live', record: liveMessage });
        await page.waitForFunction(() => { const node = document.querySelector('.conversation'); return document.querySelector('[data-record-id="tail-message"]') && node.scrollHeight - node.clientHeight - node.scrollTop < 4; });
        check(await gap(page) < 4, 'Live text growth follows to the new bottom');
        const viewport = page.locator('.conversation');
        const beforeWheel = await viewport.evaluate(node => node.scrollTop);
        const rect = await viewport.boundingBox();
        await page.mouse.move(rect.x + 8, rect.y + rect.height / 2);
        await page.mouse.wheel(0, -350);
        await page.waitForFunction(top => document.querySelector('.conversation').scrollTop < top - 100 && document.querySelector('.composer-follow').getAttribute('aria-disabled') === 'false', beforeWheel);
        await frames(page);
        const pausedTop = await viewport.evaluate(node => node.scrollTop);
        const output = entry(page, 'active-action').locator('.execution-output');
        const outputHeight = await output.evaluate(node => node.getBoundingClientRect().height);
        equal(replacementOutput.length, initialOutput.length, 'Fixture really uses a same-length replacement');
        await update(page, 'active-linked', { output: replacementOutput }, 'live');
        await page.waitForFunction(() => document.querySelector('[data-record-id="active-action"] .execution-output').textContent.includes('phase B'));
        await frames(page);
        near(await viewport.evaluate(node => node.scrollTop), pausedTop, 'Same-length output replacement preserves paused viewport');
        near(await output.evaluate(node => node.getBoundingClientRect().height), outputHeight, 'Output height remains fixed across replacements');
        equal(await follow(page).getAttribute('data-unseen'), 'true', 'Same-length replacement signals unseen content');
        await update(page, 'active-action', { state: 'succeeded', result: { stdout: replacementOutput, exitCode: 0 } });
        await update(page, 'active-linked', { output: replacementOutput, streaming: false, state: 'finished' });
        await emit(page, { type: 'settled', record: { ...liveMessage, revision: 1, data: { ...liveMessage.data, streaming: false, text: liveMessage.data.text + '\nCompleted while you were reading history.' } } });
        await update(page, taskId, { state: 'completed' });
        await page.waitForFunction(() => document.querySelector('.composer-run-label').textContent === 'Completed');
        await frames(page);
        near(await viewport.evaluate(node => node.scrollTop), pausedTop, 'Completion does not move the paused reader');
        equal(await follow(page).getAttribute('aria-disabled'), 'false', 'Completion and own scroll corrections do not rearm follow');
        await screenshot(page, `${engine.name()}-paused-completion`);
        await follow(page).click();
        await page.waitForFunction(() => { const node = document.querySelector('.conversation'); return node.scrollHeight - node.clientHeight - node.scrollTop < 4; });
        equal(await follow(page).getAttribute('aria-disabled'), 'true', 'Jump resumes following');
        equal(await follow(page).getAttribute('data-unseen'), 'false', 'Jump clears unseen updates');
      });

      // Explicit completion and cancellation retire; approval/offline notices below do not.
      for (const [state, label, name] of [
        ['completed', 'Completed', 'terminal'], ['cancelled', 'Cancelled', 'cancelled'],
      ]) await scenario(engine, `${name}-four-second-retirement`, { clock: true }, async page => {
        await page.getByRole('button', { name: 'Stop task', exact: true }).focus();
        await freeze(page);
        const before = await geometry(page);
        await update(page, taskId, { state });
        await waitClock(page, expected => document.querySelector('.composer-run-label').textContent === expected, `${label} status was not rendered`, label);
        equal(await page.locator('.composer-run-status').getAttribute('data-visible'), 'true', `${label} status initially visible`);
        check(await follow(page).evaluate(node => node === document.activeElement), 'Stop focus hands off to Jump before Stop is hidden');
        sameGeometry(before, await geometry(page), `${label} transition has no layout shift`);
        await page.clock.runFor(3998);
        equal(await page.locator('.composer-run-status').getAttribute('data-visible'), 'true', `${label} status survives almost four seconds`);
        await page.clock.runFor(3);
        await waitClock(page, () => document.querySelector('.composer-run-status').dataset.visible === 'false', `${label} status did not retire after four seconds`);
        check(await page.locator('.composer-run-status').evaluate(node => node.inert && node.getAttribute('aria-hidden') === 'true'), 'Retired status is inert and excluded from accessibility');
        sameGeometry(before, await geometry(page), `${label} retirement has no layout shift`);
        check(await follow(page).isVisible(), 'Jump remains available after status retirement');
        await screenshot(page, `${engine.name()}-${name}-retired`);
      });

      await scenario(engine, 'approval-status-persistent', { clock: true, approval: true }, async page => {
        equal(await page.locator('.composer-run-label').textContent(), 'Waiting for approval', 'Approval takes precedence over active work');
        await freeze(page);
        await page.clock.runFor(6000);
        equal(await page.locator('.composer-run-status').getAttribute('data-visible'), 'true', 'Approval status remains visible past retirement duration');
        check(await page.getByRole('button', { name: 'Review (1)', exact: true }).isVisible(), 'Approval review remains available');
      });

      await scenario(engine, 'offline-status-persistent-and-stop-guard', { clock: true, allowMutations: true }, async page => {
        await freeze(page);
        await page.evaluate(() => window.__unified.disconnect());
        await waitClock(page, () => document.querySelector('.composer-run-label').textContent === 'Offline · read-only', 'Offline status was not rendered');
        await page.clock.runFor(6000);
        equal(await page.locator('.composer-run-status').getAttribute('data-visible'), 'true', 'Offline status remains visible');
        equal(await page.locator('.composer-run-label').textContent(), 'Offline · read-only', 'Reconnect attempts do not misrepresent offline as success');
        equal(await page.getByRole('button', { name: 'Stop task', exact: true }).getAttribute('aria-disabled'), 'true', 'Stop is guarded offline');
        await page.locator('.composer-run-stop').evaluate(node => node.click());
        equal(await page.evaluate(() => window.__unified.commands), [], 'Offline Stop cannot issue a mutation');
      });

      await scenario(engine, 'stop-exact-command-and-busy-guard', { allowMutations: true }, async (page, dialogs) => {
        await page.evaluate(() => { window.__unified.holdCommands = true; });
        const stop = page.getByRole('button', { name: 'Stop task', exact: true });
        await stop.click();
        await page.waitForFunction(() => window.__unified.commands.length === 1);
        equal(dialogs, [{ type: 'confirm', message: 'Cancel this task? Completed changes will not be undone.' }], 'Stop confirms cancellation without promising rollback');
        equal(await page.evaluate(() => window.__unified.commands[0]), { command: 'environment_send_command', args: { environmentId, kind: 'task.cancel', id: taskId, revision: 41, payload: {} } }, 'Stop sends the exact owner, task, revision, and empty payload');
        await page.waitForFunction(() => document.querySelector('.composer-run-stop').getAttribute('aria-disabled') === 'true');
        await stop.evaluate(node => node.click());
        await frames(page);
        equal(await page.evaluate(() => window.__unified.commands.length), 1, 'Busy Stop cannot send twice');
        equal(dialogs.length, 1, 'Busy Stop does not prompt again');
        await page.evaluate(() => window.__unified.release());
        await page.waitForFunction(() => document.querySelector('.composer-run-label').textContent === 'Cancelled');
        check(await page.locator('.composer-run-stop').evaluate(node => node.hidden), 'Cancelled task hides Stop');
        await page.locator('.composer-run-stop').evaluate(node => node.click());
        equal(await page.evaluate(() => window.__unified.commands.length), 1, 'Closed task remains mutation-guarded');
      });

      for (const [name, options] of [
        ['pending', { pending: true }], ['pending-error', { pendingError: 'Synthetic unresolved recovery' }], ['retired-legacy', { retired: true }], ['recorded-preview', { preview: true }],
      ]) await scenario(engine, `stop-guard-${name}`, { ...options, allowMutations: true }, async (page, dialogs) => {
        if (options.preview) {
          await page.evaluate(() => { window.__OUTPOST_RECORDED_PREVIEW__ = {}; });
          await update(page, taskId, { blocker: 'Read-only preview fixture' });
        }
        await page.waitForFunction(() => document.querySelector('.composer-run-stop').getAttribute('aria-disabled') === 'true');
        await page.locator('.composer-run-stop').evaluate(node => node.click());
        await frames(page);
        equal(await page.evaluate(() => window.__unified.commands), [], `${name} blocks cancellation even if activation is dispatched directly`);
        equal(dialogs, [], `${name} blocks cancellation before confirmation`);
      });

      await scenario(engine, 'approval-stale-review-and-exact-payload', { approval: true, allowMutations: true }, async page => {
        await page.getByRole('button', { name: 'Review (1)', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Review the exact action' });
        await dialog.waitFor();
        equal(await dialog.locator('.action-body > pre').first().textContent(), JSON.stringify(approval().data.arguments, null, 2), 'Review displays exact command arguments');
        const changed = approval(18);
        await emit(page, { type: 'settled', record: changed });
        await dialog.getByText('The action has updated: pending. Close this review to see its current state.', { exact: true }).waitFor();
        equal(await dialog.getByRole('button', { name: 'Approve', exact: true }).count(), 0, 'A stale review removes its approval controls');
        equal(await page.evaluate(() => window.__unified.commands), [], 'Stale review never sends approval');
        await dialog.getByRole('button', { name: 'Close review', exact: true }).click();
        await page.getByRole('button', { name: 'Review (1)', exact: true }).click();
        await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
        await page.waitForFunction(() => window.__unified.commands.length === 1);
        equal(await page.evaluate(() => window.__unified.commands[0]), { command: 'environment_send_command', args: { environmentId, kind: 'approval.decide', id: changed.id, revision: 18, payload: { nonce: changed.data.nonce, actionDigest: changed.data.actionDigest, decision: 'approve' } } }, 'Fresh review approves exact nonce, digest and revision');
      });

      await scenario(engine, 'approval-deny-and-authorized-dispatch', { approval: true, allowMutations: true }, async page => {
        await page.getByRole('button', { name: 'Review (1)', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Review the exact action' });
        await dialog.getByRole('button', { name: 'Deny', exact: true }).click();
        await page.waitForFunction(() => window.__unified.commands.length === 1);
        equal(await page.evaluate(() => window.__unified.commands[0]), { command: 'environment_send_command', args: { environmentId, kind: 'approval.decide', id: 'approval-action', revision: 17, payload: { nonce: 'fixture-nonce-17', actionDigest: 'fixture-digest-17', decision: 'deny' } } }, 'Deny retains nonce/digest/revision');
        await dialog.getByText(/The action has updated/).waitFor();
        await dialog.getByRole('button', { name: 'Close review', exact: true }).click();
        await emit(page, { type: 'settled', record: approval(19, 'authorized') });
        await entry(page, 'approval-action').getByRole('button', { name: 'Review', exact: true }).click();
        await dialog.getByRole('button', { name: 'Run approved action', exact: true }).click();
        await page.waitForFunction(() => window.__unified.commands.length === 2);
        equal(await page.evaluate(() => window.__unified.commands[1]), { command: 'environment_send_command', args: { environmentId, kind: 'action.dispatch', id: 'approval-action', revision: 19, payload: {} } }, 'Dispatch retains exact action revision without altering arguments');
      });

      await scenario(engine, 'composer-controls-and-steering', { allowMutations: true }, async page => {
        await page.getByLabel('Task control mode', { exact: true }).selectOption('auto');
        await page.waitForFunction(() => window.__unified.commands.length === 1);
        equal(await page.evaluate(() => window.__unified.commands[0]), { command: 'environment_send_command', args: { environmentId, kind: 'policy.change', id: taskId, revision: 3, payload: { mode: 'auto' } } }, 'Permission control keeps its original mutation contract');
        await page.waitForFunction(() => !document.querySelector('[aria-label="Attach file"]').disabled);
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Attach file', exact: true }).click();
        check((await chooser).isMultiple() === false, 'Attach still opens the native single-file chooser');
        await page.getByRole('textbox', { name: 'Message Outpost', exact: true }).fill('  Keep the existing evidence and continue.  ');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await page.waitForFunction(() => window.__unified.commands.length === 2);
        equal(await page.evaluate(() => window.__unified.commands[1]), { command: 'environment_send_command', args: { environmentId, kind: 'task.steer', id: taskId, revision: 41, payload: { text: 'Keep the existing evidence and continue.' } } }, 'Send preserves trimming and task/revision routing');
        await page.waitForFunction(() => document.querySelector('[aria-label="Message Outpost"]').value === '');
        check(await gap(page) < 4, 'Successful steering clears the composer and jumps to latest');
      });
    } finally { await browser.close(); browser = undefined; }
  }
} finally {
  clearTimeout(deadline);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log(`\n${assertions} assertions passed across ${cases} cases; ${failures.length} case(s) failed.`);
for (const failure of failures) console.error(`${failure.browser} / ${failure.name}: ${failure.message}`);
if (!cases) { console.error('No cases matched OUTPOST_TEST_FILTER'); process.exitCode = 1; }
if (failures.length) process.exitCode = 1;
