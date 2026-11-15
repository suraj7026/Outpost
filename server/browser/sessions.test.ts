import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { BrowserSessions } from './sessions.js';
import { Coordinator } from '../gateway/coordinator.js';
import { httpServer } from '../gateway/http.js';
import type { Json } from '../core/contracts.js';

const signal = () => new AbortController().signal;
test('Pi tools and signed viewer use real Camoufox with fresh isolated profiles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-camoufox-')), db = new Ledger();
  const coordinator = new Coordinator(db, root, { browser: {} });
  const fixture = createServer((_, response) => response.end('<title>Browser fixture</title><input aria-label="Name"><button onclick="this.textContent=\'Clicked\'">Continue</button>'));
  const server = httpServer(coordinator, 'fixture-token'.repeat(4));
  await Promise.all([new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve)), new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))]);
  const fixtureAddress = fixture.address(), address = server.address();
  assert.ok(fixtureAddress && typeof fixtureAddress !== 'string' && address && typeof address !== 'string');
  const task = coordinator.tasks.create(id(), { goal: 'Exercise direct browser', profile: 'browser', mode: 'full_control' });
  const old = join(root, 'workspaces', task.id, 'browser-profile'); mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'Cookies'), 'not a Firefox profile');
  const gate = coordinator.gate(task.id);
  const dispatch = async (tool: string, args: Record<string, Json> = {}): Promise<Record<string, Json>> => {
    const proposed = await gate.propose(task.id, tool, args), observed = await gate.dispatch(proposed.id);
    assert.equal(observed.data.state, 'succeeded', JSON.stringify(observed.data.result));
    const value = observed.data.result; assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value;
  };
  try {
    assert.deepEqual(gate.catalogue().map(tool => tool.name).filter(name => name.startsWith('browser.')).sort(), ['browser.act', 'browser.capture', 'browser.close', 'browser.observe', 'browser.open']);
    assert.equal(coordinator.runtimeStatus().browserEngine, 'camoufox');
    const opened = await dispatch('browser.open', { url: `http://127.0.0.1:${fixtureAddress.port}` });
    assert.equal(opened.title, 'Browser fixture');
    await coordinator.browsers!.execute(task.id, 'direct', 'Engine identity', signal(), async session => {
      assert.match(await session.page.evaluate(() => navigator.userAgent), /Firefox\//);
      assert.equal((await session.context.cookies()).length, 0);
    });
    assert.equal(readFileSync(join(old, 'Cookies'), 'utf8'), 'not a Firefox profile');
    const button = (opened.elements as { ref: string; tag: string }[]).find(element => element.tag === 'button'); assert.ok(button);
    assert.equal((await dispatch('browser.act', { observation: opened.observation!, input: { action: 'click', ref: button.ref } })).text, 'Clicked');
    const stale = await gate.propose(task.id, 'browser.act', { observation: opened.observation!, input: { action: 'click', ref: button.ref } });
    assert.equal((await gate.dispatch(stale.id)).data.state, 'unknown');
    const capture = await dispatch('browser.capture'); assert.ok(Array.isArray(capture.artifactIds) && capture.artifactIds.length === 1);
    const keys = generateKeyPairSync('ed25519'), deviceId = id();
    coordinator.devices.pair(deviceId, 'Viewer', keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'));
    const bytes = Buffer.from(JSON.stringify({ deviceId, issuedAt: Date.now(), type: 'browser.frame', payload: { taskId: task.id } }));
    const query = (signature: string) => fetch(`http://127.0.0.1:${address.port}/v1/query`, { method: 'POST', body: bytes, headers: { 'x-outpost-signature': signature } });
    assert.notEqual((await query('unsigned')).status, 200);
    const signature = sign(null, bytes, keys.privateKey).toString('base64'), before = db.cursor();
    const response = await query(signature); assert.equal(response.status, 200);
    const frame = await response.json() as { frame: string; capturedAt: string; session: { engine: string } };
    assert.equal(frame.session.engine, 'camoufox'); assert.ok(Buffer.from(frame.frame, 'base64').length > 1000);
    assert.equal(db.cursor(), before, 'Live frames are not durable records');
    coordinator.devices.revoke(deviceId, 1); assert.notEqual((await query(signature)).status, 200);
    await assert.rejects(async () => coordinator.query('browser.frame', { taskId: id() }), /task not found/);
    await dispatch('browser.close'); assert.equal((await coordinator.browsers!.frame(task.id)).frame, null);
  } finally {
    await coordinator.closeBrowsers(); coordinator.live.close();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => fixture.close(() => resolve()))]);
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('Camoufox tabs, history, profile persistence and fresh-frame input remain owner-bound', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-camoufox-tabs-')), db = new Ledger(), sessions = new BrowserSessions(db, root);
  const taskId = id(), fixture = createServer((request, response) => response.end(`<title>${request.url}</title><p>${request.url}</p><input aria-label="Name">`));
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const first = await sessions.open(taskId, `${url}/first`, signal());
    const second = await sessions.execute(taskId, 'direct', 'Navigate', signal(), session => sessions.act(session, first.observation, { action: 'navigate', url: `${url}/second` }));
    const back = await sessions.execute(taskId, 'direct', 'Back', signal(), session => sessions.act(session, second.observation, { action: 'back' }));
    assert.equal(back.title, '/first');
    const tab = await sessions.execute(taskId, 'direct', 'New tab', signal(), session => sessions.act(session, back.observation, { action: 'new_tab', url: `${url}/new` }));
    assert.equal(tab.tabs.length, 2);
    const before = await sessions.frame(taskId); assert.ok(before.frameId);
    const closed = await sessions.execute(taskId, 'direct', 'Close tab', signal(), session => sessions.act(session, tab.observation, { action: 'close_tab' }));
    assert.equal(closed.title, '/first');
    sessions.reserve(taskId);
    await assert.rejects(sessions.humanInput(taskId, before.frameId, { action: 'key', key: 'Enter' }), { code: 'stale_browser_frame' });
    sessions.release(taskId);
    await sessions.execute(taskId, 'direct', 'Save profile', signal(), async session => {
      await session.context.addCookies([{ name: 'fixture', value: 'retained', url, expires: Date.now() / 1000 + 3600 }]);
    });
    await sessions.stop(taskId);
    await sessions.open(taskId, `${url}/reopened`, signal());
    await sessions.execute(taskId, 'direct', 'Check profile', signal(), async session => {
      assert.equal((await session.context.cookies()).find(cookie => cookie.name === 'fixture')?.value, 'retained');
      await assert.rejects(sessions.act(session, first.observation, { action: 'press', key: 'Enter' }), { code: 'stale_observation' });
    });
  } finally { await sessions.close(); await new Promise<void>(resolve => fixture.close(() => resolve())); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('one active action excludes competing input, permits viewing and cancels cleanly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-camoufox-lock-')), db = new Ledger(), sessions = new BrowserSessions(db, root, { maxSessions: 1 });
  const taskId = id(), abort = new AbortController();
  try {
    await sessions.execute(taskId, 'direct', 'Fixture setup', signal(), async session => { await session.page.setContent('<p>Ready</p>'); });
    let attached!: () => void;
    const ready = new Promise<void>(resolve => { attached = resolve; });
    const running = sessions.execute(taskId, 'direct', 'Bounded action', abort.signal, async (_, ownedSignal) => {
      attached(); await new Promise<void>(resolve => ownedSignal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const outcome = assert.rejects(running); await ready;
    await assert.rejects(sessions.execute(taskId, 'direct', 'Competing action', signal(), session => sessions.observe(session)), /Another browser action owns/);
    assert.ok((await sessions.frame(taskId)).frame);
    await assert.rejects(sessions.open(id(), 'https://example.com', signal()), /browser_capacity/);
    abort.abort(); await outcome;
    assert.equal((await sessions.frame(taskId)).frame, null);
  } finally { await sessions.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('missing engine fails closed without falling back to another browser', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-camoufox-missing-')), db = new Ledger(), sessions = new BrowserSessions(db, root, { python: '/missing/outpost-python' });
  try { await assert.rejects(sessions.open(id(), 'https://example.com', signal()), /Camoufox is unavailable/); }
  finally { await sessions.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
