import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { id } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
import { Coordinator } from './coordinator.js';
import { httpServer, ReplayCache, REPLAY_WINDOW_MS } from './http.js';

function device() {
  const keys = generateKeyPairSync('ed25519');
  return {
    deviceId: id(), name: 'Fixture device',
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    privateKey: keys.privateKey,
  };
}

async function fixture(t: test.TestContext, version: 1 | 2) {
  const root = mkdtempSync(join(tmpdir(), 'outpost-spec07-http-'));
  const db = new Ledger(), coordinator = new Coordinator(db, root, { browser: {} });
  const owner = device();
  coordinator.devices.pair(owner.deviceId, owner.name, owner.publicKey);
  const server = httpServer(coordinator, 'unused');
  t.after(async () => {
    try {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await coordinator.close();
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const signedRequest = (route: string, type: string, payload: object, issuedAt = Date.now()) => {
    const body = Buffer.from(JSON.stringify({
      ...(version === 2 ? { protocolVersion: 2, environmentId: coordinator.environment.environmentId } : {}),
      deviceId: owner.deviceId, issuedAt, type, payload,
    }));
    const headers = { 'x-outpost-signature': sign(null, body, owner.privateKey).toString('base64') };
    return async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/v${version}/${route}`, { method: 'POST', headers, body });
      return { status: response.status, body: await response.json() };
    };
  };
  return { db, coordinator, signedRequest };
}

for (const version of [1, 2] as const) {
  test(`spec07: v${version} pair-device refuses maintenance holds and rejects exact signed replay`, async t => {
    const { db, coordinator, signedRequest } = await fixture(t, version);
    const { deviceId, name, publicKey } = device();
    const send = signedRequest('pair-device', 'pair', { deviceId, name, publicKey });
    let revision = 0;
    for (const state of ['draining', 'holding', 'prepared']) {
      revision = db.put('runtime_update', 'server', revision, { state }).revision;
      assert.equal(coordinator.maintenance.holding, true);
      assert.deepEqual(await send(), { status: 409, body: { error: 'maintenance_in_progress', message: 'maintenance_in_progress' } });
      assert.equal(db.list('device').length, 1);
    }
    db.put('runtime_update', 'server', revision, { state: 'idle' });
    assert.equal((await send()).status, 200, 'maintenance rejection must not consume the request');
    const paired = db.need('device', deviceId);
    assert.equal(paired.data.publicKey, publicKey);
    assert.deepEqual(await send(), { status: 409, body: { error: 'replayed_request', message: 'replayed_request' } });
    assert.deepEqual(db.need('device', deviceId), paired);
    assert.equal(db.list('device').length, 2);
  });

  test(`spec07: v${version} browser and agent requests reach their handlers once, while signed queries remain retryable`, async t => {
    const { coordinator, signedRequest } = await fixture(t, version);
    assert.ok(coordinator.browserControl);
    const browser = t.mock.method(coordinator.browserControl, 'request', async () => ({ accepted: true }));
    const agent = t.mock.method(coordinator, 'agentRequest', async () => ({ accepted: true }));
    for (const [route, handler] of [['browser', browser], ['agent', agent]] as const) {
      const expired = signedRequest(route, 'fixture', {}, Date.now() - REPLAY_WINDOW_MS);
      assert.deepEqual(await expired(), { status: 409, body: { error: 'expired_request', message: 'expired_request' } });
      assert.equal(handler.mock.callCount(), 0);
      const send = signedRequest(route, 'fixture', { requestId: id() });
      assert.deepEqual(await send(), { status: 200, body: { accepted: true } });
      assert.deepEqual(await send(), { status: 409, body: { error: 'replayed_request', message: 'replayed_request' } });
      assert.equal(handler.mock.callCount(), 1);
    }
    const query = signedRequest('query', 'snapshot', {});
    const first = await query();
    assert.equal(first.status, 200);
    assert.deepEqual(await query(), first);
  });
}

test('spec07: replay cache expires entries at the deadline and stays bounded', () => {
  const cache = new ReplayCache(2);
  assert.equal(cache.consume('later', 200, 0), true);
  assert.equal(cache.consume('earlier', 100, 0), true);
  assert.equal(cache.consume('earlier', 100, 99), false);
  assert.equal(cache.consume('new', 300, 100), true);
  assert.equal(cache.size, 2);
  assert.equal(cache.consume('later', 200, 100), false, 'expired entries must be reclaimed before live ones');
  assert.equal(cache.consume('third', 300, 100), true);
  assert.equal(cache.size, 2);
  assert.equal(cache.consume('new', 300, 299), false);
  assert.equal(cache.consume('new', 600, 300), true);
});
