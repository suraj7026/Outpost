import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openSettings } from './settings-test-navigation.mjs';

// Synthetic native lifecycle and owner-bound IPC; no real servers or credentials.
const root = resolve('desktop/dist');
const server = createServer((request, response) => {
  const file = resolve(root, new URL(request.url, 'http://fixture').pathname.slice(1) || 'index.html');
  if (!file.startsWith(root + '/') || !existsSync(file)) return response.writeHead(404).end();
  response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream');
  response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let checks = 0; const errors = [];
const check = (value, message) => { assert.ok(value, message); checks++; };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ A, B }) => {
    window.isTauri = true;
    const row = (kind, id, data) => ({ kind, id, revision: 1, updatedAt: '2026-11-11T00:00:00Z', data });
    const records = id => [row('task', 'same-task', { goal: id === A ? 'Alpha task' : 'Beta task', profile: 'code', state: 'paused' }), row('message', 'same-message', { taskId: 'same-task', author: 'assistant', text: id === A ? 'Alpha private history' : 'Beta private history' })];
    let phase = localStorage.getItem('fixture-paused') === 'true' ? 'paused' : 'connecting';
    let endpoint = 'http://127.0.0.1:57066';
    const callbacks = new Map(), streams = new Map(); let sequence = 0;
    const registry = { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: A, environments: {
      [A]: { environmentId: A, label: 'Alpha', routes: [endpoint], activeRoute: endpoint },
      [B]: { environmentId: B, label: 'Beta', routes: ['https://beta.example'], activeRoute: 'https://beta.example' },
    } };
    window.__requests = [];
    window.__transition = (next, port, error) => {
      phase = next;
      if (port) { endpoint = `http://127.0.0.1:${port}`; registry.environments[A].activeRoute = endpoint; registry.environments[A].routes = [endpoint]; }
      if (error) streams.get(A)?.reject(error); else streams.get(A)?.resolve();
      streams.delete(A);
    };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; }, unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args = {}) {
        if (command.startsWith('plugin:') || command === 'set_sidebar_window_controls') return;
        if (command === 'sidebar_pointer_inside') return false;
        window.__requests.push({ command, args: structuredClone(args) });
        if (command === 'environment_list') return { registry: structuredClone(registry), legacy: { endpoint: null, pending: false } };
        if (command === 'connections_wake') return;
        if (command === 'environment_select') { registry.selectedEnvironmentId = args.environmentId; return structuredClone(registry); }
        const id = args.environmentId ?? 'legacy', op = command.replace(/^environment_/, '');
        if (op === 'disconnect') {
          streams.get(id)?.resolve(); streams.delete(id);
          if (id === A && args.pause) { phase = 'paused'; localStorage.setItem('fixture-paused', 'true'); }
          return;
        }
        if (op === 'connection_policy') {
          assertOwner(id);
          phase = args.enabled ? 'connecting' : 'paused'; localStorage.setItem('fixture-paused', String(!args.enabled)); return;
        }
        if (op === 'connection_info') return { endpoint: id === A ? endpoint : `https://${id}.example`, deviceId: 'fixture', publicKey: '', pending: id === A, nativeSidebar: false,
          lifecycle: id === A ? { state: phase, error: phase === 'needs_attention' ? 'Pinned host key changed; connection blocked' : null } : null };
        if (op === 'query') {
          if (id === A && phase !== 'connected') throw new Error('Unexpected query against an unavailable managed tunnel');
          if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: 1, records: id === 'legacy' ? [] : records(id) };
          if (args.kind === 'runtime') return { configured: true, model: 'fixture:cloud' };
          if (args.kind === 'models') return { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' };
          if (args.kind === 'events') return { events: [], nextCursor: 1, hasMore: false };
        }
        if (op === 'stream_events') return new Promise((resolve, reject) => {
          streams.set(id, { resolve, reject });
          callbacks.get(args.channel.id)?.({ index: 0, message: { type: 'snapshot', cursor: 1, records: id === 'legacy' ? [] : records(id), live: [] } });
        });
        throw new Error(`Unexpected mutation ${command}`);
      },
    };
    function assertOwner(id) { if (id !== A) throw new Error('Wrong owner lifecycle operation'); }
  }, { A, B });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('Reconnecting securely… Your saved server access is being restored automatically.', { exact: true }).waitFor();
  check(await page.getByRole('button', { name: 'Retry connection', exact: true }).count() === 0, 'Ordinary restoration is a status, not a manual-retry error');
  check(await page.evaluate(A => !window.__requests.some(request => request.command === 'environment_query' && request.args.environmentId === A), A), 'No reads are sent to the stale loopback endpoint during restoration');
  await page.evaluate(() => window.__transition('connected', 58001));
  await page.getByText('Alpha private history', { exact: true }).waitFor();
  check(await page.locator('.main-shell').getAttribute('data-owner-id') === A, 'Startup restores the same owner');
  check(await page.getByRole('button', { name: 'Retry same command', exact: true }).count() === 1, 'Unknown command outcome is retained, never replayed by reconnection');
  await page.getByRole('textbox', { name: 'Message Outpost' }).fill('Keep my unsent draft');
  await page.evaluate(() => window.__transition('retrying', undefined, 'error decoding response body'));
  await page.getByText('Reconnecting securely… Your saved server access is being restored automatically.', { exact: true }).waitFor();
  check(await page.getByRole('button', { name: 'Retry connection', exact: true }).count() === 0, 'A dropped stream does not show a routine manual-retry error');
  mkdirSync('/tmp/outpost-reconnect', { recursive: true });
  await page.screenshot({ path: `/tmp/outpost-reconnect/recovering-${engine.name()}.png` });
  check(await page.getByText('Alpha private history', { exact: true }).isVisible(), 'Cached history remains visible while the tunnel is down');
  await page.evaluate(() => window.__transition('connected', 58002));
  await page.waitForFunction(() => !document.body.textContent.includes('Reconnecting securely…'));
  check(await page.getByRole('textbox', { name: 'Message Outpost' }).inputValue() === 'Keep my unsent draft', 'A replacement ephemeral route does not remount the conversation or discard its draft');
  check(await page.getByRole('button', { name: 'Retry same command', exact: true }).count() === 1, 'Pending command survives a tunnel replacement');
  await page.locator(`.chat-server-group[data-server-id="${B}"] button[data-task-id="same-task"]`).click();
  await page.getByText('Beta private history', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Message Outpost' }).fill('Beta stays selected');
  await page.evaluate(() => { window.__transition('retrying'); window.__transition('connected', 58003); });
  await page.waitForTimeout(2500);
  check(await page.locator('.main-shell').getAttribute('data-owner-id') === B, 'Alpha recovery never retargets the active Beta chat');
  check(await page.getByRole('textbox', { name: 'Message Outpost' }).inputValue() === 'Beta stays selected', 'Another server recovering preserves the active draft');
  await openSettings(page, { server: A, tab: 'general' });
  await page.getByRole('button', { name: 'Pause connection', exact: true }).click();
  await page.getByRole('button', { name: 'Resume connection', exact: true }).waitFor();
  const queries = await page.evaluate(A => window.__requests.filter(request => request.command === 'environment_query' && request.args.environmentId === A).length, A);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(2500);
  check(await page.evaluate(() => window.__requests.some(request => request.command === 'connections_wake')), 'Network recovery wakes native reconciliation without changing connection policy');
  check(await page.evaluate(A => window.__requests.filter(request => request.command === 'environment_query' && request.args.environmentId === A).length, A) === queries, 'Explicit pause does not reconnect on the polling timer');
  await page.reload();
  await page.getByRole('button', { name: 'Resume connection', exact: true }).waitFor();
  check(await page.getByText('Connection paused', { exact: true }).count() > 0, 'Persisted native pause is respected after app restart');
  await page.getByRole('button', { name: 'Resume connection', exact: true }).click();
  await page.evaluate(() => window.__transition('connected', 58004));
  await page.getByRole('button', { name: 'Pause connection', exact: true }).waitFor();
  await page.evaluate(() => window.__transition('needs_attention'));
  await page.getByRole('alert').filter({ hasText: 'Pinned host key changed' }).waitFor();
  check(await page.getByRole('button', { name: 'Retry same command', exact: true }).count() === 1, 'A trust failure retains recovery data');
  check(await page.evaluate(() => !window.__requests.some(request => /setup_|send_command|retry_command|enroll_device/.test(request.command))), 'Recovery never invokes setup, enrollment or command replay from the webview');
  mkdirSync('/tmp/outpost-reconnect', { recursive: true });
  await page.screenshot({ path: `/tmp/outpost-reconnect/attention-${engine.name()}.png` });
  assert.deepEqual(errors, []);
  console.log(`PASS: ${checks} automatic-reconnection UI checks (${engine.name()})`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
