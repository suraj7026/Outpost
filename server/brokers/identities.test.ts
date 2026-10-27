import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Ledger } from '../core/ledger.js';
import { IdentityBroker } from './identities.js';
test('encrypted account scope never falls back and revocation blocks future broker use',() => {
  const db = new Ledger(), broker = new IdentityBroker(db,randomBytes(32)); db.put('task','task',0,{});
  const identity = broker.connect('Agent','agent','https://example.com',['read'],'fixture-secret');
  const grant = broker.grant(identity.id,'task',['read'],Date.now()+60000);
  assert.equal(broker.use(grant.id,'task','https://example.com','read').toString(),'fixture-secret');
  assert.ok(!JSON.stringify(db.list('vault')).includes('fixture-secret'));
  assert.throws(() => broker.use(grant.id,'other','https://example.com','read'));
  assert.throws(() => broker.use(grant.id,'task','https://evil.example','read'));
  broker.revoke(identity.id,1); assert.throws(() => broker.use(grant.id,'task','https://example.com','read')); db.close();
});
