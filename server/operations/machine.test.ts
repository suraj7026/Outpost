import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminPlan, inventory } from './machine.js';
test('admin previews restrict service scope and declare cooperative boundary',() => {
  assert.equal(inventory().hostRootQualified,false);
  assert.throws(() => adminPlan({ unit: 'ssh.service',verb: 'stop',machineId: 'server',reason: 'test' }));
  const plan = adminPlan({ unit: 'outpost-task-fixture.service',verb: 'restart',machineId: 'server',reason: 'test' });
  assert.deepEqual(plan.argv,['/usr/bin/systemctl','restart','--','outpost-task-fixture.service']);
});
