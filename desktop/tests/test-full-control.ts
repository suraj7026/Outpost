import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

const entry = `
  import React, { useMemo, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import App from '../src/App';
  import { EnvironmentContext } from '../src/EnvironmentContext';
  import '../src/styles.css';
  import '../src/studio.css';
  import '../src/composer.css';
  import '../src/focus.css';
  import '../src/composer-refinement.css';
  import '../src/icon-refinement.css';
  import '../src/neutral-theme.css';
  import '../src/page-consistency.css';
  import '../src/dialog-consistency.css';

  const params = new URL(location.href).searchParams;
  const managed = params.get('models') === 'managed';
  const capability = params.get('capability') ?? 'supported';
  const environmentId = managed ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null;
  const commands = [], opened = [], unexpected = [];
  const row = (kind, id, data) => ({ kind, id, revision: 1, updatedAt: '2026-11-17T12:00:00Z', data });
  const savedTask = row('task', 'saved-task', { goal: 'Saved legacy policy task', state: 'paused', profile: 'code' });
  const savedPolicy = row('policy', savedTask.id, { mode: 'ask_permission' });
  const catalogue = { protocolVersion: 1, piVersion: 'fixture', profilePath: '/synthetic/profile', generation: 'fixture',
    providers: [], refreshedAt: null, refreshErrors: [], capabilities: { providerPackages: false, callbackRelay: false },
    defaultModel: { providerId: 'fixture-default', modelId: 'default-model' },
    models: [
      { providerId: 'fixture-default', modelId: 'default-model', name: 'Default fixture model', reasoning: false },
      { providerId: 'fixture-selected', modelId: 'selected-model', name: 'Selected fixture model', reasoning: false }
    ] };
  const unexpectedCall = (kind) => { unexpected.push(kind); throw Error('Unexpected fixture operation: ' + kind); };
  const noop = () => {};
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    async invoke(command) {
      if (command === 'plugin:window|set_theme' || command === 'set_sidebar_window_controls') return;
      if (command === 'sidebar_pointer_inside') return false;
      return unexpectedCall(command);
    }
  };
  function Harness() {
    const [records, setRecords] = useState([savedTask, savedPolicy]);
    const [taskId, setTaskId] = useState(null);
    const [flags, setFlags] = useState({});
    const [runtime, setRuntime] = useState({ configured: true, piManagement: managed, model: 'default:cloud',
      ...(capability === 'old' ? {} : { controlModes: ['full_control', 'auto'], autoPolicyVersion: capability === 'future' ? 2 : 1 }) });
    const api = useMemo(() => ({ environmentId, query: unexpectedCall, call: unexpectedCall }), []);
    const connection = { environmentId, api, records, connected: true, streaming: true, busy: false, retired: false,
      connecting: false, error: '', info: { endpoint: 'Synthetic connection', deviceId: 'fixture', pending: false, nativeSidebar: false },
      runtime, ...flags,
      models: ['default:cloud', 'selected:cloud'], agentCatalogue: managed ? catalogue : null, setError: noop,
      async command(kind, id, revision, payload) {
        commands.push({ environmentId, kind, id, revision, payload });
        if (kind === 'policy.change') {
          const policy = records.find(row => row.kind === 'policy' && row.id === id);
          const next = { ...policy, revision: revision + 1, data: { mode: payload.mode } };
          setRecords(current => current.map(row => row === policy ? next : row));
          return next;
        }
        if (kind === 'task.pause') {
          const next = { ...records.find(row => row.kind === 'task' && row.id === id), revision: revision + 1 };
          next.data = { ...next.data, state: 'paused' };
          setRecords(current => current.map(row => row.kind === 'task' && row.id === id ? next : row));
          return next;
        }
        if (kind !== 'task.create') return unexpectedCall(kind);
        const task = row('task', id, { ...payload, state: 'queued' });
        setRecords(current => [...current, task, row('policy', id, { mode: payload.mode })]);
        return task;
      }
    };
    const openChat = (owner, id) => { opened.push({ environmentId: owner, id }); setTaskId(id); };
    const groups = [{ id: environmentId, label: 'Fixture server', connected: true, lastSync: new Date(),
      tasks: records.filter(record => record.kind === 'task') }];
    window.fixture = { commands, opened, unexpected, records, setRuntime, setFlags,
      setTaskState(state) { setRecords(current => current.map(row => row.kind === 'task' && row.id === 'saved-task' ? { ...row, revision: row.revision + 1, data: { ...row.data, state } } : row)); },
      setEffect(state) { setRecords(current => [...current.filter(row => row.id !== 'active-effect'), row('action', 'active-effect', { taskId: 'saved-task', state, tool: 'fixture' })]); }
    };
    return <EnvironmentContext.Provider value={connection}>
      <App connection={connection} draftConnection={connection} initialTask={taskId} initialPage="home"
        onWorkingLocation={noop} environmentNavigation={<span>Fixture server</span>} newTaskNavigation={<span>Fixture server</span>}
        draftLabel="Fixture server" ownerLabel="Fixture server" groups={groups} connections={{ [environmentId ?? 'legacy']: connection }}
        renderSettings={() => null} sharedMemory={null} openChat={openChat} showHistory={noop} history={null} dismissHistory={noop} />
    </EnvironmentContext.Provider>;
  }
  createRoot(document.getElementById('root')).render(<Harness />);
`;

const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
test(`App control modes and fail-closed capability handling (${engine.name()})`, { timeout: 60000 }, async t => {
  // Real App and model pickers, synthetic Connection props; no app server, dist, remote requests or task execution.
  const bundle = await build({ stdin: { contents: entry, resolveDir: import.meta.dirname, sourcefile: 'full-control-fixture.tsx', loader: 'tsx' },
    bundle: true, write: false, outdir: 'memory', format: 'iife', platform: 'browser',
    plugins: [{ name: 'skip-font-assets', setup(build) { build.onLoad({ filter: /\/fonts\.css$/ }, () => ({ contents: '', loader: 'css' })); } }] });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
  const browser = await engine.launch({ headless: true });
  try {
    for (const models of ['legacy', 'managed']) for (const selectedMode of ['full_control', 'auto']) for (const capability of ['supported', 'old', 'future']) await t.test(`${models} ${selectedMode} ${capability}`, async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(5000);
      const errors: string[] = [], remote: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const modeControl = () => page.getByRole('combobox', { name: /control mode/i });
      const twoModeControls = async () => {
        assert.equal(await modeControl().count(), 1);
        assert.deepEqual(await modeControl().locator('option').allTextContents(), ['Full control', 'Auto']);
        assert.equal(await modeControl().locator('option[value="auto"]').evaluate((option: HTMLOptionElement) => option.disabled), capability !== 'supported');
      };
      try {
        await page.route('**/*', route => {
          const url = new URL(route.request().url());
          if (url.origin !== 'https://full-control.test') { remote.push(url.href); return route.abort(); }
          const file = url.pathname;
          if (file === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: js });
          if (file === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: css });
          if (file !== '/') return route.fulfill({ status: 404, body: '' });
          return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
        });
        await page.goto(`https://full-control.test/?models=${models}&capability=${capability}`);
        const goal = page.getByRole('textbox', { name: 'Task goal', exact: true });
        await goal.waitFor();
        await twoModeControls();
        assert.equal(await modeControl().inputValue(), 'full_control');
        assert.equal(await page.getByRole('button', { name: 'Start task', exact: true }).isDisabled(), true);
        assert.deepEqual(await page.evaluate('window.fixture.commands'), []);

        if (models === 'legacy') {
          const picker = page.getByRole('combobox', { name: 'Ollama model', exact: true });
          assert.equal(await picker.inputValue(), 'default:cloud');
          await picker.selectOption('selected:cloud');
        } else {
          assert.equal(await page.getByRole('combobox', { name: 'Ollama model', exact: true }).count(), 0);
          await page.locator('.new-work .model-picker-trigger').click();
          const dialog = page.getByRole('dialog', { name: 'Model for the next instruction', exact: true });
          await dialog.getByRole('button', { name: /Selected fixture model/ }).click();
          await dialog.waitFor({ state: 'hidden' });
        }
        await twoModeControls();
        assert.deepEqual(await page.evaluate('window.fixture.commands'), [], 'Model selection is local, not a policy mutation');
        const sentMode = capability === 'supported' ? selectedMode : 'full_control';
        if (sentMode === 'auto') await modeControl().selectOption('auto');
        else if (capability !== 'supported') {
          await modeControl().evaluate((select: HTMLSelectElement) => { select.value = 'auto'; select.dispatchEvent(new Event('change', { bubbles: true })); });
          assert.equal(await modeControl().inputValue(), 'full_control', 'Unsupported selection cannot opt into Auto');
        }
        await goal.fill('  Create a synthetic task  ');
        if (sentMode === 'auto') {
          await page.evaluate('window.fixture.setRuntime(runtime => { const { controlModes, autoPolicyVersion, ...old } = runtime; return old; })');
          await settle();
          assert.equal(await modeControl().inputValue(), 'auto', 'Capability loss never silently downgrades the draft');
          assert.equal(await page.getByRole('button', { name: 'Start task', exact: true }).isDisabled(), true);
          await goal.press('Meta+Enter');
          assert.deepEqual(await page.evaluate('window.fixture.commands'), []);
          await page.evaluate('window.fixture.setRuntime(runtime => ({ ...runtime, controlModes: ["full_control", "auto"], autoPolicyVersion: 1 }))');
          await settle();
        }
        if (models === 'legacy') await page.getByRole('button', { name: 'Start task', exact: true }).click();
        else await goal.press('Meta+Enter');
        await page.getByRole('textbox', { name: 'Message Outpost', exact: true }).waitFor();
        const commands = await page.evaluate('window.fixture.commands');
        assert.equal(commands.length, 1);
        const command = commands[0];
        assert.match(command.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        assert.deepEqual(command, { environmentId: models === 'managed' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : null,
          kind: 'task.create', id: command.id, revision: 0, payload: {
            goal: 'Create a synthetic task', profile: 'code', mode: sentMode,
            ...(models === 'managed' ? { modelRef: { providerId: 'fixture-selected', modelId: 'selected-model' } } : { model: 'selected:cloud' }),
          } });
        assert.deepEqual(await page.evaluate('window.fixture.opened'), [{ environmentId: command.environmentId, id: command.id }]);
        await twoModeControls();
        assert.equal(await modeControl().inputValue(), sentMode);
        assert.equal(await modeControl().isDisabled(), true, 'Queued task is active');
        for (const width of [900, 390, 1440]) {
          await page.setViewportSize({ width, height: 1000 }); await settle();
          const layout = await page.locator('.composer-toolbar').evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth, items: [...node.children].map(item => ({ className: item.className, width: item.getBoundingClientRect().width })) }));
          assert.ok(layout.scroll <= layout.client + 1, 'Shared mode control fits the composer at ' + width + ': ' + JSON.stringify(layout));
        }

        await page.locator('.chat-server-group button[data-task-id="saved-task"]').click();
        await page.locator('.task-view').getByRole('heading', { name: 'Saved legacy policy task', exact: true }).waitFor();
        await twoModeControls();
        assert.equal(await modeControl().inputValue(), 'auto');
        assert.equal(await page.getByRole('button', { name: 'Resume task', exact: true }).isEnabled(), capability === 'supported');
        if (capability !== 'supported') {
          await page.getByRole('status').filter({ hasText: 'Auto needs a compatible server update' }).waitFor();
          await page.getByRole('textbox', { name: 'Message Outpost', exact: true }).fill('Do not execute on an older server');
          assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
          await page.getByRole('textbox', { name: 'Message Outpost', exact: true }).press('Meta+Enter');
        }
        assert.equal(await page.evaluate('window.fixture.records.find(record => record.kind === "policy" && record.id === "saved-task").data.mode'), 'ask_permission', 'The fixture retains its actual legacy policy');
        assert.deepEqual(await page.evaluate('window.fixture.commands'), commands, 'Opening a saved legacy policy does not mutate policy or dispatch work');
        for (const flags of [{ connected: false }, { busy: true }, { retired: true }, { info: { pending: true } }, { info: { pendingError: 'unknown' } }]) {
          await page.evaluate(flags => Reflect.get(window, 'fixture').setFlags(flags), flags);
          await settle();
          assert.equal(await modeControl().isDisabled(), true);
        }
        await page.evaluate('window.fixture.setFlags({})');
        await settle();
        await modeControl().selectOption('full_control');
        await page.waitForFunction(() => Reflect.get(window, 'fixture').commands.length === 2);
        assert.deepEqual((await page.evaluate('window.fixture.commands'))[1], { environmentId: command.environmentId, kind: 'policy.change', id: 'saved-task', revision: 1, payload: { mode: 'full_control' } });
        if (capability === 'supported') {
          await modeControl().selectOption('auto');
          await page.waitForFunction(() => Reflect.get(window, 'fixture').commands.length === 3);
          assert.deepEqual((await page.evaluate('window.fixture.commands'))[2], { environmentId: command.environmentId, kind: 'policy.change', id: 'saved-task', revision: 2, payload: { mode: 'auto' } });
        }
        for (const state of ['running', 'waiting_for_approval', 'waiting_for_login', 'waiting_for_human', 'waiting_for_payment_auth']) {
          await page.evaluate(state => Reflect.get(window, 'fixture').setTaskState(state), state);
          await settle();
          assert.equal(await modeControl().isDisabled(), true, state);
          await page.getByRole('status').filter({ hasText: 'Pause the task, then change control mode' }).waitFor();
        }
        await page.getByRole('button', { name: 'Pause task', exact: true }).click();
        await page.getByRole('button', { name: 'Resume task', exact: true }).waitFor();
        assert.equal(await modeControl().isEnabled(), true);
        await page.evaluate('window.fixture.setEffect("dispatching")');
        await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[aria-label="Task control mode"]')?.disabled);
        assert.equal(await modeControl().isDisabled(), true, 'An effect is still active after Pause');
        await page.evaluate('window.fixture.setEffect("succeeded")');
        await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>('[aria-label="Task control mode"]')?.disabled);
        assert.equal(await modeControl().isEnabled(), true);
        assert.deepEqual(await page.evaluate('window.fixture.unexpected'), []);
        assert.deepEqual(remote, []);
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    });
  } finally {
    await browser.close();
  }
});
