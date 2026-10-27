import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { Gate } from '../policy/trust.js';
import { ToolRegistry } from './tools.js';
test('discovered connector tools cannot bypass per-action permission',async () => {
  const db = new Ledger(), gate = new Gate(db), registry = new ToolRegistry(gate); let calls = 0;
  gate.changePolicy('task',0,'ask_permission');
  registry.register({ name: 'fixture.read',description: 'Read fixture',pack: 'fixture',version: 1,trust: 'isolated-connector',keywords: ['read'],effects: ['workspace.read'] },{ version: 1,effects: ['workspace.read'],parse: () => ({}),target: () => 'fixture',execute: async () => { calls++; return 'text'; } });
  assert.equal(registry.discover('read').length,1);
  const action = await registry.invoke('task','fixture.read',{}); assert.equal(action.data.state,'pending'); assert.equal(calls,0); db.close();
});
