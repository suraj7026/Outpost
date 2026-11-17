import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Synthetic React DOM harness only: in-memory bundle, no Vite/dist, IPC, credentials or remote access.
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './src/styles.css';
import './src/studio.css';
import Automations from './src/Automations';
import WorkspaceView from './src/WorkspaceViews';
import ActionReviewDialog from './src/ActionReviewDialog';
import SharedMemory, { useSharedMemory } from './src/SharedMemory';
import { AllChats } from './src/ChatHistory';
window.isTauri = true;
const row = (kind, id, data, revision = 1) => ({ kind, id, data, revision, updatedAt: '2026-11-15T10:00:00.000Z' });
const base = { name: 'Audit packages', timezone: 'Europe/London', nextAt: Date.now() + 86400000, intervalMs: 86400000, missed: 'coalesce', paused: false, task: { goal: 'Inspect package versions', profile: 'code', mode: 'ask_permission' } };
const calls = [], opened = [];
const initialRows = [row('automation', 'schedule-a', base), row('task', 'uuid-do-not-display', { goal: 'Review release notes', state: 'completed' }), row('message', 'message-1', { taskId: 'uuid-do-not-display', author: 'owner', text: 'Fixture message' }), row('message', 'message-2', { taskId: 'uuid-do-not-display', author: 'assistant', text: 'Fixture reply' }), row('message', 'unrelated-message', { taskId: 'other-task', text: 'Not counted' }), row('action', 'action-a', { state: 'pending', tool: 'command.run', nonce: 'fixture-nonce', actionDigest: 'fixture-digest', target: 'Synthetic workspace', effects: ['execute workspace command'], arguments: { argv: ['echo', 'fixture-only'] } })];
function ReplicaHarness() {
 const [online, setOnline] = useState(false);
 const [copies, setCopies] = useState({ a: [{ ...row('memory', 'replica-note', { shared: true, confirmed: true, forgotten: false, text: 'Old shared text' }), updatedAt: '2030-01-01T00:00:00Z' }], b: [row('memory', 'replica-note', { shared: true, confirmed: true, forgotten: true, text: '' })] });
 const [syncCalls, setSyncCalls] = useState([]);
 const groups = ['a','b'].map(id => ({ id, label: id, connected: id === 'a' || online, lastSync: new Date(), tasks: [] }));
 const connections = Object.fromEntries(groups.map(group => [group.id, { connected: group.connected, retired: false, busy: false, info: { pending: false }, runtime: { sharedMemory: true }, records: copies[group.id], command: async (kind, id, revision, payload) => {
   setSyncCalls(current => [...current, { server: group.id, kind, id, revision, payload }]);
   const result = row('memory', id, { shared: true, confirmed: true, forgotten: payload.text === null, text: payload.text ?? '' });
   setCopies(current => ({ ...current, [group.id]: [result] })); return result;
 } }]));
 const memory = useSharedMemory(groups, connections);
 window.replicaFixture = { setOnline, syncCalls, notes: memory.notes };
 return <SharedMemory memory={memory} />;
}
function Harness() {
 const [rows, setRows] = useState(initialRows), [view, setView] = useState('automations'), [flags, setFlags] = useState({}), [notes, setNotes] = useState([]), [failNote, setFailNote] = useState(false);
 const [offlineB, setOfflineB] = useState(false), [archivedA, setArchivedA] = useState(false), [counts, setCounts] = useState(true), [serverNotesB, setServerNotesB] = useState([]);
 const [review, setReview] = useState(null);
 const saveNote = (payload) => row('memory', 'server-generated-' + calls.length, { ...payload, confirmed: true, forgotten: false });
 const command = async (kind, id, revision, payload = {}) => {
   calls.push({ server: 'a', kind, id, revision, payload });
   if (window.fixture.hold) await new Promise(resolve => { window.fixture.release = resolve; });
   const old = rows.find(row => row.kind === 'automation' && row.id === id);
   if (kind === 'automation.save') {
     if ((old?.revision ?? 0) !== revision) throw Error('fixture revision conflict');
     const result = row('automation', id, payload, revision + 1);
     setRows(current => [...current.filter(row => row.kind !== 'automation' || row.id !== id), result]);
     return result;
   }
   if (kind === 'memory.save') { if (window.fixture.failServerNote) return undefined; const result = saveNote(payload); setRows(current => [...current, result]); return result; }
   if (kind === 'action.dispatch' || kind === 'approval.decide') {
     const action = rows.find(row => row.kind === 'action' && row.id === id);
     if (!action || action.revision !== revision) throw Error('fixture action revision conflict');
     const state = kind === 'action.dispatch' ? 'dispatching' : payload.decision === 'approve' ? 'authorized' : 'denied';
     const result = row('action', id, { ...action.data, state }, revision + 1);
     setRows(current => current.map(row => row.kind === 'action' && row.id === id ? result : row));
     return result;
   }
   throw Error('Unexpected synthetic command: ' + kind);
 };
 const connection = { environmentId: 'a', records: rows, connected: true, retired: false, busy: false, info: { pending: false }, error: '', runtime: { configured: true, piManagement: true, sharedMemory: true }, models: [], agentCatalogue: { models: [{ providerId: 'fixture', modelId: 'fixture-model', name: 'Fixture model' }] }, command, ...flags };
 const connectionB = { ...connection, environmentId: 'b', connected: !offlineB, records: serverNotesB, command: async (kind, id, revision, payload) => { calls.push({ server: 'b', kind, id, revision, payload }); if (kind !== 'memory.save') throw Error('Unexpected B command'); const result = saveNote(payload); setServerNotesB(current => [...current, result]); return result; } };
 const groups = [{ id: 'a', label: 'Studio', archived: archivedA, connected: connection.connected, lastSync: new Date(), tasks: rows.filter(row => row.kind === 'task') }, { id: 'b', label: 'Build server', connected: !offlineB, lastSync: new Date(), tasks: [row('task', 'other-uuid', { goal: 'Check deployment evidence', state: 'paused' })] }];
 const memory = { enabled: true, ready: !connection.busy && connection.connected && !connection.info?.pending && !connection.info?.pendingError, replicas: [{ id: 'a', label: 'Studio', connection }], notes, failed: false, retry() {}, save: async (id, text) => { calls.push({ kind: 'memory.shared', id, text }); if (failNote) return false; setNotes(current => [...current.filter(note => note.id !== id), { id, text, updatedAt: new Date().toISOString(), copies: new Map([['a', text]]) }]); return true; } };
 window.fixture = { ...window.fixture, calls, opened, setView, setFlags, setFailNote, setOfflineB, setArchivedA, setCounts,
    bumpAction() { setRows(current => current.map(row => row.kind === 'action' ? { ...row, revision: row.revision + 1, data: { ...row.data, target: 'Changed target', nonce: 'new-nonce', actionDigest: 'new-digest' } } : row)); },
    authorizeAction() { setRows(current => current.map(row => row.kind === 'action' ? { ...row, revision: row.revision + 1, data: { ...row.data, state: 'authorized' } } : row)); },
    restoreAction() { setRows(current => [...current.filter(row => row.kind !== 'action'), initialRows.find(row => row.kind === 'action')]); },
   bump() { setRows(current => current.map(row => row.kind === 'automation' ? { ...row, revision: row.revision + 1 } : row)); },
   unsupported() { setRows(current => [...current, row('automation', 'unsupported', { title: 'Old record', cron: 'never' })]); },
   preview(value) { window.__OUTPOST_RECORDED_PREVIEW__ = value ? {} : undefined; setFlags(current => ({ ...current })); },
   native(value) { window.isTauri = value; setFlags(current => ({ ...current })); },
   emptyActions() { setRows(current => current.filter(row => row.kind !== 'action')); }
 };
 const shared = <SharedMemory memory={memory} />;
 return <><nav>{['automations','memory','chats','review','replicas'].map(name => <button key={name} onClick={() => setView(name)}>{name}</button>)}</nav>{view === 'replicas' ? <ReplicaHarness /> : view === 'automations' ? <Automations groups={groups} connections={{ a: connection }} /> : view === 'chats' ? <AllChats groups={groups} connections={counts ? { a: connection } : undefined} open={(server, task) => opened.push({ server, task })} /> : view === 'review' ? <main><button onClick={() => setReview(rows.find(row => row.kind === 'action' && row.id === 'action-a'))}>Review this action</button>{review && <ActionReviewDialog snapshot={review} connection={connection} onClose={() => setReview(null)} />}</main> : <WorkspaceView section={view} groups={groups} connections={{ a: connection, b: connectionB }} sharedMemory={shared} />}</>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;
const result = await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'workspace-synthetic.tsx', loader: 'tsx' }, bundle: true, write: false, outdir: 'memory', format: 'iife', platform: 'browser',
  plugins: [{ name: 'skip-synthetic-font-assets', setup(build) { build.onLoad({ filter: /\/fonts\.css$/ }, () => ({ contents: '', loader: 'css' })); } }] });
const script = result.outputFiles.find(file => file.path.endsWith('.js')).contents;
const stylesheet = result.outputFiles.find(file => file.path.endsWith('.css')).contents;
const server = createServer((request, response) => {
  if (request.url === '/fixture.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(script); }
  else if (request.url === '/fixture.css') { response.setHeader('Content-Type', 'text/css'); response.end(stylesheet); }
  else if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>'); }
  else { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.goto(origin);
  const button = name => page.getByRole('button', { name, exact: true });
  const change = async (method, ...args) => { await page.evaluate(async ([method, args]) => { window.fixture[method](...args); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }, [method, args]); };
  const calls = () => page.evaluate(() => window.fixture.calls);
  const waitText = text => page.getByText(text, { exact: true }).waitFor();
  await page.getByText(/^Every 24 hours · Next start:/).waitFor();
  assert.equal((await calls()).length, 0, 'merely rendering must not mutate');
  await button('New schedule').click();
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  await page.getByLabel('Schedule name').fill('Weekly evidence check');
  await page.getByLabel('What should it do?').fill('Review only synthetic evidence');
  await page.getByLabel('Task profile').selectOption('research');
  await page.getByLabel('Control mode').selectOption('auto');
  await page.getByRole('combobox', { name: /^Model/ }).selectOption({ label: 'Fixture model · fixture' });
  await page.getByLabel('Find a time zone').fill('Tokyo');
  await page.getByLabel('Display time zone', { exact: true }).selectOption('Asia/Tokyo');
  assert.equal(await page.getByRole('textbox', { name: 'Display time zone', exact: true }).count(), 0);
  await page.evaluate(() => { window.fixture.hold = true; });
  await button('Create schedule').click();
  await page.waitForFunction(() => !!window.fixture.release);
  assert.equal(await button('Saving…').isDisabled(), true);
  await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1, 'busy modal cannot be dismissed');
  await page.evaluate(() => { window.fixture.hold = false; window.fixture.release(); });
  await dialog.waitFor({ state: 'detached' });
  const created = (await calls())[0];
  assert.equal(created.server, 'a'); assert.equal(created.kind, 'automation.save'); assert.equal(created.revision, 0);
  assert.equal(created.payload.timezone, 'Asia/Tokyo');
  assert.equal(created.payload.intervalMs, null); assert.equal(created.payload.task.profile, 'research'); assert.equal(created.payload.task.mode, 'auto');
  assert.deepEqual(created.payload.task.modelRef, { providerId: 'fixture', modelId: 'fixture-model' });
  assert.equal('model' in created.payload.task, false);
  const audit = page.locator('.workspace-item').filter({ has: page.getByRole('heading', { name: 'Audit packages', exact: true }) });
  await audit.getByRole('button', { name: 'Pause', exact: true }).click(); await waitText('Schedule paused. Tasks already started are not stopped.');
  await audit.getByRole('button', { name: 'Resume', exact: true }).click(); await waitText('Schedule resumed. An overdue start may run immediately.');
  let saved = await calls(); assert.deepEqual(saved.slice(1, 3).map(call => [call.revision, call.payload.paused]), [[1, true], [2, false]]);
  await audit.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Schedule name').fill('Updated audit');
  await button('Save changes').click(); await dialog.waitFor({ state: 'detached' });
  saved = await calls(); assert.equal(saved[3].revision, 3); assert.equal(saved[3].payload.name, 'Updated audit');
  const updated = page.locator('.workspace-item').filter({ has: page.getByRole('heading', { name: 'Updated audit', exact: true }) });
  await updated.getByRole('button', { name: 'Edit', exact: true }).click(); await change('bump');
  await page.getByText('This schedule changed on the server. Close and reopen it before saving.').waitFor(); assert.equal(await button('Save changes').isDisabled(), true);
  await button('Cancel').click();
  for (const flags of [{ connected: false }, { retired: true }, { busy: true }, { info: { pending: true } }, { info: { pending: false, pendingError: 'uncertain' } }, { info: null }]) {
    await change('setFlags', flags); await page.waitForFunction(() => document.querySelector('.page-heading button')?.disabled);
    assert.equal(await updated.getByRole('button', { name: 'Edit', exact: true }).isDisabled(), true);
    await change('setFlags', {});
  }
  for (const [method, value] of [['preview', true], ['native', false]]) {
    await change(method, value); await page.waitForFunction(() => document.querySelector('.page-heading button')?.disabled);
    await change(method, !value);
  }
  await button('New schedule').click(); await dialog.waitFor(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.equal(await button('New schedule').evaluate(element => element === document.activeElement), true, 'focus returns to opener');
  await change('unsupported'); await page.getByRole('heading', { name: 'Old record' }).waitFor();
  assert.equal(await page.locator('.workspace-item').filter({ hasText: 'Old record' }).getByRole('button').count(), 0);
  assert.equal(await page.getByRole('button', { name: /delete/i }).count(), 0);

  await button('memory').click(); await button('New shared note').click();
  await page.getByLabel('Note', { exact: true }).fill('A readable shared note\nWith a second line.');
  await change('setFailNote', true); await button('Save shared note').click();
  await dialog.getByRole('alert').waitFor(); await change('setFailNote', false); await button('Save shared note').click(); await dialog.waitFor({ state: 'detached' });
  const noteCalls = (await calls()).filter(call => call.kind === 'memory.shared'); assert.equal(noteCalls.length, 2); assert.equal(noteCalls[0].id, noteCalls[1].id, 'safe retries reuse note identity');
  await page.getByText('A readable shared note\nWith a second line.', { exact: true }).waitFor();
  await button('Forget shared note…').click(); await button('Keep note').click();
  await button('Forget shared note…').click(); await button('Forget on all servers').click(); await waitText('No shared notes yet.');

  await button('One server').click();
  assert.equal(await button('New shared note').count(), 0);
  for (const flags of [{ connected: false }, { retired: true }, { busy: true }, { info: { pending: true } }, { info: { pending: false, pendingError: 'uncertain' } }, { info: null }]) {
    await change('setFlags', flags); await page.waitForFunction(() => [...document.querySelectorAll('button')].find(button => button.textContent === 'New server note')?.disabled);
    await change('setFlags', {});
  }
  for (const [method, value] of [['preview', true], ['native', false]]) {
    await change(method, value); assert.equal(await button('New server note').isDisabled(), true); await change(method, !value);
  }
  await button('New server note').click(); await dialog.waitFor();
  await page.getByLabel('Note', { exact: true }).fill('Server-local deployment paths'); await page.getByLabel('Project', { exact: true }).fill('release');
  await change('setFlags', { info: { pending: false, pendingError: 'uncertain' } });
  assert.equal(await button('Save server note').isDisabled(), true);
  const beforeBlocked = (await calls()).length;
  await dialog.locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  assert.equal((await calls()).length, beforeBlocked, 'handler rechecks authority');
  await change('setFlags', {});
  await page.evaluate(() => { window.fixture.hold = true; });
  await button('Save server note').click(); await page.waitForFunction(() => !!window.fixture.release);
  await dialog.locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1);
  await page.evaluate(() => { window.fixture.hold = false; window.fixture.release(); window.fixture.release = undefined; });
  await dialog.waitFor({ state: 'detached' });
  const localCalls = (await calls()).filter(call => call.kind === 'memory.save');
  assert.equal(localCalls.length, 1, 'double submission only saves once');
  assert.deepEqual(localCalls[0].payload, { text: 'Server-local deployment paths', project: 'release', identityId: 'owner', source: 'Outpost desktop · server note', provenance: 'owner' });
  assert.equal(localCalls[0].server, 'a'); assert.equal(localCalls[0].revision, 0);
  await waitText('Server-local deployment paths');
  await page.getByLabel('Server', { exact: true }).selectOption('b');
  assert.equal(await page.getByText('Server-local deployment paths', { exact: true }).count(), 0);
  await button('New server note').click(); await page.getByLabel('Note', { exact: true }).fill('Build-only note'); await page.getByLabel('Project', { exact: true }).fill('builds');
  await button('Save server note').click(); await dialog.waitFor({ state: 'detached' });
  assert.equal((await calls()).filter(call => call.kind === 'memory.save').at(-1).server, 'b');
  await page.getByLabel('Server', { exact: true }).selectOption('a');
  await button('New server note').click(); await page.getByLabel('Note', { exact: true }).fill('Removed server draft'); await page.getByLabel('Project', { exact: true }).fill('release');
  await change('setArchivedA', true); assert.equal(await button('Save server note').isDisabled(), true); await button('Cancel').click(); await change('setArchivedA', false);
  await button('New server note').click();
  await page.evaluate(() => { window.fixture.failServerNote = true; });
  await button('Save server note').click(); await dialog.getByRole('alert').waitFor();
  assert.equal(await button('Save server note').isDisabled(), true, 'uncertain creation is not retryable');
  const uncertainCount = (await calls()).length;
  await dialog.locator('form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  assert.equal((await calls()).length, uncertainCount);
  await button('Cancel').click(); assert.equal(await button('New server note').isDisabled(), true);
  await page.evaluate(() => { window.fixture.failServerNote = false; });
  await button('All servers').click(); await waitText('No shared notes yet.');

  await button('chats').click(); await waitText('Review release notes');
  const releaseChat = page.getByRole('button', { name: /Review release notes/ });
  assert.match(await releaseChat.innerText(), /2 loaded messages/); assert.match(await releaseChat.innerText(), /Finished/);
  assert.equal(await releaseChat.locator('.workspace-chat-chevron').count(), 1);
  assert.ok(await releaseChat.locator('time').getAttribute('title'));
  assert.doesNotMatch(await page.getByRole('button', { name: /Check deployment evidence/ }).innerText(), /messages/);
  await change('setCounts', false); assert.doesNotMatch(await releaseChat.innerText(), /messages/); await change('setCounts', true);
  assert.equal((await page.locator('main').innerText()).includes('uuid-do-not-display'), false);
  await page.getByLabel('Search chats').fill('Build'); await waitText('Check deployment evidence'); assert.equal(await page.getByText('Review release notes', { exact: true }).count(), 0);
  await page.getByLabel('Search chats').fill(''); await page.getByRole('combobox', { name: /^Server/ }).selectOption('a');
  await page.getByRole('button', { name: /Review release notes/ }).click(); assert.deepEqual(await page.evaluate(() => window.fixture.opened), [{ server: 'a', task: 'uuid-do-not-display' }]);
  await page.getByLabel('Search chats').fill('nothing matches'); await waitText('No chats match your search'); await button('Clear search and filters').click();
  await change('setOfflineB', true); await page.getByText('Last known: Paused', { exact: true }).waitFor();

  await button('review').click();
  const beforeReview = (await calls()).length;
  assert.equal(await button('Approve').count(), 0); assert.equal(await button('Deny').count(), 0);
  await button('Review this action').click(); await dialog.waitFor(); await dialog.getByText('fixture-only', { exact: false }).waitFor();
  await waitText('Synthetic workspace');
  assert.equal(await dialog.locator('.action').getAttribute('data-record-id'), 'action-a');
  assert.equal(await dialog.locator('footer').getByRole('button', { name: 'Approve', exact: true }).count(), 1);
  assert.equal(await dialog.locator('footer').getByRole('button', { name: 'Deny', exact: true }).count(), 1);
  assert.equal(await dialog.locator('.action').getByRole('button').count(), 0, 'decisions appear only in the exact-action footer');
  assert.equal((await calls()).length, beforeReview, 'opening review never decides or dispatches');
  for (const flags of [{ connected: false }, { retired: true }, { busy: true }, { info: null }, { info: { pending: true } }, { info: { pending: false, pendingError: 'uncertain' } }]) {
    await change('setFlags', flags); assert.equal(await button('Approve').isDisabled(), true); await change('setFlags', {});
  }
  await change('native', false); assert.equal(await button('Approve').isDisabled(), true); await change('native', true);
  await change('preview', true); assert.equal(await button('Approve').isDisabled(), true); await change('preview', false);
  await change('bumpAction'); await dialog.getByRole('status').filter({ hasText: 'The action has updated' }).waitFor();
  assert.equal(await button('Approve').count(), 0); assert.equal(await button('Deny').count(), 0);
  assert.equal(await button('Run approved action').count(), 0, 'a stale snapshot cannot dispatch');
  assert.equal((await calls()).length, beforeReview, 'blocked and stale reviews never mutate');
  await button('Close review').click(); await dialog.waitFor({ state: 'detached' });
  await button('Review this action').click(); await dialog.waitFor();
  await page.evaluate(() => { window.fixture.hold = true; window.fixture.release = undefined; });
  await button('Deny').click(); await page.waitForFunction(() => !!window.fixture.release);
  assert.equal(await button('Approve').isDisabled(), true); await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 1);
  assert.equal(await button('Close review').isDisabled(), true); assert.equal(await button('Close').isDisabled(), true);
  await page.evaluate(() => { window.fixture.hold = false; window.fixture.release(); });
  await dialog.getByRole('status').filter({ hasText: 'The action has updated: denied.' }).waitFor();
  assert.equal(await button('Deny').count(), 0); assert.equal(await button('Approve').count(), 0);
  const approval = (await calls()).find(call => call.kind === 'approval.decide');
  assert.deepEqual(approval, { server: 'a', kind: 'approval.decide', id: 'action-a', revision: 2, payload: { nonce: 'new-nonce', actionDigest: 'new-digest', decision: 'deny' } });
  assert.equal((await calls()).length, beforeReview + 1, 'denial sends only the explicit decision');
  await button('Close review').click(); await dialog.waitFor({ state: 'detached' });
  await change('restoreAction'); await change('authorizeAction'); await button('Review this action').click(); await dialog.waitFor();
  assert.equal(await button('Approve').count(), 0);
  assert.equal((await calls()).length, beforeReview + 1, 'opening an authorized review does not dispatch');
  await button('Run approved action').click();
  await dialog.getByRole('status').filter({ hasText: 'The action has updated: dispatching.' }).waitFor();
  assert.equal(await button('Run approved action').count(), 0);
  assert.deepEqual((await calls()).filter(call => call.kind === 'action.dispatch'), [{ server: 'a', kind: 'action.dispatch', id: 'action-a', revision: 2, payload: {} }]);
  await button('Close').click(); await dialog.waitFor({ state: 'detached' });
  await change('restoreAction'); await button('Review this action').click(); await dialog.waitFor(); await button('Approve').click();
  await dialog.getByRole('status').filter({ hasText: 'The action has updated: authorized.' }).waitFor();
  assert.deepEqual((await calls()).filter(call => call.kind === 'approval.decide').at(-1), { server: 'a', kind: 'approval.decide', id: 'action-a', revision: 1, payload: { nonce: 'fixture-nonce', actionDigest: 'fixture-digest', decision: 'approve' } });
  assert.equal(await button('Approve').count(), 0); assert.equal(await button('Run approved action').count(), 0, 'approval never turns the old snapshot into a dispatch control');
  assert.equal((await calls()).length, beforeReview + 3, 'approval never automatically dispatches');
  await button('Close review').click(); await dialog.waitFor({ state: 'detached' });
  assert.equal(await button('Show an example').count(), 0);
  await page.setViewportSize({ width: 430, height: 780 });
  for (const view of ['automations', 'memory', 'chats']) {
    await button(view).click();
    assert.equal(await page.locator('main').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, view + ' must not overflow at a narrow width');
  }
  await button('review').click(); await button('Review this action').click(); await dialog.waitFor();
  assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'action review must not overflow at a narrow width');
  assert.equal(await button('Run approved action').isEnabled(), true, 'reopened authorized snapshot can be explicitly dispatched');
  assert.equal((await calls()).length, beforeReview + 3, 'reopening the approved action still does not dispatch');
  await button('Close review').click(); await dialog.waitFor({ state: 'detached' });
  await button('automations').click(); await button('New schedule').click(); await dialog.waitFor();
  assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'modal fields must fit a narrow viewport');
  await button('Cancel').click();
  await button('replicas').click(); await waitText('No shared notes yet.');
  assert.equal(await page.getByText('Old shared text', { exact: true }).count(), 0, 'offline tombstone wins even over a future-dated copy');
  assert.deepEqual(await page.evaluate(() => window.replicaFixture.syncCalls), [], 'offline tombstone is not sent until observed on a reachable server');
  await page.evaluate(() => window.replicaFixture.setOnline(true));
  await page.waitForFunction(() => window.replicaFixture.syncCalls.length === 1 && window.replicaFixture.notes[0].copies.get('a') === null);
  assert.deepEqual(await page.evaluate(() => window.replicaFixture.syncCalls), [{ server: 'a', kind: 'memory.shared', id: 'replica-note', revision: 0, payload: { text: null } }]);
  assert.equal(await page.getByText('Old shared text', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('Workspace refinement synthetic DOM checks passed (automation create/edit/pause/resume, guards, modal, memory, chats, action review).');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
