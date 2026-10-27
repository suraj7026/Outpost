import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { Deliveries, githubPRPlan } from './operations.js';
test('post-create provider timeout reconciles one PR and never blindly resubmits',async () => {
  const db = new Ledger(), deliveries = new Deliveries(db); let sends = 0;
  const plan = githubPRPlan('owner/repo','fix','main','a'.repeat(40),'Fix','Evidence');
  const operation = deliveries.prepare('key',plan);
  const provider = { send: async () => { sends++; throw Error('timeout after create'); },lookup: async () => ({ providerId: 'PR-42',result: { url: 'https://github.com/owner/repo/pull/42' } }) };
  await deliveries.send('key',operation.data.hash,provider);
  await assert.rejects(deliveries.send('key',operation.data.hash,provider));
  const result = await deliveries.reconcile('key',provider); assert.equal(result.data.providerId,'PR-42'); assert.equal(sends,1);
  assert.throws(() => deliveries.prepare('key',{ ...plan,revision: 'b'.repeat(40) })); db.close();
});
