import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
import { openInitialTestChat } from './chat-test-navigation.mjs';

const root = resolve('desktop/dist');
const server = createServer((request, response) => {
  const file = resolve(root, new URL(request.url, 'http://fixture').pathname.slice(1) || 'index.html');
  if (!file.startsWith(root + '/') || !existsSync(file)) return response.writeHead(404).end();
  response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(file)] || 'application/octet-stream');
  response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let checks = 0;
const errors = [];
const check = (value, message) => { assert.ok(value, message); checks++; };

try {
  // 1. Sending task.steer and task.pause while SSE is active issues ZERO snapshot queries.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ A }) => {
      window.isTauri = true;
      const row = (kind, id, revision, data) => ({ kind, id, revision, updatedAt: '2026-11-20T00:00:00Z', data });
      let cursor = 1;
      let records = [
        row('task', 'task-1', 1, { goal: 'Verify zero snapshot thrash', profile: 'code', state: 'running' }),
        row('policy', 'task-1', 1, { mode: 'full_control' }),
        row('message', 'msg-1', 1, { taskId: 'task-1', author: 'assistant', text: 'Ready for steer' }),
      ];
      const callbacks = new Map();
      let seq = 0;
      let streamChannel = null;
      let streamIndex = 0;
      const registry = { version: 1, legacyMutationsRetired: true, selectedEnvironmentId: A, environments: {
        [A]: { environmentId: A, label: 'Alpha', routes: ['https://alpha.invalid'], activeRoute: 'https://alpha.invalid' },
      } };
      window.__requests = [];
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(fn) { const id = ++seq; callbacks.set(id, fn); return id; },
        unregisterCallback(id) { callbacks.delete(id); },
        async invoke(command, args = {}) {
          if (command.startsWith('plugin:') || command === 'set_sidebar_window_controls') return;
          if (command === 'sidebar_pointer_inside') return false;
          if (command === 'automatic_updates_status' || command === 'automatic_updates_tick') return { enabled: false, targets: [], activeEnvironmentId: null, servers: [] };
          if (command === 'connections_wake') return;
          window.__requests.push({ command, args: structuredClone(args) });
          if (command === 'environment_list') return { registry: structuredClone(registry), legacy: { endpoint: null, pending: false } };
          if (command === 'environment_select') return structuredClone(registry);
          const id = args.environmentId ?? 'legacy', op = command.replace(/^environment_/, '');
          if (id === 'legacy') {
            if (op === 'connection_info') return { endpoint: '', deviceId: 'fixture', publicKey: '', pending: false, nativeSidebar: false };
            if (op === 'disconnect') return;
            throw new Error(`Unexpected legacy IPC ${command}`);
          }
          if (op === 'disconnect') return;
          if (op === 'connection_info') return { environmentId: A, endpoint: 'https://alpha.invalid', deviceId: 'fixture', publicKey: '', pending: false, nativeSidebar: false };
          if (op === 'query') {
            if (args.kind === 'snapshot') return { protocolVersion: 1, cursor, records: structuredClone(records) };
            if (args.kind === 'runtime') return { controlModes: ['full_control', 'auto'], autoPolicyVersion: 1, configured: true, model: 'fixture:cloud', hostAdministration: false, unrestrictedCommands: false };
            if (args.kind === 'models') return { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' };
            if (args.kind === 'events') return { events: [], nextCursor: cursor, hasMore: false };
          }
          if (op === 'stream_events') return new Promise(() => {
            streamChannel = args.channel;
            callbacks.get(streamChannel.id)?.({ index: streamIndex++, message: { type: 'snapshot', cursor, records: structuredClone(records), live: [] } });
          });
          if (op === 'send_command') {
            const previous = records.find(r => r.kind === 'task' && r.id === args.id);
            const next = structuredClone(previous);
            next.revision += 1;
            if (args.kind === 'task.pause') next.data.state = 'paused';
            records = records.map(r => r === previous ? next : r);
            cursor += 1;
            if (streamChannel) {
              callbacks.get(streamChannel.id)?.({ index: streamIndex++, message: { type: 'records', cursor, records: [structuredClone(next)] } });
            }
            return next;
          }
          throw new Error(`Unexpected IPC ${command}`);
        },
      };
    }, { A });

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await openInitialTestChat(page);
    await page.getByText('Ready for steer', { exact: true }).waitFor();

    const snapshotsBefore = await page.evaluate(() =>
      window.__requests.filter(r => r.command === 'environment_query' && r.args.kind === 'snapshot').length
    );
    check(snapshotsBefore === 1, `Expected 1 initial snapshot on connect, got ${snapshotsBefore}`);

    // Send task.steer while SSE is active
    await page.getByRole('textbox', { name: 'Message Outpost' }).fill('Follow up without snapshot');
    await page.getByRole('textbox', { name: 'Message Outpost' }).press('Meta+Enter');
    await page.waitForFunction(() =>
      window.__requests.some(r => r.command === 'environment_send_command' && r.args.kind === 'task.steer')
    );

    // Send task.pause while SSE is active
    await page.getByRole('button', { name: 'Pause task', exact: true }).click();
    await page.waitForFunction(() =>
      window.__requests.some(r => r.command === 'environment_send_command' && r.args.kind === 'task.pause')
    );
    await page.getByRole('button', { name: 'Resume task', exact: true }).waitFor();

    const snapshotsAfter = await page.evaluate(() =>
      window.__requests.filter(r => r.command === 'environment_query' && r.args.kind === 'snapshot').length
    );
    check(snapshotsAfter === snapshotsBefore, `Sending task.steer and task.pause while SSE is active must issue zero snapshot queries (before=${snapshotsBefore}, after=${snapshotsAfter})`);
    await page.close();
  }

  // 2. Disconnecting backs off reconnect attempts (2s -> 4s -> 8s -> 16s -> 30s max with +/-20% jitter)
  //    and resets immediately on window focus, online event, and manual connect click.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ A }) => {
      window.isTauri = true;
      const originalSetTimeout = window.setTimeout.bind(window);
      window.__backoffDelays = [];
      window.__recordingBackoff = false;
      window.setTimeout = (fn, delay = 0, ...args) => {
        if (window.__recordingBackoff && typeof delay === 'number' && delay >= 1500) {
          window.__backoffDelays.push(delay);
          // Scale delays down by 100x so 30s runs in 300ms while preserving exact requested delay values.
          return originalSetTimeout(fn, Math.max(20, Math.round(delay / 100)), ...args);
        }
        return originalSetTimeout(fn, delay, ...args);
      };

      const callbacks = new Map();
      let seq = 0;
      let offline = false;
      let streamReject = null;
      const registry = { version: 1, legacyMutationsRetired: true, selectedEnvironmentId: A, environments: {
        [A]: { environmentId: A, label: 'Alpha', routes: ['https://alpha.invalid'], activeRoute: 'https://alpha.invalid' },
      } };
      window.__connectSnapshots = 0;
      window.__disconnectServer = () => {
        offline = true;
        window.__recordingBackoff = true;
        streamReject?.(new Error('Cannot reach your server.'));
        streamReject = null;
      };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(fn) { const id = ++seq; callbacks.set(id, fn); return id; },
        unregisterCallback(id) { callbacks.delete(id); },
        async invoke(command, args = {}) {
          if (command.startsWith('plugin:') || command === 'set_sidebar_window_controls') return;
          if (command === 'sidebar_pointer_inside') return false;
          // Hold automatic-updates polling open while recording reconnect backoff so its 15s poll timer is not mixed in.
          if (command === 'automatic_updates_status' || command === 'automatic_updates_tick') {
            if (window.__recordingBackoff) return new Promise(() => {});
            return { enabled: false, targets: [], activeEnvironmentId: null, servers: [] };
          }
          if (command === 'connections_wake') return;
          if (command === 'environment_list') return { registry: structuredClone(registry), legacy: { endpoint: null, pending: false } };
          if (command === 'environment_select') return structuredClone(registry);
          const id = args.environmentId ?? 'legacy', op = command.replace(/^environment_/, '');
          if (id === 'legacy') {
            if (op === 'connection_info') return { endpoint: '', deviceId: 'fixture', publicKey: '', pending: false, nativeSidebar: false };
            if (op === 'disconnect') return;
            throw new Error(`Unexpected legacy IPC ${command}`);
          }
          if (op === 'disconnect') { streamReject = null; return; }
          if (op === 'connection_info') return { environmentId: A, endpoint: 'https://alpha.invalid', deviceId: 'fixture', publicKey: '', pending: false, nativeSidebar: false };
          if (op === 'query') {
            if (args.kind === 'snapshot') {
              window.__connectSnapshots += 1;
              if (offline) throw new Error('Cannot reach your server.');
              return { protocolVersion: 1, cursor: 1, records: [] };
            }
            if (args.kind === 'runtime') return { configured: true, model: 'fixture:cloud' };
            if (args.kind === 'models') return { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' };
            if (args.kind === 'events') return { events: [], nextCursor: 1, hasMore: false };
          }
          if (op === 'stream_events') return new Promise((_resolve, reject) => {
            streamReject = reject;
            callbacks.get(args.channel.id)?.({ index: 0, message: { type: 'snapshot', cursor: 1, records: [], live: [] } });
          });
          throw new Error(`Unexpected IPC ${command}`);
        },
      };
    }, { A });

    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => window.__connectSnapshots >= 1);
    await page.evaluate(() => { window.__backoffDelays = []; window.__disconnectServer(); });
    await page.waitForFunction(() => window.__backoffDelays.length >= 6);

    const delays = await page.evaluate(() => window.__backoffDelays.slice(0, 6));
    const bounds = [
      [1600, 2400],
      [3200, 4800],
      [6400, 9600],
      [12800, 19200],
      [24000, 30000],
      [24000, 30000],
    ];
    for (let i = 0; i < bounds.length; i++) {
      const [lo, hi] = bounds[i];
      check(delays[i] >= lo && delays[i] <= hi, `Attempt ${i} delay ${delays[i]}ms must be within [${lo}, ${hi}]ms`);
    }

    // Focus resets backoff to 0 (next scheduled delay back in [1600, 2400])
    await page.evaluate(() => { window.__backoffDelays = []; window.dispatchEvent(new Event('focus')); });
    await page.waitForFunction(() => window.__backoffDelays.length >= 1);
    const afterFocus = await page.evaluate(() => window.__backoffDelays[0]);
    check(afterFocus >= 1600 && afterFocus <= 2400, `Window focus must reset backoff (got ${afterFocus}ms)`);

    // Let it back off to attempt 2+, then verify online resets backoff
    await page.waitForFunction(() => window.__backoffDelays.length >= 3);
    await page.evaluate(() => { window.__backoffDelays = []; window.dispatchEvent(new Event('online')); });
    await page.waitForFunction(() => window.__backoffDelays.length >= 1);
    const afterOnline = await page.evaluate(() => window.__backoffDelays[0]);
    check(afterOnline >= 1600 && afterOnline <= 2400, `Online event must reset backoff (got ${afterOnline}ms)`);

    // Let it back off again, then verify manual Retry connection click resets backoff
    await page.waitForFunction(() => window.__backoffDelays.length >= 3);
    await page.evaluate(() => { window.__backoffDelays = []; });
    await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
    await page.waitForFunction(() => window.__backoffDelays.length >= 1);
    const afterClick = await page.evaluate(() => window.__backoffDelays[0]);
    check(afterClick >= 1600 && afterClick <= 2400, `Manual connect click must reset backoff (got ${afterClick}ms)`);

    await page.close();
  }

  assert.deepEqual(errors, []);
  console.log(`PASS: ${checks} SSE snapshot-skip & reconnect-backoff checks`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
