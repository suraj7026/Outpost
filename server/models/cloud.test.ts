import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoles, cloudReviewer } from './cloud.js';
import { Ledger } from '../core/ledger.js';
import { Gate } from '../policy/trust.js';
const roles = { operator: 'fixture-operator',reviewer: 'fixture-small',vision: 'fixture-vision',contextWindow: 8192,maxTokens: 1024,qualified: true,qualificationRef: 'fixture-only' };
test('models require distinct qualified roles and Cloud errors fail Auto to ask',async () => {
  assert.throws(() => validateRoles({ ...roles,qualified: false })); assert.throws(() => validateRoles({ ...roles,reviewer: roles.operator }));
  const reviewer = cloudReviewer('fixture-key',roles,async () => new Response('Unavailable',{ status: 503 }));
  const db = new Ledger(), gate = new Gate(db,reviewer); gate.changePolicy('task',0,'auto');
  gate.register('read',{ version: 1,effects: ['workspace.read'],parse: () => ({}),target: () => 'fixture',execute: async () => 'data' });
  assert.equal((await gate.propose('task','read',{})).data.state,'pending'); db.close();
});
