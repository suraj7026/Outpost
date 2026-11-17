import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { openSettings } from './settings-test-navigation.mjs';
import { openInitialTestChat } from './chat-test-navigation.mjs';

// Build first, then run: node desktop/test-conversation-detail.mjs
// Optional: OUTPOST_TEST_BROWSER=chromium|webkit, OUTPOST_TEST_FILTER=<case substring>, OUTPOST_TEST_DIST=<built directory>.
// Embedded synthetic IPC only; no recorded preview, real server, or execution is required.
const desktop = dirname(fileURLToPath(import.meta.url));
const root = process.env.OUTPOST_TEST_DIST ? resolve(process.env.OUTPOST_TEST_DIST) : resolve(desktop, 'dist');
const storageKey = 'outpost.appearance.v1';
const environmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const taskId = 'detail-task';
const otherTaskId = 'detail-other-task';
const epoch = Date.parse('2026-11-15T12:00:00Z');
const engines = process.env.OUTPOST_TEST_BROWSER ? [({ chromium, webkit })[process.env.OUTPOST_TEST_BROWSER]] : [chromium, webkit];
assert.ok(engines.every(Boolean), 'OUTPOST_TEST_BROWSER must be chromium or webkit');
assert.ok(existsSync(resolve(root, 'index.html')), 'Build desktop/dist before running conversation-detail tests');

const row = (kind, id, second, data, revision = 1) => ({
  kind, id, revision, updatedAt: new Date(epoch + second * 1000).toISOString(),
  data: { taskId, startedAt: epoch + second * 1000, ...data },
});
const toolTypes = [
  { key: 'browser', tool: 'browser.navigate', arguments: { url: 'https://fixture.invalid/read-only' } },
  { key: 'file', tool: 'file.write', arguments: { path: 'fixture.txt', text: 'Exact synthetic content', expectedHash: null } },
  { key: 'custom', tool: 'fixture.inspect', arguments: { scope: 'synthetic', limit: 3 } },
];
const approval = state => row('action', 'approval-action', 30, {
  tool: 'host.execute', state, target: 'fixture-host',
  arguments: { host: 'fixture-host', command: 'printf exact-approval-fixture' },
  nonce: 'detail-nonce', actionDigest: 'detail-digest',
}, 17);
function fixture(options) {
  const records = [
    row('task', taskId, 0, { goal: 'Conversation detail fixture', profile: 'code', state: 'running', model: 'fixture:cloud' }),
    row('policy', taskId, 0, { mode: 'ask_permission' }),
    row('message', 'owner', 1, { author: 'owner', text: 'Inspect synthetic evidence only.' }),
    row('message', 'history-reasoning-one', 2, { author: 'assistant', text: 'Normal reply stays visible.', thinking: 'First historical reasoning segment.' }),
    row('action', 'history-one', 3, { tool: 'file.read', state: 'succeeded', arguments: { path: 'first.txt' }, result: { text: 'First historical result' } }),
    row('action', 'history-two', 4, { tool: 'browser.navigate', state: 'succeeded', arguments: { url: 'https://fixture.invalid/history' }, result: { result: 'Second historical result' } }),
    row('message', 'history-reasoning-two', 5, { author: 'assistant', text: 'Another ordinary answer.', thinking: 'Second historical reasoning segment.' }),
    row('tool_stream', 'history-failed', 6, { name: 'outpost_action', state: 'error', streaming: false, arguments: { tool: 'fixture.inspect', arguments: { scope: 'old' } }, output: 'Synthetic historical failure' }),
    row('task', otherTaskId, -10, { taskId: otherTaskId, goal: 'Another detail conversation', profile: 'code', state: 'paused' }),
    row('message', 'other-owner', -9, { taskId: otherTaskId, author: 'owner', text: 'Other chat fixture.' }),
    row('message', 'other-reasoning', -8, { taskId: otherTaskId, author: 'assistant', text: 'Other normal reply.', thinking: 'Other historical reasoning.' }),
    row('action', 'other-history-one', -7, { taskId: otherTaskId, tool: 'file.read', state: 'succeeded', arguments: { path: 'other.txt' }, result: { text: 'Other result' } }),
    row('action', 'other-history-two', -6, { taskId: otherTaskId, tool: 'fixture.inspect', state: 'succeeded', arguments: { scope: 'other' }, result: { result: 'Other inspection' } }),
  ];
  for (const [index, type] of toolTypes.entries()) {
    records.push(row('tool_stream', `stream-${type.key}`, 10 + index * 2, {
      name: 'outpost_action', state: 'running', streaming: true,
      arguments: { tool: type.tool, arguments: type.arguments }, output: `${type.key} stream output`,
    }));
    records.push(row('action', `action-${type.key}`, 11 + index * 2, {
      tool: type.tool, state: 'dispatching', arguments: type.arguments, result: null,
    }));
  }
  if (options.approval) records.push(approval(options.approval));
  return records.reverse();
}

function installTransport({ records, options, storageKey, environmentId }) {
  if (!sessionStorage.getItem('detail-fixture-seeded')) {
    if (options.stored !== undefined) localStorage.setItem(storageKey, options.stored);
    sessionStorage.setItem('detail-fixture-seeded', 'true');
  }
  // Fail only appearance storage, so unrelated navigation storage remains usable.
  for (const method of options.storageFailure === 'read' ? ['getItem'] : options.storageFailure === 'write' ? ['setItem'] : []) {
    const original = Storage.prototype[method];
    Storage.prototype[method] = function (key, ...args) {
      if (this === window.localStorage && key === storageKey) throw new Error('Synthetic appearance storage failure');
      return original.call(this, key, ...args);
    };
  }
  const callbacks = new Map(), live = new Map();
  let sequence = 0, channel, index = 0;
  const key = record => `${record.kind}:${record.id}`;
  const control = window.__detail = {
    records, cursor: 1, ready: false, commands: [], unexpected: [],
    emit(frame) {
      if (frame.type === 'live') live.set(key(frame.record), frame.record);
      else {
        for (const record of frame.type === 'records' ? frame.records : [frame.record]) {
          this.records = [...this.records.filter(item => key(item) !== key(record)), record];
          live.delete(key(record));
        }
        this.cursor++;
        if (frame.type === 'records') frame.cursor = this.cursor;
      }
      if (!channel || !callbacks.has(channel.id)) throw new Error('Synthetic stream is not attached');
      callbacks.get(channel.id)({ index: index++, message: frame });
    },
    record(kind, id) { return live.get(`${kind}:${id}`) ?? this.records.find(record => record.kind === kind && record.id === id); },
  };
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    async invoke(wireCommand, args = {}) {
      if (wireCommand === 'environment_list') return {
        registry: { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: environmentId,
          environments: { [environmentId]: { environmentId, label: 'Detail fixture', activeRoute: 'https://fixture.invalid', routes: ['https://fixture.invalid'] } } },
        legacy: { endpoint: null, pending: false },
      };
      if (wireCommand === 'plugin:window|set_theme' && args.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
      if (wireCommand.startsWith('plugin:event|')) return 1;
      if (['set_sidebar_window_controls', 'set_window_blur', 'update_sidebar'].includes(wireCommand)) return;
      if (wireCommand === 'sidebar_pointer_inside') return false;
      if (['setup_list', 'setup_history_list'].includes(wireCommand)) return [];
      if (wireCommand === 'automatic_updates_status' || wireCommand === 'automatic_updates_tick') return { enabled: false, targets: [], activeEnvironmentId: null, servers: [] };
      const bound = wireCommand.startsWith('environment_');
      if (bound && args.environmentId !== environmentId) throw new Error('Wrong synthetic environment owner');
      const command = bound ? wireCommand.slice('environment_'.length) : wireCommand;
      if (command === 'disconnect') return;
      if (command === 'connection_info') return { endpoint: bound ? 'Synthetic detail transport' : null, deviceId: 'detail-fixture', publicKey: '', pending: false, nativeSidebar: false };
      if (command === 'query') {
        if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: control.cursor, records: structuredClone(control.records) };
        if (args.kind === 'runtime') return { configured: true, model: 'fixture:cloud', hostAdministration: false, unrestrictedCommands: false };
        if (args.kind === 'models') return { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' };
        if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: control.cursor };
      }
      if (command === 'stream_events') {
        if (!bound) return new Promise(() => {});
        channel = args.channel; index = 0;
        callbacks.get(channel.id)({ index: index++, message: { type: 'snapshot', records: structuredClone(control.records), live: [...live.values()], cursor: control.cursor } });
        control.ready = true;
        return new Promise(() => {});
      }
      if (bound && command === 'artifact' && args.id === 'boundary-image' && args.hash === 'synthetic-boundary-image') {
        const canvas = document.createElement('canvas');
        canvas.width = 80; canvas.height = 50;
        const context = canvas.getContext('2d');
        context.fillStyle = '#446688'; context.fillRect(0, 0, 80, 50);
        return canvas.toDataURL('image/png').split(',')[1];
      }
      if (command === 'send_command') control.commands.push({ command: wireCommand, args });
      control.unexpected.push({ command: wireCommand, args });
      throw new Error(`Unexpected IPC (execution is forbidden): ${wireCommand}`);
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
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, checks = 0, cases = 0;
const failures = [];
const deadline = setTimeout(() => {
  console.error('Conversation detail suite exceeded its 300-second bound');
  process.exitCode = 1;
  void browser?.close(); server.closeAllConnections(); server.close();
}, 300_000);
deadline.unref();
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const check = (value, message) => { assert.ok(value, message); checks++; };
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function screenshot(page, name) {
  if (!process.env.OUTPOST_TEST_SCREENSHOTS) return;
  mkdirSync(process.env.OUTPOST_TEST_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: resolve(process.env.OUTPOST_TEST_SCREENSHOTS, `${name}.png`) });
}
const entry = (page, id) => page.locator(`.conversation .execution-entry[data-record-id="${id}"]`);
const reasoning = page => page.locator('.conversation .run-reasoning');
const activity = (page, id) => page.locator('.conversation .activity-group').filter({ has: page.locator(`.execution-entry[data-record-id="${id}"]`) });
const history = page => page.locator('.conversation .activity-group').filter({ has: page.locator('.execution-entry:is([data-record-id="history-one"], [data-record-id="other-history-one"])') });
async function rememberExecution(page, id) {
  await entry(page, id).evaluate((node, key) => {
    window.__activityNodes ??= new Map();
    window.__activityNodes.set(key, { row: node, stack: node.parentElement, group: node.closest('.activity-group') });
  }, id);
}
async function sameExecution(page, id, original = id) {
  equal(await entry(page, id).evaluate((node, key) => {
    const saved = window.__activityNodes.get(key);
    return { row: node === saved.row, stack: node.parentElement === saved.stack, group: node.closest('.activity-group') === saved.group, connected: saved.row.isConnected && saved.group.isConnected };
  }, original), { row: true, stack: true, group: true, connected: true }, `${original} → ${id}: row, stack and group keep their DOM identity`);
}
async function freshRun(page, id, second = 40) {
  await emit(page, { type: 'settled', record: row('message', id, second, { author: 'owner', text: `Inspect ${id}.` }) });
  return page.locator(`.conversation-run[data-run-id="run:after:${id}"]`);
}
const actionRecord = (id, second, state = 'running', data = {}) => row('action', id, second, {
  tool: 'command.run', arguments: { argv: ['printf', id] }, state, ...data,
});
const streamRecord = (id, second, data = {}) => row('tool_stream', id, second, {
  name: 'outpost_action', arguments: { tool: 'command.run', arguments: { argv: ['printf', id] } }, state: 'running', streaming: true, output: 'Partial synthetic output', ...data,
}, 0);
const interleavedCalls = [
  { tool: 'command.run', arguments: { argv: ['pwd'] } },
  { tool: 'web.search', arguments: { query: 'synthetic documentation' } },
  { tool: 'web.fetch', arguments: { url: 'https://fixture.invalid/documentation' } },
  { name: 'fetch', arguments: { url: 'https://fixture.invalid/content' } },
  { tool: 'command.run', arguments: { argv: ['mkdir', 'synthetic-output'] } },
  { name: 'write', arguments: { path: 'synthetic-output/result.txt', content: 'Synthetic result' } },
];
const interleavedRecords = interleavedCalls.flatMap((call, index) => [
  row('message', `step-placeholder-${index}`, 41 + index * 2, { author: 'assistant', text: '', streaming: false }),
  row(call.tool ? 'action' : 'tool_stream', `step-call-${index}`, 42 + index * 2, call.tool
    ? { ...call, state: 'succeeded', result: { stdout: `Retained output ${index}`, exitCode: 0 } }
    : { ...call, state: index === 5 ? 'preparing' : 'finished', streaming: index === 5, output: `Retained output ${index}` }),
]);
const detailGroup = page => page.getByRole('group', { name: 'Conversation detail', exact: true });
const radio = (page, name) => detailGroup(page).getByRole('radio', { name, exact: true });
const saved = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey);
async function emit(page, frame) { await page.evaluate(frame => window.__detail.emit(frame), frame); await frames(page); }
async function update(page, kind, id, data, type = 'settled') {
  const previous = await page.evaluate(({ kind, id }) => window.__detail.record(kind, id), { kind, id });
  assert.ok(previous, `Fixture record ${kind}:${id} exists`);
  const next = { ...previous, revision: type === 'live' ? previous.revision : previous.revision + 1, data: { ...previous.data, ...data } };
  await emit(page, { type, record: next });
  return next;
}
async function openState(locator, expected, message) {
  await locator.waitFor({ state: 'attached' });
  equal(await locator.evaluate(node => node.open), expected, message);
}
async function toggle(locator, key = 'Enter') {
  await locator.locator(':scope > summary').focus();
  await locator.page().keyboard.press(key);
  await frames(locator.page());
}
async function chat(page, id = taskId) {
  if (await page.locator('.web-sidebar').getAttribute('aria-hidden') === 'true') await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await page.locator(`.chat-server-group[data-server-id="${environmentId}"] button[data-task-id="${id}"]`).click();
  await page.locator('.task-unified .conversation').waitFor();
  await page.locator(`.conversation [data-record-id="${id === taskId ? 'owner' : 'other-owner'}"]`).waitFor();
  await frames(page);
}
async function appearance(page) { await openSettings(page, { page: 'appearance' }); await detailGroup(page).waitFor(); }
async function setDetail(page, name) {
  await appearance(page);
  await radio(page, name).check();
  await frames(page);
  await chat(page);
}
async function defaults(page, extended, other = false) {
  const entries = page.locator('.conversation .execution-entry');
  equal(await entries.count(), other ? 2 : 9, 'All historical and active execution rows are retained');
  check(await entries.evaluateAll((nodes, expected) => nodes.every(node => node.open === expected), extended), 'Every execution kind obeys the detail default');
  equal(await reasoning(page).count(), 1, 'Reasoning stays one aggregate per run');
  await openState(reasoning(page), extended, 'Aggregate reasoning obeys the detail default');
  equal(await reasoning(page).locator('.reasoning-segments pre').count(), other ? 1 : 2, 'All reasoning segments are retained');
  equal(await page.locator('.conversation .activity-group').count(), other ? 1 : 2, 'Consecutive action and stream records share a group without crossing message boundaries');
  equal(await page.locator('.conversation .activity-group > summary + .activity-stack > .execution-entry').count(), other ? 2 : 9, 'Every execution row lives in the activity stack');
  equal(await history(page).count(), 1, 'Consecutive completed history retains its outer disclosure');
  if (!other) {
    await openState(activity(page, 'history-failed'), true, 'Active and failed work remains expanded regardless of preference');
    equal(await activity(page, 'history-failed').locator('.execution-entry').count(), 7, 'Failure and consecutive live action/stream rows share one stack');
  }
  await openState(history(page), extended, 'Historical outer group obeys the detail default');
  equal(await entry(page, other ? 'other-history-one' : 'history-one').locator(':scope > summary').isVisible(), extended, 'History rows are visible only through the expanded outer group');
  equal(await reasoning(page).locator(':scope > summary').getByText('Thinking', { exact: true }).count(), 1, 'Settled reasoning says Thinking, not an invented duration');
  check(await page.getByText(other ? 'Other normal reply.' : 'Normal reply stays visible.', { exact: true }).isVisible(), 'Normal assistant replies are never collapsed');
}
async function scenario(engine, name, options, run) {
  if (process.env.OUTPOST_TEST_FILTER && !name.includes(process.env.OUTPOST_TEST_FILTER)) return;
  cases++;
  const page = await browser.newPage({ viewport: { width: options.width ?? 1440, height: 1000 }, colorScheme: options.scheme ?? 'dark', reducedMotion: options.reducedMotion ?? 'no-preference' });
  page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10000);
  const errors = [], remote = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('**/*', route => {
      // WebKit routes local Blob previews too; these contain synthetic IPC bytes, not network requests.
      if (route.request().url().startsWith(origin + '/') || route.request().url().startsWith(`blob:${origin}/`)) return route.continue();
      remote.push(route.request().url()); return route.abort();
    });
    await page.addInitScript(installTransport, { records: [...fixture(options), ...(options.records ?? [])], options, storageKey, environmentId });
    await page.goto(origin);
    await page.waitForFunction(() => window.__detail.ready);
    await openInitialTestChat(page);
    await chat(page);
    await run(page);
    equal(await page.evaluate(() => window.__detail.commands), [], 'Preferences and disclosure inspection never execute or approve work');
    equal(await page.evaluate(() => window.__detail.unexpected), [], 'No unexpected fixture IPC');
    equal(remote, [], 'No requests leave the synthetic local server');
    equal(errors, [], 'No browser runtime errors');
    console.log(`PASS ${engine.name()} / ${name}`);
  } catch (error) {
    failures.push(`${engine.name()} / ${name}: ${error.message}`);
    console.error(`FAIL ${engine.name()} / ${name}\n${error.stack}`);
    if (errors.length) console.error('PAGE ERRORS', errors);
    if (remote.length) console.error('BLOCKED REQUESTS', remote);
    const unexpected = await page.evaluate(() => window.__detail?.unexpected);
    if (unexpected?.length) console.error('UNEXPECTED IPC', unexpected);
    if (name.includes('text-image-empty-and-owner-boundaries')) console.error('IMAGE BOUNDARY', await page.locator('#artifact-boundary-image').evaluateAll(nodes => nodes.map(node => ({
      text: node.textContent, bounds: node.getBoundingClientRect().toJSON(),
      images: [...node.querySelectorAll('img')].map(image => ({ complete: image.complete, width: image.naturalWidth, src: image.currentSrc })),
    }))));
  } finally { await page.close(); }
}

try {
  for (const engine of engines) {
    browser = await engine.launch();
    try {
      for (const [name, stored] of [
        ['absent', undefined], ['missing-field', JSON.stringify({ theme: 'light', conversationWidth: 'wide' })],
        ['invalid-string', '{"conversationDetail":"Expanded"}'], ['invalid-boolean', '{"conversationDetail":true}'],
        ['invalid-number', '{"conversationDetail":1}'], ['invalid-null', '{"conversationDetail":null}'],
        ['null-preferences', 'null'], ['malformed-json', '{broken'], ['explicit-compact', '{"conversationDetail":"compact"}'],
      ]) await scenario(engine, `compact-default-${name}`, { stored }, async page => {
        await defaults(page, false);
        await appearance(page);
        equal(await detailGroup(page).evaluate(node => node.tagName), 'FIELDSET', 'Detail options use a native fieldset');
        equal(await detailGroup(page).locator(':scope > legend').textContent(), 'Conversation detail', 'Native group has an accessible legend');
        equal(await detailGroup(page).getByRole('radio').count(), 2, 'Exactly Compact and Extended are offered');
        check(await radio(page, 'Compact').isChecked(), 'Missing or invalid preferences select Compact');
        equal(await detailGroup(page).getByRole('radio').evaluateAll(nodes => nodes.map(node => ({ tag: node.tagName, type: node.type, name: node.name }))), [
          { tag: 'INPUT', type: 'radio', name: 'conversation-detail' }, { tag: 'INPUT', type: 'radio', name: 'conversation-detail' },
        ], 'Detail selection uses native mutually exclusive radios');
        equal((await saved(page)).conversationDetail, 'compact', 'Sanitized detail preference is saved as compact');
        if (name === 'absent') await screenshot(page, `${engine.name()}-settings`);
      });

      await scenario(engine, 'extended-persisted-reload-and-chat-navigation', { stored: JSON.stringify({ conversationDetail: 'extended', theme: 'light', conversationWidth: 'wide', opacity: 61 }) }, async page => {
        await defaults(page, true);
        await chat(page, otherTaskId); await defaults(page, true, true);
        await chat(page); await defaults(page, true);
        await page.reload(); await page.waitForFunction(() => window.__detail.ready); await chat(page);
        await defaults(page, true);
        await appearance(page);
        check(await radio(page, 'Extended').isChecked(), 'Stored Extended survives full reload and navigation');
        const preferences = await saved(page);
        equal({ detail: preferences.conversationDetail, theme: preferences.theme, width: preferences.conversationWidth, opacity: preferences.opacity },
          { detail: 'extended', theme: 'light', width: 'wide', opacity: 61 }, 'Detail preserves unrelated appearance preferences');
      });

      await scenario(engine, 'keyboard-selection-and-settings-reset-row-choices', {}, async page => {
        await toggle(entry(page, 'action-browser'));
        await toggle(reasoning(page));
        await toggle(history(page), 'Space');
        await toggle(entry(page, 'action-browser'));
        await toggle(reasoning(page)); await toggle(history(page));
        await openState(entry(page, 'action-browser'), false, 'Compact has an explicit manual closed choice to reset');
        await appearance(page);
        await radio(page, 'Compact').focus(); await page.keyboard.press('ArrowRight'); await frames(page);
        check(await radio(page, 'Extended').isChecked(), 'ArrowRight selects Extended without a mouse');
        equal((await saved(page)).conversationDetail, 'extended', 'Keyboard selection is persisted');
        await chat(page); await defaults(page, true);
        await toggle(entry(page, 'action-browser'), 'Space');
        await toggle(reasoning(page)); await toggle(history(page));
        await openState(entry(page, 'action-browser'), false, 'Extended still permits manually closing a row');
        await toggle(entry(page, 'action-browser'));
        await toggle(reasoning(page)); await toggle(history(page));
        await openState(entry(page, 'action-browser'), true, 'Extended has an explicit manual open choice to reset');
        await appearance(page);
        await radio(page, 'Extended').focus(); await page.keyboard.press('ArrowLeft'); await frames(page);
        check(await radio(page, 'Compact').isChecked(), 'ArrowLeft selects Compact');
        await chat(page); await defaults(page, false);
        await toggle(entry(page, 'action-file'));
        await setDetail(page, 'Extended'); await defaults(page, true);
        await page.reload(); await page.waitForFunction(() => window.__detail.ready); await chat(page);
        await defaults(page, true);
      });

      for (const mode of ['compact', 'extended']) {
        const extended = mode === 'extended';
        const options = { stored: JSON.stringify({ conversationDetail: mode }) };
        await scenario(engine, `${mode}-manual-disclosures-streaming-and-action-linking`, options, async page => {
          await defaults(page, extended);
          for (const type of toolTypes) {
            for (const kind of ['tool_stream', 'action']) {
              const id = `${kind === 'action' ? 'action' : 'stream'}-${type.key}`;
              const details = entry(page, id);
              await rememberExecution(page, id);
              await toggle(details);
              await update(page, kind, id, kind === 'action' ? { state: 'running', result: { stdout: 'First action revision' } } : { output: 'First stream revision' }, kind === 'action' ? 'settled' : 'live');
              await openState(details, !extended, `${kind}/${type.key}: manual choice survives updates`);
              await toggle(details, 'Space');
              await update(page, kind, id, kind === 'action' ? { result: { stdout: 'Second action revision' } } : { output: 'Second stream revision' }, kind === 'action' ? 'settled' : 'live');
              await openState(details, extended, `${kind}/${type.key}: reversing the manual choice also survives updates`);
              if (kind === 'tool_stream') {
                await toggle(details);
                const linkedId = `linked-${type.key}`;
                await update(page, kind, id, { actionId: linkedId }, 'live');
                await emit(page, { type: 'settled', record: row('action', linkedId, 25, { tool: type.tool, state: 'dispatching', arguments: type.arguments }) });
                equal(await details.count(), 0, 'Linked stream is replaced, not duplicated');
                await openState(entry(page, linkedId), !extended, `${type.key}: stream-to-action linking preserves the reader choice`);
                await sameExecution(page, linkedId, id);
                await update(page, kind, id, { streaming: false, state: 'finished' });
                await update(page, 'action', linkedId, { state: 'succeeded', result: { stdout: 'Linked final result', exitCode: 0 } });
                await openState(entry(page, linkedId), !extended, `${type.key}: linked completion does not reset the disclosure`);
                await sameExecution(page, linkedId, id);
              } else {
                await update(page, kind, id, { state: 'succeeded', result: { stdout: 'Final result', exitCode: 0 } });
                await openState(details, extended, `${type.key}: action completion preserves the reader choice`);
                await sameExecution(page, id);
              }
            }
          }
          await toggle(history(page));
          await update(page, 'action', 'history-one', { result: { text: 'Historical revision' } });
          await openState(history(page), !extended, 'Manual outer history choice survives child updates');
          await toggle(history(page));
          await update(page, 'action', 'history-two', { result: { result: 'Another historical revision' } });
          await openState(history(page), extended, 'Both outer disclosure choices persist');
          await toggle(reasoning(page));
          await update(page, 'message', 'history-reasoning-one', { thinking: 'Updated historical reasoning.' });
          await openState(reasoning(page), !extended, 'Manual aggregate reasoning choice survives updates');
          await toggle(reasoning(page));
          await update(page, 'message', 'history-reasoning-two', { thinking: 'Another reasoning revision.' });
          await openState(reasoning(page), extended, 'Both aggregate reasoning choices persist');
          equal(await reasoning(page).count(), 1, 'Updates never split the per-run aggregate');
        });

        await scenario(engine, `${mode}-activity-uninspected-lifecycle-and-explicit-expansion`, options, async page => {
          const run = await freshRun(page, 'activity-owner');
          await emit(page, { type: 'live', record: streamRecord('activity-first', 41) });
          const group = activity(page, 'activity-first');
          await rememberExecution(page, 'activity-first');
          equal(await group.getAttribute('data-single'), 'true', 'The first singleton already owns its stable group');
          equal(await group.locator(':scope > summary').isVisible(), false, 'Singleton hides only the redundant outer summary');
          check(await entry(page, 'activity-first').locator(':scope > summary').isVisible(), 'Singleton row stays visible');
          await openState(group, true, 'Singleton wrapper is open in both modes');

          await emit(page, { type: 'settled', record: actionRecord('activity-second', 42) });
          await sameExecution(page, 'activity-first');
          equal(await run.locator('.activity-group').count(), 1, 'Appending active work grows the existing stack');
          equal(await group.getAttribute('data-single'), 'false', 'Second row reveals the outer summary');
          check(await group.locator(':scope > summary').isVisible(), 'Multi-row summary is visible');
          equal(await group.locator('.activity-group-title').textContent(), 'Working', 'Active-only group is working, not complete');
          equal(await group.locator('.activity-group-progress').textContent(), '0 of 2 actions complete', 'Progress does not count active work as success');
          equal(await group.locator(':scope > .activity-stack > .execution-entry').count(), 2, 'Action and stream occupy the same stack');
          await screenshot(page, `${engine.name()}-${mode}-activity-live`);
          await update(page, 'tool_stream', 'activity-first', { state: 'finished', streaming: false });
          await openState(group, true, 'Completing one row cannot collapse remaining active work');
          equal(await group.locator('.activity-group-progress').textContent(), '1 of 2 actions complete', 'Only the completed row is counted');
          await update(page, 'action', 'activity-second', { state: 'succeeded', result: { stdout: 'Completed second action', exitCode: 0 } });
          await openState(group, extended, 'Without any group or row interaction, last completion follows the detail default');
          equal(await group.locator('.activity-group-title').textContent(), '2 actions completed', 'All-complete summary has an accurate count');
          equal(await group.locator('.thinking-indicator[data-active="true"]').count(), 0, 'Completed group has no stale activity indicator');
          await sameExecution(page, 'activity-first');
          if (extended) await toggle(group, 'Space');
          await openState(group, false, 'Completed group can be collapsed with the keyboard');
          await emit(page, { type: 'live', record: streamRecord('activity-third', 43) });
          await openState(group, true, 'New active work reopens even an explicitly collapsed group');
          check(await entry(page, 'activity-third').locator(':scope > summary').isVisible(), 'Appended active row is visible');
          await sameExecution(page, 'activity-first');
          await toggle(group, 'Enter');
          await openState(group, true, 'Enter cannot hide active work');
          await toggle(group, 'Space');
          await openState(group, true, 'Space cannot hide active work');
          await update(page, 'tool_stream', 'activity-third', { state: 'finished', streaming: false });
          await openState(group, false, 'Completion restores the compact default or prior explicit collapse');
          await toggle(group, 'Enter');
          await openState(group, true, 'Explicit outer expansion works without inspecting a row');
          await emit(page, { type: 'settled', record: actionRecord('activity-fourth', 44) });
          await update(page, 'action', 'activity-fourth', { state: 'succeeded', result: { exitCode: 0 } });
          await openState(group, true, 'Explicit outer expansion survives another active-to-complete cycle');
          await toggle(group, 'Space');
          await update(page, 'action', 'activity-second', { result: { stdout: 'Revised completed output', exitCode: 0 } });
          await openState(group, false, 'Explicit outer collapse survives child revisions');
          await sameExecution(page, 'activity-first');
          await setDetail(page, extended ? 'Compact' : 'Extended');
          await openState(group, !extended, 'Changing preferences discards the prior manual outer choice');
          await toggle(group);
          await setDetail(page, extended ? 'Extended' : 'Compact');
          await openState(group, extended, 'Returning to the original preference resets the outer choice again');
        });

        await scenario(engine, `${mode}-activity-completed-singleton-remains-visible`, options, async page => {
          await freshRun(page, 'singleton-owner');
          await emit(page, { type: 'settled', record: actionRecord('singleton-first', 41, 'succeeded', { result: { stdout: 'Singleton completed', exitCode: 0 } }) });
          const group = activity(page, 'singleton-first');
          await rememberExecution(page, 'singleton-first');
          await openState(group, true, 'Even a completed singleton keeps its only row visible');
          equal(await group.getAttribute('data-single'), 'true', 'Completed singleton uses the same group structure');
          equal(await group.locator(':scope > summary').isVisible(), false, 'Completed singleton hides only the redundant outer header');
          check(await entry(page, 'singleton-first').locator(':scope > summary').isVisible(), 'Completed singleton is not lost to compact auto-collapse');
          await openState(entry(page, 'singleton-first'), extended, 'Completed singleton row still obeys the detail preference');
          await emit(page, { type: 'settled', record: actionRecord('singleton-second', 42, 'succeeded', { result: { exitCode: 0 } }) });
          await sameExecution(page, 'singleton-first');
          await openState(group, extended, 'Appending a second completed row follows the outer detail default without remounting');
        });

        for (const inspection of ['pointer', 'focus']) await scenario(engine, `${mode}-activity-${inspection}-inspection-survives-completion`, options, async page => {
          await freshRun(page, 'inspected-owner');
          await emit(page, { type: 'settled', record: actionRecord('inspected-first', 41, 'running', { result: { stdout: 'Output being inspected' } }) });
          await emit(page, { type: 'settled', record: actionRecord('inspected-second', 42, 'succeeded', { result: { exitCode: 0 } }) });
          const details = entry(page, 'inspected-first');
          const group = activity(page, 'inspected-first');
          await rememberExecution(page, 'inspected-first');
          if (inspection === 'pointer') {
            if (!extended) await details.locator(':scope > summary').click();
            await details.locator('.execution-output').click();
          } else {
            if (!extended) await toggle(details, 'Space');
            await details.locator('.execution-output').focus();
          }
          await frames(page);
          await openState(details, true, 'Inspected row is expanded before completion');
          await update(page, 'action', 'inspected-first', { state: 'succeeded', result: { stdout: 'Final inspected output', exitCode: 0 } });
          await openState(group, true, `${inspection} inspection prevents completed compact content from disappearing`);
          await openState(details, true, 'Completion preserves the individual disclosure choice');
          check(await details.getByText('Final inspected output', { exact: true }).isVisible(), 'Final output remains visible after completion');
          await sameExecution(page, 'inspected-first');
          if (inspection === 'focus') check(await details.locator('.execution-output').evaluate(node => document.activeElement === node), 'Focused output retains focus across completion');
          await setDetail(page, extended ? 'Compact' : 'Extended');
          await openState(group, !extended, 'Preference change resets inspected-group expansion');
          await setDetail(page, extended ? 'Extended' : 'Compact');
          await openState(group, extended, 'Inspection does not leak into the next preference generation');
        });

        for (const actionFirst of [false, true]) await scenario(engine, `${mode}-activity-first-stream-alias-keeps-group-and-row-${actionFirst ? 'action-before-link' : 'link-before-action'}`, options, async page => {
          await freshRun(page, 'alias-owner');
          await emit(page, { type: 'live', record: streamRecord('alias-stream', 41) });
          await rememberExecution(page, 'alias-stream');
          await toggle(entry(page, 'alias-stream'));
          if (actionFirst) await emit(page, { type: 'settled', record: actionRecord('alias-action', 45) });
          await update(page, 'tool_stream', 'alias-stream', { actionId: 'alias-action' }, 'live');
          if (!actionFirst) await emit(page, { type: 'settled', record: actionRecord('alias-action', 45) });
          equal(await entry(page, 'alias-stream').count(), 0, 'Alias replaces the stream projection rather than duplicating it');
          await sameExecution(page, 'alias-action', 'alias-stream');
          await openState(entry(page, 'alias-action'), !extended, 'Singleton stream-to-action replacement preserves row choice');
          await emit(page, { type: 'settled', record: actionRecord('alias-companion', 46, 'succeeded', { result: { exitCode: 0 } }) });
          await update(page, 'tool_stream', 'alias-stream', { state: 'finished', streaming: false });
          await openState(activity(page, 'alias-action'), true, 'Finished stream cannot falsely complete its running action');
          equal(await activity(page, 'alias-action').locator('.activity-group-progress').textContent(), '1 of 2 actions complete', 'Linked wrapper completion is not counted as another successful action');
          await update(page, 'action', 'alias-action', { state: 'succeeded', result: { stdout: 'Aliased action completed', exitCode: 0 } });
          await sameExecution(page, 'alias-action', 'alias-stream');
          await openState(activity(page, 'alias-action'), true, 'Inspection survives linking, append and completion of the first row');
          await openState(entry(page, 'alias-action'), !extended, 'Final completion still preserves the original row choice');
        });

        for (const delivery of ['loaded-history', 'streaming-appends']) for (const inspected of [false, true]) {
          const owner = row('message', 'interleaved-owner', 40, { author: 'owner', text: 'Run the six synthetic tools.' });
          await scenario(engine, `${mode}-activity-interleaved-model-steps-${delivery}-${inspected ? 'inspected' : 'uninspected'}`, {
            ...options, records: delivery === 'loaded-history' ? [owner, ...interleavedRecords].reverse() : [],
          }, async page => {
            const run = page.locator('.conversation-run[data-run-id="run:after:interleaved-owner"]');
            const ids = interleavedCalls.map((_, index) => `step-call-${index}`);
            if (delivery === 'streaming-appends') {
              await emit(page, { type: 'settled', record: owner });
              for (let index = 0; index < interleavedCalls.length; index++) {
                const placeholder = interleavedRecords[index * 2];
                const call = interleavedRecords[index * 2 + 1];
                await emit(page, { type: 'live', record: { ...placeholder, revision: 0, data: { ...placeholder.data, streaming: true } } });
                for (const id of ids.slice(0, index)) await sameExecution(page, id);
                await emit(page, { type: call.kind === 'action' ? 'settled' : 'live', record: {
                  ...call, data: { ...call.data, state: index === 5 ? 'preparing' : 'running', ...(call.kind === 'tool_stream' ? { streaming: true } : {}) },
                } });
                await rememberExecution(page, call.id);
                if (index < 5) await update(page, call.kind, call.id, call.data);
                await update(page, 'message', placeholder.id, { streaming: false });
                equal(await run.locator('.activity-group').count(), 1, 'Each interleaved append extends one activity group');
                equal(await run.locator('.execution-entry').evaluateAll(nodes => nodes.map(node => node.dataset.recordId)), ids.slice(0, index + 1), 'Streaming rows retain execution order');
                for (const id of ids.slice(0, index + 1)) await sameExecution(page, id);
              }
            } else for (const id of ids) await rememberExecution(page, id);

            const group = activity(page, ids[0]);
            equal(await run.locator('.activity-group').count(), 1, 'Six model steps separated by empty assistant records form one group');
            equal(await group.locator(':scope > .activity-stack > .execution-entry').evaluateAll(nodes => nodes.map(node => node.dataset.recordId)), ids, 'All six action/stream rows share one ordered stack');
            equal(await group.locator('.activity-group-title').textContent(), 'Working', 'Preparing write keeps the group working');
            if (process.env.OUTPOST_TEST_SCREENSHOTS) {
              mkdirSync(process.env.OUTPOST_TEST_SCREENSHOTS, { recursive: true });
              await group.screenshot({ path: resolve(process.env.OUTPOST_TEST_SCREENSHOTS, `${engine.name()}-${mode}-${delivery}-six-tools.png`) });
            }
            equal(await group.locator('.activity-group-progress').textContent(), '5 of 6 actions complete', 'Only the first five calls count as completed');
            equal(await entry(page, ids[5]).getAttribute('data-state'), 'preparing', 'Final streaming call is still preparing');
            await openState(group, true, 'Preparing work keeps the group expanded in both detail modes');
            for (const id of ids) check(await entry(page, id).locator(':scope > summary').isVisible(), `${id}: row is visible, not an isolated hidden card`);
            if (inspected) for (const [index, id] of ids.entries()) {
              if (!extended) await toggle(entry(page, id));
              await toggle(entry(page, id).locator('.execution-raw'));
              check(await entry(page, id).locator('.execution-output').isVisible(), `${id}: output can be expanded`);
              equal(await entry(page, id).locator('.execution-output').textContent(), `Retained output ${index}`, `${id}: exact output is retained`);
            }
            // These envelopes have settled; final records intentionally reject late live frames.
            for (const [index, id] of ids.entries()) {
              await update(page, 'message', `step-placeholder-${index}`, { text: '' });
              await sameExecution(page, id);
              await update(page, 'message', `step-placeholder-${index}`, { text: index % 2 ? ' \n\t ' : '', thinking: `Model step ${index} reasoning.` });
              for (const rowId of ids) await sameExecution(page, rowId);
            }
            equal(await run.locator('.activity-group').count(), 1, 'Whitespace and reasoning-only revisions introduce no boundaries');
            equal(await run.locator('.run-message').count(), 0, 'Invisible placeholders do not render empty message blocks');
            equal(await run.locator('.run-reasoning').count(), 1, 'Reasoning survives in the existing run aggregate');
            equal(await run.locator('.reasoning-segments pre').allTextContents(), ids.map((_, index) => `Model step ${index} reasoning.`), 'Every model-step reasoning segment is retained in order');
            equal(await group.locator('.activity-group-progress').textContent(), '5 of 6 actions complete', 'Placeholder revisions do not alter execution progress');
            await update(page, 'tool_stream', ids[5], { state: 'finished', streaming: false, output: 'Final write output' });
            equal(await group.locator('.activity-group-title').textContent(), '6 actions completed', 'Final write completes exactly six actions');
            equal(await group.locator('.thinking-indicator[data-active="true"]').count(), 0, 'Completion clears the group activity indicator');
            await openState(group, inspected || extended, 'Completion respects inspection or the untouched detail default');
            for (const id of ids) {
              await sameExecution(page, id);
              await openState(entry(page, id), inspected || extended, `${id}: completion preserves row expansion`);
              await openState(entry(page, id).locator('.execution-raw'), inspected, `${id}: raw-output choice survives placeholder revisions and completion`);
            }
            if (inspected) check(await entry(page, ids[5]).getByText('Final write output', { exact: true }).isVisible(), 'Inspected final output remains visible after completion');
          });
        }

        await scenario(engine, `${mode}-activity-text-image-empty-and-owner-boundaries`, options, async page => {
          const run = await freshRun(page, 'boundary-owner');
          const pair = async (prefix, second) => {
            await emit(page, { type: 'records', records: ['one', 'two'].map(suffix => actionRecord(`${prefix}-${suffix}`, second + (suffix === 'two' ? 0.1 : 0), 'succeeded', { result: { stdout: `Retained ${prefix}-${suffix} output`, exitCode: 0 } })) });
            await rememberExecution(page, `${prefix}-one`);
          };
          await pair('before-text', 41);
          await emit(page, { type: 'settled', record: row('message', 'boundary-text', 42, { author: 'assistant', text: 'Text separates tool stacks.' }) });
          await pair('after-text', 43);
          await emit(page, { type: 'settled', record: row('artifact', 'boundary-image', 44, { name: 'boundary.png', mime: 'image/png', hash: 'synthetic-boundary-image' }) });
          await pair('after-image', 45);
          await emit(page, { type: 'live', record: row('message', 'boundary-empty', 46, { author: 'assistant', text: '', streaming: true }, 0) });
          await pair('after-empty', 47);
          const mergedOrder = ['before-text-one', 'boundary-text', 'after-text-one', 'artifact-boundary-image', 'after-image-one'];
          const splitOrder = [...mergedOrder, 'boundary-empty', 'after-empty-one'];
          const order = () => run.locator('.run-content > :not(.run-reasoning)').evaluateAll(nodes => nodes.map(node => node.matches('.activity-group') ? node.querySelector('.execution-entry').dataset.recordId : node.dataset.recordId || node.id));
          equal(await order(), mergedOrder, 'Visible text and image divide stacks; the empty assistant record does not');
          equal(await run.locator('.activity-group').count(), 3, 'Empty assistant messages do not create a fourth stack');
          equal(await activity(page, 'after-image-one').locator('.execution-entry').evaluateAll(nodes => nodes.map(node => node.dataset.recordId)), ['after-image-one', 'after-image-two', 'after-empty-one', 'after-empty-two'], 'Rows on both sides of an empty message remain ordered together');
          equal(await run.locator('.activity-group .run-message, .activity-group .stream-artifact').count(), 0, 'Messages and artifacts never become collapsible tool rows');
          check(await run.getByText('Text separates tool stacks.', { exact: true }).isVisible(), 'Text stays visible between completed stacks');
          const image = run.locator('#artifact-boundary-image img');
          await run.locator('#artifact-boundary-image').scrollIntoViewIfNeeded();
          await image.waitFor();
          await page.waitForFunction(() => {
            const image = document.querySelector('#artifact-boundary-image img');
            return image?.complete && image.naturalWidth > 0;
          });
          check(await image.isVisible(), 'Actual decoded image remains visible outside collapsed activity');
          const allIds = ['before-text', 'after-text', 'after-image', 'after-empty'].flatMap(prefix => [`${prefix}-one`, `${prefix}-two`]);
          const retainedOutputs = async () => {
            equal(await run.locator('.execution-entry').evaluateAll(nodes => nodes.map(node => node.dataset.recordId)), allIds, 'Every execution remains in its original order across boundary changes');
            for (const id of allIds) equal(await entry(page, id).locator('.execution-output').textContent(), `Retained ${id} output`, `${id}: output survives boundary changes`);
          };
          const inspect = entry(page, 'after-empty-one');
          if (!extended) {
            await toggle(activity(page, 'after-image-one'));
            await toggle(inspect);
          }
          await toggle(inspect.locator('.execution-raw'));
          // Exercise both explicit choices, including the choice opposite Extended's default.
          if (extended) await toggle(entry(page, 'after-empty-two'));
          else {
            await toggle(entry(page, 'after-empty-two'));
            await toggle(entry(page, 'after-empty-two'));
          }
          const retainedInspection = async () => {
            await openState(inspect, true, 'Inspected row expansion survives an actual split or merge');
            await openState(inspect.locator('.execution-raw'), true, 'Raw-output expansion survives an actual split or merge');
            await openState(entry(page, 'after-empty-two'), false, 'Explicit row collapse survives an actual split or merge');
            check((await inspect.locator('.execution-raw > pre').textContent()).includes('Retained after-empty-one output'), 'Expanded raw payload is retained after reparenting');
          };
          await update(page, 'message', 'boundary-empty', { text: ' \n\t ', thinking: 'Boundary placeholder reasoning.' }, 'live');
          equal(await order(), mergedOrder, 'Whitespace and reasoning changes leave the stack unchanged');
          for (const prefix of ['before-text', 'after-text', 'after-image', 'after-empty']) await sameExecution(page, `${prefix}-one`);
          await retainedInspection();
          equal(await run.locator('.reasoning-segments pre').allTextContents(), ['Boundary placeholder reasoning.'], 'Ignoring an invisible message does not discard its reasoning');
          await update(page, 'message', 'boundary-empty', { text: 'Previously empty message now has text.', streaming: false });
          equal(await order(), splitOrder, 'Late visible text splits the activity at its original chronological position');
          equal(await run.locator('.activity-group').count(), 4, 'Late visible text introduces a real boundary');
          check(await run.getByText('Previously empty message now has text.', { exact: true }).isVisible(), 'Late assistant text stays visible outside activity');
          await retainedInspection();
          await retainedOutputs();
          await update(page, 'message', 'boundary-empty', { text: '' });
          equal(await order(), mergedOrder, 'Clearing visible text merges the adjacent activity stacks again');
          equal(await run.locator('.activity-group').count(), 3, 'Cleared text removes only its former boundary');
          await retainedInspection();
          await retainedOutputs();
          await rememberExecution(page, 'after-empty-one');
          await emit(page, { type: 'settled', record: row('message', 'boundary-next-owner', 48, { author: 'owner', text: '' }) });
          const nextRun = page.locator('.conversation-run[data-run-id="run:after:boundary-next-owner"]');
          await pair('after-owner', 49);
          equal(await run.locator('.activity-group').count(), 3, 'Even an empty owner turn cannot absorb the preceding stack');
          equal(await nextRun.locator('.activity-group').count(), 1, 'An empty owner message still starts its own activity group');
          await sameExecution(page, 'after-empty-one');
          await retainedOutputs();
        });

        for (const [name, patch, warning] of [
          ['failure', { error: 'Synthetic model failure' }, 'Synthetic model failure'],
          ['interruption', { interrupted: true }, 'Interrupted · partial output retained'],
          ['truncation', { outputTruncated: true }, 'Display limited to 128 KiB'],
          ['stop-reason-error', { stopReason: 'error' }, null],
          ['stop-reason-aborted', { stopReason: 'aborted' }, null],
        ]) await scenario(engine, `${mode}-activity-terminal-assistant-placeholder-${name}-remains-boundary`, options, async page => {
          const second = 60;
          const run = await freshRun(page, `terminal-owner-${name}`, second);
          await emit(page, { type: 'records', records: [
            actionRecord(`terminal-before-${name}`, second + 1, 'succeeded', { result: { stdout: `Before ${name}` } }),
            row('message', `terminal-message-${name}`, second + 2, { author: 'assistant', text: ' \n\t ', streaming: true, ...patch }),
            actionRecord(`terminal-after-${name}`, second + 3, 'succeeded', { result: { stdout: `After ${name}` } }),
          ] });
          equal(await run.locator('.activity-group').count(), 2, `${name}: terminal placeholder remains an activity boundary`);
          equal(await run.locator('.run-content > :not(.run-reasoning)').evaluateAll(nodes => nodes.map(node => node.matches('.activity-group') ? node.querySelector('.execution-entry').dataset.recordId : node.dataset.recordId)), [`terminal-before-${name}`, `terminal-message-${name}`, `terminal-after-${name}`], `${name}: warning remains between its execution rows`);
          const message = run.locator(`.run-message[data-record-id="terminal-message-${name}"]`);
          check(await message.isVisible(), `${name}: terminal placeholder remains visible outside collapsed activity`);
          if (warning) check((await message.textContent()).includes(warning), `${name}: terminal warning is retained`);
          for (const position of ['before', 'after']) {
            const details = entry(page, `terminal-${position}-${name}`);
            check(await details.locator(':scope > summary').isVisible(), `${name}: adjacent singleton stays visible`);
            equal(await details.locator('.execution-output').textContent(), `${position === 'before' ? 'Before' : 'After'} ${name}`, `${name}: adjacent output is retained`);
          }
          await update(page, 'message', `terminal-message-${name}`, { text: '' });
          equal(await run.locator('.activity-group').count(), 2, `${name}: clearing whitespace must not erase a terminal boundary`);
          check(await message.isVisible(), `${name}: empty terminal warning stays visible`);
        });

        for (const [stateName, kind, data, expectedState] of [
          ['failed', 'action', { state: 'failed' }, 'attention'],
          ['error', 'tool_stream', { state: 'error', streaming: false }, 'attention'],
          ['unknown-action', 'action', { state: 'unknown' }, 'attention'],
          ['unknown-stream', 'tool_stream', { state: 'unknown', streaming: false }, 'attention'],
          ['pending', 'action', { state: 'pending' }, 'attention'],
          ['authorized', 'action', { state: 'authorized' }, 'attention'],
          ['denied', 'action', { state: 'denied' }, 'attention'],
          ['interrupted', 'tool_stream', { state: 'finished', streaming: false, interrupted: true }, 'attention'],
          ['cancelled', 'action', { state: 'cancelled' }, 'attention'],
          ['nonzero-exit', 'action', { state: 'succeeded', result: { stdout: 'Attempt output retained', stderr: 'Synthetic command rejection', exitCode: 7 } }, 'attention'],
          ['reported-rejection', 'action', { state: 'succeeded', result: { agent_reported_success: false, detail: 'Synthetic execution rejected' } }, 'attention'],
          ['unrecognized-state', 'action', { state: 'future-server-state' }, 'waiting'],
        ]) await scenario(engine, `${mode}-activity-${stateName}-cannot-falsely-complete`, options, async page => {
          await freshRun(page, 'outcome-owner');
          await emit(page, { type: 'records', records: [actionRecord('outcome-one', 41, 'succeeded'), actionRecord('outcome-two', 42, 'succeeded')] });
          const group = activity(page, 'outcome-one');
          if (extended) await toggle(group);
          await openState(group, false, 'Outcome fixture starts as a collapsed completed group');
          await emit(page, { type: 'settled', record: kind === 'action' ? actionRecord('outcome-attention', 43, data.state, data) : streamRecord('outcome-attention', 43, data) });
          await openState(group, expectedState === 'attention' || !extended, 'Attention forces expansion; unrecognized waiting states follow the default or explicit choice');
          equal(await group.getAttribute('data-state'), expectedState, 'Group reports the actual unresolved outcome');
          if (expectedState === 'attention') check(await entry(page, 'outcome-attention').locator(':scope > summary').isVisible(), 'Unsuccessful/unresolved row summary stays visible');
          if (['pending', 'authorized'].includes(stateName)) check(await entry(page, 'outcome-attention').getByRole('button', { name: 'Review', exact: true }).isVisible(), 'Approval controls cannot disappear into previously collapsed activity');
          equal(await group.locator('.activity-group-progress').textContent(), '2 of 3 actions complete', 'Unsuccessful or unresolved work is excluded from completion count');
          equal(await group.locator('.activity-complete').count(), 0, 'No success icon on an incomplete group');
          check(!/actions completed/.test(await group.locator('.activity-group-title').textContent()), 'No false all-complete label');
          if (expectedState === 'attention') {
            await toggle(group);
            await openState(group, true, 'Attention cannot be hidden by keyboard collapse');
          }
          if (['nonzero-exit', 'reported-rejection'].includes(stateName)) {
            const details = entry(page, 'outcome-attention');
            if (!extended) await toggle(details);
            check(await details.locator('.action-state').getByLabel('Needs review', { exact: true }).isVisible(), 'Succeeded envelope with rejected execution remains Needs review');
            if (stateName === 'nonzero-exit') {
              check(await details.getByText('Exit code 7', { exact: true }).isVisible(), 'Actual nonzero exit code is retained');
              check(await details.getByText('Synthetic command rejection', { exact: true }).isVisible(), 'Actual rejection output remains inspectable');
            } else check(await details.getByText('Synthetic execution rejected', { exact: true }).isVisible(), 'Reported rejection detail is retained');
          }
        });

        await scenario(engine, `${mode}-thinking-indicator-lifecycle`, options, async page => {
          for (const [index, [end, patch]] of [
            ['text', { text: 'Answer starts here.' }], ['completion', { streaming: false }],
            ['interruption', { interrupted: true }], ['error', { error: 'Synthetic provider error' }],
            ['stop-reason-error', { stopReason: 'error' }],
          ].entries()) {
            await emit(page, { type: 'settled', record: row('message', `owner-${end}`, 40 + index * 5, { author: 'owner', text: `Start ${end} fixture.` }) });
            // Keep the live message latest so a later settled chunk cannot end activity before the patch under test.
            await emit(page, { type: 'settled', record: row('message', `segment-${end}`, 40.5 + index * 5, { author: 'assistant', text: 'A retained ordinary chunk.', thinking: `Earlier ${end} segment.` }) });
            const message = row('message', `thinking-${end}`, 41 + index * 5, { author: 'assistant', text: '', thinking: `Live ${end} reasoning.`, streaming: true }, 0);
            await emit(page, { type: 'live', record: message });
            const run = page.locator(`.conversation-run[data-run-id="run:after:owner-${end}"]`);
            const aggregate = run.locator('.run-reasoning');
            equal(await aggregate.count(), 1, 'A live run has exactly one aggregate reasoning disclosure');
            await openState(aggregate, extended, 'Live reasoning honors the preference');
            equal(await aggregate.locator(':scope > summary').getByText('Thinking…', { exact: true }).count(), 1, 'Active reasoning says Thinking…');
            const indicator = run.locator('.thinking-indicator[data-active="true"]');
            equal(await indicator.count(), 1, 'Exactly one active indicator per thinking run');
            check(await indicator.isVisible(), 'Thinking activity is visible even in Compact');
            equal(await indicator.locator(':scope > span').count(), 3, 'Thinking indicator contains three dots');
            check(await indicator.locator(':scope > span').evaluateAll(nodes => nodes.every(node => {
              const style = getComputedStyle(node);
              return style.animationName !== 'none' && parseFloat(style.animationDuration) > 0 && style.animationPlayState === 'running' && node.getAnimations().some(animation => animation.playState === 'running');
            })), 'All three dots have running CSS animation, not static punctuation');
            if (index === 0) await screenshot(page, `${engine.name()}-${mode}-thinking`);
            await toggle(aggregate);
            await update(page, 'message', message.id, { thinking: `Updated ${end} reasoning.` }, 'live');
            await openState(aggregate, !extended, 'Live reasoning changes preserve manual expansion');
            equal(await aggregate.locator('.reasoning-segments pre').allTextContents(), [`Earlier ${end} segment.`, `Updated ${end} reasoning.`], 'Historical and active traces remain ordered in one aggregate');
            equal(await run.locator('.run-reasoning').count(), 1, 'No per-message duplicate reasoning disclosures');
            await toggle(aggregate);
            equal(await indicator.count(), 1, `${end}: indicator is still active immediately before the terminal patch`);
            check(await indicator.isVisible(), `${end}: active indicator remains visible before the terminal patch`);
            equal(await aggregate.locator(':scope > summary').getByText('Thinking…', { exact: true }).count(), 1, `${end}: active wording persists until the terminal patch`);
            equal(await indicator.locator(':scope > span').count(), 3, `${end}: all three active dots remain mounted`);
            check(await indicator.locator(':scope > span').evaluateAll(nodes => nodes.every(node => node.getAnimations().some(animation => animation.playState === 'running'))), `${end}: dots are still animating immediately before the terminal patch`);
            await update(page, 'message', message.id, patch, end === 'completion' ? 'settled' : 'live');
            equal(await run.locator('.thinking-indicator[data-active="true"]').count(), 0, `${end} stops the active indicator even if a stale streaming flag remains`);
            equal(await aggregate.locator(':scope > summary').getByText('Thinking', { exact: true }).count(), 1, `${end} uses the inactive Thinking label`);
            equal(await aggregate.locator(':scope > summary').getByText('Thinking…', { exact: true }).count(), 0, 'Inactive reasoning has no active wording');
            check(!/\b\d+(?:\.\d+)?\s*(?:ms|s|seconds?|minutes?)\b/i.test(await aggregate.locator(':scope > summary').textContent()), 'No fabricated reasoning duration appears');
            check(await run.locator('.thinking-indicator span').evaluateAll(nodes => nodes.every(node => !node.getAnimations().some(animation => animation.playState === 'running'))), 'Inactive dots do not keep animating');
            await openState(aggregate, extended, `${end} preserves the last manual reasoning choice`);
            if (end === 'text') check(await run.getByText('Answer starts here.', { exact: true }).isVisible(), 'The normal streamed answer remains visible');
            if (end === 'error') check(await run.getByText('Synthetic provider error', { exact: true }).isVisible(), 'Provider errors remain visible');
            if (end === 'interruption') check(await run.getByText('Interrupted · partial output retained', { exact: true }).isVisible(), 'Interruption remains visible');
          }
        });

        for (const state of ['pending', 'authorized']) await scenario(engine, `${mode}-${state}-approval-remains-open`, { ...options, approval: state }, async page => {
          await openState(entry(page, 'approval-action'), extended, 'Timeline approval row follows detail preference');
          await openState(activity(page, 'approval-action'), true, 'Approval remains visible in its expanded activity stack');
          equal(await activity(page, 'approval-action').locator('.activity-group-title').textContent(), 'Waiting for approval', 'Approval is not reported as completed activity');
          await toggle(activity(page, 'approval-action'));
          await openState(activity(page, 'approval-action'), true, 'Keyboard collapse cannot hide approval controls');
          await entry(page, 'approval-action').getByRole('button', { name: 'Review', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: 'Review the exact action', exact: true });
          await dialog.waitFor();
          await openState(dialog.locator('.action'), true, 'Safety review stays expanded independently of conversation detail');
          const args = dialog.locator('.action-body > pre').first();
          check(await args.isVisible(), 'Exact approval arguments are visible without opening another disclosure');
          equal(JSON.parse(await args.textContent()), approval(state).data.arguments, 'Review retains the exact arguments');
          check(await dialog.getByRole('button', { name: state === 'pending' ? 'Approve' : 'Run approved action', exact: true }).isVisible(), 'Approval controls remain visibly reviewable');
          await dialog.getByRole('button', { name: 'Close review', exact: true }).click();
          await openState(entry(page, 'approval-action'), extended, 'Closing the review does not alter the timeline disclosure');
        });
      }

      await scenario(engine, 'narrow-light-thinking-and-preference-layout', { width: 390, scheme: 'light' }, async page => {
        const fits = async (locator, label) => {
          check(await locator.isVisible(), `${label} is visible`);
          const box = await locator.evaluate(node => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth, overflow: node.scrollWidth - node.clientWidth };
          });
          check(box.width > 0 && box.left >= -1 && box.right <= box.viewport + 1 && box.overflow <= 1, `${label} fits the narrow viewport without horizontal overflow: ${JSON.stringify(box)}`);
        };
        const noPageOverflow = async label => {
          check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: no page-level horizontal overflow`);
        };
        equal(await page.locator('html').getAttribute('data-theme'), 'light', 'Layout fixture exercises the light theme');
        await appearance(page);
        await detailGroup(page).scrollIntoViewIfNeeded();
        await frames(page);
        await fits(detailGroup(page), 'Conversation detail fieldset');
        equal(await detailGroup(page).locator(':scope > legend').textContent(), 'Conversation detail', 'Native legend retains the accessible group name');
        check(await detailGroup(page).locator(':scope > legend').evaluate(node => node.classList.contains('sr-only')), 'Native legend is visually hidden in the row layout');
        await fits(page.locator('.appearance-choice-row').filter({ has: detailGroup(page) }).locator('.ui-row-content > strong'), 'Conversation detail row title');
        for (const name of ['Compact', 'Extended']) {
          const control = radio(page, name);
          await fits(control.locator('..'), `${name} radio label`);
          await control.check(); await frames(page);
          check(await control.isChecked(), `${name} remains selectable at 390px in light mode`);
        }
        await noPageOverflow('Appearance controls');
        await chat(page);
        await emit(page, { type: 'settled', record: row('message', 'layout-owner', 40, { author: 'owner', text: 'Inspect narrow thinking layout.' }) });
        await emit(page, { type: 'settled', record: row('message', 'layout-history', 41, { author: 'assistant', text: 'Earlier reply remains visible.', thinking: 'Earlier layout reasoning.' }) });
        const message = row('message', 'layout-thinking', 42, { author: 'assistant', text: '', thinking: 'Long model-provided reasoning stays inside the conversation. '.repeat(20) + 'unbroken-reasoning-'.repeat(40), streaming: true }, 0);
        await emit(page, { type: 'live', record: message });
        const run = page.locator('.conversation-run[data-run-id="run:after:layout-owner"]');
        const aggregate = run.locator('.run-reasoning');
        const indicator = run.locator('.thinking-indicator[data-active="true"]');
        await openState(aggregate, true, 'Narrow layout uses Extended selected in Appearance');
        equal(await aggregate.locator('.reasoning-segments pre').count(), 2, 'Narrow summary includes multiple reasoning segments');
        await fits(aggregate, 'Expanded thinking disclosure');
        await fits(aggregate.locator(':scope > summary'), 'Active thinking summary');
        await fits(indicator, 'Three-dot thinking indicator');
        await fits(page.locator('.conversation'), 'Conversation viewport');
        await noPageOverflow('Expanded thinking');
        await toggle(aggregate);
        await fits(aggregate.locator(':scope > summary'), 'Collapsed active thinking summary');
        equal(await indicator.count(), 1, 'Closing the narrow disclosure does not stop thinking');
        equal(await aggregate.locator(':scope > summary').getByText('Thinking…', { exact: true }).count(), 1, 'Narrow thinking remains active immediately before completion');
        await update(page, 'message', message.id, { streaming: false });
        equal(await run.locator('.thinking-indicator[data-active="true"]').count(), 0, 'Narrow thinking completion stops activity');
        await fits(aggregate.locator(':scope > summary'), 'Completed thinking summary');
        await noPageOverflow('Completed thinking');
      });

      await scenario(engine, 'waiting-without-reasoning-terminal-states', {}, async page => {
        for (const [index, [end, patch]] of [
          ['text', { text: 'First model output.' }], ['completion', { streaming: false }],
          ['interruption', { interrupted: true }], ['error', { error: 'Waiting provider failed' }],
          ['stop-reason-error', { stopReason: 'error' }],
        ].entries()) {
          await emit(page, { type: 'settled', record: row('message', `empty-owner-${end}`, 40 + index * 3, { author: 'owner', text: `Empty ${end} fixture.` }) });
          const message = row('message', `empty-${end}`, 41 + index * 3, { author: 'assistant', text: '', thinking: '', streaming: true }, 0);
          await emit(page, { type: 'live', record: message });
          const run = page.locator(`.conversation-run[data-run-id="run:after:empty-owner-${end}"]`);
          equal(await run.locator('.reasoning-segments pre').count(), 0, 'Waiting does not invent a reasoning trace');
          // Waiting activity is optional; if present it must share the real lifecycle.
          const indicator = run.locator('.thinking-indicator[data-active="true"]');
          check(await indicator.count() <= 1, 'An empty waiting row never duplicates activity');
          if (await indicator.count()) equal(await indicator.locator(':scope > span').count(), 3, 'Waiting indicator uses the same three-dot structure');
          await update(page, 'message', message.id, patch, end === 'completion' ? 'settled' : 'live');
          equal(await run.locator('.thinking-indicator[data-active="true"]').count(), 0, `${end} retires empty waiting activity`);
          equal(await run.locator('.reasoning-segments pre').count(), 0, 'Ending an empty wait still does not invent reasoning');
        }
      });

      await scenario(engine, 'reduced-motion-and-empty-waiting-reasoning', { reducedMotion: 'reduce' }, async page => {
        await emit(page, { type: 'settled', record: row('message', 'waiting-owner', 40, { author: 'owner', text: 'Wait for output.' }) });
        const message = row('message', 'waiting-message', 41, { author: 'assistant', text: '', thinking: '', streaming: true }, 0);
        await emit(page, { type: 'live', record: message });
        const run = page.locator('.conversation-run[data-run-id="run:after:waiting-owner"]');
        equal(await run.locator('.reasoning-segments pre').count(), 0, 'No fabricated reasoning text while waiting');
        await update(page, 'message', message.id, { thinking: 'Real model-provided reasoning.' }, 'live');
        const indicator = run.locator('.thinking-indicator[data-active="true"]');
        equal(await indicator.count(), 1, 'Reduced motion preserves the semantic active state');
        check(await indicator.isVisible(), 'Reduced motion retains a visible activity indicator');
        equal(await indicator.locator(':scope > span').count(), 3, 'Reduced motion retains the three-dot structure');
        check(await indicator.locator(':scope > span').evaluateAll(nodes => nodes.every(node => {
          const style = getComputedStyle(node);
          return style.animationName === 'none' || style.animationPlayState === 'paused' || (parseFloat(style.animationDuration) <= 0.01 && style.animationIterationCount !== 'infinite');
        })), 'Reduced motion disables continuous dot animation');
        await toggle(run.locator('.run-reasoning'), 'Space');
        check(await run.getByText('Real model-provided reasoning.', { exact: true }).isVisible(), 'Keyboard disclosure still works with reduced motion');
        equal(await indicator.count(), 1, 'Reduced-motion indicator remains active immediately before completion');
        equal(await run.locator('.run-reasoning > summary').getByText('Thinking…', { exact: true }).count(), 1, 'Reduced-motion thinking wording remains active until completion');
        await update(page, 'message', message.id, { streaming: false });
        equal(await run.locator('.thinking-indicator[data-active="true"]').count(), 0, 'Waiting-to-thinking-to-complete clears activity');
      });

      for (const failure of ['read', 'write']) await scenario(engine, `appearance-storage-${failure}-failure`, { storageFailure: failure }, async page => {
        await defaults(page, false);
        await appearance(page);
        if (failure === 'write') check(await page.getByRole('alert').filter({ hasText: 'could not be saved' }).isVisible(), 'Failed persistence is disclosed without crashing');
        await radio(page, 'Extended').check(); await frames(page); await chat(page);
        await defaults(page, true);
        await chat(page, otherTaskId); await defaults(page, true, true);
        await page.reload(); await page.waitForFunction(() => window.__detail.ready); await chat(page);
        await defaults(page, false);
      });
    } finally { await browser.close(); browser = undefined; }
  }
} finally {
  clearTimeout(deadline); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
console.log(`\n${checks} conversation detail checks across ${cases} cases; ${failures.length} failure(s).`);
for (const failure of failures) console.error(failure);
if (!cases) { console.error('No cases matched OUTPOST_TEST_FILTER'); process.exitCode = 1; }
if (failures.length) process.exitCode = 1;
