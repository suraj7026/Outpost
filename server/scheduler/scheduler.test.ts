import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { Tasks } from '../tasks/tasks.js';
import { Scheduler } from './scheduler.js';
test('server scheduling coalesces missed runs without duplicate tasks and quiet monitors stay quiet',() => {
  const db = new Ledger(), scheduler = new Scheduler(db,new Tasks(db));
  scheduler.save('routine',0,{ name: 'Inspect',timezone: 'UTC',nextAt: 1000,intervalMs: 60000,missed: 'coalesce',task: { goal: 'Inspect service',profile: 'operations' } });
  assert.equal(scheduler.tick(181000).length,1); assert.equal(scheduler.tick(181000).length,0);
  assert.equal(db.list('task').length,1); assert.equal(db.list('policy')[0]?.data.mode,'ask_permission');
  assert.equal(scheduler.changed('site','one'),false); assert.equal(scheduler.changed('site','one'),false); assert.equal(scheduler.changed('site','two'),true); db.close();
});
