import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../core/ledger.js';
import { Tasks, type Task } from './tasks.js';

test('planned idle checkpoint preserves verifying records exactly and restores prior dispatch state', () => {
  const db = new Ledger(), tasks = new Tasks(db);
  try {
    const task = tasks.create('fixture', { goal: 'Preserve review', profile: 'code' });
    db.db.prepare("UPDATE outbox SET state='done'").run();
    const settled = db.put<Task>('task', task.id, task.revision, { ...task.data, state: 'verifying' });
    tasks.prepareMaintenance();
    assert.equal(db.need('recovery','server').data.dispatchEnabled, false);
    new Tasks(db).recover();
    assert.deepEqual(db.need('task',task.id), settled);
    new Tasks(db).recover();
    assert.deepEqual(db.need('task',task.id), settled, 'Repeated pre-release startup is safe');
    tasks.finishMaintenance();
    assert.equal(db.need('recovery','server').data.dispatchEnabled, true);
    assert.equal(db.need('maintenance_checkpoint','server').data.state, 'completed');
  } finally { db.close(); }
});

test('maintenance refuses active work and changed checkpoint rather than rewriting task history', () => {
  const db = new Ledger(), tasks = new Tasks(db);
  try {
    const task = tasks.create('fixture', { goal: 'Pending', profile: 'code' });
    assert.throws(() => tasks.prepareMaintenance(), /maintenance_tasks_active/);
    db.db.prepare("UPDATE outbox SET state='done'").run();
    const settled = db.put<Task>('task', task.id, task.revision, { ...task.data, state: 'verifying' });
    tasks.prepareMaintenance();
    db.put('task', task.id, settled.revision, { ...settled.data, instructionSequence: 2 });
    assert.throws(() => tasks.recover(), /maintenance_checkpoint_changed/);
    assert.equal(db.need('task',task.id).data.state, 'verifying');
    assert.equal(db.need('recovery','server').data.dispatchEnabled, false);
  } finally { db.close(); }
});
