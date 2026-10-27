import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from './ledger.js';
import { canonical, digest, id } from './contracts.js';
import type { Command } from './contracts.js';

test('canonical contracts reject non-JSON and hash order independently', () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.throws(() => canonical({ a: undefined })); assert.throws(() => canonical(NaN));
});
test('acceptance, record, event and outbox commit atomically with replay-safe keys', () => {
  const db = new Ledger();
  const cmd: Command = { protocolVersion: 1, commandId: id(), deviceId: id(), idempotencyKey: 'one', type: 'task.create', aggregateId: id(), expectedRevision: 0, payload: { title: 'Test' }, issuedAt: Date.now() };
  const apply = () => { db.put('task',cmd.aggregateId,0,cmd.payload); db.enqueue('run',cmd.payload); return { accepted: true }; };
  assert.deepEqual(db.accept(cmd,apply), db.accept(cmd,apply));
  assert.equal(db.events().length,1);
  assert.throws(() => db.accept({ ...cmd,payload: { title: 'Different' } },apply), /idempotency_conflict/);
  assert.throws(() => db.transaction(() => { db.put('task',id(),0,{}); throw Error('crash'); }));
  assert.equal(db.events().length,1);
  assert.throws(() => db.put('task',cmd.aggregateId,0,{}),/stale_revision/);
  assert.deepEqual(db.events(1),[]);
  assert.throws(() => db.events(2),/invalid_cursor/);
  db.close();
});
