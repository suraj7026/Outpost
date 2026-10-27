import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { Workers } from './coordination.js';
test('children inherit smaller scopes, charged budgets and exclusive resource leases',() => {
  const db = new Ledger(), workers = new Workers(db), scope = { taskId: 'task',identityId: 'agent',resources: ['repo'],tools: ['read'],budget: 10,depth: 0,cancelled: false };
  db.put('worker','parent',0,scope);
  assert.throws(() => workers.delegate('parent',{ ...scope,tools: ['sudo'],depth: 1 },'Review'));
  const child = workers.delegate('parent',{ ...scope,budget: 5,depth: 1 },'Review');
  workers.acquire('repo',child.id,1000); assert.throws(() => workers.acquire('repo','parent',1000));
  workers.cancel('parent'); assert.equal(db.need('worker',child.id).data.cancelled,true); db.close();
});
