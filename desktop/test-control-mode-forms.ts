import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, webkit, type Page } from 'playwright';

const entry = `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import Automations from './src/Automations';
  import RecoveryInvestigation from './src/RecoveryInvestigation';
  import './src/styles.css';
  import './src/studio.css';
  import './src/anchor-menu/anchor-menu.css';
  const params = new URL(location.href).searchParams;
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const commands = [], queries = [];
  const row = (kind, id, data) => ({ kind, id, revision: 3, updatedAt: '2026-11-17T12:00:00Z', data });
  const saved = row('automation', 'saved', { name: 'Saved Auto schedule', timezone: 'UTC', nextAt: Date.now() + 86400000,
    intervalMs: 86400000, missed: 'coalesce', paused: true, task: { goal: 'Review dependencies', profile: 'code', mode: 'ask_permission' } });
  const report = { schemaVersion: 1, environmentId: owner, collectedAt: '2026-11-17T12:00:00Z', release: 'fixture', platform: 'linux', architecture: 'arm64',
    recovery: { state: 'missing', revision: null }, dispatchEnabled: true, maintenance: { state: 'idle', holding: false },
    runtime: { configured: true, hostAdministration: false, hosts: [] }, work: { queuedTasks: 0, unknownActions: 0, unknownOperations: 0, unknownOutbox: 0 },
    findings: [], agent: { available: true, reason: null } };
  window.isTauri = true;
  function Harness() {
    const [records, setRecords] = useState([saved, row('device', 'self', { revoked: false })]);
    const [runtime, setRuntime] = useState({ configured: true, model: 'fixture:cloud', piManagement: params.get('models') === 'managed',
      ...(params.get('capability') === 'old' ? {} : { controlModes: ['full_control', 'auto'], autoPolicyVersion: 1 }) });
    const [flags, setFlags] = useState({});
    const connection = { environmentId: owner, connected: true, busy: false, retired: false, error: '', info: { pending: false, deviceId: 'self' },
      runtime, records, models: ['fixture:cloud'], agentCatalogue: { defaultModel: { providerId: 'fixture', modelId: 'managed' },
        models: [{ providerId: 'fixture', modelId: 'managed', name: 'Managed model' }] }, ...flags,
      api: { async query(kind) { queries.push(kind); if (kind !== 'recovery.diagnostics') throw Error(kind); return report; } },
      async command(kind, id, revision, payload) {
        commands.push({ kind, id, revision, payload });
        if (params.get('receipt') === 'unknown') return undefined;
        if (kind === 'automation.save') {
          const next = { ...row('automation', id, payload), revision: revision + 1 };
          setRecords(rows => [...rows.filter(row => row.id !== id), next]); return next;
        }
        if (kind === 'recovery.investigate') return row('task', id, { goal: 'Investigate recovery', state: 'queued' });
        throw Error(kind);
      } };
    window.fixture = { commands, queries, setRuntime, setFlags, saved,
      stale() { setRecords(rows => rows.map(row => row.id === 'saved' ? { ...row, revision: row.revision + 1 } : row)); } };
    return params.get('screen') === 'recovery' ? <RecoveryInvestigation connection={connection} onClose={() => {}} />
      : <Automations groups={[{ id: owner, label: 'Fixture server', connected: true }]} connections={{ [owner]: connection }} />;
  }
  createRoot(document.getElementById('root')).render(<Harness />);
`;
const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;

test(`schedule and recovery mode forms (${engine.name()})`, { timeout: 120000 }, async t => {
  const bundle = await build({ stdin: { contents: entry, resolveDir: import.meta.dirname, sourcefile: 'mode-forms-fixture.tsx', loader: 'tsx' },
    bundle: true, write: false, outdir: 'memory', format: 'iife', platform: 'browser',
    plugins: [{ name: 'skip-font-assets', setup(build) { build.onLoad({ filter: /\/fonts\.css$/ }, () => ({ contents: '', loader: 'css' })); } }] });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
  const browser = await engine.launch({ headless: true });
  const errors: string[] = [];
  async function open(query: string, styles = '/fixture.css') {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'https://mode-forms.test') { errors.push(url.href); return route.abort(); }
      return route.fulfill({ contentType: url.pathname === '/fixture.js' ? 'text/javascript' : url.pathname === '/fixture.css' ? 'text/css' : 'text/html',
        body: url.pathname === '/fixture.js' ? js : url.pathname === '/fixture.css' ? css : '<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    });
    await page.goto('https://mode-forms.test/?' + query); return page;
  }
  const commands = (page: Page) => page.evaluate('window.fixture.commands');
  const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const choose = async (page: Page, name: string, mode: string) => {
    const trigger = page.getByRole('button', { name, exact: true });
    await trigger.click();
    const menu = page.getByRole('dialog', { name: 'Control mode', exact: true });
    await menu.getByRole('option', { name: mode === 'auto' ? /^Auto/ : /Full control/ }).click();
    await menu.waitFor({ state: 'hidden' });
  };
  try {
    for (const mode of ['full_control', 'auto']) await t.test(`new schedule exact ${mode} payload`, async () => {
      const page = await open('screen=schedule');
      try {
        await page.getByRole('button', { name: 'New schedule', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await choose(page, 'Schedule control mode', mode);
        await dialog.getByLabel('Schedule name', { exact: true }).fill('  New audit  ');
        await dialog.getByLabel('What should it do?', { exact: true }).fill('  Audit dependencies  ');
        const nextAt = new Date(await dialog.locator('input[type="datetime-local"]').inputValue()).getTime();
        const timezone = await dialog.getByRole('combobox', { name: 'Display time zone', exact: true }).inputValue();
        await dialog.getByRole('button', { name: 'Create schedule', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        const calls = await commands(page); assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], { kind: 'automation.save', id: calls[0].id, revision: 0,
          payload: { name: 'New audit', timezone, nextAt, intervalMs: null, missed: 'coalesce', paused: false, task: { goal: 'Audit dependencies', profile: 'code', mode } } });
      } finally { await page.close(); }
    });
    for (const capability of ['supported', 'old']) await t.test(`saved legacy schedule ${capability}`, async () => {
      const page = await open('screen=schedule&capability=' + capability);
      try {
        const item = page.locator('.workspace-item');
        assert.match(await item.innerText(), / · Auto/);
        if (capability === 'old') assert.equal(await item.getByRole('button', { name: 'Resume', exact: true }).isDisabled(), true);
        await item.getByRole('button', { name: 'Edit', exact: true }).click();
        const dialog = page.getByRole('dialog');
        const label = dialog.getByRole('button', { name: 'Schedule control mode' });
        if (capability === 'old') {
          const save = dialog.getByRole('button', { name: 'Save changes', exact: true });
          assert.equal(await save.isDisabled(), true);
          assert.match(await dialog.innerText(), /safety policy is not verified/);
          assert.deepEqual(await commands(page), []);
          await choose(page, 'Schedule control mode', 'full_control');
        }
        await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
        const calls = await commands(page), saved = await page.evaluate('window.fixture.saved');
        assert.deepEqual(calls, [{ kind: 'automation.save', id: 'saved', revision: 3,
          payload: { ...saved.data, task: { ...saved.data.task, mode: capability === 'old' ? 'full_control' : 'auto' } } }]);
      } finally { await page.close(); }
    });
    await t.test('schedule capability loss, stale revision and authority guards', async () => {
      const page = await open('screen=schedule');
      try {
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        const save = page.getByRole('button', { name: 'Save changes', exact: true });
        for (const flags of [{ connected: false }, { busy: true }, { retired: true }, { info: { pending: true } }, { info: { pendingError: 'uncertain' } }]) {
          await page.evaluate(flags => Reflect.get(window, 'fixture').setFlags(flags), flags);
          await settle(page);
          assert.equal(await save.isDisabled(), true);
        }
        await page.evaluate('window.fixture.setFlags({}); window.fixture.setRuntime({})');
        await settle(page);
        assert.equal(await save.isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: 'Schedule control mode' }).getAttribute('data-mode'), 'auto');
        await choose(page, 'Schedule control mode', 'full_control');
        // The blocked Auto policy persists until the user picks Full control.
        await page.evaluate('window.fixture.stale()');
        await settle(page);
        assert.equal(await save.isDisabled(), true); assert.deepEqual(await commands(page), []);
      } finally { await page.close(); }
    });
    for (const models of ['legacy', 'managed']) for (const capability of ['supported', 'old']) for (const mode of capability === 'old' ? ['full_control'] : ['full_control', 'auto']) {
      await t.test(`recovery ${models} ${capability} ${mode} exact payload`, async () => {
        const page = await open('screen=recovery&models=' + models + '&capability=' + capability);
        try {
          const label = page.getByRole('button', { name: 'Investigation control mode' });
          await label.waitFor();
          const supported = capability !== 'old';
          if (supported) {
            await label.click();
            const menu = page.getByRole('dialog', { name: 'Control mode', exact: true });
            assert.equal(await menu.getByRole('option', { name: /^Auto/ }).isDisabled(), false);
            await menu.getByRole('option', { name: /^Auto/ }).click();
            await menu.waitFor({ state: 'hidden' });
          }
          if (mode === 'full_control') await choose(page, 'Investigation control mode', 'full_control');
          await page.getByRole('checkbox', { name: /Send a fresh diagnostic summary/ }).check();
          await page.getByRole('button', { name: 'Start agent investigation', exact: true }).click();
          await page.getByRole('status').filter({ hasText: 'Investigation created' }).waitFor();
          const calls = await commands(page); assert.equal(calls.length, 1);
          assert.deepEqual(calls[0], { kind: 'recovery.investigate', id: calls[0].id, revision: 0,
            payload: { ...(models === 'managed' ? { modelRef: { providerId: 'fixture', modelId: 'managed' } } : { model: 'fixture:cloud' }), ...(capability === 'supported' ? { mode } : {}) } });
          assert.deepEqual(await page.evaluate('window.fixture.queries'), ['recovery.diagnostics', 'recovery.diagnostics']);
        } finally { await page.close(); }
      });
    }
    await t.test('recovery capability loss blocks Auto without downgrading it', async () => {
      const page = await open('screen=recovery');
      try {
        await choose(page, 'Investigation control mode', 'auto');
        await page.getByRole('checkbox', { name: /Send a fresh diagnostic summary/ }).check();
        await page.evaluate('window.fixture.setRuntime({ configured: true, model: "fixture:cloud" })');
        await settle(page);
        assert.equal(await page.getByRole('button', { name: 'Investigation control mode' }).getAttribute('data-mode'), 'auto');
        assert.equal(await page.getByRole('button', { name: 'Start agent investigation', exact: true }).isDisabled(), true);
        assert.deepEqual(await commands(page), []);
      } finally { await page.close(); }
    });
    await t.test('unknown recovery receipt is not automatically retried', async () => {
      const page = await open('screen=recovery&receipt=unknown');
      try {
        await page.getByRole('checkbox', { name: /Send a fresh diagnostic summary/ }).check();
        await page.getByRole('button', { name: 'Start agent investigation', exact: true }).click();
        await page.getByRole('status').filter({ hasText: 'Investigation was not confirmed' }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Start agent investigation', exact: true }).isDisabled(), true);
        assert.equal((await commands(page)).length, 1);
      } finally { await page.close(); }
    });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
