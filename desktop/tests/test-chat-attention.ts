import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chatAttention } from '../src/chat-attention.ts';
import type { ServerRecord } from '../src/types.ts';

const record = (id: string, state: string, taskId = 'shared-task', kind = 'action', revision = 1): ServerRecord =>
  ({ id, kind, revision, updatedAt: '2026-11-15T10:00:00.000Z', data: { state, taskId } });

test('missing records and tasks produce no attention', () => {
  for (const records of [undefined, [], [record('other', 'pending', 'other-task')]]) {
    assert.deepEqual(chatAttention(records, 'shared-task'), { pending: 0, total: 0, label: '', records: [], first: undefined });
  }
});

test('only legacy pending approvals need attention; authorized actions dispatch automatically', () => {
  const ready = record('ready', 'authorized'), pending = record('pending', 'pending'), second = record('second', 'pending');
  assert.equal(chatAttention([pending], 'shared-task').label, '1 approval needed');
  assert.equal(chatAttention([pending, second], 'shared-task').label, '2 approvals needed');
  assert.deepEqual(chatAttention([ready], 'shared-task'), { pending: 0, total: 0, label: '', records: [], first: undefined });
  const result = chatAttention([ready, pending, second], 'shared-task');
  assert.equal(result.pending, 2);
  assert.equal(result.total, 2);
  assert.equal(result.label, '2 approvals needed');
  assert.deepEqual(result.records, [pending, second]);
  assert.equal(result.first, pending);
});

test('only actionable action states count, never task readiness or other record kinds', () => {
  const records = ['authorized', 'failed', 'succeeded', 'denied', 'dispatching', 'running', 'unknown', 'cancelled'].map(state => record(state, state));
  records.push(record('ready-task', 'verifying', 'shared-task', 'task'), record('waiting-task', 'waiting_for_approval', 'shared-task', 'task'),
    record('pending-message', 'pending', 'shared-task', 'message'), record('other-task', 'pending', 'elsewhere'));
  assert.equal(chatAttention(records, 'shared-task').total, 0);
});

test('duplicate task and action IDs stay isolated by owning connection, including legacy', () => {
  const connections = {
    a: { records: [record('same-action', 'pending')] },
    b: { records: [record('same-action', 'authorized')] },
    legacy: { records: [record('same-action', 'succeeded')] },
  };
  assert.equal(chatAttention(connections.a.records, 'shared-task').label, '1 approval needed');
  assert.equal(chatAttention(connections.b.records, 'shared-task').total, 0);
  assert.equal(chatAttention(connections.legacy.records, 'shared-task').total, 0);
});

test('latest revisions prevent duplicate counts and stale completed approvals without mutating input', () => {
  const pending = record('same', 'pending'), succeeded = record('same', 'succeeded', 'shared-task', 'action', 2);
  const authorized = record('same', 'authorized', 'shared-task', 'action', 2);
  for (const latest of [succeeded, authorized]) {
    for (const records of [[pending, latest], [latest, pending]]) assert.equal(chatAttention(records, 'shared-task').total, 0);
  }
  const input = Object.freeze([pending, pending, record('same', 'authorized', 'shared-task', 'message', 3)]);
  assert.equal(chatAttention(input, 'shared-task').total, 1);
  assert.equal(input.length, 3);
});

test('history indicators, combined filters, cached semantics, updates and control dimensions', { timeout: 60000 }, async () => {
  // In-memory browser fixture: no app server, dist files, IPC, or external network.
  const entry = `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import '../src/styles.css';
    import '../src/studio.css';
    import '../src/settings-workspace.css';
    import { AllChats, SidebarHistory } from '../src/ChatHistory';
    const row = (kind, id, state, taskId = 'shared-task', goal = id) => ({ kind, id, revision: 1, updatedAt: '2026-11-15T10:00:00Z', data: { state, taskId, goal } });
    const initial = {
      a: [row('action', 'ready', 'authorized'), row('action', 'one', 'pending'), row('action', 'two', 'pending'), row('action', 'ignored', 'pending', 'not-listed')],
      b: [row('action', 'one', 'authorized')],
      legacy: [row('action', 'one', 'pending')],
      removed: [row('action', 'one', 'pending')]
    };
    function Harness() {
      const [records, setRecords] = useState(initial), [empty, setEmpty] = useState(false), [missing, setMissing] = useState(false);
      const groups = empty ? [] : [
        { id: 'a', label: 'Studio', connected: true, tasks: [row('task', 'shared-task', 'running', '', 'Release audit'), row('task', 'review', 'verifying', '', 'Review evidence')] },
        { id: 'b', label: 'Build', connected: true, tasks: [row('task', 'shared-task', 'queued', '', 'Build release')] },
        { id: null, label: 'Legacy', connected: false, tasks: [row('task', 'shared-task', 'running', '', 'Legacy release')] },
        { id: 'removed', label: 'Removed', connected: true, archived: true, tasks: [row('task', 'shared-task', 'running', '', 'Archived release')] }
      ].map(group => ({ ...group, lastSync: new Date('2026-11-15T10:00:00Z') }));
      const connections = missing ? undefined : Object.fromEntries(Object.entries(records).map(([id, records]) => [id, { records }]));
      window.fixture = { setEmpty, setMissing, finish() { setRecords({ ...initial, a: initial.a.map(row => ({ ...row, data: { ...row.data, state: 'succeeded' } })) }); } };
      const open = (server, task) => { window.opened = { server, task }; };
      return <><aside className="web-sidebar"><SidebarHistory groups={groups} connections={connections} selectedServer="a" selectedTask="shared-task" search="" open={open} /></aside><AllChats groups={groups} connections={connections} open={open} /></>;
    }
    createRoot(document.getElementById('root')).render(<Harness />);
  `;
  const bundle = await build({ stdin: { contents: entry, resolveDir: import.meta.dirname, sourcefile: 'attention-fixture.tsx', loader: 'tsx' },
    bundle: true, write: false, outdir: 'memory', format: 'iife', platform: 'browser',
    plugins: [{ name: 'skip-font-assets', setup(build) { build.onLoad({ filter: /\/fonts\.css$/ }, () => ({ contents: '', loader: 'css' })); } }] });
  const js = bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ contentType: path === '/fixture.js' ? 'text/javascript' : path === '/fixture.css' ? 'text/css' : 'text/html',
        body: path === '/fixture.js' ? js : path === '/fixture.css' ? css : '<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    });
    await page.goto('http://attention.test/');
    const filter = page.getByRole('button', { name: /^Needs attention/ });
    const rows = page.locator('.workspace-chat');
    await filter.waitFor();
    assert.equal(await filter.innerText(), 'Needs attention\n3');
    assert.equal(await rows.count(), 5);
    const sidebarA = page.locator('.chat-server-group[data-server-id="a"] button[data-task-id="shared-task"]');
    assert.match(await sidebarA.getAttribute('aria-label') ?? '', /2 approvals needed/);
    assert.doesNotMatch(await sidebarA.getAttribute('aria-label') ?? '', /ready to run/);
    assert.equal(await sidebarA.locator('.chat-attention-count b').innerText(), '2');
    assert.equal(await page.locator('.chat-server-group[data-server-id="b"] .chat-attention-count').count(), 0);
    assert.equal(await page.locator('.workspace-chat[data-server-id="b"] .ui-badge').innerText(), 'Queued');
    assert.equal(await page.locator('.workspace-chat[data-server-id="b"]').getAttribute('data-attention'), 'false');
    assert.equal(await page.locator('.workspace-chat[data-task-id="review"] .ui-badge').innerText(), 'Ready for your review');
    for (const owner of ['legacy', 'removed']) {
      assert.equal(await page.locator('.workspace-chat[data-server-id="' + owner + '"] .ui-badge-neutral').innerText(), 'Last known: 1 approval needed');
      assert.match(await page.locator('.chat-server-group[data-server-id="' + owner + '"] button[data-task-id]').getAttribute('aria-label') ?? '', /Last known: 1 approval needed.*cached \/ read-only/);
    }
    const dimensions = await filter.evaluate(button => {
      const style = getComputedStyle(button), icon = button.querySelector('svg')!, count = button.querySelector('b')!;
      const box = button.getBoundingClientRect(), iconBox = icon.getBoundingClientRect(), countBox = count.getBoundingClientRect();
      return { height: box.height, radius: style.borderRadius, font: style.fontSize, icon: iconBox.width, count: countBox.height,
        centered: Math.abs(iconBox.y + iconBox.height / 2 - box.y - box.height / 2) < 1,
        countCentered: Math.abs(countBox.y + countBox.height / 2 - box.y - box.height / 2) < 1 };
    });
    assert.deepEqual(dimensions, { height: 40, radius: '8px', font: '14px', icon: 16, count: 20, centered: true, countCentered: true });
    await filter.focus();
    await page.keyboard.press('Space');
    assert.equal(await filter.getAttribute('aria-pressed'), 'true');
    assert.equal(await rows.count(), 3);
    assert.equal(await page.locator('.workspace-chat[data-server-id="b"]').count(), 0);
    await page.locator('.workspace-toolbar select').selectOption('a');
    assert.equal(await rows.count(), 1);
    assert.match(await filter.innerText(), /1$/);
    await page.getByLabel('Search chats').fill('review');
    await page.getByRole('heading', { name: 'No chats need attention in this view' }).waitFor();
    assert.match(await filter.innerText(), /0$/);
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    assert.equal(await rows.count(), 5);
    assert.equal(await filter.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByLabel('Search chats').inputValue(), '');
    assert.equal(await page.locator('.workspace-toolbar select').inputValue(), 'all');
    await page.getByLabel('Search chats').fill('approval needed');
    assert.equal(await rows.count(), 2);
    await page.getByLabel('Search chats').fill('ready to run');
    await page.getByRole('heading', { name: 'No chats match your search' }).waitFor();
    await page.getByLabel('Search chats').fill('not found');
    await page.getByRole('heading', { name: 'No chats match your search' }).waitFor();
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    await page.locator('.workspace-chat[data-server-id="b"]').click();
    assert.deepEqual(await page.evaluate('window.opened'), { server: 'b', task: 'shared-task' });
    await page.evaluate('window.fixture.finish()');
    await page.waitForFunction('!document.querySelector(\'.chat-server-group[data-server-id="a"] .chat-attention-count\')');
    assert.match(await filter.innerText(), /2$/);
    await page.evaluate('window.fixture.setMissing(true)');
    await page.waitForFunction('document.querySelectorAll(".chat-attention-count").length === 0');
    assert.match(await filter.innerText(), /0$/);
    await filter.click();
    await page.getByRole('heading', { name: 'No chats need attention in this view' }).waitFor();
    await page.evaluate('window.fixture.setEmpty(true)');
    await page.getByRole('heading', { name: 'No conversations loaded yet' }).waitFor();
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    assert.equal(await filter.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
