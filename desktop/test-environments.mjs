import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { openInitialTestChat } from './chat-test-navigation.mjs';
import { openSettings, serverTab } from './settings-test-navigation.mjs';

// Integrated dist only; all records, credentials and IPC callbacks are synthetic. No build is run.
const root = resolve(dirname(fileURLToPath(import.meta.url)), 'dist');
const server = createServer((request, response) => {
  const file = resolve(root, new URL(request.url, 'http://fixture').pathname.slice(1) || 'index.html');
  if (!file.startsWith(root + '/') || !existsSync(file)) return response.writeHead(404).end();
  response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' }[extname(file)] || 'application/octet-stream');
  response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch();
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const errors = []; let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' });
  page.setDefaultTimeout(10000);
    page.on('pageerror', error => (errors.push(error.message), console.error(error.message)));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(({ A, B, C }) => {
    window.isTauri = true;
    const row = (kind, id, data) => ({ kind, id, data, revision: 1, updatedAt: '2026-11-04T12:00:00Z' });
    const make = (id, label) => ({ environmentId: id, label, activeRoute: `https://${label.toLowerCase()}.example`, routes: [`https://${label.toLowerCase()}.example`] });
    const registry = { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: A, environments: { [A]: make(A, 'Alpha'), [B]: make(B, 'Beta') } };
    const states = Object.fromEntries([A, B, 'legacy'].map((id, index) => [id, { pending: id === A, offline: false, cursor: 1, records: [
      row('task', 'same-task', { goal: `${['Alpha', 'Beta', 'Legacy'][index]} owned task`, profile: 'code', state: 'running' }),
      row('policy', 'same-task', { mode: 'full_control' }),
      row('message', 'same-message', { taskId: 'same-task', author: 'assistant', text: `${['Alpha', 'Beta', 'Legacy'][index]} private history` }),
      row('artifact', 'same-artifact', { taskId: 'same-task', name: 'shared.png', hash: id, mime: 'image/png' }),
      row('device', 'self', { name: 'This Mac', publicKey: 'synthetic-public', revoked: false }),
      row('automation', 'same-schedule', { name: `${['Alpha', 'Beta', 'Legacy'][index]} schedule` }),
      row('memory', 'same-note', { title: `${['Alpha', 'Beta', 'Legacy'][index]} server note`, text: `${['Alpha', 'Beta', 'Legacy'][index]} server note` }),
      ...(id === 'legacy' ? [] : [row('action', 'same-approval', { taskId: 'same-task', tool: 'file.write',
        state: 'pending', nonce: id, actionDigest: id, target: `${id === A ? 'Alpha' : 'Beta'} file` })]),
    ] }]));
    const catalogue = { protocolVersion: 1, piVersion: 'fixture', profilePath: '/synthetic/profile', generation: 'a'.repeat(64),
      providers: [{ id: 'test', name: 'Synthetic OAuth', configured: false, storedMethod: null, methods: [{ type: 'oauth', label: 'Sign in', subscription: true }] }],
      models: [{ providerId: 'test', modelId: 'model', name: 'Test model', reasoning: false }], defaultModel: { providerId: 'test', modelId: 'model' }, refreshErrors: [], capabilities: {}, refreshedAt: null };
    const callbacks = new Map(), streams = {}, oldStreams = {}; let sequence = 0;
    let legacyEndpoint = 'legacy';
    window.__streams = streams;
    window.__requests = []; window.__states = states; window.__registry = registry;
    window.__holdSnapshot = null; window.__holdArtifact = false; window.__holdLogin = false; window.__holdFile = false;
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () { if (window.__holdFile) await new Promise(resolve => { window.__releaseFile = resolve; }); return original.call(this); };
    const emit = (stream, frame) => callbacks.get(stream.channel.id)?.({ index: stream.index++, message: frame });
    window.__emit = (id, frame, old = false) => emit((old ? oldStreams : streams)[id], frame);
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; }, unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args = {}) {
        if (command === 'set_sidebar_window_controls') return;
        if (command === 'sidebar_pointer_inside') return false;
        if (command.startsWith('plugin:')) return;
        // Secret values are never copied into the test's request log either.
        window.__requests.push({ command, args: command === 'environment_agent_request' ? { environmentId: args.environmentId, payload: { type: args.payload.type, flowId: args.payload.flowId } } : structuredClone(args) });
        if (command === 'environment_list') return { registry: structuredClone(registry), legacy: { endpoint: legacyEndpoint, pending: states.legacy.pending } };
        if (command === 'setup_list') return [];
        if (command === 'terminal_target' || command === 'terminal_open') {
          if (args.environmentId !== B) throw new Error('Machines terminal must target the chosen Beta card, not active Alpha');
          const target = { setupId: 'synthetic-beta-setup', label: 'Beta', host: 'beta.ssh.example', user: 'beta-user', port: 22, fingerprint: 'SHA256:synthetic-beta' };
          return command === 'terminal_target' ? target : { sessionId: 'synthetic-beta-shell', target };
        }
        if (['terminal_read', 'terminal_resize', 'terminal_close'].includes(command)) {
          if (args.sessionId !== 'synthetic-beta-shell') throw new Error('Wrong synthetic terminal session');
          return command === 'terminal_read' ? { data: '', nextOffset: args.offset, dropped: false, exited: false, exitCode: null } : undefined;
        }
        if (command === 'clear_legacy_endpoint') { legacyEndpoint = ''; return; }
        if (command === 'environment_select') { registry.selectedEnvironmentId = args.environmentId; return structuredClone(registry); }
        if (command === 'environment_discover') return { descriptorVersion: 1, environmentId: C, label: 'Gamma', protocolVersion: 2, recordProtocolVersion: 1 };
        if (command === 'environment_register') {
          if (args.endpoint === 'https://wrong-installation.example') throw 'Authenticated installation ID mismatch';
          if (args.bootstrapToken && window.__failBootstrap) throw 'Pairing outcome unknown';
          if (args.environmentId === C && states.legacy.pending && !args.bootstrapToken) throw 'Resolve unbound legacy pending work first';
          if (args.environmentId === C && !args.retireLegacyMutations && !args.bootstrapToken) throw 'needs_legacy_retirement';
          if (!registry.environments[args.environmentId]) registry.environments[args.environmentId] = make(args.environmentId, args.label);
          const saved = registry.environments[args.environmentId];
          saved.label = args.label; saved.activeRoute = args.endpoint;
          if (!saved.routes.includes(args.endpoint)) saved.routes.push(args.endpoint);
          if (args.retireLegacyMutations) registry.legacyMutationsRetired = true;
          states[C] ??= { ...structuredClone(states[B]), pending: false };
          return structuredClone(registry);
        }
        if (command === 'environment_rename') { registry.environments[args.environmentId].label = args.label; return structuredClone(registry); }
        if (command === 'environment_remove') {
          if (states[args.environmentId].pending) throw 'Pending recovery blocks removal';
          delete registry.environments[args.environmentId]; registry.selectedEnvironmentId = null; return structuredClone(registry);
        }
        if (command === 'oauth_callback_start' || command === 'open_url') return;
        if (command === 'oauth_callback_wait') return new Promise(resolve => { window.__releaseCallback = () => resolve('http://localhost:1455/auth/callback?code=synthetic-private'); });
        if (command === 'oauth_callback_cancel') return;
        const id = command.startsWith('environment_') ? args.environmentId : 'legacy';
        if (!states[id]) throw new Error(`Unknown fixture owner ${id}`);
        const state = states[id];
        const op = command.replace(/^environment_/, '');
        if (op === 'connection_policy') { state.lifecycle = { state: 'connected', error: null }; return; }
        if (op === 'disconnect') {
          if (args.pause && state.lifecycle) state.lifecycle = { state: 'paused', error: null };
          if (streams[id]) { oldStreams[id] = streams[id]; streams[id].resolve(); delete streams[id]; }
          return;
        }
        if (op === 'connection_info') {
          if (window.__failInfo === id) throw 'Synthetic recovery-state read failure';
          const info = { environmentId: id, endpoint: id === 'legacy' ? legacyEndpoint : id, deviceId: 'self', publicKey: 'synthetic-public', pending: state.pending, pendingError: state.pendingError ?? null, lifecycle: state.lifecycle, nativeSidebar: false };
          if (window.__holdInfo === id) {
            window.__holdInfo = null;
            return new Promise(resolve => { window.__releaseInfo = () => resolve(info); });
          }
          return info;
        }
        if (op === 'query') {
          if (state.offline) throw 'Synthetic offline';
          if (args.kind === 'snapshot') {
            const snapshot = { protocolVersion: 1, cursor: state.cursor, records: structuredClone(state.records) };
            if (window.__holdSnapshot === id) { window.__holdSnapshot = null; return new Promise(resolve => { window.__releaseSnapshot = () => resolve(snapshot); }); }
            return snapshot;
          }
          if (args.kind === 'runtime') return { configured: true, piManagement: true, model: 'fixture:cloud', sharedMemory: id !== 'legacy' };
          if (args.kind === 'models') return { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' };
          if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: state.cursor };
        }
        if (op === 'stream_events') return new Promise(resolve => {
          streams[id] = { channel: args.channel, resolve, index: 0 };
          emit(streams[id], { type: 'snapshot', cursor: state.cursor, records: structuredClone(state.records), live: [] });
        });
        if (op === 'retry_command') { state.pending = false; return state.records[0]; }
        if (op === 'enroll_device') {
          const device = row('device', args.deviceId, { name: args.name, publicKey: args.publicKey, revoked: false });
          state.records.push(device); state.cursor++; return device;
        }
        if (op === 'send_command') {
          if (state.pending || state.offline) throw 'Wrong owner mutation';
          state.cursor++;
          if (args.kind === 'memory.shared') {
            const previous = state.records.find(record => record.kind === 'memory' && record.id === args.id);
            if (previous?.data.forgotten) return previous;
            const note = row('memory', args.id, { text: args.payload.text ?? '', forgotten: args.payload.text === null, confirmed: true, shared: true });
            if (previous) note.revision = previous.revision + 1;
            state.records = [...state.records.filter(record => record !== previous), note];
            return note;
          }
          if (window.__holdPendingCommand === id) {
            window.__holdPendingCommand = null;
            state.pending = true;
            return new Promise((resolve, reject) => {
              window.__settlePendingCommand = (unknown = false) => {
                state.pending = unknown;
                if (unknown) reject('Synthetic command outcome unknown');
                else resolve(state.records[0]);
              };
            });
          }
          if (args.kind === 'task.create' && window.__holdCommand) {
            const task = row('task', args.id, { ...args.payload, state: 'running' });
            state.records.push(task);
            return new Promise(resolve => { window.__releaseCommand = () => resolve(task); });
          }
          if (args.kind === 'artifact.begin') return row('artifact', 'upload', args.payload);
          return state.records[0];
        }
        if (op === 'artifact') {
          if (window.__holdArtifact) return new Promise(resolve => { window.__releaseArtifact = () => resolve('invalid-image'); });
          return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7n8AAAAASUVORK5CYII=';
        }
        if (op === 'save_artifact') return `/synthetic/Downloads/Outpost/${id}/${args.id}/${args.name}`;
        if (op === 'agent_request') {
          const request = args.payload;
          if (request.type === 'catalogue' || request.type === 'refresh') return structuredClone(catalogue);
          if (request.type === 'login.start') {
            state.flow = { id: `flow-${id}`, providerId: 'test', method: 'oauth', state: 'waiting', expiresAt: Date.now() + 60000,
              prompt: { id: 'manual', input: { type: 'manual_code', message: 'Paste callback' } },
              events: [{ type: 'auth_url', url: 'https://auth.openai.com/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback' }] };
            if (window.__holdLogin) return new Promise(resolve => { window.__releaseLogin = () => resolve(structuredClone(state.flow)); });
          }
          if (request.type === 'login.cancel') state.flow.state = 'cancelled';
          if (request.type === 'login.answer') state.flow.state = 'succeeded';
          return structuredClone(state.flow);
        }
        throw new Error(`Unexpected fixture IPC ${command}`);
      },
    };
  }, { A, B, C });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await openInitialTestChat(page);
  const picker = { inputValue: () => page.locator('.main-shell').getAttribute('data-owner-id') };
  const closeSetup = async () => {
    const setup = page.getByRole('dialog', { name: 'Server setup', exact: true });
    if (await setup.isVisible()) {
      await setup.getByRole('button', { name: 'Close server setup', exact: true }).click();
      await setup.waitFor({ state: 'hidden' });
    }
  };
  const select = async id => {
    await closeSetup();
    await page.locator(`.chat-server-group[data-server-id="${id}"] button[data-task-id="same-task"]`).click();
    await page.waitForFunction(id => document.querySelector('.main-shell')?.dataset.ownerId === id && !document.querySelector('.settings-workspace'), id);
  };
  const settings = async (tab = 'general') => openSettings(page, { server: await picker.inputValue(), tab });
  const allChats = async () => {
    await closeSetup();
    await page.getByRole('button', { name: 'All chats', exact: true }).click();
  };
  const go = async name => {
    await closeSetup();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name, exact: true }).click();
  };
  await page.getByText('Alpha private history', { exact: true }).waitFor();
  await page.waitForFunction(A => !!window.__streams[A], A);
  if (process.env.OUTPOST_SETTINGS_ONLY === '1') {
    await openSettings(page, { server: B });
    check(await picker.inputValue() === A, 'Viewing another server never selects it as the chat owner');
    check(await page.locator('.settings-breadcrumb, .settings-connection-status').count() === 0, 'No persistent status strip or breadcrumb chrome');
    await page.getByLabel('Server name', { exact: true }).fill('Beta renamed');
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await page.getByRole('heading', { name: 'Beta renamed', level: 1, exact: true }).waitFor();
    check(await page.getByRole('button', { name: 'Save name', exact: true }).isDisabled(), 'Saved name has no pending edit');
    check(await page.getByRole('heading', { name: 'Trust & credentials', exact: true }).count() === 0, 'Trust is not in General');
    await serverTab(page, 'setup');
    check(await page.getByRole('heading', { name: 'Server details', exact: true }).count() === 0, 'Connection does not duplicate General');
    await page.getByRole('heading', { name: 'Trust & credentials', exact: true }).waitFor();
    const routeRequests = await page.evaluate(() => window.__requests.filter(r => r.command === 'environment_register').length);
    await page.getByRole('button', { name: 'Add route', exact: true }).click();
    await page.getByRole('dialog', { name: 'Add a route', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    check(await page.evaluate(() => window.__requests.filter(r => r.command === 'environment_register').length) === routeRequests, 'Cancel route sends no registration');
    await page.getByRole('button', { name: 'Add route', exact: true }).click();
    const routeDialog = page.getByRole('dialog', { name: 'Add a route', exact: true });
    await routeDialog.getByLabel('Route URL', { exact: true }).fill('https://wrong-installation.example');
    await routeDialog.getByRole('button', { name: 'Verify and use route', exact: true }).click();
    await routeDialog.getByRole('alert').filter({ hasText: 'Authenticated installation ID mismatch' }).waitFor();
    check(await page.evaluate(B => !window.__registry.environments[B].routes.includes('https://wrong-installation.example'), B), 'Rejected identity does not persist a route');
    await routeDialog.getByLabel('Route URL', { exact: true }).fill('https://beta-alternate.example');
    await routeDialog.getByRole('button', { name: 'Verify and use route', exact: true }).click();
    await routeDialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(B => window.__registry.environments[B].activeRoute === 'https://beta-alternate.example', B);
    check(await page.evaluate(B => window.__requests.filter(r => r.command === 'environment_register').every(r => r.args.environmentId === B && !('bootstrapToken' in r.args)), B), 'Routes authenticate against the saved owner and never bootstrap');
    await page.getByLabel('Connection route', { exact: true }).selectOption('https://beta.example');
    await page.waitForFunction(B => window.__registry.environments[B].activeRoute === 'https://beta.example', B);
    await page.evaluate(B => { window.__states[B].lifecycle = { state: 'connected', error: null }; }, B);
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.getByRole('button', { name: 'Pause connection', exact: true }).click();
    await page.getByRole('button', { name: 'Resume connection', exact: true }).waitFor();
    check(await page.getByRole('button', { name: 'Check connection', exact: true }).isDisabled(), 'Paused route requires explicit resume');
    await page.getByRole('button', { name: 'Resume connection', exact: true }).click();
    await page.getByRole('button', { name: 'Pause connection', exact: true }).waitFor();
    check(await page.evaluate(B => window.__requests.some(r => r.command === 'environment_disconnect' && r.args.environmentId === B && r.args.pause === true) && window.__requests.some(r => r.command === 'environment_connection_policy' && r.args.environmentId === B && r.args.enabled === true), B), 'Pause and resume retain native policy contracts');
    await page.evaluate(B => {
      const state = window.__states[B]; state.cursor++;
      state.records.push({ kind: 'recovery', id: 'server', revision: 7, updatedAt: '', data: { dispatchEnabled: false, reason: 'Restored server snapshot' } });
      state.records.push({ kind: 'task', id: 'queued-review', revision: 1, updatedAt: '', data: { state: 'queued', goal: 'Review queued work' } });
      window.__emit(B, { type: 'snapshot', cursor: state.cursor, records: state.records, live: [] });
    }, B);
    mkdirSync('/tmp/outpost-settings-production', { recursive: true });
    for (const width of [1440, 900, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const tab of ['general', 'setup', 'devices', 'recovery']) {
        await serverTab(page, tab);
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tab} has no page overflow at ${width}`);
        if (width === 900) {
          const tops = await page.locator('.server-settings-tabs a').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
          check(new Set(tops).size === 1, `${tab}: six tabs remain one row at 900px`);
                    check(await page.locator('.server-settings-tabs').evaluate(node => node.scrollWidth <= node.clientWidth), `${tab}: all tabs fit without scrolling at 900px`);
        }
        await page.screenshot({ path: `/tmp/outpost-settings-production/parity-${tab}-${width}-${engine.name()}.png` });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await serverTab(page, 'general');
    await page.getByRole('button', { name: 'Remove connection…', exact: true }).click();
    let removal = page.getByRole('dialog', { name: 'Remove this saved connection?', exact: true });
    await removal.getByRole('button', { name: 'Keep connection', exact: true }).click();
    check(await page.evaluate(() => !window.__requests.some(r => r.command === 'environment_remove')), 'Cancel removal sends nothing');
    await page.evaluate(B => { window.__states[B].pendingError = 'Unreadable recovery file'; }, B);
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Unreadable recovery file' }).waitFor();
    check(await page.getByRole('button', { name: 'Remove connection…', exact: true }).isDisabled(), 'Recovery storage errors prevent removal');
    await serverTab(page, 'setup');
    check(await page.getByRole('button', { name: 'Add route', exact: true }).isDisabled(), 'Recovery storage errors prevent route mutation');
    await page.evaluate(B => { window.__states[B].pendingError = null; }, B);
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await serverTab(page, 'general');
    await page.getByRole('button', { name: 'Remove connection…', exact: true }).click();
    removal = page.getByRole('dialog', { name: 'Remove this saved connection?', exact: true });
    await page.evaluate(B => { window.__states[B].pending = true; }, B);
    await removal.getByRole('checkbox').check();
    await removal.getByRole('button', { name: 'Remove connection', exact: true }).click();
    await removal.getByRole('alert').filter({ hasText: 'Pending recovery blocks removal' }).waitFor();
    check(await page.evaluate(B => !!window.__registry.environments[B], B), 'Native pending-recovery refusal retains owner');
    await page.evaluate(B => { window.__states[B].pending = false; }, B);
    await removal.getByRole('button', { name: 'Remove connection', exact: true }).click();
    await page.getByRole('heading', { name: 'Machines', exact: true }).waitFor();
    check(await page.locator(`.server-settings-list [data-server-id="${B}"]`).count() === 0, 'Successful removal returns to Machines');
    await openSettings(page, { page: 'add' });
    await page.getByLabel('Environment URL', { exact: true }).fill('https://gamma.example');
    await page.getByRole('button', { name: 'Discover environment' }).click();
    await page.getByLabel('Expected installation UUID').fill(A);
    await page.getByLabel('New environment label').fill('Gamma');
    check(await page.getByRole('button', { name: 'Verify and adopt enrollment' }).isDisabled(), 'Discovery does not authorize mismatched identity');
    await page.getByLabel('Expected installation UUID').fill(C);
    await page.getByRole('button', { name: 'Verify and adopt enrollment' }).click();
    await page.getByRole('alert').filter({ hasText: 'needs_legacy_retirement' }).waitFor();
    check(!(await page.getByRole('checkbox', { name: /^Retire legacy mutations/ }).isChecked()), 'Ambiguous adoption needs explicit retirement consent');
    await page.getByRole('radio', { name: /Pair a new installation/ }).check();
    await page.getByLabel('New installation bootstrap token').fill('synthetic-bootstrap-only');
    await page.evaluate(() => { window.__failBootstrap = true; });
    await page.getByRole('button', { name: 'Pair and verify installation' }).click();
    await page.getByRole('alert').filter({ hasText: 'Pairing may already have succeeded' }).waitFor();
    check(await page.getByLabel('New installation bootstrap token').inputValue() === '', 'Ambiguous bootstrap clears token');
    await page.waitForTimeout(2100);
    check(await page.evaluate(() => window.__requests.filter(r => r.command === 'environment_register' && r.args.bootstrapToken).length === 1), 'Ambiguous bootstrap is never automatically replayed');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${checks} focused settings checks (${engine.name()}): General/Connection parity, route identity, pause policy, readonly recovery, modal removal, bootstrap ambiguity, and responsive layouts.`);
  } else {
  check(await page.locator('.chat-server-group').count() === 3, 'Sidebar includes every server without changing the active owner');
  check(await page.getByLabel('Environment', { exact: true }).count() === 0, 'No global environment dropdown');
  const selectsBefore = await page.evaluate(() => window.__requests.filter(r => r.command === 'environment_select').length);
  await go('Machines');
  await page.getByRole('heading', { name: 'Machines', exact: true }).waitFor();
  check(await page.locator('.machines-server-card').count() === 3, 'Machines contains a card for every server');
  check(await page.locator('.machines-server-card').getByRole('button', { name: 'Open terminal', exact: true }).count() === 3, 'Every machine card offers its own terminal');
  check(await page.locator('.settings-workspace').count() === 0, 'Machines is a dedicated page, not an alias for Settings');
  check(await picker.inputValue() === A, 'Opening Machines preserves active Alpha chat ownership');
  await page.getByRole('region', { name: 'Beta', exact: true }).getByRole('button', { name: 'Open terminal', exact: true }).click();
  await page.getByText('Shell connected', { exact: true }).waitFor();
  check(await page.locator('.server-terminal-full .xterm').count() === 1, 'Selected machine opens a full-size real terminal');
  check(await page.locator('.server-terminal-pane').getAttribute('data-terminal-owner') === B, 'Beta terminal retains the selected card owner');
  check(await page.getByText('beta-user@beta.ssh.example', { exact: true }).isVisible(), 'Machines terminal displays the native SSH identity');
  check(await picker.inputValue() === A, 'Opening Beta terminal never changes the active Alpha chat owner');
  check(await page.getByRole('link', { name: 'Connection settings', exact: true }).getAttribute('href') === `#settings/servers/${B}/setup`, 'Terminal settings link is scoped to Beta');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.waitForFunction(() => window.__requests.some(r => r.command === 'terminal_close' && r.args.sessionId === 'synthetic-beta-shell'));
  await page.locator('.machines-terminal-heading').getByRole('button', { name: 'Machines', exact: true }).click();
  await page.getByRole('heading', { name: 'Machines', exact: true }).waitFor();
  check(new URL(page.url()).hash === '#machines', 'Machines is the server management overview');
  check(await picker.inputValue() === A, 'Machines preserves the active chat owner');
  const machineRows = await page.locator('.machines-server-card h2').allTextContents();
  await openSettings(page, { page: 'home' });
  check(await page.getByRole('heading', { name: 'Settings', exact: true, level: 1 }).isVisible(), 'One Settings landing page');
  check(await page.getByRole('group', { name: 'Theme', exact: true }).isVisible(), 'Settings root shows appearance preferences');
  check(await page.locator('.settings-workspace .settings-link-list a').count() === 0, 'Settings root has no Machines or Appearance menu links');
  await openSettings(page, { page: 'servers' });
  await page.locator('.server-settings-list a[data-server-id]').nth(2).waitFor();
  check(await page.locator('.server-settings-list a[data-server-id]').count() === 3, 'Each machine has a server settings entry');
  assert.equal(new URL(page.url()).hash, '#machines');
  assert.deepEqual(await page.locator('.machines-server-card h2').allTextContents(), machineRows); checks++;
  check(await page.getByRole('button', { name: /Disconnect environment|Reconnect environment|Select server/ }).count() === 0, 'Servers index has no connection or selection actions');
  await page.locator(`.server-settings-list a[data-server-id="${B}"]`).click();
  await page.locator('.server-settings-tabs').waitFor();
  assert.deepEqual(await page.locator('.server-settings-tabs a').allTextContents(), ['General', 'Connection', 'Models & providers', 'Pi & extensions', 'Devices', 'Recovery']); checks++;
  check(await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Machines', exact: true }).getAttribute('aria-current') === 'page', 'Machines remains selected for server settings');
  check(await page.locator('.settings-back-link').getByText('Machines', { exact: true }).count() === 1, 'Server settings has a quiet back link to Machines');
    check(await page.locator('.settings-breadcrumb, .settings-connection-status').count() === 0, 'No breadcrumb-heavy chrome or persistent refresh strip');
    check(await page.getByRole('heading', { name: 'Trust & credentials', exact: true }).count() === 0, 'Trust details are not duplicated in General');
  for (const tab of ['setup', 'models', 'runtime', 'devices', 'recovery', 'general']) {
    await serverTab(page, tab);
    check(await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Machines', exact: true }).getAttribute('aria-current') === 'page', `${tab} belongs to Machines`);
  }
  await serverTab(page, 'models');
  await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await page.waitForFunction(B => window.__requests.some(r => r.command === 'environment_agent_request' && r.args.environmentId === B && r.args.payload.type === 'refresh'), B);
  check(await picker.inputValue() === A, 'Viewing Beta settings never changes the active Alpha chat owner');
  check(await page.getByRole('button', { name: 'Retry same command' }).count() === 0, 'Alpha pending recovery does not appear as Beta recovery');
  check(await page.getByRole('heading', { name: 'Legacy Ollama models' }).count() === 0, 'Managed server has one model catalogue, not a duplicate legacy section');
  check(await page.locator('.chat-server-group button[data-task-id="same-task"]').count() === 3, 'All server chats remain visible inside server settings');
  check(await page.evaluate(() => window.__requests.filter(r => r.command === 'environment_select').length) === selectsBefore, 'Settings navigation sends no environment selection mutation');
  await page.goBack();
  await page.locator('.server-settings-tabs a[aria-current="page"][href$="/general"]').waitFor();
  await page.goForward();
  await page.locator('.server-settings-tabs a[aria-current="page"][href$="/models"]').waitFor();
  await select(B);
  await page.getByText('Beta private history', { exact: true }).waitFor();
  check(await page.locator('.chat-server-threads button[aria-current="page"]').count() === 1, 'Colliding task IDs select only the owning server row');
  for (const id of [B, A]) {
    await select(id);
    await go('Tasks');
    check(await page.locator('.recent .session-row').count() === 0 && await page.getByLabel('Task goal').isVisible(), 'Tasks is the focused new-task composer, not a history table');
    check(await page.locator('.new-task-server summary').getAttribute('aria-label') === 'Run on Alpha' && (await page.locator('.new-task-server summary').textContent()).trim() === 'Alpha', 'Opening a chat does not change the new-task destination');
    await allChats();
    check(await page.locator('.workspace-chat').count() === 3, 'All chats shows conversations from every server');
    await go('Automations');
    check(await page.getByRole('heading', { name: 'Alpha schedule', exact: true }).isVisible() && await page.getByRole('heading', { name: 'Beta schedule', exact: true }).isVisible(), 'Automations spans both servers regardless of active chat');
    await go('Memory');
    check(await page.getByRole('button', { name: 'All servers', exact: true }).getAttribute('aria-pressed') === 'true', 'Memory opens on shared notes regardless of active chat');
    await page.getByRole('button', { name: 'One server', exact: true }).click();
    for (const [server, label] of [[A, 'Alpha'], [B, 'Beta']]) {
      await page.getByRole('combobox', { name: 'Server', exact: true }).selectOption(server);
      check(await page.getByText(`${label} server note`, { exact: true }).isVisible() && await page.getByText(`${label === 'Alpha' ? 'Beta' : 'Alpha'} server note`, { exact: true }).count() === 0, 'Server note selection isolates colliding IDs independently of the active chat');
      check(await picker.inputValue() === id, 'Selecting Memory scope does not change the active chat owner');
    }
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Approvals/ }).click();
    check(await page.getByText('Alpha file', { exact: true }).isVisible() &&
      await page.getByText('Beta file', { exact: true }).isVisible(), 'Approvals spans both servers regardless of active chat');
  }
  await select(A);
  mkdirSync('/tmp/outpost-settings-production', { recursive: true });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    for (const [name, destination] of [['settings', { page: 'home' }], ['servers', { page: 'servers' }], ['models', { server: B, tab: 'models' }], ['add', { page: 'add' }], ['appearance', { page: 'appearance' }]]) {
      await openSettings(page, destination);
      if (name === 'add') {
        check(await page.getByRole('radio', { name: /I already have access/ }).isChecked(), 'Existing enrollment is the safe default');
        await page.getByRole('radio', { name: /Pair a new installation/ }).check();
        check(await page.getByLabel('New installation bootstrap token').isVisible(), 'New installation exposes its token only after choosing pairing');
      }
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}: no horizontal overflow at ${width}`);
      await page.mouse.move(width - 20, 70);
      if (width <= 780) { await page.keyboard.press('Escape'); await page.locator('#app-sidebar[data-motion="closed"]').waitFor({ state: 'attached' }); }
      await page.screenshot({ path: `/tmp/outpost-settings-production/${name}-${width}-${engine.name()}.png`, fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await select(A);
  // Restoring the same installation can rewind its ledger cursor. Retain stale memory
  // while disconnected, then replace it with the new lifecycle's authoritative baseline.
  await page.evaluate(A => {
    window.__beforeRestore = structuredClone(window.__states[A]);
    // An independently resolved native receipt permits connection management; restore the
    // original pending fixture below before testing owner-local mutation blocking.
    const state = window.__states[A]; state.pending = false; state.cursor = 100;
    state.records.push({ kind: 'task', id: 'obsolete-task', revision: 1, updatedAt: '2026-11-04T12:00:00Z', data: { goal: 'Pre-restore-only task', state: 'paused' } });
    window.__emit(A, { type: 'snapshot', cursor: 100, records: structuredClone(state.records), live: [] });
  }, A);
  await settings();
  await page.evaluate(A => { window.__holdSnapshot = A; window.__releaseSnapshot = null; }, A);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.waitForFunction(() => !!window.__releaseSnapshot);
  await page.evaluate(() => { window.__releasePreRestore = window.__releaseSnapshot; });
  await serverTab(page, 'setup');
  await page.getByRole('button', { name: 'Disconnect environment', exact: true }).click();
  await page.evaluate(A => {
    const state = window.__states[A]; state.cursor = 2;
    state.records = structuredClone(window.__beforeRestore.records);
    state.records.find(r => r.kind === 'task').data.goal = 'Restored Alpha task';
    state.records.push({ kind: 'recovery', id: 'server', revision: 1, updatedAt: '', data: { dispatchEnabled: false, reason: 'Restored ledger needs review' } });
    window.__holdSnapshot = A; window.__releaseSnapshot = null;
  }, A);
  await page.getByRole('button', { name: 'Reconnect environment', exact: true }).click();
  await page.waitForFunction(() => !!window.__releaseSnapshot);
  check(await page.locator('.sidebar-sessions').getByText('Pre-restore-only task', { exact: true }).count() === 1, 'Stale pre-restore memory remains until the authoritative snapshot arrives');
  await page.evaluate(() => window.__releaseSnapshot());
  await serverTab(page, 'recovery');
  await page.getByText('Restored ledger needs review', { exact: true }).waitFor({ timeout: 3000 });
  await page.waitForFunction(A => !!window.__streams[A], A);
  check(await page.locator('.sidebar-sessions').getByText('Pre-restore-only task', { exact: true }).count() === 0, 'Lower-cursor authoritative snapshot replaces rather than merges old records');
  await page.evaluate(A => {
    window.__releasePreRestore();
    window.__emit(A, { type: 'snapshot', cursor: 100, records: window.__beforeRestore.records, live: [] }, true);
  }, A);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check(await page.getByText('Restored ledger needs review', { exact: true }).count() === 1, 'Old-generation read and SSE snapshot cannot erase the restore recovery hold');
  await page.evaluate(A => {
    const task = structuredClone(window.__states[A].records.find(r => r.kind === 'task'));
    task.revision = 2; task.data.goal = 'Restored event task';
    window.__emit(A, { type: 'records', cursor: 3, records: [task] });
    window.__emit(A, { type: 'snapshot', cursor: 2, records: window.__states[A].records, live: [] });
  }, A);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check(await page.locator('.sidebar-sessions').getByText('Restored event task', { exact: true }).count() === 1, 'Same-lifecycle newer event wins over an older SSE snapshot');
  check(await page.getByText('Restored ledger needs review', { exact: true }).count() === 1, 'Recovery hold survives same-lifecycle snapshot ordering');
  check(await page.evaluate(() => !window.__requests.some(r => r.command.endsWith('send_command') || r.command.endsWith('retry_command'))), 'Restore/reconnect never replays commands');
  await select(B); await page.getByText('Beta private history', { exact: true }).waitFor();
  check(await page.getByText('Restored ledger needs review', { exact: true }).count() === 0, 'Restored A does not change B');
  await page.evaluate(A => { window.__states[A] = window.__beforeRestore; }, A);
  await select(A); await settings(); await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByText('Restored ledger needs review', { exact: true }).waitFor({ state: 'hidden' });

  // The installed v1 connection retains live overlays and owner-local native teardown.
  await select('legacy');
  await page.waitForFunction(() => !!window.__streams.legacy, null, { timeout: 3000 });
  const legacyFrame = { type: 'live', record: { kind: 'message', id: 'legacy-live', revision: 0, updatedAt: '', data: { taskId: 'same-task', author: 'assistant', text: 'Legacy live tokens', streaming: true } } };
  await page.evaluate(frame => window.__emit('legacy', frame), legacyFrame);
  await page.getByText('Legacy live tokens', { exact: true }).waitFor();
  await settings('setup'); await page.getByRole('button', { name: 'Disconnect environment', exact: true }).click();
  await page.waitForFunction(() => !window.__streams.legacy);
  await page.evaluate(frame => window.__emit('legacy', frame, true), { ...legacyFrame, record: { ...legacyFrame.record, data: { ...legacyFrame.record.data, text: 'Cancelled legacy tokens' } } });
  await page.getByRole('button', { name: 'Reconnect environment', exact: true }).click();
  await page.waitForFunction(() => !!window.__streams.legacy);
  await select('legacy');
  check(await page.getByText('Cancelled legacy tokens', { exact: true }).count() === 0, 'Cancelled legacy JavaScript frames remain fenced after reconnect');
  await page.evaluate(frame => window.__emit('legacy', frame), legacyFrame);
  await page.getByText('Legacy live tokens', { exact: true }).waitFor();
  check(await page.evaluate(() => window.__requests.some(r => r.command === 'disconnect' && Object.keys(r.args).length === 0)), 'Legacy adapter explicitly cancels only its unbound State');
  check(await page.evaluate(B => !!window.__streams[B], B), 'Legacy teardown leaves bound B streaming');
  await select(A);
  check(await page.getByRole('button', { name: 'Attach file' }).isDisabled(), 'Pending Alpha blocks only Alpha');
  await select(B); await page.getByText('Beta private history', { exact: true }).waitFor();
  check(await page.getByText('Alpha private history', { exact: true }).count() === 0, 'Same task ID is owner isolated');
  await page.getByRole('textbox', { name: 'Message Outpost' }).fill('Synthetic Beta instruction');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => window.__requests.some(r => r.command === 'environment_send_command'));
  check(await page.evaluate(B => window.__requests.filter(r => r.command === 'environment_send_command').every(r => r.args.environmentId === B), B), 'Pending A does not block B mutation');
  await page.getByRole('button', { name: /New task/ }).click();
  await page.getByLabel('Task goal').fill('Delayed Beta creation');
  await page.locator('.new-task-server summary').click();
  await page.getByRole('group', { name: 'New task server' }).getByRole('button', { name: 'Beta', exact: true }).click();
  check(await page.getByLabel('Task goal').inputValue() === 'Delayed Beta creation', 'Changing the run destination preserves the draft');
  await page.evaluate(() => { window.__holdCommand = true; });
  await page.getByRole('button', { name: 'Start task', exact: true }).click();
  await page.waitForFunction(() => !!window.__releaseCommand);
  await select(A); await page.evaluate(() => window.__releaseCommand());
  await page.getByText('Alpha private history', { exact: true }).waitFor();
  check(await picker.inputValue() === A, 'Late B command/create callback cannot navigate A');
  await select(A); await page.getByRole('button', { name: 'Retry same command' }).click();
  await page.waitForFunction(A => !window.__states[A].pending, A);
  check(await page.evaluate(A => window.__requests.filter(r => r.command.endsWith('retry_command')).every(r => r.args.environmentId === A), A), 'Explicit retry retains A');

  // Settings intentionally disables manual refresh during an executing command. Simulate
  // transport loss, then use the offline composer's reconnect control for the same owner.
  const reconnectWhileWorking = async id => {
    const label = (await page.locator(`.chat-server-group[data-server-id="${id}"] .chat-server-heading > span`).first().textContent()).trim();
    await page.evaluate(id => window.__streams[id]?.resolve(), id);
    await go('Tasks');
    await page.locator('.new-task-server summary').click();
    await page.getByRole('group', { name: 'New task server' }).getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await settings('devices');
  };
  // Wait past both reconnect info reads before releasing the controlled operation.
  const reconnectPendingOwner = async id => {
    const countCatalogueReads = id => window.__requests.filter(r =>
      r.command === (id === 'legacy' ? 'agent_request' : 'environment_agent_request') &&
      (id === 'legacy' || r.args.environmentId === id) && r.args.payload.type === 'catalogue').length;
    const catalogueReads = await page.evaluate(countCatalogueReads, id);
    await reconnectWhileWorking(id);
    await page.getByRole('button', { name: 'Retry same command' }).waitFor();
    await page.waitForFunction(({ id, count }) => window.__requests.filter(r =>
      r.command === (id === 'legacy' ? 'agent_request' : 'environment_agent_request') &&
      (id === 'legacy' || r.args.environmentId === id) && r.args.payload.type === 'catalogue').length > count, { id, count: catalogueReads });
  };
  // A reconnect can observe the native pending slot while a command is still in flight.
  // Success must reconcile that same owner's local recovery state, without replaying the command.
  for (const id of [A, 'legacy']) {
    await select(id);
    const before = await page.evaluate(() => ({
      commands: window.__requests.filter(r => r.command.endsWith('send_command')).length,
      retries: window.__requests.filter(r => r.command.endsWith('retry_command')).length,
    }));
    await page.evaluate(id => { window.__holdPendingCommand = id; window.__settlePendingCommand = null; }, id);
    await page.getByRole('button', { name: 'Pause task', exact: true }).click();
    await page.waitForFunction(() => !!window.__settlePendingCommand);
    await settings('devices');
    await reconnectPendingOwner(id);
    check(await page.getByRole('button', { name: 'Retry same command' }).isDisabled(), 'Reconnect does not allow retry while original command is executing');
    const reconciliationStart = await page.evaluate(() => window.__requests.length);
    await page.evaluate(() => window.__settlePendingCommand());
    await page.getByRole('button', { name: 'Retry same command' }).waitFor({ state: 'hidden', timeout: 3000 });
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Add device')?.disabled);
    check(await page.getByRole('button', { name: 'Add device', exact: true }).isEnabled(), `${id}: successful command clears reconnect-observed pending lock`);
    const after = await page.evaluate(() => ({
      commands: window.__requests.filter(r => r.command.endsWith('send_command')).length,
      retries: window.__requests.filter(r => r.command.endsWith('retry_command')).length,
    }));
    assert.deepEqual(after, { commands: before.commands + 1, retries: before.retries }); checks++;
    const infoReads = await page.evaluate(start => window.__requests.slice(start).filter(r => r.command.endsWith('connection_info')).map(r => [r.command, r.args.environmentId ?? null]), reconciliationStart);
    assert.deepEqual(infoReads, [[id === 'legacy' ? 'connection_info' : 'environment_connection_info', id === 'legacy' ? null : id]]); checks++;
  }
  const startReconnectedCommand = async () => {
    await select(A);
    await page.evaluate(A => { window.__holdPendingCommand = A; window.__settlePendingCommand = null; }, A);
    await page.getByRole('button', { name: 'Pause task', exact: true }).click();
    await page.waitForFunction(() => !!window.__settlePendingCommand);
    await settings('devices');
    await reconnectPendingOwner(A);
  };
  await startReconnectedCommand();
  const unknownRetries = await page.evaluate(() => window.__requests.filter(r => r.command.endsWith('retry_command')).length);
  await page.evaluate(() => window.__settlePendingCommand(true));
  await page.waitForFunction(() => !document.querySelector('.pending-notice button').disabled);
  check(await page.getByRole('button', { name: 'Add device', exact: true }).isDisabled(), 'Unknown outcome keeps the native pending blocker after reconnect');
  check(await page.evaluate(() => window.__requests.filter(r => r.command.endsWith('retry_command')).length) === unknownRetries, 'Reconciliation reads state; it never retries an unknown command');
  await page.getByRole('button', { name: 'Retry same command' }).click();
  await page.getByRole('button', { name: 'Retry same command' }).waitFor({ state: 'hidden' });

  await startReconnectedCommand();
  await page.evaluate(A => { window.__failInfo = A; window.__settlePendingCommand(); }, A);
  await page.waitForFunction(() => !document.querySelector('.pending-notice button').disabled);
  check(await page.getByRole('button', { name: 'Add device', exact: true }).isDisabled(), 'Failed reconciliation read conservatively retains the pending blocker');
  check(await page.evaluate(A => !window.__states[A].pending, A), 'Fixture native pending is cleared, independently of the failed frontend read');
  await page.evaluate(() => { window.__failInfo = null; });
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByRole('button', { name: 'Retry same command' }).waitFor({ state: 'hidden' });

  // An earlier info read within the same lifecycle also cannot restore the old pending flag.
  await select(A);
  await page.evaluate(A => { window.__holdPendingCommand = A; window.__settlePendingCommand = null; }, A);
  await page.getByRole('button', { name: 'Pause task', exact: true }).click();
  await page.waitForFunction(() => !!window.__settlePendingCommand);
  await settings('devices');
  await page.evaluate(A => { window.__holdInfo = A; window.__releaseInfo = null; }, A);
  await reconnectWhileWorking(A);
  await page.waitForFunction(() => !!window.__releaseInfo);
  await page.evaluate(() => window.__settlePendingCommand());
  await page.waitForFunction(() => document.querySelector('.settings-header-actions .ui-badge')?.textContent !== 'Working…');
  await page.evaluate(A => { window.__holdSnapshot = A; window.__releaseSnapshot = null; window.__releaseInfo(); }, A);
  await page.waitForFunction(() => !!window.__releaseSnapshot);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check(await page.getByRole('button', { name: 'Retry same command' }).count() === 0, 'Earlier same-lifecycle info response cannot restore a reconciled pending flag');
  await page.evaluate(() => window.__releaseSnapshot());
  await page.waitForFunction(() => { const button = Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "Add device"); return button && !button.disabled; });

  // A held recovery-state response cannot erase a blocker from a newer lifecycle.
  await startReconnectedCommand();
  await page.evaluate(A => { window.__holdInfo = A; window.__releaseInfo = null; window.__settlePendingCommand(); }, A);
  await page.waitForFunction(() => !!window.__releaseInfo);
  await page.evaluate(A => { window.__states[A].pendingError = 'Synthetic corrupt recovery'; }, A);
  await reconnectWhileWorking(A);
  await page.getByRole('alert').filter({ hasText: 'Synthetic corrupt recovery' }).waitFor();
  await page.evaluate(() => window.__releaseInfo());
  await page.waitForFunction(() => document.querySelector('.settings-header-actions .ui-badge')?.textContent !== 'Working…');
  check(await page.getByRole('alert').filter({ hasText: 'Synthetic corrupt recovery' }).count() === 1, 'Obsolete reconciliation cannot overwrite current pendingError');
  check(await page.getByRole('button', { name: 'Add device', exact: true }).isDisabled(), 'Current recovery-storage blocker remains fail-closed');
  await page.evaluate(A => { window.__states[A].pendingError = null; }, A);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.waitForFunction(() => { const button = Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "Add device"); return button && !button.disabled; });
  await select(A);

  // Capture upload owner before file.arrayBuffer/hash; changing selection must not move any chunk.
  await page.evaluate(() => { window.__holdFile = true; });
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.alloc(600000, 65) });
  await page.waitForFunction(() => !!window.__releaseFile);
  await select(B); await page.evaluate(() => window.__releaseFile());
  await page.waitForFunction(() => window.__requests.some(r => r.args.kind === 'artifact.complete'));
  const uploads = await page.evaluate(() => window.__requests.filter(r => r.args.kind?.startsWith('artifact.')));
  assert.deepEqual(uploads.map(r => r.args.kind), ['artifact.begin', 'artifact.chunk', 'artifact.chunk', 'artifact.complete']); checks++;
  check(uploads.every(r => r.args.environmentId === A), 'All upload steps retain captured A before hashing');

  await select(A); await settings('models');
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page.getByRole("dialog", { name: "Add provider", exact: true }).getByRole("button", { name: /Synthetic OAuth/ }).click();
  await page.getByRole('button', { name: 'Sign in · Subscription', exact: true }).click();
  await page.getByRole('button', { name: 'Open provider sign-in', exact: true }).click();
  await page.waitForFunction(() => !!window.__releaseCallback);
  await select(B); await page.evaluate(() => window.__releaseCallback());
  await page.waitForFunction(A => window.__requests.some(r => r.command === 'environment_agent_request' && r.args.environmentId === A && r.args.payload.type === 'login.cancel'), A);
  check(await page.evaluate(() => !window.__requests.some(r => r.args.payload?.type === 'login.answer')), 'Late OAuth callback is cancelled, never forwarded to B');
  check(await page.evaluate(() => window.__requests.some(r => r.command === 'oauth_callback_cancel')), 'Native callback listener cancelled on owner switch');
  await select(A); await settings('models'); await page.evaluate(() => { window.__holdLogin = true; });
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page.getByRole("dialog", { name: "Add provider", exact: true }).getByRole("button", { name: /Synthetic OAuth/ }).click();
  await page.getByRole('button', { name: 'Sign in · Subscription', exact: true }).click();
  await page.waitForFunction(() => !!window.__releaseLogin); await select(B); await page.evaluate(() => window.__releaseLogin());
  await page.waitForFunction(A => window.__requests.filter(r => r.args.environmentId === A && r.args.payload?.type === 'login.cancel').length === 2, A);
  checks++;

  // A stale snapshot and delivered JS stream callback are fenced on disconnect, while B remains live.
  await select(A); await settings(); await page.evaluate(A => { window.__holdSnapshot = A; window.__releaseSnapshot = null; }, A);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.waitForFunction(() => !!window.__releaseSnapshot);
  await serverTab(page, 'setup');
  await page.getByRole('button', { name: 'Disconnect environment', exact: true }).click();
  await select(B); await page.evaluate(() => window.__releaseSnapshot());
  await allChats();
  await page.locator(`.workspace-chat[data-server-id="${A}"]`).getByText(/Offline · cached/).first().waitFor();
  checks++;
  await page.evaluate(A => { window.__states[A].offline = true; }, A);
  await select(A); await settings(); await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Synthetic offline' }).waitFor();
  await allChats();
  await page.locator(`.workspace-chat[data-server-id="${A}"]`).getByText(/Offline · cached/).first().waitFor();
  await page.locator(`.workspace-chat[data-server-id="${B}"]`).filter({ hasText: 'Beta owned task' }).click();
  await page.getByText('Beta private history', { exact: true }).waitFor();
  check(await picker.inputValue() === B, 'Unified history opens owning environment with identical task ID');
  await page.evaluate(({ A, B }) => {
    const record = { kind: 'message', id: 'late', revision: 0, updatedAt: '', data: { taskId: 'same-task', author: 'assistant', text: 'A obsolete frame', streaming: true } };
    window.__emit(A, { type: 'live', record }, true);
    window.__emit(B, { type: 'live', record: { ...record, data: { ...record.data, text: 'B ongoing frame' } } });
  }, { A, B });
  await page.getByText('B ongoing frame', { exact: true }).waitFor();
  check(await page.getByText('A obsolete frame', { exact: true }).count() === 0, 'Cancelled A frame cannot appear in B; B stream continues');

  // Artifact replies and downloads retain their owner even with colliding artifact IDs.
  await page.evaluate(() => { window.__holdArtifact = true; });
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  check(await page.getByRole('button', { name: 'Download shared.png', exact: true }).count() === 3, 'Library includes colliding artifact IDs from every server');
  await page.getByRole('region', { name: 'Beta library', exact: true }).getByRole('button', { name: 'Download shared.png', exact: true }).click();
  await page.getByText(`/synthetic/Downloads/Outpost/${B}/same-artifact/shared.png`, { exact: false }).waitFor();
  await page.waitForFunction(() => !!window.__releaseArtifact);
  await select(A); await page.evaluate(() => window.__releaseArtifact());
  check(await page.getByText('The string to be decoded', { exact: false }).count() === 0, 'Late B artifact result cannot populate A');
  check(await page.evaluate(B => window.__requests.filter(r => r.command === 'environment_save_artifact').every(r => r.args.environmentId === B && r.args.id === 'same-artifact'), B), 'Artifact save targets owning B and namespaced download');
  await page.evaluate(() => { window.__holdArtifact = false; });
  await select(B);

  // Explicit disconnect holds read-only history and never reconnects/mutates automatically.
  await settings('setup'); await page.getByRole('button', { name: 'Disconnect environment', exact: true }).click();
  await allChats();
  await page.locator(`.workspace-chat[data-server-id="${B}"]`).getByText(/Offline · cached/).first().waitFor();
  await page.waitForTimeout(2200);
  check(await page.locator(`.workspace-chat[data-server-id="${B}"]`).getByText(/Offline · cached/).first().count() === 1, 'Manual disconnect is stable');
  await page.locator(`.workspace-chat[data-server-id="${B}"]`).filter({ hasText: 'Beta owned task' }).click();
  check(await page.getByRole('button', { name: 'Attach file' }).isDisabled(), 'Offline owner task read-only');
  await settings('setup'); await page.getByRole('button', { name: 'Reconnect environment', exact: true }).click();
  await page.getByRole('button', { name: 'Disconnect environment', exact: true }).waitFor();
  await serverTab(page, 'general');
  await page.getByLabel('Server name', { exact: true }).fill('Beta renamed');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await serverTab(page, 'devices');
  await page.getByRole('button', { name: 'Add device', exact: true }).click();
  await page.getByLabel('Device name', { exact: true }).fill('Synthetic other device');
  await page.getByLabel('Other device ID', { exact: true }).fill('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await page.getByLabel('Other device public pairing key').fill('synthetic-public-only');
  await page.getByRole('dialog', { name: 'Add a trusted device', exact: true }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Enroll device', exact: true }).click();
  await page.getByRole('article', { name: 'Synthetic other device', exact: true }).waitFor();
  check(await page.evaluate(B => window.__requests.filter(r => r.command === 'environment_enroll_device').every(r => r.args.environmentId === B), B), 'Device enrollment remains bound to its owner');
  await serverTab(page, 'setup');
  check(await page.getByRole('heading', { name: 'Server details', exact: true }).count() === 0, 'Connection does not repeat General');
  await page.getByRole('button', { name: 'Add route', exact: true }).click();
  await page.getByRole('dialog', { name: 'Add a route', exact: true }).getByLabel('Route URL', { exact: true }).fill('https://beta-alternate.example');
  await page.getByRole('button', { name: 'Verify and use route', exact: true }).click();
  await page.waitForFunction(B => window.__registry.environments[B].activeRoute.includes('alternate'), B);
  check(await picker.inputValue() === B, 'Rename and verified route preserve identity');

  // Legacy recovery is explicit, uses only original IPC; ambiguous adoption requires retirement confirmation.
  await select('legacy'); await settings();
  await page.evaluate(() => { window.__states.legacy.pending = true; });
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.getByRole('button', { name: 'Retry same command' }).waitFor();
  await openSettings(page, { page: 'add' });
  await page.getByLabel('Environment URL', { exact: true }).fill('https://gamma.example');
  await page.getByRole('button', { name: 'Discover environment' }).click();
  await page.getByText(/Untrusted preview: Gamma/).waitFor();
  await page.getByLabel('Expected installation UUID').fill(A);
  check(await page.getByRole('button', { name: 'Verify and adopt enrollment' }).isDisabled(), 'Discovery mismatch is blocked');
  await page.getByLabel('Expected installation UUID').fill(C); await page.getByLabel('New environment label').fill('Gamma');
  await page.getByRole('button', { name: 'Verify and adopt enrollment' }).click();
  await page.getByRole('alert').filter({ hasText: 'Resolve unbound legacy pending work' }).waitFor();
  await settings();
  await page.getByRole('button', { name: 'Retry same command' }).click();
  await page.waitForFunction(() => !window.__states.legacy.pending);
  await openSettings(page, { page: 'add' });
  await page.getByLabel('Environment URL', { exact: true }).fill('https://gamma.example');
  await page.getByRole('button', { name: 'Discover environment' }).click();
  await page.getByLabel('Expected installation UUID').fill(C);
  await page.getByLabel('New environment label').fill('Gamma');
  await page.getByRole('button', { name: 'Verify and adopt enrollment' }).click();
  await page.getByRole('alert').filter({ hasText: 'needs_legacy_retirement' }).waitFor();
  const retirement = page.getByRole('checkbox', { name: /^Retire legacy mutations even if this is a different installation/ });
  check(!(await retirement.isChecked()), 'Retirement consent defaults unchecked and explicitly includes different installations');
  check(await page.evaluate(() => window.__requests.filter(r => r.command === 'environment_register').every(r => !('retireLegacyMutations' in r.args))), 'Declined adoption sends no retirement flag');
  await retirement.check();
  await page.getByRole('button', { name: 'Verify and adopt enrollment' }).click();
  await page.waitForFunction(() => window.__registry.legacyMutationsRetired);
  check(await page.evaluate(C => window.__requests.some(r => r.command === 'environment_register' && r.args.environmentId === C && r.args.retireLegacyMutations === true), C), 'Explicit consent retires legacy even for the different Gamma installation');
  await settings('setup');
  await page.getByText('Legacy connection & first-device pairing', { exact: true }).click();
  check(await page.getByRole('button', { name: 'Pair device', exact: true }).isDisabled(), 'Retired legacy mutation controls disabled');
  check(await page.evaluate(() => window.__requests.filter(r => r.command === 'environment_register').every(r => !('bootstrapToken' in r.args))), 'Adoption/route changes never bootstrap or replay enrollment');
  check(await page.evaluate(() => window.__requests.some(r => r.command === 'retry_command' && !('environmentId' in r.args))), 'Unbound pending retry stays on legacy path');
  check(await page.evaluate(() => Object.keys(localStorage).every(key => key.startsWith('outpost.appearance') || key.startsWith('outpost.sidebar')) && sessionStorage.length === 0), 'No environment or provider state persisted in browser storage');
  const requests = await page.evaluate(() => window.__requests);
  check(requests.filter(r => /^(query|agent_request|send_command|artifact|save_artifact)$/.test(r.command)).every(r => !r.args.environmentId), 'Legacy and bound IPC stay distinct');
  check(!requests.some(r => r.command === 'pair' || r.command === 'enroll_device'), 'Switch/reconnect never reenrolls');
  await select(C); await settings();
  await page.evaluate(C => { window.__states[C].pending = true; }, C);
  await page.getByRole('button', { name: 'Remove connection…' }).click();
  const removal = page.getByRole('dialog', { name: 'Remove this saved connection?', exact: true });
  check(await removal.getByRole('button', { name: 'Remove connection', exact: true }).isDisabled(), 'Removal requires explicit confirmation');
  await removal.getByRole('checkbox').check();
  await removal.getByRole('button', { name: 'Remove connection', exact: true }).click();
  await removal.getByRole('alert').filter({ hasText: 'Pending recovery blocks removal' }).waitFor();
  check(await picker.inputValue() === C, 'Failed removal retains saved owner and recovery');
  await page.evaluate(C => { window.__states[C].pending = false; }, C);
  await removal.getByRole('button', { name: 'Remove connection', exact: true }).click();
  await page.waitForFunction(C => !window.__registry.environments[C], C);
  await page.getByRole('heading', { name: 'Machines', exact: true }).waitFor();
  check(await page.locator(`.server-settings-list [data-server-id="${C}"]`).count() === 0, 'Deleting a connection returns to Servers and removes the row');
  await allChats();
  await page.locator('.workspace-chat').filter({ hasText: 'Gamma' }).getByText(/Removed · cached/).first().waitFor();
  await select(C);
  check(await page.getByRole('button', { name: 'Attach file' }).isDisabled(), 'Removed connection keeps its cached conversation read-only');
  check(await page.getByRole('button', { name: 'Pause task', exact: true }).isDisabled(), 'Removed owner cannot dispatch commands through cached controls');
  await openSettings(page, { page: 'add' });
  await page.getByLabel('Environment URL', { exact: true }).fill('https://gamma.example');
  await page.getByRole('button', { name: 'Discover environment' }).click();
  await page.getByText(/Untrusted preview: Gamma/).waitFor();
  await page.getByLabel('Expected installation UUID').fill(C);
  await page.getByLabel('New environment label').fill('New Gamma');
  await page.getByRole('radio', { name: /Pair a new installation/ }).check();
  await page.getByLabel('New installation bootstrap token').fill('synthetic-bootstrap-only');
  await page.evaluate(() => { window.__failBootstrap = true; });
  await page.getByRole('button', { name: 'Pair and verify installation' }).click();
  await page.getByRole('alert').filter({ hasText: 'Pairing may already have succeeded' }).waitFor();
  check(await page.getByLabel('New installation bootstrap token').inputValue() === '', 'Bootstrap token cleared after ambiguous response');
  check(await page.evaluate(C => window.__requests.filter(r => r.command === 'environment_register' && r.args.bootstrapToken).every(r => r.args.environmentId === C && r.args.bootstrapToken === 'synthetic-bootstrap-only'), C), 'Explicit new-installation bootstrap includes expected UUID');
  await page.waitForTimeout(2100);
  check(await page.evaluate(() => window.__requests.filter(r => r.command === 'environment_register' && r.args.bootstrapToken).length === 1), 'Ambiguous bootstrap never automatically retried');

  await select(B);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Approvals/ }).click();
  await page.getByRole('region', { name: 'Alpha approvals' }).getByRole('button', { name: 'Review this action', exact: true }).click();
  check(await page.getByRole('dialog', { name: 'Review this action', exact: true }).getByRole('button', { name: 'Approve', exact: true }).isDisabled(), 'Offline approvals are read-only');
  await page.getByRole('button', { name: 'Close review', exact: true }).click();
  await page.getByRole('region', { name: 'Beta renamed approvals' }).getByRole('button', { name: 'Review this action', exact: true }).click();
  await page.getByRole('dialog', { name: 'Review this action', exact: true }).getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(B => window.__requests.some(r => r.args.kind === 'approval.decide' && r.args.environmentId === B && r.args.payload.nonce === B), B);
  check(await page.evaluate(B => window.__requests.filter(r => r.args.kind === 'approval.decide').every(r => r.args.environmentId === B), B), 'Approval uses only its owning server');
    await page.getByRole('button', { name: 'Close review', exact: true }).click();

  const noteText = 'Shared note synced from another server';
  await go('Memory');
  await page.getByRole('button', { name: 'New shared note', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Note', { exact: true }).fill(noteText);
  await page.getByRole('button', { name: 'Save shared note', exact: true }).click();
  await page.getByText(/^Saved on 1 of 2 servers:/).waitFor();
  await page.getByText('Waiting for Alpha to reconnect.', { exact: true }).waitFor();
  check(await page.getByText(noteText, { exact: true }).count() === 1, 'Shared note is visible while the other server is offline');
  await page.evaluate(A => { window.__states[A].offline = false; }, A);
  await openSettings(page, { server: A });
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await go('Memory');
  await page.getByText(/^Saved on 2 of 2 servers:/).waitFor();
  check(await page.getByText(noteText, { exact: true }).count() === 1, 'A reconnect receives the note without a duplicate UI row');
  await openSettings(page, { server: A, tab: 'setup' });
  await page.getByRole('button', { name: 'Disconnect environment', exact: true }).click();
  await go('Memory');
  await page.getByRole('button', { name: 'Forget shared note…' }).click();
  await page.getByRole('button', { name: 'Forget on all servers' }).click();
  await page.getByText('A deletion is still syncing to your servers.', { exact: true }).waitFor();
  check(await page.getByText(noteText, { exact: true }).count() === 0, 'An offline copy cannot make a forgotten note reappear');
  await openSettings(page, { server: A, tab: 'setup' });
  await page.getByRole('button', { name: 'Reconnect environment', exact: true }).click();
  await page.waitForFunction(({ A, B }) => [A, B].every(id => window.__states[id].records.some(record => record.data.shared && record.data.forgotten)), { A, B });
  check(await page.evaluate(({ A, B }) => {
    const writes = window.__requests.filter(r => r.args.kind === 'memory.shared');
    return writes.length === 4 && writes.every(r => [A, B].includes(r.args.environmentId) && r.args.id === writes[0].args.id);
  }, { A, B }), 'The save and deletion propagate only to verified installations under a stable note ID');

  await openSettings(page, { server: 'legacy' });
  await page.getByRole('button', { name: 'Remove connection…' }).click();
  await page.getByRole('button', { name: 'Keep connection' }).click();
  check(await page.evaluate(() => !window.__requests.some(r => r.command === 'clear_legacy_endpoint')), 'Cancel leaves the legacy connection in place');
  await page.getByRole('button', { name: 'Remove connection…' }).click();
  await page.getByRole('dialog', { name: 'Remove this saved connection?', exact: true }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Remove connection', exact: true }).click();
  await page.getByRole('heading', { name: 'Machines', exact: true }).waitFor();
  check(await page.locator('.server-settings-list [data-server-id="legacy"]').count() === 0, 'Deleting the legacy connection removes the row');

  mkdirSync('/tmp/outpost-a3-ui', { recursive: true });
  await page.screenshot({ path: `/tmp/outpost-a3-ui/settings-dark-${engine.name()}.png`, fullPage: true });
  await allChats();
  await page.screenshot({ path: `/tmp/outpost-a3-ui/history-dark-${engine.name()}.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' }); await page.setViewportSize({ width: 760, height: 1000 });
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  await page.screenshot({ path: `/tmp/outpost-a3-ui/history-light-narrow-${engine.name()}.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`PASS: ${checks} environment isolation checks (${engine.name()}); same IDs, owner-bound mutations/upload/OAuth, streams, stale history, route, adoption and legacy recovery. Synthetic screenshots: /tmp/outpost-a3-ui`);
  }
} catch (error) {
  console.error(`FAIL after ${checks} completed environment checks (${engine.name()}): ${error.message}`);
  throw error;
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
