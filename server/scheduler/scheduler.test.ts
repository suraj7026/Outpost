import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { Tasks } from '../tasks/tasks.js';
import { Scheduler, type Schedule } from './scheduler.js';
test('persisted schedules normalize legacy child modes when fired, without duplicate occurrences',() => {
  const db = new Ledger(), scheduler = new Scheduler(db,new Tasks(db));
  try {
    for (const mode of ['ask_permission','auto']) db.put('automation',mode,0,{ name: mode,timezone: 'UTC',nextAt: 1000,intervalMs: null,missed: 'coalesce',paused: false,task: { goal: 'Inspect',profile: 'operations',mode } });
    const started = scheduler.tick(1000);
    assert.equal(started.length,2);
    assert.deepEqual(scheduler.tick(1000),[]);
    for (const taskId of started) assert.equal(db.need('policy',taskId).data.mode,'auto');
    assert.ok(db.list<Schedule>('automation').every(record => record.data.task.mode === 'auto' && record.data.paused));
  } finally { db.close(); }
});

test('server scheduling coalesces missed runs without duplicate tasks and quiet monitors stay quiet',() => {
  const db = new Ledger(), scheduler = new Scheduler(db,new Tasks(db));
  scheduler.save('routine',0,{ name: 'Inspect',timezone: 'UTC',nextAt: 1000,intervalMs: 60000,missed: 'coalesce',task: { goal: 'Inspect service',profile: 'operations' } });
  assert.equal(scheduler.tick(181000).length,1); assert.equal(scheduler.tick(181000).length,0);
  assert.equal(db.list('task').length,1); assert.equal(db.list('policy')[0]?.data.mode,'full_control');
  assert.equal(scheduler.changed('site','one'),false); assert.equal(scheduler.changed('site','one'),false); assert.equal(scheduler.changed('site','two'),true); db.close();
});
