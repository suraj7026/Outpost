import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Ledger } from '../core/ledger.js';
import { Devices, Gate } from './trust.js';
import type { Action, Reviewer } from './trust.js';

function setup(mode: string, reviewer?: Reviewer) {
  const db = new Ledger(), gate = new Gate(db,reviewer); let effects = 0;
  gate.changePolicy('task',0,mode);
  gate.register('read',{ version: 1,effects: ['workspace.read'],parse: () => ({}),target: () => 'workspace',execute: async () => { effects++; return 'read'; } });
  return { db,gate,effects: () => effects };
}
test('all three modes, fail-to-ask, stale policy and single dispatch',async () => {
  for (const mode of ['full_control','auto','ask_permission']) {
    const { gate,db,effects } = setup(mode,async action => ({ actionDigest: action.actionDigest,policyVersion: action.policyVersion,decision: 'allow',summary: 'Scoped read' }));
    const action = await gate.propose('task','read',{});
    if (mode === 'ask_permission') {
      await assert.rejects(gate.dispatch(action.id),/not_authorized/); assert.equal(effects(),0);
      db.transaction(() => gate.decide(action.id,1,action.data.nonce,action.data.actionDigest,'approve','mac'));
      const loser = db.transaction(() => gate.decide(action.id,1,action.data.nonce,action.data.actionDigest,'deny','phone'));
      assert.equal(loser.data.state,'authorized');
    }
    await gate.dispatch(action.id); assert.equal(effects(),1);
    await assert.rejects(gate.dispatch(action.id)); db.close();
  }
  const { gate,db } = setup('auto',async () => ({ decision: 'allow' }));
  const pending = await gate.propose('task','read',{}); assert.equal(pending.data.state,'pending');
  assert.equal(db.list('inbox').length,1);
  gate.changePolicy('task',1,'ask_permission');
  assert.throws(() => gate.decide(pending.id,1,pending.data.nonce,pending.data.actionDigest,'approve','mac'),/stale_policy/);
  db.close();
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
