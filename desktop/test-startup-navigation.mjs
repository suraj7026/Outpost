import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { openSettings } from './settings-test-navigation.mjs';

// Integrated dist only: never build, contact a server, or execute a native mutation.
const desktop = dirname(fileURLToPath(import.meta.url));
const root = resolve(desktop, 'dist');
const index = resolve(root, 'index.html');
assert.ok(existsSync(index), 'Missing desktop/dist/index.html; build the desktop app before running this test.');
console.log(`Testing dist built ${statSync(index).mtime.toISOString()}`);
for (const source of ['App.tsx', 'Environments.tsx', 'appearance.tsx', 'startup-navigation.ts']) {
  const path = resolve(desktop, 'src', source);
  if (existsSync(path) && statSync(path).mtimeMs > statSync(index).mtimeMs) {
    console.warn(`Warning: src/${source} is newer than dist; failures may reflect an outdated build.`);
  }
}
const engineName = process.env.OUTPOST_TEST_BROWSER || 'chromium';
assert.ok(['chromium', 'webkit'].includes(engineName), 'OUTPOST_TEST_BROWSER must be chromium or webkit');
const engine = engineName === 'webkit' ? webkit : chromium;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REMOVED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const appearanceKey = 'outpost.appearance.v1';
const locationKey = 'outpost.last-location.v1';
const lastPreference = JSON.stringify({ startupPage: 'last' });
const taskLocation = (environmentId = A, taskId = 'same-task') => ({ page: 'task', environmentId, taskId });
const ownerKey = id => id ?? 'legacy';
const labels = { [A]: 'Alpha', [B]: 'Beta', legacy: 'Legacy' };
let checks = 0, scenarios = 0, browser, origin, deadline;
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const server = createServer((request, response) => {
  const file = resolve(root, new URL(request.url, 'http://fixture').pathname.slice(1) || 'index.html');
  if (request.method !== 'GET' || !file.startsWith(root + '/') || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404).end(); return;
  }
  response.setHeader('content-type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream');
  response.end(readFileSync(file));
});

async function scenario(name, options, test) {
  console.log(`  ${name}`);
  const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 1000 }, colorScheme: 'dark', serviceWorkers: 'block' });
  const errors = [], calls = [], violations = [];
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(7000);
    page.setDefaultNavigationTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      const asset = url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/') || url.pathname === '/icon.svg';
      if (url.origin === origin && request.method() === 'GET' && asset) return route.continue();
      violations.push(`Blocked network request: ${request.method()} ${request.url()}`);
      return route.abort();
    });
    await page.exposeFunction('__startupIpc', entry => { calls.push(entry); });
    await page.exposeFunction('__startupViolation', message => { violations.push(message); });
    await page.addInitScript(({ A, B, origin, appearanceKey, locationKey, options }) => {
      if (location.origin !== origin) return;
      if (!sessionStorage.getItem('startup-fixture-seeded')) {
        if (options.appearance !== undefined) localStorage.setItem(appearanceKey, options.appearance);
        if (options.location !== undefined) localStorage.setItem(locationKey, options.location);
        sessionStorage.setItem('startup-fixture-seeded', 'true');
      }
      if (options.blockedStorage) {
        for (const method of ['getItem', 'setItem', 'removeItem']) {
          const original = Storage.prototype[method];
          Storage.prototype[method] = function (...args) {
            if (this === localStorage) throw new DOMException('Synthetic blocked storage', 'SecurityError');
            return original.apply(this, args);
          };
        }
      }
      window.isTauri = true;
      window.__startupDocument = crypto.randomUUID();
      const row = (kind, id, data, newer = false) => ({ kind, id, data, revision: 1, updatedAt: newer ? '2026-11-16T12:00:00Z' : '2026-11-01T12:00:00Z' });
      const make = (environmentId, label) => ({ environmentId, label, activeRoute: `https://${label.toLowerCase()}.example`, routes: [`https://${label.toLowerCase()}.example`] });
      const registry = { version: 1, legacyMutationsRetired: false, selectedEnvironmentId: A, environments: { [A]: make(A, 'Alpha'), [B]: make(B, 'Beta') } };
      const legacyEndpoint = options.emptyLegacy ? '' : 'https://legacy.example';
      const states = Object.fromEntries([[A, 'Alpha'], [B, 'Beta'], ['legacy', 'Legacy']].map(([id, label]) => [id, {
        offline: options.offlineOwner === id, held: options.heldOwner === id, releases: [], cursor: 1,
        records: [
          row('task', 'same-task', { goal: `${label} older task`, profile: 'code', state: 'paused' }),
          row('message', 'same-message', { taskId: 'same-task', author: 'assistant', text: `${label} private older conversation` }),
          row('task', 'newer-task', { goal: `${label} newest task`, profile: 'code', state: 'paused' }, true),
          row('message', 'newer-message', { taskId: 'newer-task', author: 'assistant', text: `${label} private newest conversation` }, true),
        ].filter(record => !(options.missingTaskOwner === id && (record.id === 'same-task' || record.data.taskId === 'same-task'))),
      }]));
      const callbacks = new Map(), streams = new Map();
      let sequence = 0;
      window.__startupStates = states;
      window.__startupRequests = [];
      window.__releaseStartupSnapshot = id => {
        states[id].held = false;
        for (const release of states[id].releases.splice(0)) release();
      };
      const unexpected = async message => {
        await window.__startupViolation(message);
        throw new Error(message);
      };
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        transformCallback(fn) { const id = ++sequence; callbacks.set(id, fn); return id; },
        unregisterCallback(id) { callbacks.delete(id); },
        async invoke(command, args = {}) {
          const entry = { command, environmentId: args.environmentId ?? null, kind: args.kind };
          window.__startupRequests.push(entry);
          await window.__startupIpc(entry);
          if (['plugin:window|set_theme', 'set_sidebar_window_controls', 'set_window_blur'].includes(command)) return;
          if (command === 'sidebar_pointer_inside') return false;
          if (command === 'environment_list') return { registry: structuredClone(registry), legacy: { endpoint: legacyEndpoint, pending: false } };
          // Only the remount regression may simulate adoption; nothing reaches native IPC or a server.
          if (options.delayedAdoption && command === 'environment_discover') {
            if (args.endpoint !== 'https://beta.example') return unexpected('Discovery targeted an unexpected route');
            return { descriptorVersion: 1, environmentId: B, label: 'Beta', protocolVersion: 2, recordProtocolVersion: 1 };
          }
          if (options.delayedAdoption && command === 'environment_register') {
            if (args.environmentId !== B || args.endpoint !== 'https://beta.example' || args.retireLegacyMutations !== true || args.bootstrapToken !== undefined)
              return unexpected('Adoption did not match the reviewed synthetic owner and retirement choice');
            await new Promise(resolve => { window.__finishStartupAdoption = resolve; });
            registry.legacyMutationsRetired = true;
            return structuredClone(registry);
          }
          // This is local selection metadata only; no server commands are permitted.
          if (command === 'environment_select') {
            if (args.environmentId !== null && !registry.environments[args.environmentId]) return unexpected('Selection targeted an unknown owner');
            registry.selectedEnvironmentId = args.environmentId;
            return structuredClone(registry);
          }
          if (command === 'setup_list' || command === 'setup_history_list') return [];
          if (command === 'automatic_updates_status' || command === 'automatic_updates_tick') return { enabled: false, targets: [], activeEnvironmentId: null, servers: [] };
          const id = command.startsWith('environment_') ? args.environmentId : 'legacy';
          const state = states[id], op = command.replace(/^environment_/, '');
          if (!state) return unexpected(`Unknown fixture owner: ${command} ${id}`);
          if (op === 'disconnect') {
            if (args.pause) return unexpected('Navigation must not pause a server');
            streams.get(id)?.resolve(); streams.delete(id); return;
          }
          if (op === 'connection_info') {
            if (options.emptyLegacy && id === 'legacy') await new Promise(resolve => { window.__releaseStartupLegacyInfo = resolve; });
            return {
              environmentId: id === 'legacy' ? null : id, endpoint: id === 'legacy' ? legacyEndpoint : `https://${id === A ? 'alpha' : 'beta'}.example`,
              deviceId: 'synthetic-device', publicKey: 'synthetic-public-key', pending: false, nativeSidebar: false,
              lifecycle: options.emptyLegacy && id === 'legacy' ? null : { state: state.offline ? 'offline' : 'connected', error: null },
            };
          }
          if (op === 'query') {
            if (state.offline) throw new Error('Synthetic offline owner');
            if (args.kind === 'snapshot') {
              if (state.held) await new Promise(resolve => state.releases.push(resolve));
              return { protocolVersion: 1, cursor: state.cursor, records: structuredClone(state.records) };
            }
            if (args.kind === 'runtime') return { configured: true, piManagement: false, sharedMemory: false, model: 'fixture:cloud' };
            if (args.kind === 'models') return { models: ['fixture:cloud'], defaultModel: 'fixture:cloud' };
            if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: state.cursor };
          }
          if (op === 'stream_events') return new Promise(resolve => {
            streams.set(id, { resolve });
            callbacks.get(args.channel.id)?.({ index: 0, message: { type: 'snapshot', cursor: state.cursor, records: structuredClone(state.records), live: [] } });
          });
          return unexpected(`Unexpected IPC (mutations are forbidden): ${command} ${args.kind ?? ''}`);
        },
      };
    }, { A, B, origin, appearanceKey, locationKey, options });
    await page.goto(`${origin}/${options.hash ?? ''}`);
    await page.locator('.app-shell').waitFor();
    await test(page, calls);
    equal(violations, [], `${name}: no external network or unexpected IPC`);
    equal(errors, [], `${name}: no uncaught browser errors`);
    scenarios++;
  } catch (error) {
    error.message = `${name}: ${error.message}${violations.length ? `\n${violations.join('\n')}` : ''}`;
    throw error;
  } finally {
    await context.close();
  }
}

const home = page => page.getByRole('textbox', { name: 'Task goal', exact: true });
const chat = page => page.getByRole('textbox', { name: 'Message Outpost', exact: true });
const heading = (page, name) => page.getByRole('heading', { name, exact: true, level: 1 });
const chatButton = (page, id, taskId = 'same-task') => page.locator(`#app-sidebar [data-server-id="${ownerKey(id)}"] [data-task-id="${taskId}"]`);
const startupGroup = page => page.getByRole('group', { name: 'On startup', exact: true });
const startupRadio = (page, mode) => startupGroup(page).getByRole('radio', { name: mode === 'last' ? 'Last working page' : 'New task home page', exact: true });
const stored = (page, key) => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
async function savedLocation(page, expected) {
  await page.waitForFunction(({ key, expected }) => localStorage.getItem(key) === JSON.stringify(expected), { key: locationKey, expected });
  equal(await stored(page, locationKey), expected, 'Working location is persisted with its owner/hash');
}
async function ready(page, id = A) {
  await page.locator(`#app-sidebar [data-server-id="${ownerKey(id)}"] .status-dot.online`).waitFor();
  await chatButton(page, id, 'newer-task').waitFor({ state: 'attached' });
}
async function assertHome(page) {
  await home(page).waitFor();
  check(!await chat(page).isVisible(), 'Home does not select the server’s newest chat');
  equal(await page.locator('#app-sidebar [data-task-id][aria-current="page"]').count(), 0, 'No sidebar chat is selected on Home');
}
async function assertChat(page, id, taskId = 'same-task') {
  await chat(page).waitFor();
  const label = labels[ownerKey(id)], age = taskId === 'same-task' ? 'older' : 'newest';
  await page.locator('.main-shell').getByText(`${label} private ${age} conversation`, { exact: true }).waitFor();
  equal(await page.locator('.main-shell').getAttribute('data-owner-id'), ownerKey(id), 'Chat keeps its owning server');
  equal(await chatButton(page, id, taskId).getAttribute('aria-current'), 'page', 'Owner-qualified sidebar chat is selected');
  equal(await page.locator('#app-sidebar [data-task-id][aria-current="page"]').count(), 1, 'Only one owner-qualified chat is selected');
  check(!await home(page).isVisible(), 'Chat does not show the Home composer');
  await savedLocation(page, taskLocation(id, taskId));
}
async function showSidebar(page) {
  if (await page.locator('#app-sidebar').getAttribute('aria-hidden') === 'true') await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await page.locator('#app-sidebar[data-motion="open"]').waitFor();
}
async function selectChat(page, id, taskId = 'same-task') {
  await showSidebar(page);
  await chatButton(page, id, taskId).click();
  await assertChat(page, id, taskId);
}
async function navigate(page, label) {
  await showSidebar(page);
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: label, exact: true }).click();
  await heading(page, label).waitFor();
}
async function appearance(page) {
  await openSettings(page, { page: 'appearance' });
  await startupGroup(page).waitFor();
}
async function setStartup(page, mode, persist = true) {
  const hash = new URL(page.url()).hash;
  await startupRadio(page, mode).check();
  check(await startupRadio(page, mode).isChecked(), `Startup radio selects ${mode}`);
  await heading(page, hash === '#settings/appearance' ? 'Appearance' : 'Settings').waitFor();
  equal(new URL(page.url()).hash, hash, 'Changing startup preference does not navigate immediately');
  if (persist) {
    await page.waitForFunction(({ key, mode }) => JSON.parse(localStorage.getItem(key))?.startupPage === mode, { key: appearanceKey, mode });
    equal((await stored(page, appearanceKey)).startupPage, mode, 'Startup preference is saved through the controls');
  }
}
async function freshLaunch(page, hash = '') {
  const documentId = await page.evaluate(() => window.__startupDocument);
  // Avoid a same-document hash navigation; retain the tab’s localStorage without reseeding it.
  await page.goto('about:blank');
  await page.goto(`${origin}/${hash}`);
  await page.locator('.app-shell').waitFor();
  check(await page.evaluate(() => window.__startupDocument) !== documentId, 'Fresh launch creates a new document');
}

async function run() {
  await scenario('Default launch is Home despite existing and newer chats', {}, async page => {
    await ready(page); await assertHome(page);
    await appearance(page);
    equal(await startupGroup(page).getByRole('radio').count(), 2, 'On startup exposes exactly two choices');
    check(await startupRadio(page, 'home').isChecked(), 'New task home page is the default');
    check(!await startupRadio(page, 'last').isChecked(), 'Last working page is opt-in');
    await selectChat(page, A);
    await freshLaunch(page); await ready(page); await assertHome(page);
  });

  for (const [name, value] of [
    ['malformed JSON', '{broken'], ['null', 'null'], ['array', '[]'], ['primitive', '42'],
    ['older preferences without startupPage', JSON.stringify({ theme: 'light' })],
    ['unsupported startupPage', JSON.stringify({ startupPage: 'newest' })],
    ['wrong startupPage type', JSON.stringify({ startupPage: true })],
  ]) {
    await scenario(`Invalid/legacy appearance: ${name}`, { appearance: value, location: JSON.stringify(taskLocation(B)) }, async page => {
      await ready(page); await assertHome(page);
      await appearance(page);
      check(await startupRadio(page, 'home').isChecked(), 'Invalid/missing startupPage defaults to Home');
    });
  }

  await scenario('Save Last working page, restore an older chat, then reset Home', {}, async page => {
    await ready(page); await assertHome(page);
    await appearance(page); await setStartup(page, 'last');
    await selectChat(page, A);
    await freshLaunch(page); await ready(page); await assertChat(page, A);
    check(!await page.locator('.main-shell').getByText('Alpha private newest conversation', { exact: true }).isVisible(), 'A newer task does not replace the last selected task');
    await appearance(page); await setStartup(page, 'home');
    await selectChat(page, A);
    await freshLaunch(page); await ready(page); await assertHome(page);
    await appearance(page);
    check(await startupRadio(page, 'home').isChecked(), 'Reset Home preference survives fresh launch');
  });

  for (const id of [B, null]) {
    await scenario(`Restore ${labels[ownerKey(id)]} owner, not registry-selected Alpha`, { appearance: lastPreference, location: JSON.stringify(taskLocation(id)) }, async (page, calls) => {
      await ready(page, A); await ready(page, id); await assertChat(page, id);
      equal(calls.filter(call => call.command === 'environment_select'), [], 'Startup overrides the owner locally without mutating registry selection');
      await selectChat(page, A);
      await selectChat(page, id);
      const beforeLaunch = calls.length;
      await freshLaunch(page); await assertChat(page, id);
      equal(calls.slice(beforeLaunch).filter(call => call.command === 'environment_select'), [], 'Restoration is local on every launch');
    });
  }

  await scenario('Missing saved environment falls back to Home', { appearance: lastPreference, location: JSON.stringify(taskLocation(REMOVED)) }, async (page, calls) => {
    await ready(page); await assertHome(page); await savedLocation(page, { page: 'home' });
    check(!calls.some(call => call.environmentId === REMOVED), 'Removed environment is never contacted');
  });
  await scenario('Missing legacy endpoint waits for connection info, then falls back to Home', {
    appearance: lastPreference, location: JSON.stringify(taskLocation(null)), emptyLegacy: true,
  }, async (page, calls) => {
    await ready(page, A);
    await page.waitForFunction(() => typeof window.__releaseStartupLegacyInfo === 'function');
    await page.getByRole('status').filter({ hasText: 'This chat is not available yet.' }).waitFor();
    check(!await home(page).isVisible() && !await chat(page).isVisible(), 'Unknown legacy endpoint does not trigger an early fallback');
    await savedLocation(page, taskLocation(null));
    await page.evaluate(() => window.__releaseStartupLegacyInfo());
    await assertHome(page); await savedLocation(page, { page: 'home' });
    check(!await page.getByRole('status').filter({ hasText: 'This chat is not available yet.' }).isVisible(), 'Confirmed missing legacy server does not leave startup waiting');
    check(!calls.some(call => call.command === 'query' || call.command === 'stream_events'), 'Unconfigured legacy server is never queried or streamed');
    equal(calls.filter(call => call.command === 'environment_select'), [], 'Missing legacy fallback does not select another owner');
  });
  for (const missing of [false, true]) {
    await scenario(`Wait for authoritative snapshot before ${missing ? 'missing-task fallback' : 'restoring a task'}`, {
      appearance: lastPreference, location: JSON.stringify(taskLocation(B)), heldOwner: B, ...(missing ? { missingTaskOwner: B } : {}),
    }, async page => {
      await ready(page, A);
      await page.waitForFunction(id => window.__startupStates[id].releases.length > 0, B);
      await page.getByRole('status').filter({ hasText: 'This chat is not available yet.' }).waitFor();
      equal(await page.locator('.main-shell').getAttribute('data-owner-id'), B, 'Pending restoration keeps Beta ownership');
      check(!await home(page).isVisible() && !await chat(page).isVisible(), 'Pending snapshot neither falls back prematurely nor selects another chat');
      await savedLocation(page, taskLocation(B));
      await page.evaluate(id => window.__releaseStartupSnapshot(id), B);
      await ready(page, B);
      if (missing) { await assertHome(page); await savedLocation(page, { page: 'home' }); }
      else await assertChat(page, B);
    });
  }
  await scenario('Offline owner waits, then restores when it reconnects', { appearance: lastPreference, location: JSON.stringify(taskLocation(B)), offlineOwner: B }, async page => {
    await ready(page, A);
    await page.getByRole('status').filter({ hasText: 'This chat is not available yet.' }).waitFor();
    await page.waitForFunction(id => window.__startupRequests.filter(call => call.command === 'environment_connection_info' && call.environmentId === id).length >= 2, B);
    check(!await home(page).isVisible() && !await chat(page).isVisible(), 'Offline restoration does not switch to an available Alpha task or Home');
    equal(await page.locator('.main-shell').getAttribute('data-owner-id'), B, 'Offline restoration remains on Beta');
    await savedLocation(page, taskLocation(B));
    await page.evaluate(id => { window.__startupStates[id].offline = false; }, B);
    await ready(page, B); await assertChat(page, B);
  });

  await scenario('User navigation to Home wins over a later saved-owner reconnect', {
    appearance: lastPreference, location: JSON.stringify(taskLocation(B)), offlineOwner: B,
  }, async page => {
    await ready(page, A);
    await page.getByRole('status').filter({ hasText: 'This chat is not available yet.' }).waitFor();
    await showSidebar(page); await page.locator('#app-sidebar .new-task-button').click();
    await assertHome(page); await savedLocation(page, { page: 'home' });
    await page.evaluate(id => { window.__startupStates[id].offline = false; }, B);
    await ready(page, B); await assertHome(page); await savedLocation(page, { page: 'home' });
  });

  for (const [name, location, destination] of [
    ['saved chat to Home', taskLocation(B), 'home'],
    ['saved Appearance to Library', { page: 'connection', hash: '#settings/appearance' }, 'outputs'],
  ]) {
    await scenario(`Delayed adoption remount preserves current page: ${name}`, {
      appearance: lastPreference, location: JSON.stringify(location), delayedAdoption: true,
    }, async (page, calls) => {
      if (location.page === 'task') await assertChat(page, B);
      else await heading(page, 'Appearance').waitFor();
      await page.evaluate(() => { window.location.hash = '#settings/servers/new'; });
      await page.getByRole('button', { name: 'Connect with a URL', exact: true }).click();
      await page.locator('#add-url').fill('https://beta.example');
      await page.getByRole('button', { name: 'Discover environment', exact: true }).click();
      await page.locator('#expected-environment').fill(B);
      await page.locator('#add-label').fill('Beta');
      await page.getByRole('checkbox', { name: /Retire legacy mutations/ }).check();
      await page.getByRole('button', { name: 'Verify and adopt enrollment', exact: true }).click();
      await page.waitForFunction(() => typeof window.__finishStartupAdoption === 'function');
      await page.getByRole('button', { name: 'Close server setup', exact: true }).click();
      if (destination === 'home') {
        await showSidebar(page); await page.locator('#app-sidebar .new-task-button').click();
        await assertHome(page);
      } else await navigate(page, 'Library');
      await savedLocation(page, { page: destination });
      const shell = await page.locator('.app-shell').elementHandle();
      await page.evaluate(() => window.__finishStartupAdoption());
      // Prove the retirement-key remount occurred before asserting that navigation survived it.
      await page.waitForFunction(element => !element.isConnected, shell);
      await shell.dispose();
      await page.locator('.app-shell').waitFor();
      if (destination === 'home') await assertHome(page);
      else await heading(page, 'Library').waitFor();
      check(!await chat(page).isVisible(), 'Remount does not reopen the saved startup chat');
      equal(new URL(page.url()).hash, '', 'Remount does not replay a saved settings hash');
      await savedLocation(page, { page: destination });
      equal(calls.filter(call => call.command === 'environment_register').length, 1, 'Exactly one synthetic adoption completes');
      equal(calls.filter(call => call.command === 'environment_select'), [], 'Remount does not mutate selected-owner metadata');
      await freshLaunch(page);
      if (destination === 'home') await assertHome(page);
      else await heading(page, 'Library').waitFor();
      await savedLocation(page, { page: destination });
    });
  }

  const invalidLocations = [
    ['absent', undefined], ['malformed JSON', '{broken'], ['null', 'null'], ['array', '[]'], ['primitive', 'true'],
    ['unsupported page', JSON.stringify({ page: 'unknown' })],
    ['missing task ID', JSON.stringify({ page: 'task', environmentId: A })],
    ['empty task ID', JSON.stringify(taskLocation(A, ''))],
    ['non-string task ID', JSON.stringify(taskLocation(A, 42))],
    ['oversized task ID', JSON.stringify(taskLocation(A, 'x'.repeat(513)))],
    ['missing owner', JSON.stringify({ page: 'task', taskId: 'same-task' })],
    ['empty owner', JSON.stringify(taskLocation(''))],
    ['invalid owner', JSON.stringify(taskLocation(42))],
    ['missing settings hash', JSON.stringify({ page: 'connection' })],
    ['unsupported settings section', JSON.stringify({ page: 'connection', hash: '#settings/unsupported' })],
    ['unsafe settings hash', JSON.stringify({ page: 'connection', hash: 'https://outside.example/#settings' })],
    ['missing settings server', JSON.stringify({ page: 'machines', hash: `#settings/servers/${REMOVED}/devices` })],
  ];
  for (const [name, location] of invalidLocations) {
    await scenario(`Invalid last location: ${name}`, { appearance: lastPreference, location }, async page => {
      await ready(page); await assertHome(page); await savedLocation(page, { page: 'home' });
    });
  }

  for (const [destination, label] of [['decisions', 'Approvals'], ['outputs', 'Library'], ['automations', 'Automations'], ['memory', 'Memory'], ['machines', 'Machines'], ['history', 'All chats']]) {
    await scenario(`Remember and restore ${label}`, { appearance: lastPreference }, async page => {
      await ready(page); await assertHome(page);
      await navigate(page, label);
      const expected = destination === 'machines' ? { page: destination, hash: '#machines' } : { page: destination };
      await savedLocation(page, expected);
      await freshLaunch(page); await heading(page, label).waitFor();
      check(!await home(page).isVisible() && !await chat(page).isVisible(), 'Restored workspace/history is not replaced by a chat');
      await savedLocation(page, expected);
    });
  }

  await scenario('Remember Settings preferences and the legacy Appearance route', { appearance: lastPreference }, async page => {
    await openSettings(page, { page: 'home' });
    await savedLocation(page, { page: 'connection', hash: '#settings' });
    await freshLaunch(page); await heading(page, 'Settings').waitFor();
    equal(new URL(page.url()).hash, '#settings', 'Settings root hash is restored');
    await startupGroup(page).waitFor();
    check(await page.getByRole('group', { name: 'Theme', exact: true }).isVisible(), 'Restored Settings root shows appearance preferences');
    equal(await page.locator('.settings-workspace .settings-link-list a').count(), 0, 'Settings root has no Machines or Appearance menu links');
    await page.evaluate(() => { window.location.hash = '#settings/appearance'; });
    await heading(page, 'Appearance').waitFor();
    await savedLocation(page, { page: 'connection', hash: '#settings/appearance' });
    await freshLaunch(page); await heading(page, 'Appearance').waitFor();
    equal(new URL(page.url()).hash, '#settings/appearance', 'Appearance section hash is restored');
    check(await startupRadio(page, 'last').isChecked(), 'Last working page remains selected');
  });
  await scenario('Restore a server settings subsection', { appearance: lastPreference }, async page => {
    await ready(page, B);
    await openSettings(page, { server: B, tab: 'devices' });
    const hash = `#settings/servers/${B}/devices`;
    await savedLocation(page, { page: 'machines', hash });
    await freshLaunch(page);
    await heading(page, 'Beta').waitFor();
    await page.locator(`.server-settings-tabs a[href="${hash}"][aria-current="page"]`).waitFor();
    equal(new URL(page.url()).hash, hash, 'Server owner and subsection survive restoration');
  });

  for (const mode of ['home', 'last']) {
    await scenario(`Explicit URL overrides ${mode} preference and saved chat`, { appearance: JSON.stringify({ startupPage: mode }), location: JSON.stringify(taskLocation(B)), hash: '#settings/appearance' }, async page => {
      await heading(page, 'Appearance').waitFor();
      check(await startupRadio(page, mode).isChecked(), 'Explicit link does not change the startup preference');
      check(!await chat(page).isVisible(), 'Explicit settings link wins over saved chat');
    });
  }
  await scenario('Explicit startup URL wins over a different stored settings section', {
    appearance: lastPreference, location: JSON.stringify({ page: 'connection', hash: '#settings/appearance' }), hash: `#settings/servers/${B}/devices`,
  }, async page => {
    await heading(page, 'Beta').waitFor();
    await page.locator('.server-settings-tabs a[aria-current="page"][href$="/devices"]').waitFor();
    equal(new URL(page.url()).hash, `#settings/servers/${B}/devices`, 'Explicit server subsection is not replaced by stored Appearance');
  });

  await scenario('New task button and Cmd+N remain usable with Last working page', { appearance: lastPreference, location: JSON.stringify(taskLocation(B)) }, async page => {
    await assertChat(page, B);
    await showSidebar(page); await page.locator('#app-sidebar .new-task-button').click();
    await assertHome(page); await savedLocation(page, { page: 'home' });
    await freshLaunch(page); await ready(page); await assertHome(page);
    await selectChat(page, B);
    await page.keyboard.press('Meta+n');
    await assertHome(page);
    check(await home(page).evaluate(element => element === document.activeElement), 'Cmd+N focuses Task goal');
    await savedLocation(page, { page: 'home' });
    await navigate(page, 'All chats');
    await page.keyboard.press('Meta+n'); await assertHome(page);
    await appearance(page);
    await page.keyboard.press('Meta+n'); await assertHome(page);
    equal(new URL(page.url()).hash, '', 'Cmd+N clears a settings hash');
    await savedLocation(page, { page: 'home' });
    await freshLaunch(page); await assertHome(page);
    equal((await stored(page, appearanceKey)).startupPage, 'last', 'New task navigation does not reset the startup preference');
  });

  for (const width of [1440, 390]) {
    await scenario(`Startup settings controls fit a ${width}px viewport`, { width, hash: '#settings/appearance' }, async page => {
      await startupGroup(page).waitFor();
      await setStartup(page, 'last');
      await setStartup(page, 'home');
      await page.evaluate(() => document.fonts.ready);
      const overflow = await startupGroup(page).evaluate(group => {
        const viewport = document.documentElement.clientWidth;
        return [document.documentElement, document.querySelector('.settings-page'), group, ...group.querySelectorAll('label')]
          .filter(element => element.scrollWidth > element.clientWidth + 1 ||
            element.getBoundingClientRect().left < -1 || element.getBoundingClientRect().right > viewport + 1)
          .map(element => ({ tag: element.tagName, className: element.className, width: element.clientWidth, scrollWidth: element.scrollWidth }));
      });
      equal(overflow, [], 'Appearance page and startup choices have no horizontal overflow');
      const screenshot = await page.screenshot({ animations: 'disabled' });
      equal([...screenshot.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'Settings screenshot is captured as PNG in memory');
    });
  }

  await scenario('Blocked localStorage defaults safely and navigation remains usable', {
    appearance: lastPreference, location: JSON.stringify(taskLocation(B)), blockedStorage: true,
  }, async page => {
    await ready(page); await assertHome(page);
    await appearance(page);
    check(await startupRadio(page, 'home').isChecked(), 'Unreadable storage falls back to Home');
    await setStartup(page, 'last', false);
    await page.getByRole('alert').filter({ hasText: 'could not be saved on this device' }).waitFor();
    await showSidebar(page); await chatButton(page, B).click();
    await chat(page).waitFor();
    await page.locator('.main-shell').getByText('Beta private older conversation', { exact: true }).waitFor();
    await appearance(page);
    check(await startupRadio(page, 'last').isChecked(), 'Unsaved preference survives in-session App remounts');
    await freshLaunch(page); await ready(page); await assertHome(page);
  });
}

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await engine.launch({ timeout: 15000 });
  await Promise.race([
    run(),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Startup navigation suite exceeded 180 seconds')), 180000); }),
  ]);
  console.log(`Startup navigation (${engineName}): ${scenarios} scenarios, ${checks} assertions passed.`);
} finally {
  clearTimeout(deadline);
  try { await browser?.close(); }
  finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
