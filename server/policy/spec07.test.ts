import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { id } from '../core/contracts.js';
import { Ledger } from '../core/ledger.js';
import { Gate } from './trust.js';

async function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  const db = new Ledger(), gate = new Gate(db), taskId = id(), owner = id();
  t.after(() => db.close());
  gate.changePolicy(taskId, 0, 'auto');
  db.put('device', owner, 0, { revoked: false });
  const execute = t.mock.fn(async () => 'observed');
  gate.register('fixture.effect', { version: 1, effects: ['unknown'], parse: () => ({}), target: () => 'fixture', execute });
  const action = await gate.propose(taskId, 'fixture.effect', {});
  assert.equal(action.data.state, 'pending');
  const decide = (decision: 'approve' | 'deny') => gate.decide(action.id, action.revision, owner, {
    decision, nonce: action.data.nonce, actionDigest: action.data.actionDigest,
  });
  return { db, gate, taskId, action, decide, execute };
}

function withoutClockAdvance<T>(waiting: Promise<T>) {
  return Promise.race([waiting, setImmediate().then(() => assert.fail('Approval waiter did not settle before the next event-loop turn'))]);
}

test('spec07: approval waits without polling and observes queued dispatch without advancing the clock', async t => {
  const { db, gate, taskId, action, decide, execute } = await fixture(t);
  const read = t.mock.method(db, 'need');
  const interval = t.mock.method(globalThis, 'setInterval');
  const waiting = gate.awaitDecisionAndDispatch(action.id);
  const initialReads = read.mock.callCount();
  t.mock.timers.tick(1_000);
  assert.equal(interval.mock.callCount(), 0, 'approval wait must not schedule an interval');
  assert.equal(read.mock.callCount(), initialReads, 'idle waiter must not read the ledger periodically');
  assert.equal(execute.mock.callCount(), 0);

  assert.equal(decide('approve').data.state, 'authorized');
  assert.equal(execute.mock.callCount(), 0, 'approval must not execute outside the dispatch queue');
  const dispatched = await gate.dispatch(action.id);
  assert.equal(dispatched.data.state, 'succeeded');
  assert.deepEqual(await withoutClockAdvance(waiting), dispatched);
  assert.equal(execute.mock.callCount(), 1);
  assert.equal(gate.isActive(taskId), false);
});

test('spec07: denial wakes the pending waiter without advancing the clock', async t => {
  const { gate, taskId, action, decide, execute } = await fixture(t);
  const waiting = gate.awaitDecisionAndDispatch(action.id);
  const denied = decide('deny');
  assert.deepEqual(await withoutClockAdvance(waiting), denied);
  assert.equal(execute.mock.callCount(), 0);
  assert.equal(gate.isActive(taskId), false);
});

test('spec07: stop cancels the waiter and retires the action without dispatch', async t => {
  const { db, gate, taskId, action, execute } = await fixture(t);
  const cancelled = assert.rejects(withoutClockAdvance(gate.awaitDecisionAndDispatch(action.id)), /^Error: action_cancelled$/);
  gate.stop(taskId);
  await cancelled;
  assert.equal(db.need('action', action.id).data.state, 'denied');
  assert.equal(execute.mock.callCount(), 0);
  assert.equal(gate.isActive(taskId), false);
});

test('spec07: the expiry deadline retires the pending approval without dispatch', async t => {
  const { db, gate, taskId, action, execute } = await fixture(t);
  const expired = assert.rejects(withoutClockAdvance(gate.awaitDecisionAndDispatch(action.id)), { message: 'expired_action' });
  t.mock.timers.tick(action.data.expiresAt - Date.now() - 1);
  assert.equal(db.need('action', action.id).data.state, 'pending');
  t.mock.timers.tick(1);
  await expired;
  assert.equal(db.need('action', action.id).data.state, 'denied');
  assert.equal(db.need('inbox', action.id).data.state, 'resolved');
  assert.equal(execute.mock.callCount(), 0);
  assert.equal(gate.isActive(taskId), false);
});
