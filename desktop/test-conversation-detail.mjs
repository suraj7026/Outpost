import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { openSettings } from './settings-test-navigation.mjs';

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
const history = page => page.locator('.conversation .completed-action-group');
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
  equal(await history(page).count(), 1, 'Consecutive completed history retains its outer disclosure');
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
      if (route.request().url().startsWith(origin + '/')) return route.continue();
      remote.push(route.request().url()); return route.abort();
    });
    await page.addInitScript(installTransport, { records: fixture(options), options, storageKey, environmentId });
    await page.goto(origin);
    await page.waitForFunction(() => window.__detail.ready);
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
                await update(page, kind, id, { streaming: false, state: 'finished' });
                await update(page, 'action', linkedId, { state: 'succeeded', result: { stdout: 'Linked final result', exitCode: 0 } });
                await openState(entry(page, linkedId), !extended, `${type.key}: linked completion does not reset the disclosure`);
                check(!await entry(page, linkedId).evaluate(node => !!node.closest('.completed-action-group')), 'Newly completed live work is not remounted as historical work');
              } else {
                await update(page, kind, id, { state: 'succeeded', result: { stdout: 'Final result', exitCode: 0 } });
                await openState(details, extended, `${type.key}: action completion preserves the reader choice`);
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
        await fits(detailGroup(page).locator(':scope > legend'), 'Conversation detail legend');
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
