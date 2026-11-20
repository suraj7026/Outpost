import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, webkit } from 'playwright';
import { openSettings, settingsTestAssets } from './settings-test-navigation.mjs';

// Current React source, in-memory assets and synthetic IPC only; no native or live server access.
const server = createServer(await settingsTestAssets());
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const self = '11111111-1111-4111-8111-111111111111';
const secret = 'SYNTHETIC-PRIVATE-NOT-FOR-THE-REPORT';
const models = ['fixture-default:cloud', 'fixture-selected:cloud'];
const modelRef = { providerId: 'fixture-provider', modelId: 'selected-model' };
function report(environmentId = A, state = 'missing') {
  const dispatchEnabled = state === 'missing' || state === 'enabled';
  return {
    schemaVersion: 1, environmentId, collectedAt: '2026-11-16T10:20:30.000Z',
    release: 'synthetic-1', platform: 'linux', architecture: 'arm64',
    recovery: { state, revision: state === 'missing' ? null : 1 }, dispatchEnabled,
    maintenance: { state: 'idle', holding: false },
    runtime: { configured: true, hostAdministration: false, hosts: [] },
    work: { queuedTasks: 1, unknownActions: 0, unknownOperations: 0, unknownOutbox: 0 },
    findings: [{ code: `recovery_${state}`, severity: dispatchEnabled ? 'info' : 'warning', summary: state === 'missing'
      ? 'No recovery record exists. Legacy dispatch remains enabled; absence alone is not a fault and does not require creating a record.'
      : dispatchEnabled ? 'Dispatch is enabled; runtime health is unverified.' : 'Recovery explicitly holds dispatch. Diagnostics do not release the hold.' }],
    agent: { available: dispatchEnabled, reason: dispatchEnabled ? null : `recovery_${state}` },
  };
}
let browser;
const failures = [];
let passed = 0;

async function open(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(6000);
  if (options.commandFailure) await page.clock.install();
  const errors = [], network = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    network.push(route.request().url());
    return route.abort();
  });
  await page.routeWebSocket('**/*', socket => { network.push(socket.url()); socket.close(); });
  await page.addInitScript(({ options, A, B, self, models, modelRef, secret, reports }) => {
    const row = (kind, id, data) => ({ kind, id, data, revision: 1, updatedAt: '2026-11-16T10:20:30.000Z' });
    const owners = ['legacy', A, B];
    const states = Object.fromEntries(owners.map(id => [id, {
      cursor: 1, report: reports[id], pending: options.blocker === 'pending',
      pendingError: options.blocker === 'pendingError' ? 'Synthetic unreadable recovery storage' : null,
      records: [row('device', self, { name: 'This Mac', publicKey: 'synthetic-public-key', revoked: options.blocker === 'revoked' }),
        row('task', 'queued-fixture', { goal: 'Existing queued work', state: 'queued', payload: { token: secret } }),
        ...(options.held ? [row('recovery', 'server', { dispatchEnabled: false })] : [])],
    }]));
    const saved = (environmentId, label) => ({ environmentId, label, activeRoute: `https://${label.toLowerCase()}.invalid`, routes: [`https://${label.toLowerCase()}.invalid`] });
    const registry = { version: 1, legacyMutationsRetired: options.blocker === 'retired', selectedEnvironmentId: options.multi ? A : null,
      environments: options.multi ? { [A]: saved(A, 'Alpha'), [B]: saved(B, 'Beta') } : {} };
    const runtime = { configured: true, model: models[0], piManagement: !!options.managed, hostAdministration: false, browserDirect: false, browserEngine: null, unrestrictedCommands: false };
    const catalogue = { protocolVersion: 1, piVersion: 'synthetic', profilePath: '/synthetic/profile', generation: 'a'.repeat(64),
      providers: [{ id: modelRef.providerId, name: 'Synthetic provider', configured: true, storedMethod: 'api_key', methods: [] }],
      models: options.noModels ? [] : [
        { providerId: modelRef.providerId, modelId: 'default-model', name: 'Default model', reasoning: false },
        { ...modelRef, name: 'Selected model', reasoning: false },
      ], defaultModel: { providerId: modelRef.providerId, modelId: 'default-model' }, refreshErrors: [], capabilities: {}, refreshedAt: null };
    window.__requests = []; window.__unexpected = []; window.__states = states;
    window.__registry = registry; window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => {
      if (window.__clipboardFail) throw new Error('Synthetic clipboard failure');
      window.__copied = value;
    } } });
    if (options.blocker === 'preview') {
      window.__OUTPOST_RECORDED_PREVIEW__ = { snapshot: { protocolVersion: 1, cursor: 1, records: states.legacy.records }, runtime,
        models: { models, defaultModel: models[0] } };
      return;
    }
    window.isTauri = true;
    let sequence = 0;
    const callbacks = new Map(), streams = {};
    window.__publish = id => {
      const stream = streams[id], state = states[id];
      if (stream) callbacks.get(stream.channel.id)?.({ index: stream.index++, message: {
        type: 'snapshot', cursor: state.cursor, records: structuredClone(state.records), live: [],
      } });
    };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback(callback) { const id = ++sequence; callbacks.set(id, callback); return id; },
      unregisterCallback(id) { callbacks.delete(id); },
      async invoke(command, args = {}) {
        if (command === 'plugin:window|set_theme' && args?.label === 'main' && [null, 'light', 'dark'].includes(args.value)) return;
        if (command === 'set_sidebar_window_controls' || command === 'update_sidebar' || command.startsWith('plugin:event|')) return 1;
        if (command === 'sidebar_pointer_inside') return false;
        window.__requests.push({ command, args: structuredClone(args) });
        if (command === 'environment_list') return { registry: structuredClone(registry), legacy: { endpoint: 'Synthetic legacy', pending: states.legacy.pending } };
        if (command === 'environment_select') { registry.selectedEnvironmentId = args.environmentId; return structuredClone(registry); }
        if (command === 'setup_list') return [];
        const id = command.startsWith('environment_') ? args.environmentId : 'legacy';
        const state = states[id], op = command.replace(/^environment_/, '');
        if (state && op === 'disconnect') { streams[id]?.resolve(); delete streams[id]; return; }
        if (state && op === 'connection_info') return { environmentId: id === 'legacy' ? null : id,
          endpoint: id === 'legacy' ? 'Synthetic legacy' : registry.environments[id].activeRoute,
          deviceId: self, publicKey: 'synthetic-public-key', pending: state.pending, pendingError: state.pendingError, nativeSidebar: false };
        if (state && op === 'query') {
          if (options.offline) throw new Error('Synthetic offline server');
          if (args.kind === 'snapshot') return { protocolVersion: 1, cursor: state.cursor, records: structuredClone(state.records) };
          if (args.kind === 'runtime') return runtime;
          if (args.kind === 'models') return { models: options.noModels ? [] : models, defaultModel: models[0] };
          if (args.kind === 'events') return { events: [], hasMore: false, nextCursor: state.cursor };
          if (args.kind === 'recovery.diagnostics') {
            if (options.unsupported) throw new Error(`Unsupported query: ${secret}`);
            const response = structuredClone(state.report);
            if (window.__holdRead === id) {
              window.__holdRead = null;
              return new Promise(resolve => { window.__releaseRead = () => { window.__releaseRead = null; resolve(response); }; });
            }
            return response;
          }
        }
        if (state && op === 'agent_request' && args.payload.type === 'catalogue') return structuredClone(catalogue);
        if (state && op === 'stream_events') return new Promise(resolve => {
          streams[id] = { channel: args.channel, index: 0, resolve };
          window.__publish(id);
        });
        if (state && op === 'send_command' && args.kind === 'recovery.investigate') {
          if (options.commandFailure) throw new Error('Synthetic investigation failure; outcome not confirmed');
          // The backend, not the browser payload, supplies the goal and permission policy.
          // Actual enforcement is tested in server/gateway/recovery-investigation.test.ts.
          const task = row('task', args.id, { goal: 'Investigate recovery', profile: 'operations', state: 'queued',
            model: args.payload.model ?? args.payload.modelRef?.modelId, provider: args.payload.modelRef?.providerId });
          const finish = () => {
            state.records.push(task, row('policy', args.id, { mode: 'full_control' }));
            state.cursor++; window.__publish(id);
            return structuredClone(task);
          };
          if (window.__holdCommand === id) {
            window.__holdCommand = null;
            return new Promise(resolve => { window.__releaseCommand = () => { window.__releaseCommand = null; resolve(finish()); }; });
          }
          return finish();
        }
        window.__unexpected.push({ command, args });
        throw new Error(`Unexpected synthetic IPC: ${command}`);
      },
    };
  }, { options, A, B, self, models, modelRef, secret, reports: {
    legacy: report(A, options.held ? 'held' : 'missing'), [A]: report(A), [B]: report(B),
  } });
  try {
    await page.goto(origin);
    await openSettings(page, { server: options.owner ?? 'legacy', tab: 'recovery' });
    await page.getByRole('heading', { name: 'Recovery status', exact: true }).waitFor();
    return { page, errors, network };
  } catch (error) { await page.close(); throw error; }
}
const dialog = page => page.getByRole('dialog', { name: 'Investigate recovery', exact: true });
const findings = modal => modal.getByRole('region', { name: 'Recovery findings', exact: true });
const start = modal => modal.getByRole('button', { name: 'Start agent investigation', exact: true });
const consent = modal => modal.getByRole('checkbox', { name: /Send a fresh diagnostic summary/ });
const modelSelect = modal => modal.getByRole('combobox', { name: /^Investigation model/ });
const requests = page => page.evaluate(() => window.__requests);
const mutations = async page => (await requests(page)).filter(({ command }) => /(?:send_command|retry_command|enroll_device)$/.test(command));
const reads = async page => (await requests(page)).filter(({ command, args }) => /(?:^|_)query$/.test(command) && args.kind === 'recovery.diagnostics');
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function investigate(page, { ready = true } = {}) {
  await page.getByRole('button', { name: 'Investigate with Outpost', exact: true }).click();
  const modal = dialog(page);
  await modal.waitFor();
  if (ready) await findings(modal).waitFor();
  return modal;
}
async function manual(modal) {
  const details = modal.locator('details').filter({ has: modal.page().getByText('Manual investigation commands', { exact: true }) });
  if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
  await details.getByRole('heading', { name: /Confirm the (server|Mac)/ }).waitFor();
  assert.match(await details.innerText(), /none repairs, restarts or deletes anything/);
  assert.match(await details.locator('pre').first().innerText(), /uname -s/);
  return details;
}
async function approve(modal, managed = false) {
  assert.equal(await start(modal).isDisabled(), true, 'Consent is required before starting');
  await modelSelect(modal).selectOption(managed ? JSON.stringify([modelRef.providerId, modelRef.modelId]) : models[1]);
  await consent(modal).check();
  assert.equal(await start(modal).isEnabled(), true);
}
async function noMutation(page) { assert.deepEqual(await mutations(page), [], 'Read-only investigation must not mutate or retry commands'); }
async function run(name, options, body) {
  let fixture;
  try {
    fixture = await open(options);
    await body(fixture.page);
    await settle(fixture.page);
    assert.deepEqual(await fixture.page.evaluate(() => window.__unexpected), [], 'No unexpected IPC (including shell commands)');
    assert.deepEqual(fixture.network, [], 'No requests outside the in-memory asset server');
    assert.deepEqual(fixture.errors, [], 'No uncaught browser errors');
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}\n${error.stack ?? error}`);
    if (fixture?.errors.length) console.error('Browser errors:', fixture.errors);
  } finally { await fixture?.page.close(); }
}

try {
  browser = await engine.launch({ headless: true });
  await run('missing record: automatic read, legacy dispatch, no fault or mutation', {}, async page => {
    assert.equal((await reads(page)).length, 0);
    const modal = await investigate(page);
    assert.deepEqual(await reads(page), [{ command: 'query', args: { kind: 'recovery.diagnostics', payload: {} } }]);
    assert.match(await findings(modal).innerText(), /legacy dispatch is enabled.*Absence alone is not an error and requires no repair/s);
    assert.match(await findings(modal).innerText(), /legacy route \(not environment-bound\)/);
    assert.match(await findings(modal).innerText(), /Enabled · recovery revision not present/);
    assert.equal(await start(modal).isDisabled(), true);
    await manual(modal);
    await noMutation(page);
    assert.equal(await page.evaluate(() => window.__states.legacy.records.some(row => row.kind === 'recovery')), false);
  });

  await run('held report remains readable, manual commands and clipboard failure at 900px', { held: true }, async page => {
    await page.setViewportSize({ width: 900, height: 700 });
    const modal = await investigate(page);
    assert.match(await findings(modal).innerText(), /Recovery explicitly holds dispatch/);
    assert.equal(await start(modal).count(), 0);
    const steps = await manual(modal);
    await page.evaluate(() => { window.__clipboardFail = true; });
    await steps.getByRole('button', { name: 'Copy confirm the server and operating system', exact: true }).click();
    await modal.getByText('Clipboard unavailable. Select the text below to copy it.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__copied), null);
    await page.evaluate(() => { window.__clipboardFail = false; });
    await steps.getByRole('button', { name: 'Copy discover system outpost units', exact: true }).click();
    await modal.getByText('Copied. Commands have not been executed.', { exact: true }).waitFor();
    assert.match(await page.evaluate(() => window.__copied), /systemctl list-units/);
    await modal.getByText('Copy diagnostic report', { exact: true }).click();
    const layout = await modal.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
        width: innerWidth, height: innerHeight,
        overflow: [document.documentElement, element, ...element.querySelectorAll('.ui-dialog-body, pre')]
          .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className || node.tagName) };
    });
    assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.top >= 0 && layout.bottom <= layout.height, JSON.stringify(layout));
    assert.deepEqual(layout.overflow, [], 'Report and manual commands must not overflow horizontally at 900px');
    await modal.getByRole('button', { name: 'Done', exact: true }).scrollIntoViewIfNeeded();
    assert.ok((await modal.getByRole('button', { name: 'Done', exact: true }).boundingBox()).y < 700);
    await page.keyboard.press('Escape');
    await modal.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'Investigate with Outpost', exact: true }).evaluate(element => element === document.activeElement), true);
    await noMutation(page);
    assert.equal(await page.evaluate(() => window.__states.legacy.records.find(row => row.kind === 'recovery').data.dispatchEnabled), false);
  });

  await run('copied and displayed reports exclude extra secrets and record payloads', {}, async page => {
    const clean = report();
    await page.evaluate(secret => {
      const value = window.__states.legacy.report;
      value.token = secret; value.logs = secret;
      for (const key of ['recovery', 'maintenance', 'runtime', 'work', 'agent']) value[key].credentials = secret;
      value.findings[0].payload = secret;
    }, secret);
    const modal = await investigate(page);
    await modal.getByText('Copy diagnostic report', { exact: true }).click();
    await modal.getByRole('button', { name: 'Copy report', exact: true }).click();
    await modal.getByText('Copied. Commands have not been executed.', { exact: true }).waitFor();
    const copied = await page.evaluate(() => window.__copied);
    assert.deepEqual(JSON.parse(copied), clean);
    assert.equal((await modal.textContent()).includes(secret), false);
    assert.equal(copied.includes(secret), false);
    await noMutation(page);
  });

  await run('invalid and wrong-owner refreshes clear stale findings and consent', { multi: true, owner: B }, async page => {
    const modal = await investigate(page);
    for (const invalid of [{ ...report(B), schemaVersion: 2 }, { ...report(B), work: { ...report(B).work, queuedTasks: -1 } }, report(A)]) {
      await consent(modal).check();
      await page.evaluate(({ B, invalid }) => { window.__states[B].report = invalid; window.__holdRead = B; }, { B, invalid });
      await modal.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
      await page.waitForFunction(() => !!window.__releaseRead);
      assert.equal(await findings(modal).count(), 0, 'Previous findings must disappear while the replacement is pending');
      assert.equal(await start(modal).count(), 0);
      await page.evaluate(() => window.__releaseRead());
      await modal.getByRole('alert').waitFor();
      assert.match(await modal.getByRole('alert').innerText(), /could not be verified/);
      assert.equal(await findings(modal).count(), 0, 'Rejected responses cannot leave stale findings');
      await manual(modal);
      await page.evaluate(({ B, value }) => { window.__states[B].report = value; }, { B, value: report(B) });
      await modal.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
      await findings(modal).waitFor();
      assert.equal(await consent(modal).isChecked(), false);
      assert.equal(await start(modal).isDisabled(), true);
    }
    assert.ok((await reads(page)).every(request => request.args.environmentId === B));
    await noMutation(page);
  });

  for (const [name, options, message] of [
    ['offline', { offline: true }, /server is offline/],
    ['unsupported', { unsupported: true }, /could not be verified/],
    ['pending', { blocker: 'pending' }, /earlier command has an unknown outcome/],
    ['pendingError', { blocker: 'pendingError' }, /Local recovery storage needs attention/],
    ['revoked', { blocker: 'revoked' }, /authority is not confirmed/],
    ['retired', { blocker: 'retired' }, /Select the verified installation/],
    ['preview', { blocker: 'preview' }, /requires the installed app/],
  ]) await run(`${name}: agent blocked, manual discovery remains available`, options, async page => {
    const unavailable = options.offline || options.unsupported || options.blocker === 'preview';
    const modal = await investigate(page, { ready: !unavailable });
    await modal.getByText(message).waitFor();
    if (await start(modal).count()) {
      assert.equal(await start(modal).isDisabled(), true);
      assert.equal(await consent(modal).isDisabled(), true);
      assert.equal(await modelSelect(modal).isDisabled(), true);
    }
    await manual(modal);
    assert.equal((await modal.textContent()).includes(secret), false, 'Raw transport errors must not be displayed');
    assert.equal((await reads(page)).length, options.offline || options.blocker === 'preview' ? 0 : 1);
    await noMutation(page);
  });

  for (const managed of [false, true]) await run(`${managed ? 'provider-qualified' : 'legacy'} model: consent, fresh read, one command and correct chat owner`, { multi: true, owner: B, managed }, async page => {
    assert.equal(await page.locator('.main-shell').getAttribute('data-owner-id'), A, 'Settings navigation does not change the selected chat owner');
    const modal = await investigate(page);
    assert.match(await modal.getByRole('region', { name: 'Agent investigation' }).innerText(), /Full control.*without individual approvals/);
    await approve(modal, managed);
    // A changed model requires renewed sharing consent.
    await modelSelect(modal).selectOption(managed ? JSON.stringify([modelRef.providerId, 'default-model']) : models[0]);
    assert.equal(await consent(modal).isChecked(), false);
    await approve(modal, managed);
    await page.evaluate(B => { window.__holdRead = B; window.__holdCommand = B; }, B);
    // Same-turn clicks exercise the ref guard before React can disable the button.
    await start(modal).evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => !!window.__releaseRead);
    assert.equal((await reads(page)).length, 2, 'Exactly one preflight re-read');
    await noMutation(page);
    await page.evaluate(() => window.__releaseRead());
    await page.waitForFunction(() => !!window.__releaseCommand);
    const sent = await mutations(page);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].command, 'environment_send_command');
    assert.deepEqual(sent[0].args, { kind: 'recovery.investigate', id: sent[0].args.id, revision: 0,
      payload: managed ? { modelRef } : { model: models[1] }, environmentId: B });
    assert.match(sent[0].args.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    await page.keyboard.press('Escape');
    assert.equal(await modal.isVisible(), true, 'An in-flight command cannot be dismissed accidentally');
    await page.evaluate(() => window.__releaseCommand());
    await modal.getByText(/Investigation created with Full control/).waitFor();
    assert.equal(await start(modal).isDisabled(), true);
    await modal.getByRole('button', { name: 'Open investigation', exact: true }).click();
    await page.waitForFunction(({ B, id }) => document.querySelector('.main-shell')?.dataset.ownerId === B &&
      document.querySelector(`.chat-server-group[data-server-id="${B}"] button[data-task-id="${id}"]`)?.getAttribute('aria-current') === 'page', { B, id: sent[0].args.id });
    await modal.waitFor({ state: 'hidden' });
    assert.deepEqual((await requests(page)).filter(request => request.command === 'environment_select').map(request => request.args), [{ environmentId: B }]);
    assert.equal((await mutations(page)).length, 1);
  });

  for (const managed of [false, true]) await run(`no available ${managed ? 'provider' : 'legacy'} model: manual only`, { managed, noModels: true }, async page => {
    const modal = await investigate(page);
    await modal.getByText(/No verified model is selected/).waitFor();
    assert.equal(await consent(modal).isDisabled(), true);
    assert.equal(await start(modal).isDisabled(), true);
    await manual(modal);
    await noMutation(page);
  });

  await run('late recovery hold in preflight prevents the command', {}, async page => {
    const modal = await investigate(page);
    await approve(modal);
    await page.evaluate(value => { window.__states.legacy.report = value; window.__holdRead = 'legacy'; }, report(A, 'held'));
    await start(modal).click();
    await page.waitForFunction(() => !!window.__releaseRead);
    await noMutation(page);
    await page.evaluate(() => window.__releaseRead());
    await modal.getByText('The server cannot start an agent investigation now. Use the findings and manual steps below.', { exact: true }).waitFor();
    assert.equal((await reads(page)).length, 2);
    assert.match(await findings(modal).innerText(), /Recovery explicitly holds dispatch/);
    assert.equal(await start(modal).count(), 0);
    await manual(modal);
    await noMutation(page);
  });

  await run('late previous-owner report cannot replace current findings', { multi: true, owner: A }, async page => {
    await page.evaluate(A => { window.__holdRead = A; }, A);
    const old = await investigate(page, { ready: false });
    await page.waitForFunction(() => !!window.__releaseRead);
    await page.keyboard.press('Escape');
    await old.waitFor({ state: 'hidden' });
    await openSettings(page, { server: B, tab: 'recovery' });
    const current = await investigate(page);
    assert.match(await findings(current).innerText(), new RegExp(B));
    await page.evaluate(() => window.__releaseRead());
    await settle(page);
    assert.match(await findings(current).innerText(), new RegExp(B));
    assert.equal((await findings(current).innerText()).includes(A), false);
    assert.equal(await current.getByRole('alert').count(), 0);
    assert.deepEqual((await reads(page)).map(request => request.args.environmentId), [A, B]);
    await noMutation(page);
  });

  await run('navigation during start-time read cancels the old owner handoff', { multi: true, owner: A }, async page => {
    const old = await investigate(page);
    await approve(old);
    await page.evaluate(A => { window.__holdRead = A; }, A);
    await start(old).click();
    await page.waitForFunction(() => !!window.__releaseRead);
    // Hash navigation models an external route change while the native modal is busy.
    await page.evaluate(B => { window.location.hash = `settings/servers/${B}/recovery`; }, B);
    await old.waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: 'Beta', exact: true }).waitFor();
    const current = await investigate(page);
    await page.evaluate(() => window.__releaseRead());
    await settle(page);
    assert.match(await findings(current).innerText(), new RegExp(B));
    assert.equal(await consent(current).isChecked(), false);
    assert.equal(await current.getByRole('button', { name: 'Open investigation', exact: true }).count(), 0);
    await noMutation(page);
  });

  await run('late command result cannot show a success or open link for another owner', { multi: true, owner: A }, async page => {
    const old = await investigate(page);
    await approve(old);
    await page.evaluate(A => { window.__holdCommand = A; }, A);
    await start(old).click();
    await page.waitForFunction(() => !!window.__releaseCommand);
    await page.evaluate(B => { window.location.hash = `settings/servers/${B}/recovery`; }, B);
    await old.waitFor({ state: 'hidden' });
    await page.getByRole('heading', { name: 'Beta', exact: true }).waitFor();
    const current = await investigate(page);
    await page.evaluate(() => window.__releaseCommand());
    await settle(page);
    assert.match(await findings(current).innerText(), new RegExp(B));
    assert.equal(await current.getByText(/Investigation created/).count(), 0);
    assert.equal(await current.getByRole('button', { name: 'Open investigation', exact: true }).count(), 0);
    assert.equal(await consent(current).isChecked(), false);
    const sent = await mutations(page);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].args.environmentId, A);
    assert.equal(await page.locator('.main-shell').getAttribute('data-owner-id'), A, 'A late result does not select another chat owner');
  });

  await run('failed command is not retried automatically or on diagnostics refresh', { commandFailure: true }, async page => {
    const modal = await investigate(page);
    await approve(modal);
    await start(modal).click();
    await modal.getByText(/Investigation was not confirmed/).waitFor();
    assert.equal((await mutations(page)).length, 1);
    assert.equal(await start(modal).isDisabled(), true);
    assert.equal(await modal.getByRole('button', { name: 'Open investigation', exact: true }).count(), 0);
    // Advance through multiple supervisor polling periods without a wall-clock sleep.
    await page.clock.fastForward(10000);
    await modal.getByRole('button', { name: 'Refresh diagnostics', exact: true }).click();
    await findings(modal).waitFor();
    assert.equal(await start(modal).isDisabled(), true);
    assert.equal((await mutations(page)).length, 1);
    assert.equal((await reads(page)).length, 3);
    await page.clock.resume();
  });
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
console.log(`Recovery investigation: ${passed} passed, ${failures.length} failed.`);
if (failures.length) process.exitCode = 1;
