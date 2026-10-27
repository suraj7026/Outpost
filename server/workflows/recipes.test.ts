import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { Workflows } from './recipes.js';
test('personal errands retain one task, explicit effects and evidence-backed dependencies',() => {
  const db = new Ledger(), workflows = new Workflows(db);
  const input = { title: 'Collect invoices',taskId: 'task',identityId: 'agent',steps: [{ key: 'collect',title: 'Collect sources',dependsOn: [],effect: 'read' },{ key: 'report',title: 'Prepare report',dependsOn: ['collect'],effect: 'prepare' }] };
  const workflow = workflows.prepare(input); assert.deepEqual(workflows.ready(workflow.id).map(step => step.key),['collect']);
  assert.throws(() => workflows.verify(workflow.id,1,'collect',[]));
  db.put('artifact','source',0,{ taskId: 'task' }); workflows.verify(workflow.id,1,'collect',['source']);
  assert.deepEqual(workflows.ready(workflow.id).map(step => step.key),['report']);
  assert.throws(() => workflows.prepare({ ...input,steps: [{ ...input.steps[0],dependsOn: ['report'] },input.steps[1]] }),/cyclic_workflow/); db.close();
});
