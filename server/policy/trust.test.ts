import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Ledger } from '../core/ledger.js';
import { Devices, Gate } from './trust.js';
import type { Action } from './trust.js';

function setup(mode: string) {
  const db = new Ledger(), gate = new Gate(db); let effects = 0;
  gate.changePolicy('task',0,mode);
  gate.register('read',{ version: 1,effects: ['workspace.read'],parse: () => ({}),target: () => 'workspace',execute: async () => { effects++; return 'read'; } });
  return { db,gate,effects: () => effects };
}
test('Full Control executes once; Auto and legacy require approval for uncertified tools',async () => {
  for (const mode of ['full_control','auto','ask_permission']) {
    const { gate,db,effects } = setup(mode);
    const auto = mode !== 'full_control';
    assert.equal(gate.policy('task').data.mode,auto ? 'auto' : 'full_control');
    // Exercise storage predating normalization, not just the public input parser.
    db.put('policy','task',1,{ mode });
    const action = await gate.propose('task','read',{});
    assert.equal(action.data.state,auto ? 'pending' : 'authorized'); assert.equal(effects(),0);
    assert.equal(gate.policy('task').data.mode,auto ? 'auto' : 'full_control');
    assert.equal(db.list('inbox').length,auto ? 1 : 0);
    assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE topic='notice'").get()?.n,auto ? 1 : 0);
    if (auto) {
      db.put('device','owner',0,{ revoked: false });
      gate.decide(action.id,action.revision,'owner',{ nonce: action.data.nonce, actionDigest: action.data.actionDigest, decision: 'approve' });
    }
    await gate.dispatch(action.id); assert.equal(effects(),1);
    await assert.rejects(gate.dispatch(action.id),/not_authorized/); db.close();
  }
});
test('legacy policy changes normalize but retain revision validation and stale-action fencing',async () => {
  const { gate,db,effects } = setup('auto');
  const action = await gate.propose('task','read',{});
  assert.throws(() => gate.changePolicy('task',0,'ask_permission'),/stale_revision/);
  assert.throws(() => gate.changePolicy('task',1,'root'));
  gate.changePolicy('task',1,'ask_permission');
  assert.equal(gate.policy('task').data.mode,'auto');
  assert.equal(db.need('action', action.id).data.state, 'denied');
  await assert.rejects(gate.dispatch(action.id),/not_authorized/);
  assert.equal(effects(),0); db.close();
});
for (const state of ['paused','cancelled','completed','failed','interrupted']) test(`full_control retains the ${state} dispatch boundary`,async () => {
  const { gate,db,effects } = setup('full_control');
  const action = await gate.propose('task','read',{});
  db.put('task','task',0,{ state });
  await assert.rejects(gate.dispatch(action.id),/task_not_dispatchable/);
  assert.equal(effects(),0); db.close();
});
test('malformed persisted modes fail validation instead of silently authorizing actions',async () => {
  const { gate,db,effects } = setup('full_control');
  db.put('policy','task',1,{ mode: 'root' });
  await assert.rejects(gate.propose('task','read',{}));
  assert.equal(db.list('action').length,0); assert.equal(effects(),0); db.close();
});
for (const [change, code] of [
  [{ expiresAt: 1 }, 'expired_action'],
  [{ toolVersion: 2 }, 'tool_changed'],
  [{ identityRef: 'owner' }, 'identity_not_delegated'],
] as const) test(`full_control retains ${code} validation`,async () => {
  const { gate,db,effects } = setup('full_control');
  const action = await gate.propose('task','read',{});
  db.put('action',action.id,action.revision,{ ...action.data,...change });
  await assert.rejects(gate.dispatch(action.id),{ code });
  assert.equal(effects(),0); db.close();
});
test('protected effects and ambiguous failures never grant or retry authority', async () => {
  const { gate,db } = setup('full_control');
  gate.register('money',{ version: 1,effects: ['payment.charge'],parse: () => ({}),target: () => 'bank',execute: async () => 'charged' });
  await assert.rejects(gate.propose('task','money',{}),/protected_effect/);
  gate.register('broken',{ version: 1,effects: ['unknown'],parse: () => ({}),target: () => 'fixture',execute: async () => { throw Error('post-send timeout'); } });
  const action = await gate.propose('task','broken',{}); await gate.dispatch(action.id);
  assert.equal(db.need<Action>('action',action.id).data.state,'unknown'); await assert.rejects(gate.dispatch(action.id)); db.close();
});
test('device signatures bind bytes and revocation is effective', () => {
  const db = new Ledger(), devices = new Devices(db), keys = generateKeyPairSync('ed25519');
  devices.pair('mac','Mac',keys.publicKey.export({ format: 'der',type: 'spki' }).subarray(-32).toString('base64'));
  const bytes = Buffer.from('approved exact request'), signature = sign(null,bytes,keys.privateKey).toString('base64');
  devices.authenticate('mac',bytes,signature);
  assert.throws(() => devices.authenticate('mac',Buffer.from('changed'),signature),/invalid_signature/);
  devices.revoke('mac',1); assert.throws(() => devices.authenticate('mac',bytes,signature),/revoked_device/); db.close();
});
