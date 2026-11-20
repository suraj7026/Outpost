import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controlCommandBlocker, modeChangeActive, savedControlMode, supportsAuto, taskModeBlocker } from './src/control-mode.ts';
import type { ServerRecord } from './src/types.ts';

const supported = { controlModes: ['full_control', 'auto'], autoPolicyVersion: 1 };
const row = (kind: string, id: string, data: ServerRecord['data']): ServerRecord => ({ kind, id, revision: 4, updatedAt: '', data });
const task = row('task', 'task', { state: 'paused' });
const policy = row('policy', 'task', { mode: 'ask_permission' });
const action = row('action', 'action', { taskId: 'task', state: 'pending' });

test('only the exact known capability enables Auto; legacy display never mutates a policy', () => {
  for (const runtime of [undefined, null, {}, { controlModes: ['auto'], autoPolicyVersion: 1 }, { controlModes: ['full_control', 'auto', 'ask_permission'], autoPolicyVersion: 1 },
    { controlModes: ['full_control', 'auto'] }, { ...supported, autoPolicyVersion: 0 }, { ...supported, autoPolicyVersion: 2 }, { controlModes: ['auto', 'auto'], autoPolicyVersion: 1 }]) {
    assert.equal(supportsAuto(runtime), false);
    assert.match(taskModeBlocker([policy], 'task', runtime), /needs a compatible server update/);
  }
  assert.equal(supportsAuto(supported), true);
  assert.equal(supportsAuto({ ...supported, controlModes: ['auto', 'full_control'] }), true);
  assert.equal(savedControlMode('ask_permission'), 'auto');
  assert.equal(savedControlMode('auto'), 'auto');
  assert.equal(savedControlMode('full_control'), 'full_control');
  assert.equal(savedControlMode('other'), null);
  assert.equal(policy.data.mode, 'ask_permission');
});

test('every new Auto command is fail closed, while old-server Full control remains supported', () => {
  for (const kind of ['task.create', 'policy.change', 'automation.save', 'recovery.investigate']) {
    for (const mode of ['auto', 'full_control']) {
      const payload = kind === 'automation.save' ? { task: { mode } } : { mode };
      assert.equal(!!controlCommandBlocker({}, [task, policy], kind, 'task', payload), mode === 'auto');
      assert.equal(controlCommandBlocker(supported, [task, policy], kind, 'task', payload), '');
    }
  }
  assert.equal(controlCommandBlocker({}, [], 'recovery.investigate', 'new-task', { model: 'legacy' }), '');
});

test('cached Auto cannot start or approve work on old servers, but Pause, Cancel and Deny remain available', () => {
  const records = [task, policy, action];
  for (const kind of ['task.resume', 'task.steer', 'action.propose']) assert.ok(controlCommandBlocker({}, records, kind, 'task', {}));
  assert.ok(controlCommandBlocker({}, records, 'approval.decide', 'action', { decision: 'approve' }));
  for (const kind of ['task.pause', 'task.cancel']) assert.equal(controlCommandBlocker({}, records, kind, 'task', {}), '');
  assert.equal(controlCommandBlocker({}, records, 'approval.decide', 'action', { decision: 'deny' }), '');
  assert.equal(controlCommandBlocker(supported, records, 'approval.decide', 'action', { decision: 'approve' }), '');
});

test('waiting runs require Pause and active effects must settle before policy changes', () => {
  for (const state of ['queued', 'running', 'reconciling', 'waiting_for_approval', 'waiting_for_login', 'waiting_for_payment_auth', 'waiting_for_human']) {
    const active = row('task', 'task', { state });
    assert.equal(modeChangeActive(active, []), true, state);
    assert.match(controlCommandBlocker(supported, [active], 'policy.change', 'task', { mode: 'auto' }), /Pause/);
  }
  assert.equal(modeChangeActive(task, [action]), false, 'Paused pending approval is no longer an active runtime');
  assert.equal(modeChangeActive(row('task', 'task', { state: 'waiting_for_capacity' }), []), false, 'Capacity wait has not started a runtime');
  assert.equal(modeChangeActive(task, [row('action', 'effect', { taskId: 'task', state: 'dispatching' })]), true);
  assert.equal(modeChangeActive(task, [row('message', 'stream', { taskId: 'task', streaming: true })]), true);
  assert.equal(modeChangeActive(task, [row('action', 'other', { taskId: 'other', state: 'dispatching' })]), false);
});
