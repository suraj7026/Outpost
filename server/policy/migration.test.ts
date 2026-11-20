import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { id } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
import { Coordinator } from '../gateway/coordinator.js';
import { InferenceConfiguration } from '../models/inference.js';
import { PiRuntime } from '../pi-adapter/runtime.js';
import { Tasks, type Task } from '../tasks/tasks.js';
import { Gate, type Action } from './trust.js';
import type { Schedule } from '../scheduler/scheduler.js';
import type { RecordValue } from '../core/contracts.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'outpost-approval-migration-')), db = new Ledger(join(root, 'ledger.sqlite'));
  const tasks = new Tasks(db), gate = new Gate(db);
  let effects = 0;
  const tool = { version: 1, effects: ['workspace.read'], parse: () => ({}), target: () => 'fixture', execute: async () => { effects++; return 'observed'; } };
  gate.register('fixture.effect', tool);
  const create = (state: Task['state'] = 'waiting_for_approval') => {
    const task = tasks.create(id(), { goal: 'Inspect evidence before continuing', profile: 'operations' });
    return db.put<Task>('task', task.id, task.revision, { ...task.data, state });
  };
  const pending = async (taskId: string) => {
    const action = await gate.propose(taskId, 'fixture.effect', {});
    db.put('inbox', action.id, 0, { taskId, category: 'approval', state: 'pending' });
    db.enqueue('notice', { taskId, noticeId: action.id }, `notice:${action.id}`);
    return db.put<Action>('action', action.id, action.revision, { ...action.data, state: 'pending', expiresAt: 1 });
  };
  return { root, db, tasks, gate, tool, create, pending, effects: () => effects, task: undefined as unknown as RecordValue<Task>, coordinator: undefined as unknown as Coordinator,
    close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const command = (type: string, aggregateId: string, expectedRevision: number, payload: object = {}) => ({ protocolVersion: 1, commandId: id(), idempotencyKey: id(), deviceId: id(), issuedAt: Date.now(), type, aggregateId, expectedRevision, payload });
/** Seed the policy at a chosen revision without involving Gate's change semantics. */
const seedPolicy = (gate: Gate, taskId: string, revision: number, mode: 'auto' | 'full_control') =>
  gate.db.put('policy', taskId, gate.db.get('policy', taskId)?.revision ?? 0, { mode }, 'policy.normalized');

test('a compatible pending approval survives a no-op startup recovery and stays pending', async t => {
  const f = fixture();
  f.task = f.create('queued'); seedPolicy(f.gate, f.task.id, 0, 'auto');
  const pending = await f.gate.propose(f.task.id, 'fixture.effect', {});
  assert.equal(f.db.need('action', pending.id).data.state, 'pending');
  assert.equal(f.db.need('task', f.task.id).data.state, 'waiting_for_approval');
  f.tasks.recover(); f.tasks.recover();
  const preserved = f.db.need('action', pending.id);
  assert.equal(preserved.data.state, 'pending');
  assert.equal(f.db.get('inbox', pending.id)?.data.state, 'pending');
  f.close();
});

test('a preserved pending approval expires cleanly after restart, without a waiter', async t => {
  const f = fixture();
  try {
    f.task = f.create('queued'); seedPolicy(f.gate, f.task.id, 0, 'auto');
    const proposed = await f.gate.propose(f.task.id, 'fixture.effect', {});
    const live = f.db.need<Action>('action', proposed.id);
    f.db.put('action', proposed.id, live.revision, { ...live.data, expiresAt: Date.now() + 150 });
    f.gate.startRuntime(f.task.id);
    const waiting = f.gate.awaitDecisionAndDispatch(proposed.id).then(value => value, error => error);
    await new Promise(resolve => setTimeout(resolve, 250));
    const settled = await waiting;
    const retired = f.db.need('action', proposed.id);
    assert.equal(retired.data.state, 'denied');
    assert.match(String(retired.data.review), /expired|reconcile/i);
    assert.equal(f.db.get('inbox', proposed.id)?.data.state, 'resolved');
    assert.ok(settled instanceof Error);
  } finally { f.close(); }
});

test('startup retires approvals and stale unclaimed work; explicit resume replans without replaying prior effects', async t => {
  const f = fixture();
  let coordinator: Coordinator | undefined;
  try {
    const task = f.create(), pending = await f.pending(task.id);
    const missingNotice = f.db.put<Action>('action', id(), 0, { ...pending.data, expiresAt: 1 });
    const preserved = ['succeeded', 'unknown', 'denied', 'failed'].map(state => f.db.put<Action>('action', id(), 0,
      { ...pending.data, state: state as Action['state'], result: { evidence: state } }));
    const dispatching = f.db.put<Action>('action', id(), 0, { ...pending.data, state: 'dispatching' });
    f.db.put('policy', task.id, 1, { mode: 'ask_permission' });
    const queued = ['task.steer', 'task.resume', 'action.propose', 'action.dispatch'].map(topic => {
      const key = id();
      f.db.put('operation', key, 0, { taskId: task.id, topic, state: 'accepted', error: null });
      f.db.enqueue(topic, { taskId: task.id, actionId: pending.id, tool: 'fixture.effect', arguments: {}, text: 'Stale instruction' }, key);
      return key;
    });
    const uncertain = f.db.enqueue('action.dispatch', { taskId: task.id, actionId: preserved[1]!.id });
    f.db.db.prepare("UPDATE outbox SET state='unknown' WHERE id=?").run(uncertain);
    const claimed = f.db.enqueue('action.dispatch', { taskId: task.id, actionId: dispatching.id });
    f.db.db.prepare("UPDATE outbox SET state='claimed' WHERE id=?").run(claimed);
    const inference = InferenceConfiguration.parse({ baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' });
    coordinator = new Coordinator(f.db, f.root, { inference });
    assert.equal(f.db.need('policy', task.id).data.mode, 'auto');
    assert.equal(f.db.need('task', task.id).data.state, 'paused');
    assert.match(String(f.db.need('task', task.id).data.blocker), /Explicitly resume.*reconcile/);
    for (const action of [pending, missingNotice]) assert.equal(f.db.need('action', action.id).data.state, 'denied');
    for (const record of preserved) assert.deepEqual(f.db.need('action', record.id), record);
    assert.equal(f.db.need('action', dispatching.id).data.state, 'unknown');
    assert.equal(f.db.need('inbox', pending.id).data.state, 'resolved');
    for (const key of queued) {
      assert.equal(f.db.db.prepare('SELECT state FROM outbox WHERE id=?').get(key)?.state, 'done');
      assert.equal(f.db.need('operation', key).data.state, 'cancelled');
    }
    for (const key of [uncertain, claimed]) assert.equal(f.db.db.prepare('SELECT state FROM outbox WHERE id=?').get(key)?.state, 'unknown');
    const cursor = f.db.cursor();
    coordinator.live.close();
    coordinator = new Coordinator(f.db, f.root, { inference });
    assert.equal(f.db.cursor(), cursor, 'Migration must be idempotent across restarts');
    const current = coordinator;
    const gate = current.gate(task.id); gate.register('fixture.effect', f.tool);
    const finished = Promise.withResolvers<void>();
    let runs = 0;
    t.mock.method(PiRuntime.prototype, 'run', async (taskId: string) => {
      runs++;
      try {
        const fresh = await gate.propose(taskId, 'fixture.effect', {});
        assert.equal(fresh.data.state, 'pending');
                assert.equal(f.effects(), 0);
        finished.resolve();
      } catch (error) { finished.reject(error); throw error; }
    });
    await current.drain();
    assert.equal(runs, 0); assert.equal(f.effects(), 0);
    assert.throws(() => current.command(command('approval.decide', pending.id, pending.revision,
      { nonce: pending.data.nonce, actionDigest: pending.data.actionDigest, decision: 'approve' })), { code: 'stale_revision' });
    const paused = f.db.need('task', task.id);
    current.command(command('task.resume', task.id, paused.revision));
    await current.drain(); await finished.promise;
    assert.equal(runs, 1); assert.equal(f.effects(), 0);
    for (const record of [pending, missingNotice, ...preserved, dispatching]) await assert.rejects(gate.dispatch(record.id), /not_authorized/);
    for (const record of preserved) assert.deepEqual(f.db.need('action', record.id), record);
    assert.equal(f.db.list('inbox').filter(row => row.data.state === 'pending').length, 1, 'Fresh Auto work is reviewed, not escalated on resume');
  } finally { coordinator?.live.close(); f.close(); }
});

test('migration normalizes stored policies/schedules, clears orphan approval notices and preserves terminal/manual holds', async () => {
  const f = fixture();
  let coordinator: Coordinator | undefined;
  try {
    const tasks = [];
    for (const state of ['completed', 'cancelled', 'paused', 'reconciling', 'waiting_for_approval'] as const) {
      const task = f.create();
      await f.pending(task.id);
      const saved = f.db.put<Task>('task', task.id, task.revision, { ...task.data, state, blocker: 'Existing hold', evidence: ['keep'] });
      tasks.push(saved);
      f.db.put('policy', task.id, 1, { mode: 'auto' });
    }
    const orphan = f.create();
    f.db.put('inbox', 'orphan', 0, { taskId: orphan.id, category: 'approval', state: 'pending' });
    f.db.enqueue('notice', { noticeId: 'orphan', taskId: orphan.id }, 'orphan-notice');
    const login = f.db.put('inbox', 'login', 0, { taskId: orphan.id, category: 'login', state: 'pending' });
    for (const mode of ['ask_permission', 'auto']) f.db.put('automation', mode, 0, {
      name: mode, timezone: 'UTC', nextAt: 1000, intervalMs: 60000, missed: 'coalesce', paused: mode === 'auto',
      task: { goal: 'Inspect scheduled service', profile: 'operations', mode },
    });
    coordinator = new Coordinator(f.db, f.root);
    for (const task of tasks) {
      if (task.data.state === 'waiting_for_approval') assert.equal(f.db.need('task', task.id).data.state, 'paused');
      else assert.deepEqual(f.db.need('task', task.id), task);
    }
    assert.equal(f.db.need('task', orphan.id).data.state, 'paused');
    assert.equal(f.db.need('inbox', 'orphan').data.state, 'resolved');
    assert.equal(f.db.db.prepare("SELECT state FROM outbox WHERE id='orphan-notice'").get()?.state, 'done');
    assert.deepEqual(f.db.need('inbox', 'login'), login);
    assert.ok(tasks.every(task => f.db.need('policy', task.id).data.mode === 'auto'));
    for (const mode of ['ask_permission', 'auto']) {
      const schedule = f.db.need<Schedule>('automation', mode).data;
      assert.equal(schedule.task.mode, 'auto');
      assert.equal(schedule.paused, mode === 'auto'); assert.equal(schedule.nextAt, 1000);
    }
    assert.equal(f.db.list('occurrence').length, 0, 'Startup must not fire schedules');
    const children = coordinator.scheduler.tick(1000);
    assert.equal(children.length, 1);
    assert.equal(f.db.need('policy', children[0]!).data.mode, 'auto');
    assert.deepEqual(coordinator.scheduler.tick(1000), []);
  } finally { coordinator?.live.close(); f.close(); }
});

for (const recovery of [false, 'malformed']) test(`approval migration and explicit resume do not release recovery hold ${recovery}`, async () => {
  const f = fixture();
  let coordinator: Coordinator | undefined;
  try {
    const task = f.create(); await f.pending(task.id);
    const hold = f.db.put('recovery', 'server', 0, { dispatchEnabled: recovery });
    coordinator = new Coordinator(f.db, f.root);
    coordinator.command(command('task.resume', task.id, f.db.need('task', task.id).revision));
    await coordinator.drain();
    assert.deepEqual(f.db.need('recovery', 'server'), hold);
    assert.equal(f.db.need('task', task.id).data.state, 'queued');
    assert.equal(f.effects(), 0);
  } finally { coordinator?.live.close(); f.close(); }
});

test('approval retirement keeps a prepared maintenance checkpoint valid across repeated startups', async () => {
  const f = fixture();
  try {
    const task = f.create('verifying'); await f.pending(task.id);
    f.db.db.prepare("UPDATE outbox SET state='done'").run();
    f.tasks.prepareMaintenance();
    const hold = f.db.need('recovery', 'server');
    f.tasks.recover();
    assert.equal(f.db.need('task', task.id).data.state, 'paused');
    assert.deepEqual(f.db.need('maintenance_checkpoint', 'server').data.tasks, []);
    const cursor = f.db.cursor();
    f.tasks.recover();
    assert.equal(f.db.cursor(), cursor);
    assert.deepEqual(f.db.need('recovery', 'server'), hold);
    f.tasks.finishMaintenance();
    assert.equal(f.db.need('recovery', 'server').data.dispatchEnabled, true);
  } finally { f.close(); }
});
