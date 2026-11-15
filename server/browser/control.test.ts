import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Coordinator, publicKinds } from '../gateway/coordinator.js';
import { httpServer } from '../gateway/http.js';
import { BrowserSessions } from './sessions.js';
import { BrowserControl } from './control.js';

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await delay(10);
  assert.ok(check(), 'State transition did not settle');
}
const signal = () => new AbortController().signal;

test('signed takeover waits for an action, fences Pi, protects inputs, and returns the same page', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-takeover-')), db = new Ledger();
  const coordinator = new Coordinator(db, root, { browser: {} }), sessions = coordinator.browsers!, control = coordinator.browserControl!;
  const server = httpServer(coordinator, 'fixture'.repeat(8));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const devices = [0, 1].map(index => {
    const keys = generateKeyPairSync('ed25519'), deviceId = id();
    coordinator.devices.pair(deviceId, `Fixture ${index}`, keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'));
    return { keys, deviceId };
  });
  const task = coordinator.tasks.create(id(), { goal: 'Take over fixture', profile: 'browser', mode: 'full_control' });
  const second = coordinator.tasks.create(id(), { goal: 'Other task', profile: 'browser' });
  const request = async (payload: Record<string, unknown>, owner = 0, options: { unsigned?: boolean; environmentId?: string; issuedAt?: number } = {}) => {
    const device = devices[owner]!;
    const body = Buffer.from(JSON.stringify({ protocolVersion: 2, environmentId: options.environmentId ?? coordinator.environment.environmentId,
      deviceId: device.deviceId, issuedAt: options.issuedAt ?? Date.now(), type: 'browser', payload: { taskId: task.id, requestId: id(), epoch: control.epoch, ...payload } }));
    return fetch(`http://127.0.0.1:${address.port}/v2/browser`, { method: 'POST', body,
      headers: { 'x-outpost-signature': options.unsigned ? 'invalid' : sign(null, body, device.keys.privateKey).toString('base64') } });
  };
  let finish!: () => void;
  try {
    await sessions.execute(task.id, 'direct', 'Fixture', signal(), async session => {
      await session.page.setContent('<title>Takeover fixture</title><input autofocus aria-label="Secret"><button onclick="this.textContent=\'Clicked\'">Continue</button>');
      await session.page.locator('input').focus();
    });
    assert.notEqual((await request({ type: 'take' }, 0, { unsigned: true })).status, 200);
    assert.notEqual((await request({ type: 'take' }, 0, { environmentId: id() })).status, 200);
    assert.notEqual((await request({ type: 'take' }, 0, { issuedAt: Date.now() - 600000 })).status, 200);
    assert.notEqual((await request({ type: 'take', epoch: id() })).status, 200);
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const running = sessions.execute(task.id, 'direct', 'Bounded fixture', signal(), async () => { await waiting; });
    const taken = await request({ type: 'take' }); assert.equal(taken.status, 200);
    const lease = await taken.json() as { state: string; leaseId: string };
    assert.equal(lease.state, 'pending'); assert.equal(db.need('task', task.id).data.state, 'paused');
    assert.notEqual((await request({ type: 'take' }, 1)).status, 200);
    assert.notEqual((await request({ type: 'input', leaseId: lease.leaseId, frameId: id(), input: { action: 'key', key: 'Enter' } })).status, 200);
    await assert.rejects(sessions.execute(task.id, 'direct', 'Competing agent', signal(), session => sessions.observe(session)), /browser_control_held/);
    assert.throws(() => coordinator.command({ protocolVersion: 1, commandId: id(), idempotencyKey: id(), deviceId: devices[0]!.deviceId,
      type: 'task.resume', aggregateId: task.id, expectedRevision: db.need('task', task.id).revision, payload: {}, issuedAt: Date.now() }), /browser_control_held/);
    assert.ok((await sessions.frame(task.id)).frame);
    finish(); await running;
    await until(() => control.status(task.id)?.state === 'human');
    const frame = await sessions.frame(task.id); assert.ok(frame.frameId);
    const secret = 'synthetic-private-input-41284';
    const input = { type: 'input', requestId: id(), leaseId: lease.leaseId, frameId: frame.frameId, input: { action: 'text', text: secret } };
    assert.notEqual((await request(input, 1)).status, 200);
    assert.notEqual((await request({ ...input, requestId: id(), taskId: second.id })).status, 200);
    assert.equal((await request(input)).status, 200);
    assert.notEqual((await request(input)).status, 200, 'Replaying a signed input must not type twice');
    assert.notEqual((await request({ ...input, requestId: id() })).status, 200, 'A consumed frame is stale');
    assert.equal(JSON.stringify(db.snapshot(publicKinds)).includes(secret), false, 'No input text in durable records or events');
    assert.equal(JSON.stringify(db.events(0, 200)).includes(secret), false);
    const fresh = await sessions.frame(task.id); assert.ok(fresh.frameId);
    assert.equal((await request({ type: 'input', leaseId: lease.leaseId, frameId: fresh.frameId, input: { action: 'click', x: 220, y: 18 } })).status, 200);
    assert.equal((await request({ type: 'release', leaseId: lease.leaseId })).status, 200);
    await until(() => control.status(task.id)?.state === 'released');
    assert.equal(db.need('task', task.id).data.state, 'paused');
    assert.equal(db.need('browser', task.id).data.mode, 'human');
    await sessions.execute(task.id, 'direct', 'Inspect result', signal(), async session => {
      assert.equal(await session.page.locator('input').inputValue(), secret);
      assert.equal(await session.page.title(), 'Takeover fixture');
    });
    const reacquired = await request({ type: 'take' }); assert.equal(reacquired.status, 200);
    await until(() => control.status(task.id)?.state === 'human');
    coordinator.devices.revoke(devices[0]!.deviceId, 1);
    assert.notEqual((await request({ type: 'renew', leaseId: (await reacquired.json() as { leaseId: string }).leaseId })).status, 200);
    await until(() => control.status(task.id)?.state === 'expired');
  } finally {
    finish?.(); await coordinator.closeBrowsers(); coordinator.live.close();
    await new Promise<void>(resolve => server.close(() => resolve())); db.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('expired pending takeover never grants input or resumes the agent; restart invalidates leases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-lease-')), db = new Ledger();
  const sessions = new BrowserSessions(db, root);
  const taskId = id(), deviceId = id();
  db.put('task', taskId, 0, { state: 'running' }); db.put('device', deviceId, 0, { revoked: false });
  let paused = false, stopped = false;
  const control = new BrowserControl(db, sessions, () => { paused = true; }, async () => { stopped = true; }, 40);
  let finish!: () => void;
  try {
    await sessions.execute(taskId, 'direct', 'Fixture', signal(), async session => { await session.page.setContent('<p>Fixture</p>'); });
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const running = sessions.execute(taskId, 'direct', 'Wait', signal(), async () => { await waiting; });
    const taken = await control.request(deviceId, { type: 'take', taskId, requestId: id(), epoch: control.epoch });
    assert.ok('leaseId' in taken);
    await delay(60); assert.equal(control.status(taskId)?.state, 'releasing');
    assert.equal(sessions.isHeld(taskId), true); assert.equal(paused, true); assert.equal(stopped, false);
    finish(); await running;
    await until(() => control.status(taskId)?.state === 'expired'); assert.equal(stopped, true);
    await assert.rejects(control.request(deviceId, { type: 'renew', taskId, requestId: id(), epoch: control.epoch, leaseId: taken.leaseId }), /invalid_browser_lease/);
    const row = db.need('browser_control', taskId); db.put('browser_control', taskId, row.revision, { ...row.data, state: 'human' });
    await control.close();
    const restarted = new BrowserControl(db, sessions, () => {}, async () => {});
    try {
      assert.equal(restarted.status(taskId)?.state, 'expired');
      await assert.rejects(restarted.request(deviceId, { type: 'take', taskId, requestId: id(), epoch: control.epoch }), /browser_request_expired/);
    } finally { await restarted.close(); }
  } finally { finish?.(); await sessions.close(); await control.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
