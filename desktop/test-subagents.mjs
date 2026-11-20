import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, webkit } from 'playwright';
import { openInitialTestChat } from './chat-test-navigation.mjs';
import { installWorkspaceTransport, workspaceFixture, workspaceOwnerA as A, workspaceOwnerB as B } from './test-fixtures/workspace-panel-native.mjs';

// Existing dist only; no builds, production mutations, or external requests.
// OUTPOST_SUBAGENT_SCREENSHOTS=1 optionally writes PNGs under /tmp/outpost-subagents.
// node desktop/test-subagents.mjs
// OUTPOST_TEST_BROWSER=webkit node desktop/test-subagents.mjs
// OUTPOST_SUBAGENT_DIST_WAIT_MS=120000 optionally waits longer for the parent's build.
const engine = { chromium, webkit }[process.env.OUTPOST_TEST_BROWSER ?? 'chromium'];
assert.ok(engine, 'OUTPOST_TEST_BROWSER must be chromium or webkit');
const waitMs = Number(process.env.OUTPOST_SUBAGENT_DIST_WAIT_MS ?? 60_000);
assert.ok(Number.isSafeInteger(waitMs) && waitMs >= 0 && waitMs <= 300_000, 'Dist wait must be 0–300000 ms');
const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const screenshotsEnabled = process.env.OUTPOST_SUBAGENT_SCREENSHOTS === '1';
const screenshotDirectory = '/tmp/outpost-subagents';
const taskId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const parentToolId = 'a'.repeat(64), runId = 'b'.repeat(64);
const epoch = Date.parse('2026-11-17T10:00:00.000Z');
const row = (kind, id, second, data) => ({ kind, id, revision: 1, updatedAt: new Date(epoch + second * 1000).toISOString(), data: { taskId, ...data } });
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const near = (actual, expected, message) => check(Math.abs(actual - expected) <= 1.5, `${message}: ${actual} vs ${expected}`);
const panel = page => page.locator('.subagent-run-panel');
const dialog = page => page.locator('dialog.subagent-run-dialog');
const card = (page, label = 'Audit Alpha') => page.locator('.subagent-card').filter({ has: page.locator('.subagent-card-title', { hasText: label }) });
const toggle = page => page.locator('.task-workspace-toggle');
const files = page => page.locator('.reply-composer').getByRole('button', { name: 'Files, changes and browser', exact: true });
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

function fixture(options = {}) {
  const fixture = workspaceFixture({ empty: true });
  for (const [owner, name] of [[A, 'Alpha'], [B, 'Beta']]) {
    const state = fixture.states[owner];
    const text = `# Actual workspace ${name}\n\nRead-only fixture file.\n`;
    state.documents = { [taskId]: { 'notes.md': { path: 'notes.md', name: 'notes.md', text, hash: createHash('sha256').update(text).digest('hex'), size: Buffer.byteLength(text), modifiedAt: new Date(epoch).toISOString() } } };
    state.artifacts = {};
    const run = row('subagent_run', runId, 3, {
      parentSessionId: sessionId, parentCallId: 'launch-audit', parentToolId,
      runId: 'native-audit', agent: 'reviewer', label: `Audit ${name}`, model: 'provider/child-model',
      assignment: `Inspect recorded evidence for ${name}. Do not execute anything.`, executionMode: 'background', state: 'running',
      startedAt: epoch, summary: `Recorded partial findings ${name}.`,
      activity: [
        { id: 'message:1', kind: 'message', label: 'Reviewer', text: `Observed activity ${name}.` },
        { id: 'read:1', kind: 'tool', tool: 'read', label: 'Read notes', arguments: '{"path":"notes.md"}', output: `<img src="https://subagent-exfil.invalid/pixel" onerror="alert(1)">\nRecorded output ${name}.`, state: 'completed' },
      ],
      files: [{ path: 'notes.md', change: 'reviewed' }], children: [{ id: 'child:1', agent: 'Verifier', state: 'unknown' }],
      incomplete: true, truncated: false, stopSupported: false, streaming: true,
    });
    state.records = [
      row('task', taskId, 0, { goal: `Subagent task ${name}`, profile: 'code', state: 'running', model: 'parent-model-must-not-leak' }),
      row('message', 'owner-before', 1, { author: 'owner', text: 'Inspect this workspace.' }),
      row('message', 'assistant-before', 2, { author: 'assistant', text: 'Before the delegated audit.' }),
      row('tool_stream', parentToolId, 3, { name: 'subagent', sessionId, callId: 'launch-audit', arguments: { agent: 'wrapper-must-be-deduplicated', task: 'Audit notes', async: true }, state: 'finished', streaming: false }),
      run,
      row('message', 'assistant-after', 4, { author: 'assistant', text: 'After the delegated audit.' }),
      row('message', 'owner-after', 5, { author: 'owner', text: 'Keep the audit in its original turn.' }),
      row('message', 'assistant-later', 6, { author: 'assistant', text: 'A later response must remain below the audit.' }),
    ];
    if (options.legacyFirst) {
      state.pendingRun = structuredClone(run);
      state.pendingRun.updatedAt = new Date(epoch + 60_000).toISOString();
      state.records = state.records.filter(record => record.kind !== 'subagent_run');
      const wrapper = state.records.find(record => record.kind === 'tool_stream');
      wrapper.data.arguments.agent = `Legacy audit ${name}`;
      wrapper.data.state = 'running';
      wrapper.data.streaming = true;
      // Older wrappers can omit session identity; the public projection supplies it later.
      delete wrapper.data.sessionId;
    }
    if (options.edgeCases) {
      state.records.push(row('subagent_run', 'unknown-run', 7, {
        taskId, parentSessionId: sessionId, parentCallId: 'unknown-call', parentToolId: 'c'.repeat(64),
        label: 'Unverified run', executionMode: 'unknown', state: 'unknown', activity: [], incomplete: true, truncated: true, stopSupported: false,
      }), row('tool_stream', 'legacy-wrapper', 8, {
        name: 'subagent', arguments: { agent: 'Legacy background', task: 'Old assignment', async: true }, state: 'finished', streaming: false,
        details: { results: [{ exitCode: 0 }] }, output: 'LEGACY_RAW_SECRET_MUST_NOT_RENDER',
      }));
    }
    if (options.malformed) {
      for (const [index, patch] of [
        { parentSessionId: 'not-a-uuid' }, { parentToolId: 'not-a-digest' }, { stopSupported: true }, { metadata: { secret: 'PRIVATE_METADATA' } },
      ].entries()) state.records.push(row('subagent_run', `invalid:${index}`, 10 + index, { ...run.data, ...patch, label: `Rejected payload ${index}` }));
    }
  }
  return fixture;
}

// Extend the existing native fixture locally; do not patch its file or replace app modules.
function installSubagentEvents() {
  const native = window.__TAURI_INTERNALS__, control = window.__workspacePanelTest;
  const callbacks = new Map(), streams = new Map();
  const transformCallback = native.transformCallback.bind(native), invoke = native.invoke.bind(native);
  native.transformCallback = (callback, once) => {
    const id = transformCallback(callback, once); callbacks.set(id, callback); return id;
  };
  native.invoke = (command, args = {}) => {
    if (/send_command|retry_command|browser_request|open_url|terminal|save_|upload|artifact/.test(command)) {
      control.unexpected.push({ command, args: structuredClone(args) });
      return Promise.reject(new Error(`Subagent test blocked side-effect IPC: ${command}`));
    }
    if (command === 'environment_stream_events') streams.set(args.environmentId, { channel: args.channel.id, index: 1 });
    return invoke(command, args);
  };
  control.publishRun = owner => {
    const state = control.states[owner], stream = streams.get(owner), record = state.pendingRun;
    if (!stream || state.offline || !record || state.records.some(item => item.id === record.id)) throw new Error('No pending synthetic public run');
    state.records.push(record);
    delete state.pendingRun;
    callbacks.get(stream.channel)({ index: stream.index++, message: { type: 'records', cursor: ++state.cursor, records: [structuredClone(record)] } });
  };
  control.updateRun = (owner, id, patch) => {
    const state = control.states[owner], stream = streams.get(owner);
    if (!stream || state.offline) throw new Error('No connected synthetic stream');
    const record = state.records.find(record => record.kind === 'subagent_run' && record.id === id);
    if (!record) throw new Error('Unknown synthetic run');
    record.data = { ...record.data, ...patch };
    record.revision++;
    record.updatedAt = new Date(Date.parse(record.updatedAt) + 60_000).toISOString();
    callbacks.get(stream.channel)({ index: stream.index++, message: { type: 'records', cursor: ++state.cursor, records: [structuredClone(record)] } });
  };
}

function distSnapshot() {
  const hash = createHash('sha256');
  let javascript = '';
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path); hash.update(path.slice(root.length)).update(bytes);
        if (entry.name.endsWith('.js')) javascript += bytes.toString();
      }
    }
  };
  visit(root);
  return { hash: hash.digest('hex'), ready: existsSync(resolve(root, 'index.html')) && ['subagent-card', 'subagent-run-panel', 'subagent-run-dialog', 'Open run'].every(marker => javascript.includes(marker)) };
}
async function waitForDist() {
  const deadline = Date.now() + waitMs;
  let previous;
  do {
    try {
      const snapshot = distSnapshot();
      if (snapshot.ready && (waitMs === 0 || snapshot.hash === previous)) return snapshot.hash;
      previous = snapshot.ready ? snapshot.hash : undefined;
    } catch { previous = undefined; }
    if (Date.now() >= deadline) break;
    await delay(1000);
  } while (true);
  throw new Error(`Subagent E2E is ready, but desktop/dist has no stable Subagent UI build after ${waitMs}ms. Build in the parent, then rerun; this test never builds or edits dist.`);
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = createServer((request, response) => {
  try {
    const path = resolve(root, decodeURIComponent(new URL(request.url, 'http://fixture').pathname).slice(1) || 'index.html');
    if (request.method !== 'GET' || !path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(readFileSync(path));
  } catch { response.writeHead(400).end(); }
});
server.requestTimeout = 5000; server.headersTimeout = 5000;
let browser, origin, checks = 0, distHash;
const failures = [], results = [];

async function selectChat(page, owner = A) {
  const button = page.locator(`.chat-server-group[data-server-id="${owner}"] button[data-task-id="${taskId}"]`);
  await button.waitFor({ state: 'attached' });
  await button.evaluate(node => node.click());
  await page.waitForFunction(owner => document.querySelector('.main-shell')?.dataset.ownerId === owner, owner);
  await page.locator('.task-workspace-heading h1').filter({ hasText: owner === A ? 'Subagent task Alpha' : 'Subagent task Beta' }).waitFor();
  await settle(page);
}
async function openRun(page, label = 'Audit Alpha', expanded = false) {
  const target = card(page, label);
  await target.waitFor();
  if (!await target.evaluate(node => node.open)) await target.locator(':scope > summary').click();
  await target.getByRole('button', { name: expanded ? 'Expand subagent run' : 'Open run', exact: true }).click();
  await (expanded ? dialog(page) : panel(page)).waitFor();
  await settle(page);
}
async function focused(locator, message) {
  await locator.page().waitForFunction(selector => {
    const node = document.querySelector(selector);
    return node && node === document.activeElement;
  }, await locator.evaluate(node => {
    // A test-only selector avoids assumptions about which card button the parent restores.
    node.setAttribute('data-subagent-focus-target', 'true'); return '[data-subagent-focus-target="true"]';
  }));
  check(await locator.evaluate(node => node === document.activeElement), message);
  await locator.evaluate(node => node.removeAttribute('data-subagent-focus-target'));
}
async function chooseView(container, name) {
  const button = container.getByRole('group', { name: 'Run view' }).getByRole('button', { name, exact: true });
  await button.click(); equal(await button.getAttribute('aria-pressed'), 'true', `${name} view selected`);
}
async function setColumnsWidth(page, width) {
  const current = await page.locator('.task-columns').boundingBox();
  await page.setViewportSize({ width: Math.round(page.viewportSize().width + width - current.width), height: 1000 });
  await page.waitForFunction(width => Math.abs(document.querySelector('.task-columns').getBoundingClientRect().width - width) < 1, width);
  await settle(page);
}
async function capture(page, name) {
  if (!screenshotsEnabled) return;
  await settle(page);
  mkdirSync(screenshotDirectory, { recursive: true });
  const path = `${screenshotDirectory}/${engine.name()}-${name}.png`;
  await page.screenshot({ path, animations: 'disabled', timeout: 5000 });
  console.log(`SCREENSHOT ${path}`);
}
async function scenario(name, options, run) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: options.colorScheme ?? 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [], external = [], dialogs = [];
  const result = { name, status: 'passed' }; results.push(result);
  page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async popup => { dialogs.push(popup.message()); await popup.dismiss(); });
  try {
    await context.route('**/*', route => {
      const request = route.request();
      if (new URL(request.url()).origin === origin && request.method() === 'GET') return route.continue();
      external.push(`${request.method()} ${request.url()}`); return route.abort();
    });
    await context.routeWebSocket('**/*', socket => { external.push(socket.url()); socket.close(); });
    // One script guarantees installation order on both Chromium and WebKit.
    await context.addInitScript({ content: `(${installWorkspaceTransport.toString()})(${JSON.stringify(fixture(options))});(${installSubagentEvents.toString()})();` });
    await page.goto(origin);
    await openInitialTestChat(page);
    await page.waitForFunction(() => Object.values(window.__workspacePanelTest.states).every(state => state.ready));
    await selectChat(page);
    await page.evaluate(() => document.fonts.ready);
    await run(page);
  } catch (error) {
    result.status = 'failed'; failures.push(new Error(`${name}: ${error.message}`, { cause: error }));
    console.error(`FAIL ${engine.name()} / ${name}\n${error.stack}`);
  } finally {
    try {
      const ipc = await page.evaluate(() => ({ unexpected: window.__workspacePanelTest.unexpected, downloads: window.__workspacePanelTest.downloads, calls: window.__workspacePanelTest.calls }));
      equal(errors, [], `${name}: no runtime errors`);
      equal(external, [], `${name}: no external HTTP/WebSocket requests`);
      equal(dialogs, [], `${name}: no script or confirmation dialogs`);
      equal(ipc.unexpected, [], `${name}: native IPC remains allowlisted`);
      equal(ipc.downloads, [], `${name}: no native file writes`);
      equal(ipc.calls.filter(call => /send_command|retry_command|browser_request|open_url|terminal|save_|upload|artifact/.test(call.command)), [], `${name}: no side-effect commands`);
      check(ipc.calls.filter(call => call.command === 'environment_query').every(call => [A, B].includes(call.args.environmentId)), `${name}: all queries are owner scoped`);
    } catch (error) {
      result.status = 'failed'; failures.push(new Error(`${name} safety: ${error.message}`, { cause: error }));
      console.error(`FAIL ${name} safety: ${error.message}`);
    }
    await context.close();
  }
  if (result.status === 'passed') console.log(`PASS ${engine.name()} / ${name}`);
}

async function run() {
  console.log(`Waiting up to ${waitMs}ms for a stable existing Subagent UI dist (${engine.name()}).`);
  distHash = await waitForDist();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await engine.launch({ headless: true, timeout: 15_000 });

  await scenario('public-card-dedup-and-live-completion', { malformed: true }, async page => {
    await card(page).waitFor();
    equal(await page.locator('.subagent-card').count(), 1, 'Public run replaces wrapper; malformed public records do not become cards');
    const summary = card(page).locator(':scope > summary');
    check((await summary.innerText()).includes('Audit Alpha'), 'Compact summary contains title');
    equal((await summary.locator('.subagent-card-model').innerText()).replace(/^\s*·\s*/, ''), 'provider/child-model', 'Summary uses child model, not parent model');
    equal(await summary.locator('.subagent-status svg').count(), 1, 'Summary has a status icon');
    equal(await summary.locator('.subagent-status').getAttribute('title'), 'Running', 'Compact status retains its accessible label');
    check(await summary.locator('.subagent-status > span').evaluate(node => {
      const style = getComputedStyle(node);
      return node.textContent === 'Running' && style.clipPath === 'inset(50%)' && style.display !== 'none' && !node.closest('[aria-hidden="true"]');
    }), 'Compact status text is visually clipped, not removed from accessibility');
    check((await summary.boundingBox()).height < 110, 'Summary remains compact');
    check(!await card(page).evaluate(node => node.open), 'Run starts collapsed');
    check(!await panel(page).isVisible(), 'Side panel starts closed');
    check(!(await page.locator('.conversation').innerText()).includes('wrapper-must-be-deduplicated'), 'Wrapper is not rendered as a duplicate execution');
    await capture(page, 'dark-collapsed');
    await summary.click();
    await card(page).getByRole('button', { name: 'Open run', exact: true }).waitFor();
    check(!await panel(page).isVisible(), 'Expanding inline card does not open inspector');
    await capture(page, 'dark-expanded-inline');
    await openRun(page);
    await chooseView(panel(page), 'Result');
    await panel(page).getByText('Recorded partial findings Alpha.', { exact: true }).waitFor();
    await page.evaluate(() => {
      const node = document.querySelector('.subagent-card');
      window.__subagentAnchor = { node, parent: node.parentElement, group: node.closest('.conversation-run'), order: [...document.querySelectorAll('.conversation .subagent-card, .conversation [data-record-id]')] };
    });
    await page.evaluate(({ owner, id }) => window.__workspacePanelTest.updateRun(owner, id, {
      state: 'completed', streaming: false, incomplete: false, endedAt: Date.parse('2026-11-17T10:00:12.000Z'), summary: 'Verified final findings Alpha.',
    }), { owner: A, id: runId });
    await card(page).locator('.subagent-status[data-state="completed"]').waitFor();
    await panel(page).getByText('Verified final findings Alpha.', { exact: true }).waitFor();
    equal(await page.locator('.subagent-card').count(), 1, 'Completion never duplicates run');
    check(await page.evaluate(() => {
      const before = window.__subagentAnchor, node = document.querySelector('.subagent-card');
      const order = [...document.querySelectorAll('.conversation .subagent-card, .conversation [data-record-id]')];
      return node === before.node && node.parentElement === before.parent && node.closest('.conversation-run') === before.group && order.length === before.order.length && order.every((node, index) => node === before.order[index]);
    }), 'Completion updates in place without remounting, moving turns, or reordering transcript');
    equal(await panel(page).getByRole('button', { name: 'Result', exact: true }).getAttribute('aria-pressed'), 'true', 'Completion preserves selected view');
    equal(await card(page).locator('.subagent-card-duration').innerText(), '12s', 'Completed duration comes from recorded child interval');
  });

  await scenario('live-legacy-to-public-preserves-card-and-inspector', { legacyFirst: true }, async page => {
    await openRun(page, 'Legacy audit Alpha');
    await panel(page).getByText('Older run · Detailed activity was not recorded.', { exact: true }).waitFor();
    const assignment = panel(page).locator('.subagent-assignment');
    check(await assignment.evaluate(node => node.open), 'Legacy assignment starts expanded');
    await assignment.locator('summary').click();
    await page.waitForFunction(() => !document.querySelector('.subagent-run-panel .subagent-assignment').open);
    await chooseView(panel(page), 'Result');
    await panel(page).getByText('Older-run details unavailable.', { exact: true }).waitFor();
    await page.evaluate(() => {
      const card = document.querySelector('.subagent-card'), inspector = document.querySelector('.subagent-run-panel');
      window.__subagentHandoff = {
        card, parent: card.parentElement, group: card.closest('.conversation-run'), inspector,
        heading: inspector.querySelector('.subagent-run-heading'), content: inspector.querySelector('.subagent-run-scroll'),
        result: inspector.querySelector('.subagent-view-tabs button[aria-pressed="true"]'),
        order: [...document.querySelectorAll('.conversation .subagent-card, .conversation [data-record-id]')],
      };
    });
    await page.evaluate(owner => window.__workspacePanelTest.publishRun(owner), A);
    await panel(page).getByRole('heading', { name: 'Audit Alpha', exact: true }).waitFor();
    await settle(page);
    equal(await page.locator('.subagent-card').count(), 1, 'Public arrival replaces rather than duplicates legacy card');
    equal(await page.evaluate(() => {
      const before = window.__subagentHandoff, card = document.querySelector('.subagent-card'), inspector = document.querySelector('.subagent-run-panel');
      const order = [...document.querySelectorAll('.conversation .subagent-card, .conversation [data-record-id]')];
      return {
        sameCard: before.card === card, expanded: card.open, sameParent: before.parent === card.parentElement,
        sameTurn: before.group === card.closest('.conversation-run'), sameInspector: before.inspector === inspector,
        sameHeading: before.heading === inspector.querySelector('.subagent-run-heading'),
        sameContent: before.content === inspector.querySelector('.subagent-run-scroll'),
        sameSelectedView: before.result === inspector.querySelector('.subagent-view-tabs button[aria-pressed="true"]'),
        sameOrder: order.length === before.order.length && order.every((node, index) => node === before.order[index]),
      };
    }), { sameCard: true, expanded: true, sameParent: true, sameTurn: true, sameInspector: true, sameHeading: true, sameContent: true, sameSelectedView: true, sameOrder: true }, 'Legacy-to-public handoff retains DOM identity, expansion, inspector view, and transcript order');
    equal(await panel(page).getByRole('button', { name: 'Result', exact: true }).getAttribute('aria-pressed'), 'true', 'Public arrival preserves selected Result view');
    await panel(page).getByText('Recorded partial findings Alpha.', { exact: true }).waitFor();
    equal(await panel(page).getByText('Older run · Detailed activity was not recorded.', { exact: true }).count(), 0, 'Public evidence replaces obsolete legacy notices');
    await chooseView(panel(page), 'Activity');
    check(!await assignment.evaluate(node => node.open), 'Assignment disclosure memory survives legacy-to-public replacement');
    await assignment.locator('summary').click();
    await assignment.getByText('Inspect recorded evidence for Alpha. Do not execute anything.', { exact: true }).waitFor();
    const tool = panel(page).locator('.subagent-tool');
    await tool.locator('summary').click();
    await page.evaluate(() => { window.__subagentHandoffTool = document.querySelector('.subagent-run-panel .subagent-tool'); });
    await page.evaluate(({ owner, id }) => window.__workspacePanelTest.updateRun(owner, id, { summary: 'Enriched public evidence after handoff.' }), { owner: A, id: runId });
    await card(page).getByText('Enriched public evidence after handoff.', { exact: true }).waitFor();
    check(await tool.evaluate(node => node === window.__subagentHandoffTool && node.open), 'Post-handoff live enrichment preserves tool node and disclosure');
    await capture(page, 'dark-legacy-public-handoff');
    await panel(page).getByRole('button', { name: 'Close subagent run', exact: true }).click();
    await focused(card(page).getByRole('button', { name: 'Open run', exact: true }), 'Post-handoff close restores original card trigger');
  });

  await scenario('activity-result-tool-disclosures-and-modal-focus', {}, async page => {
    await openRun(page);
    const tool = container => container.locator('.subagent-tool');
    check(!await tool(panel(page)).evaluate(node => node.open), 'Recorded tool starts collapsed');
    await tool(panel(page)).locator('summary').click();
    await tool(panel(page)).getByText('{"path":"notes.md"}', { exact: true }).waitFor();
    check((await tool(panel(page)).innerText()).includes('Recorded output Alpha.'), 'Disclosure exposes recorded output');
    equal(await tool(panel(page)).locator('img, iframe, script').count(), 0, 'Tool output is inert text, never HTML');
    await chooseView(panel(page), 'Result');
    await panel(page).getByRole('region', { name: 'Recorded files' }).getByText('notes.md', { exact: true }).waitFor();
    await chooseView(panel(page), 'Activity');
    check(await tool(panel(page)).evaluate(node => node.open), 'Tool disclosure survives view switches');
    await capture(page, 'dark-side-inspector');
    await panel(page).getByRole('button', { name: 'Expand run', exact: true }).click();
    await dialog(page).waitFor();
    check(await dialog(page).evaluate(node => node instanceof HTMLDialogElement && node.open && node.matches(':modal')), 'Expanded view is a native modal dialog');
    check(!await panel(page).isVisible(), 'Modal replaces side content rather than duplicating it');
    check(await tool(dialog(page)).evaluate(node => node.open), 'Tool disclosure survives expansion');
    await capture(page, 'dark-modal');
    await toggle(page).evaluate(node => node.focus());
    check(await dialog(page).evaluate(node => node.contains(document.activeElement)), 'Native modal prevents background control focus');
    for (let index = 0; index < 14; index++) {
      await page.keyboard.press(index < 7 ? 'Tab' : 'Shift+Tab');
      const focus = await dialog(page).evaluate(node => ({ inside: node.contains(document.activeElement), tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label'), documentFocused: document.hasFocus() }));
      // WebKit's native dialog cycle visits browser chrome, reporting BODY with document focus lost.
      const browserChrome = engine.name() === 'webkit' && focus.tag === 'BODY' && !focus.documentFocused;
      check(focus.inside || browserChrome, `Modal keyboard navigation never reaches background content (step ${index + 1}: ${JSON.stringify(focus)})`);
    }
    check(await dialog(page).evaluate(node => node.contains(document.activeElement)), 'Keyboard cycle returns focus to the modal');
    await page.keyboard.press('Escape');
    await dialog(page).waitFor({ state: 'hidden' }); await panel(page).waitFor();
    await focused(panel(page).getByRole('button', { name: 'Expand run', exact: true }), 'Escape restores side expand focus');
    check(await tool(panel(page)).evaluate(node => node.open), 'Escape preserves disclosure state');
    await panel(page).getByRole('button', { name: 'Expand run', exact: true }).click();
    await dialog(page).getByRole('button', { name: 'Close subagent run', exact: true }).click();
    await dialog(page).waitFor({ state: 'hidden' }); await panel(page).waitFor();
    await panel(page).getByRole('button', { name: 'Close subagent run', exact: true }).click();
    await panel(page).waitFor({ state: 'hidden' });
    await focused(card(page).getByRole('button', { name: 'Open run', exact: true }), 'Closing side panel restores originating card button');
    await openRun(page, 'Audit Alpha', true);
    await dialog(page).getByRole('button', { name: 'Return to side panel', exact: true }).click();
    await panel(page).waitFor();
    await panel(page).getByRole('button', { name: 'Close subagent run', exact: true }).click();
    await focused(card(page).getByRole('button', { name: 'Expand subagent run', exact: true }), 'Direct card expansion restores its own originating button');
  });

  await scenario('shared-workspace-selection-and-file-switching', {}, async page => {
    await openRun(page);
    const header = await toggle(page).boundingBox();
    check((await page.locator('.conversation-column').boundingBox()).width >= 599, 'Run pane preserves 600px minimum chat');
    check((await panel(page).boundingBox()).x >= (await page.locator('.conversation-column').boundingBox()).x + 599, 'Run pane sits beside chat');
    await toggle(page).click(); await panel(page).waitFor({ state: 'hidden' });
    await toggle(page).click(); await panel(page).waitFor();
    check(!await page.locator('#task-resources').isVisible(), 'Header reopens selected run, not Files');
    await files(page).click(); await page.locator('#task-resources').waitFor();
    check(!await panel(page).isVisible(), 'Composer Files replaces the run pane');
    await page.locator('.workspace-file-row').filter({ hasText: 'notes.md' }).click();
    await page.locator('.workspace-document-body').getByText('Actual workspace Alpha', { exact: false }).waitFor();
    await toggle(page).click(); await page.locator('#task-resources').waitFor({ state: 'hidden' });
    await toggle(page).click(); await page.locator('#task-resources').waitFor();
    check(!await panel(page).isVisible(), 'Header reopens selected Files pane');
    await openRun(page);
    check(!await page.locator('#task-resources').isVisible(), 'Opening run replaces Files pane');
    const after = await toggle(page).boundingBox(); near(after.x, header.x, 'Header toggle remains fixed horizontally'); near(after.y, header.y, 'Header toggle remains fixed vertically');
    const reads = await page.evaluate(() => window.__workspacePanelTest.calls.filter(call => call.command === 'environment_query' && call.args.kind === 'workspace.read'));
    check(reads.length > 0 && reads.every(call => call.args.environmentId === A && call.args.payload.taskId === taskId && call.args.payload.path === 'notes.md'), 'File reads use exact selected owner/task/path');
  });

  await scenario('shared-600px-boundary-and-narrow-single-pane', {}, async page => {
    await openRun(page);
    await setColumnsWidth(page, 1020);
    equal(await page.locator('.task-columns').getAttribute('data-workspace-single'), 'false', '1020px supports two panes');
    near((await page.locator('.conversation-column').boundingBox()).width, 600, 'Minimum chat is 600px');
    near((await panel(page).boundingBox()).width, 420, 'Minimum run pane is 420px');
    const separator = page.getByRole('separator', { name: 'Resize chat and workspace' });
    await separator.focus(); await page.keyboard.press('Home'); await settle(page);
    near((await page.locator('.conversation-column').boundingBox()).width, 600, 'Run pane shares workspace keyboard resizing constraint');
    await setColumnsWidth(page, 1019);
    equal(await page.locator('.task-columns').getAttribute('data-workspace-single'), 'true', 'Below minimum switches to single pane');
    check(!await page.locator('.conversation-column').isVisible(), 'Narrow run pane hides chat');
    equal(await separator.count(), 0, 'Narrow run pane has no splitter');
    near((await panel(page).boundingBox()).width, (await page.locator('.task-columns').boundingBox()).width, 'Run fills narrow workspace');
    await page.setViewportSize({ width: 720, height: 900 }); await settle(page);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Narrow pane causes no document overflow');
    await capture(page, 'dark-narrow');
    await panel(page).getByRole('button', { name: 'Expand run', exact: true }).click();
    await page.keyboard.press('Escape'); await panel(page).waitFor();
    await panel(page).getByRole('button', { name: 'Close subagent run', exact: true }).focus();
    await page.keyboard.press('Escape'); await panel(page).waitFor({ state: 'hidden' });
    check(await page.locator('.conversation-column').isVisible(), 'Side Escape returns narrow layout to conversation');
    await focused(card(page).getByRole('button', { name: 'Open run', exact: true }), 'Narrow close restores originating card');
  });

  await scenario('light-theme-inspector-and-modal', { colorScheme: 'light' }, async page => {
    await card(page).waitFor();
    equal(await page.locator('html').getAttribute('data-theme'), 'light', 'Real app follows light system theme');
    await capture(page, 'light-collapsed');
    await openRun(page);
    check(await page.locator('.conversation-column').isVisible(), 'Light inspector remains beside chat');
    equal(await panel(page).locator('.subagent-run-heading .subagent-status').innerText(), 'Running', 'Light inspector status is readable text');
    await capture(page, 'light-side-inspector');
    await panel(page).getByRole('button', { name: 'Expand run', exact: true }).click();
    await dialog(page).waitFor();
    check(await dialog(page).evaluate(node => node.matches(':modal')), 'Light expanded view uses native modal');
    await capture(page, 'light-modal');
    await page.keyboard.press('Escape');
    await panel(page).waitFor();
    await focused(panel(page).getByRole('button', { name: 'Expand run', exact: true }), 'Light modal Escape restores inspector focus');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Light theme has no document overflow');
  });

  await scenario('unknown-legacy-and-offline-evidence', { edgeCases: true }, async page => {
    await card(page, 'Unverified run').waitFor();
    equal(await page.locator('.subagent-card').count(), 3, 'Public, unknown, and independent legacy runs render once each');
    await openRun(page, 'Unverified run');
    await panel(page).getByText('The outcome is unknown. No successful completion is confirmed.', { exact: true }).waitFor();
    check((await panel(page).innerText()).includes('Model not recorded'), 'Unknown child model is explicit');
    check(!(await panel(page).innerText()).includes('parent-model-must-not-leak'), 'Parent model is not substituted');
    await panel(page).getByText('Recorded content was truncated. Some details are omitted.', { exact: true }).waitFor();
    await panel(page).getByRole('button', { name: 'Close subagent run', exact: true }).click();
    await openRun(page, 'Legacy background');
    await panel(page).getByText('Older run · Detailed activity was not recorded.', { exact: true }).waitFor();
    await panel(page).getByText('The outcome is unknown. No successful completion is confirmed.', { exact: true }).waitFor();
    await chooseView(panel(page), 'Result');
    await panel(page).getByText('Older-run details unavailable.', { exact: true }).waitFor();
    check(!(await page.locator('.task-view').innerText()).includes('LEGACY_RAW_SECRET_MUST_NOT_RENDER'), 'Legacy raw output is not exposed');
    await panel(page).getByRole('button', { name: 'Close subagent run', exact: true }).click();
    await openRun(page);
    await page.evaluate(owner => window.__workspacePanelTest.offline(owner), A);
    await panel(page).getByText('Offline · Showing recorded data. Current activity cannot be verified.', { exact: true }).waitFor();
    equal(await panel(page).locator('.subagent-spin').count(), 0, 'Offline run has no live animation');
    equal(await card(page).locator('summary .subagent-status').innerText(), 'Last known: Running', 'Offline card exposes last-known status explicitly');
    equal(await card(page).locator('summary .subagent-status').getAttribute('data-compact'), 'false', 'Offline status is not visually clipped');
    equal(await panel(page).locator('.subagent-run-heading .subagent-status').innerText(), 'Last known: Running', 'Offline inspector exposes last-known status explicitly');
    equal(await panel(page).locator('.subagent-duration').count(), 0, 'Offline active run stops advertising live elapsed time');
    equal(await panel(page).getByRole('button', { name: /stop|cancel|retry/i }).count(), 0, 'No fabricated subagent mutations');
    await chooseView(panel(page), 'Result');
    await panel(page).getByText('Recorded partial findings Alpha.', { exact: true }).waitFor();
  });

  await scenario('owner-isolation-with-identical-task-and-run-ids', {}, async page => {
    await openRun(page, 'Audit Alpha', true);
    await selectChat(page, B);
    await dialog(page).waitFor({ state: 'hidden' });
    check(!await panel(page).isVisible(), 'Owner switch resets prior run selection and presentation');
    await openRun(page, 'Audit Beta');
    await panel(page).getByText('Observed activity Beta.', { exact: true }).waitFor();
    await page.evaluate(({ owner, id }) => window.__workspacePanelTest.updateRun(owner, id, { state: 'completed', summary: 'STALE_ALPHA_COMPLETION', streaming: false }), { owner: A, id: runId });
    await settle(page);
    check(!(await panel(page).innerText()).includes('Alpha'), 'Late previous-owner update cannot replace identical run on new owner');
    equal(await panel(page).locator('.subagent-run-heading .subagent-status').getAttribute('data-state'), 'running', 'Current owner status is isolated');
    await files(page).click(); await page.locator('#task-resources').waitFor();
    await page.locator('.workspace-file-row').filter({ hasText: 'notes.md' }).click();
    await page.locator('.workspace-document-body').getByText('Actual workspace Beta', { exact: false }).waitFor();
    const reads = await page.evaluate(() => window.__workspacePanelTest.calls.filter(call => call.command === 'environment_query' && call.args.kind === 'workspace.read'));
    check(reads.length > 0 && reads.every(call => call.args.environmentId === B && call.args.payload.taskId === taskId), 'Files after owner switch read only the new owner');
  });
}

const started = Date.now();
const watchdog = setTimeout(() => {
  console.error('Subagent E2E hard watchdog exceeded; no production files were modified.');
  server.closeAllConnections(); server.close(); void browser?.close(); process.exit(1);
}, waitMs + 150_000);
try { await run(); } catch (error) { failures.push(error); console.error(error.stack); }
finally {
  try {
    if (distHash) equal(distSnapshot().hash, distHash, 'Existing dist remained unchanged during E2E execution');
  } catch (error) { failures.push(error); }
  await browser?.close(); server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  clearTimeout(watchdog);
}
console.log(`Subagents (${engine.name()}): ${results.filter(result => result.status === 'passed').length}/${results.length} scenarios, ${checks} assertions, ${Date.now() - started}ms.`);
if (failures.length) throw new AggregateError(failures, 'Subagent real-app E2E failed; production files were not modified');
