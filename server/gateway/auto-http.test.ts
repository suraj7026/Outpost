import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { id } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
import { Coordinator } from './coordinator.js';
import { httpServer } from './http.js';
import type { Action } from '../policy/trust.js';

for (const version of [1, 2]) test(`signed v${version} approval responds with exact action revision and dispatches once without a second button`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-auto-http-')), db = new Ledger();
  const coordinator = new Coordinator(db, root), token = 'auto-http-fixture-token'.repeat(2);
  const server = httpServer(coordinator, token);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/v${version}`, deviceId = id(), keys = generateKeyPairSync('ed25519');
  const binding = version === 2 ? { protocolVersion: 2, environmentId: coordinator.environment.environmentId } : {};
  const post = (route: string, body: object, valid = true) => {
    const bytes = Buffer.from(JSON.stringify(body));
    return fetch(base + route, { method: 'POST', headers: { 'x-outpost-signature': sign(null, valid ? bytes : Buffer.from('different bytes'), keys.privateKey).toString('base64') }, body: bytes });
  };
  const command = (type: string, aggregateId: string, expectedRevision: number, payload: object) => ({ protocolVersion: 1, ...binding, commandId: id(), idempotencyKey: id(), deviceId, issuedAt: Date.now(), type, aggregateId, expectedRevision, payload });
  try {
    assert.equal((await post('/pair', { ...binding, deviceId, name: 'Owner', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'), token })).status, 200);
    const taskId = id();
    assert.equal((await post('/commands', command('task.create', taskId, 0, { goal: 'Sensitive action', profile: 'code', mode: 'auto' }))).status, 200);
    const runtime = await (await post('/query', { ...binding, deviceId, issuedAt: Date.now(), type: 'runtime', payload: {} })).json();
    assert.deepEqual(z.object({ controlModes: z.array(z.string()), autoPolicyVersion: z.number() }).parse(runtime), { controlModes: ['full_control', 'auto'], autoPolicyVersion: 1 });
    let effects = 0;
    const gate = coordinator.gate(taskId);
    gate.register('fixture.purchase', { version: 1, effects: ['financial.purchase'], parse: input => z.strictObject({ amount: z.number() }).parse(input), target: () => 'fixture shop', execute: async () => { effects++; return { observed: true }; } });
    assert.equal((await post('/commands', command('action.propose', taskId, 1, { tool: 'fixture.purchase', arguments: { amount: 42 } }))).status, 200);
    await coordinator.drain();
    const action = db.list<Action>('action')[0]!;
    assert.equal(action.data.state, 'pending');
    const payload = { nonce: action.data.nonce, actionDigest: action.data.actionDigest, decision: 'approve' };
    const approve = command('approval.decide', action.id, action.revision, payload);
    assert.equal((await post('/commands', approve, false)).status, 409);
    assert.equal((await post('/commands', command('approval.decide', action.id, action.revision, { ...payload, nonce: 'wrong' }))).status, 409);
    assert.equal(effects, 0);
    const waiting = gate.awaitDecisionAndDispatch(action.id);
    const response = await post('/commands', approve); assert.equal(response.status, 200);
    const updated = z.object({ id: z.string(), revision: z.number(), data: z.object({ state: z.string() }) }).parse(await response.json());
    assert.equal(updated.id, action.id); assert.equal(updated.revision, action.revision + 1); assert.equal(updated.data.state, 'authorized');
    assert.equal(effects, 0);
    const repeated = await post('/commands', approve); assert.equal(repeated.status, 200);
    assert.equal(z.object({ revision: z.number() }).parse(await repeated.json()).revision, updated.revision);
    assert.equal((await post('/commands', command('approval.decide', action.id, action.revision, payload))).status, 409);
    await Promise.all([coordinator.drain(), coordinator.drain()]);
    assert.equal((await waiting).data.state, 'succeeded');
    await coordinator.drain(); assert.equal(effects, 1);
    const next = await gate.propose(taskId, 'fixture.purchase', { amount: 43 });
    const nextApproval = command('approval.decide', next.id, next.revision, { nonce: next.data.nonce, actionDigest: next.data.actionDigest, decision: 'approve' });
    assert.equal((await post('/commands', nextApproval)).status, 200);
    coordinator.devices.revoke(deviceId, 1);
    await coordinator.drain(); assert.equal(effects, 1, 'Revocation fences accepted but not dispatched approvals');
    assert.equal((await post('/commands', nextApproval)).status, 409);
  } finally {
    await coordinator.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});
