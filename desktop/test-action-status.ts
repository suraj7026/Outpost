import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';

const entry = `
  import React, { useMemo, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import './src/styles.css';
  import './src/studio.css';
  import TaskView from './src/TaskView';
  import ComposerContext from './src/ComposerContext';
  import ActionReviewDialog from './src/ActionReviewDialog';
  import { ActionDecisions } from './src/TaskAction';
  import { ConversationDetailContext } from './src/conversation-detail';
  import { EnvironmentContext } from './src/EnvironmentContext';
  const row = (kind, id, state, extra = {}) => ({ kind, id, revision: 1, updatedAt: '2026-11-17T12:00:00Z',
    data: { taskId: 'task', state, ...extra } });
  const task = row('task', 'task', 'running', { goal: 'Automatic execution fixture' });
  const automatic = row('action', 'automatic', 'authorized', { tool: 'host.execute', target: 'fixture-host',
    nonce: 'legacy-nonce', actionDigest: 'legacy-digest', arguments: { host: 'fixture-host', command: 'printf fixture' } });
  const initial = [task, row('policy', 'task', '', { mode: 'auto' }), row('action', 'before', 'succeeded'), automatic, row('action', 'after', 'succeeded')];
  const commands = [];
  window.isTauri = true;
  function Harness() {
    const [records, setRecords] = useState(initial), [flags, setFlags] = useState({});
    const [detail, setDetail] = useState('compact'), [snapshot, setSnapshot] = useState(null);
    const action = records.find(record => record.id === 'automatic');
    const api = useMemo(() => ({ environmentId: 'fixture', async query(kind) {
      if (kind === 'workspace.files') return { files: [], truncated: false };
      throw Error('Unexpected query: ' + kind);
    } }), []);
    const connection = { environmentId: 'fixture', api, connected: true, streaming: true, busy: false,
      info: { pending: false }, runtime: { configured: true, model: 'fixture', controlModes: ['full_control', 'auto'], autoPolicyVersion: 1 }, records, setError() {},
      ...flags, async command(kind, id, revision, payload) {
        commands.push({ kind, id, revision, payload });
        if (kind !== 'approval.decide') throw Error('Unexpected command: ' + kind);
        if (window.fixture.unknownReceipt) return undefined;
        const current = records.find(record => record.kind === 'action' && record.id === id);
        const next = { ...current, revision: revision + 1, data: { ...current.data,
          state: payload.decision === 'approve' ? 'authorized' : 'denied' } };
        if (!window.fixture.receiptOnly) setRecords(rows => rows.map(record => record === current ? next : record));
        return next;
      } };
    window.fixture = { commands, setDetail, setFlags, receiptOnly: window.fixture?.receiptOnly ?? false, unknownReceipt: window.fixture?.unknownReceipt ?? false,
      setReview(review, reviewCategory, classification) { setRecords(rows => rows.map(record => record.id === 'automatic' ? { ...record, data: { ...record.data, review, reviewCategory, classification } } : record)); },
      setAction(state, result = {}) { setRecords(rows => rows.map(record => record.id === 'automatic'
        ? { ...record, revision: record.revision + 1, data: { ...record.data, state, result } } : record)); },
      inspect() { setSnapshot(structuredClone(action)); }
    };
    return <EnvironmentContext.Provider value={connection}><ConversationDetailContext.Provider value={detail}>
      <TaskView task={task} ownerLabel="Fixture" connection={connection} contextBar={<ComposerContext environmentNavigation={null} onSettings={() => {}} />} />
      <div data-testid="direct-decisions"><ActionDecisions record={action} connection={connection} /></div>
      {snapshot && <ActionReviewDialog snapshot={snapshot} connection={connection} onClose={() => setSnapshot(null)} />}
    </ConversationDetailContext.Provider></EnvironmentContext.Provider>;
  }
  createRoot(document.getElementById('root')).render(<Harness />);
`;

const engine = process.env.OUTPOST_TEST_BROWSER === 'webkit' ? webkit : chromium;
test(`automatic action UI and legacy pending compatibility (${engine.name()})`, { timeout: 60000 }, async () => {
  // Isolated component fixture: no real server, IPC, dispatch, external assets or network.
  const bundle = await build({ stdin: { contents: entry, resolveDir: import.meta.dirname, sourcefile: 'action-status-fixture.tsx', loader: 'tsx' },
    bundle: true, write: false, outdir: 'memory', format: 'iife', platform: 'browser',
    plugins: [{ name: 'skip-font-assets', setup(build) { build.onLoad({ filter: /\/fonts\.css$/ }, () => ({ contents: '', loader: 'css' })); } }] });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
  const browser = await engine.launch({ headless: true });
  try {
    for (const detail of ['compact', 'extended']) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.setDefaultTimeout(5000);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ contentType: path === '/fixture.js' ? 'text/javascript' : path === '/fixture.css' ? 'text/css' : 'text/html',
          body: path === '/fixture.js' ? js : path === '/fixture.css' ? css : '<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
      });
      await page.goto('http://action-status.test/');
      const action = page.locator('.execution-entry[data-record-id="automatic"]');
      const group = page.locator('.activity-group');
      const dialog = page.getByRole('dialog');
      const setAction = async (state: string, result = {}) => {
        await page.evaluate(({ state, result }) => Reflect.get(window, 'fixture').setAction(state, result), { state, result });
        await page.waitForFunction(state => document.querySelector('.execution-entry[data-record-id="automatic"]')?.getAttribute('data-state') === state, state);
      };
      await action.waitFor();
      await page.evaluate(detail => Reflect.get(window, 'fixture').setDetail(detail), detail);
      await page.waitForFunction(open => document.querySelector<HTMLDetailsElement>('.execution-entry[data-record-id="automatic"]')?.open === open, detail === 'extended');
      assert.equal(await action.locator('.action-state').innerText(), 'Queued');
      assert.equal(await group.getAttribute('data-state'), 'active');
      assert.equal(await group.locator('.activity-group-title').innerText(), 'Working');
      assert.equal(await group.locator('.activity-group-progress').innerText(), '2 of 3 actions complete');
      assert.equal(await page.locator('.composer-run-label').innerText(), 'Queued: Run printf fixture');
      assert.equal(await page.locator('.task-attention-indicator, .review-shortcut, .execution-review').count(), 0);
      assert.equal(await page.getByTestId('direct-decisions').getByRole('button').count(), 0);
      assert.equal(await page.getByRole('button', { name: /^(Review|Approve|Deny|Run approved action)$/ }).count(), 0);
      if (detail === 'compact') await action.locator(':scope > summary').click();
      await action.getByText('Queued for automatic execution.', { exact: true }).waitFor();

      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      const files = page.locator('#workspace-files');
      if (!await files.isVisible()) await page.getByRole('button', { name: 'Toggle file list', exact: true }).click();
      assert.equal(await files.getByText('Proposed actions', { exact: true }).count(), 0);
      assert.deepEqual(await page.evaluate('window.fixture.commands'), []);

      await setAction('pending');
      await page.evaluate('window.fixture.setReview({ reason: "Root access requires review", category: "security_sensitive" })');
      assert.equal(await group.getAttribute('data-state'), 'attention');
      assert.equal(await group.locator('.activity-group-title').innerText(), 'Waiting for approval');
      assert.equal(await page.locator('.task-attention-indicator').innerText(), '1 approval needed');
      assert.equal(await page.getByTestId('direct-decisions').getByRole('button').count(), 2);
      if (!await files.isVisible()) await page.getByRole('button', { name: 'Toggle file list', exact: true }).click();
      await files.getByText('Proposed actions', { exact: true }).waitFor();
      await files.getByRole('button', { name: 'fixture-host', exact: true }).click();
      await dialog.waitFor();
      assert.equal(await dialog.getByRole('heading').innerText(), 'Review the exact action');
      assert.equal(await dialog.locator('.action').evaluate((node: HTMLDetailsElement) => node.open), true);
      assert.deepEqual(JSON.parse(await dialog.locator('.action-body > pre').first().innerText()), { host: 'fixture-host', command: 'printf fixture' });
      await dialog.getByText('Review · security sensitive: Root access requires review', { exact: true }).waitFor();
      assert.match(await dialog.innerText(), /Approval runs this exact action and continues the agent automatically/);
      for (const flags of [{ connected: false }, { busy: true }, { retired: true }, { info: { pending: true } }, { info: { pendingError: 'uncertain' } }]) {
        await page.evaluate(flags => Reflect.get(window, 'fixture').setFlags(flags), flags);
        await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('dialog .action-deny')?.disabled);
        assert.equal(await dialog.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), true);
      }
      await page.evaluate('window.fixture.setFlags({ runtime: {} })');
      assert.equal(await dialog.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), true, 'Cached Auto must not be approved on old servers');
      assert.equal(await dialog.getByRole('button', { name: 'Deny', exact: true }).isEnabled(), true);
      await page.evaluate('window.fixture.setFlags({})');
      await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
      await dialog.getByRole('status').filter({ hasText: 'The action has updated: Queued.' }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: /^(Approve|Deny|Run approved action)$/ }).count(), 0);
      assert.equal(await dialog.getByText(/Approve only/).count(), 0);
      assert.deepEqual(await page.evaluate('window.fixture.commands'), [{ kind: 'approval.decide', id: 'automatic', revision: 2,
        payload: { nonce: 'legacy-nonce', actionDigest: 'legacy-digest', decision: 'approve' } }]);
      await dialog.getByRole('button', { name: 'Close review', exact: true }).click();
      assert.equal(await page.locator('.task-attention-indicator').count(), 0);
      assert.equal(await files.getByText('Proposed actions', { exact: true }).count(), 0);
      assert.equal(await action.getByRole('button', { name: 'Review', exact: true }).count(), 0);
      assert.equal(await page.getByTestId('direct-decisions').getByRole('button').count(), 0);
      await page.getByRole('button', { name: 'Close workspace', exact: true }).click();

      // Even a direct/stale integration entry point cannot offer dispatch for authorized work.
      await page.evaluate('window.fixture.inspect()');
      await dialog.getByRole('heading', { name: 'Action details', exact: true }).waitFor();
      assert.equal(await dialog.locator('.action').evaluate((node: HTMLDetailsElement) => node.open), false);
      await dialog.locator('.action > summary').click();
      await dialog.getByText('Queued for automatic execution.', { exact: true }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: /^(Approve|Deny|Run approved action)$/ }).count(), 0);
      assert.equal(await dialog.getByText(/Approve only/).count(), 0);
      await dialog.getByRole('button', { name: 'Close action details', exact: true }).click();

      await setAction('dispatching');
      assert.equal(await group.getAttribute('data-state'), 'active');
      assert.equal(await action.locator('.action-state').innerText(), 'running');
      await setAction('succeeded');
      assert.equal(await group.getAttribute('data-state'), 'complete');
      for (const [state, result, label] of [
        ['failed', {}, 'Action failed'], ['unknown', {}, 'Action outcome unknown'],
        ['succeeded', { exitCode: 7 }, 'Action failed'],
      ] as const) {
        await setAction(state, result);
        assert.equal(await group.getAttribute('data-state'), 'attention');
        assert.equal(await group.locator('.activity-group-title').innerText(), 'Needs attention');
        assert.equal(await action.getByRole('img', { name: 'Needs review', exact: true }).count(), 1);
        assert.equal(await page.locator('.composer-run-label').innerText(), label);
        assert.equal(await action.getByRole('button', { name: 'Review', exact: true }).count(), 0);
      }
      await setAction('pending');
      await action.getByRole('button', { name: 'Review', exact: true }).click();
      await dialog.getByRole('button', { name: 'Deny', exact: true }).click();
      await dialog.getByRole('status').filter({ hasText: 'The action has updated: denied.' }).waitFor();
      await dialog.getByRole('button', { name: 'Close review', exact: true }).click();
      assert.equal(await group.locator('.activity-group-title').innerText(), 'Needs attention');
      assert.equal(await page.locator('.composer-run-label').innerText(), 'Action denied');
      assert.deepEqual(await page.evaluate('window.fixture.commands.map(command => command.kind)'), ['approval.decide', 'approval.decide']);
      await setAction('pending');
      await page.evaluate('window.fixture.setReview("Unknown script effects", "unknown")');
      await action.getByRole('button', { name: 'Review', exact: true }).click();
      await dialog.getByText('Review · unknown: Unknown script effects', { exact: true }).waitFor();
      await page.evaluate('window.fixture.receiptOnly = true');
      await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
      await dialog.getByRole('status').filter({ hasText: 'The action has updated: Queued.' }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: /^(Approve|Deny|Run approved action)$/ }).count(), 0, 'Synchronous receipt settles review even before live projection');
      assert.deepEqual(await page.evaluate('window.fixture.commands.map(command => command.kind)'), ['approval.decide', 'approval.decide', 'approval.decide']);
      await dialog.getByRole('button', { name: 'Close review', exact: true }).click();
      await page.evaluate('window.fixture.receiptOnly = false; window.fixture.setReview("Auto requires exact approval: financial", undefined, "financial")');
      await action.getByRole('button', { name: 'Review', exact: true }).click();
      await dialog.getByText('Review · financial: Auto requires exact approval: financial', { exact: true }).waitFor();
      await page.evaluate('window.fixture.setReview("Changed reason", "destructive")');
      await dialog.getByRole('status').filter({ hasText: 'The action has updated: pending.' }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Approve', exact: true }).count(), 0, 'Changed review evidence invalidates the snapshot even at the same revision');
      await dialog.getByRole('button', { name: 'Close review', exact: true }).click();
      await action.getByRole('button', { name: 'Review', exact: true }).click();
      await page.evaluate('window.fixture.unknownReceipt = true');
      await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
      await dialog.getByRole('alert').first().waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Approve', exact: true }).isDisabled(), true);
      assert.deepEqual(await page.evaluate('window.fixture.commands.map(command => command.kind)'), ['approval.decide', 'approval.decide', 'approval.decide', 'approval.decide'], 'No dispatch or retry after an unknown receipt');
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
