import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Ledger } from '../core/ledger.js';
import { id } from '../core/contracts.js';
import { Coordinator } from '../gateway/coordinator.js';
import { Workspace } from '../artifacts/files.js';
import { Gate } from './trust.js';
import { RunStart } from '../pi-worker/contracts.js';
import { outpostSystemPrompt } from '../pi-adapter/system-prompt.js';

function fixture(t: test.TestContext, mode = 'auto') {
  const root = mkdtempSync(join(tmpdir(), 'outpost-auto-')), db = new Ledger();
  const coordinator = new Coordinator(db, root, { unrestrictedCommands: true, browser: {} });
  const task = coordinator.tasks.create(id(), { goal: 'Test Auto boundaries', profile: 'code', mode });
  const gate = coordinator.gate(task.id);
  db.put('device', 'owner', 0, { revoked: false });
  t.after(async () => { await coordinator.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const propose = (tool: string, args: unknown) => gate.propose(task.id, tool, args);
  const decide = (action: Awaited<ReturnType<Gate['propose']>>, decision = 'approve') => gate.decide(action.id, action.revision, 'owner', { nonce: action.data.nonce, actionDigest: action.data.actionDigest, decision });
  let calls = 0;
  gate.register('fixture.effect', { version: 1, effects: ['workspace.read'], parse: () => ({}), target: () => 'fixture', execute: async () => { calls++; return 'observed'; } });
  return { root, db, coordinator, task, gate, propose, decide, calls: () => calls };
}

test('Auto certifies exact system read argv, never shells, scripts, PATH lookups, or executable-name spoofing', async t => {
  const f = fixture(t);
  for (const argv of [['/bin/ls'], ['/bin/ls', '-la'], ['/bin/pwd'], ['/usr/bin/id', '-u']]) {
    const action = await f.propose('command.run', { argv });
    assert.equal(action.data.state, 'authorized', JSON.stringify(argv));
  }
  for (const argv of [
    ['ls'], ['./ls'], ['/tmp/ls'], ['/bin/bash', '-lc', 'ls'], ['/bin/sh', '-c', 'echo safe; rm -rf .'],
    ['/usr/bin/env', '/bin/ls'], ['/bin/ls', '--format=anything'], ['/usr/bin/id', ';touch'],
    ['/usr/bin/python3', 'read.py'], ['/usr/bin/node', '-e', 'console.log(1)'], ['/usr/bin/npm', 'run', 'build'],
    ['/usr/bin/git', 'status'], ['/usr/bin/sudo', '/usr/bin/id'],
  ]) assert.equal((await f.propose('command.run', { argv })).data.state, 'pending', JSON.stringify(argv));
  await assert.rejects(f.propose('command.run', { argv: ['/bin/ls'], cwd: '../escape' }), /path_escape/);
});

test('workspace edits: ordinary source is routine, credentials/config/hooks and destructive rewrites are reviewed', async t => {
  const f = fixture(t), workspace = new Workspace(join(f.root, 'workspaces', f.task.id));
  const source = await f.propose('file.write', { path: 'src/main.ts', text: 'export const value = 1;\n', expectedHash: null });
  assert.equal(source.data.state, 'authorized');
  assert.equal((await f.gate.dispatch(source.id)).data.state, 'succeeded');
  for (const path of ['.env', '.env.local', '.ssh/authorized_keys', '.git/hooks/pre-commit', '.pi/settings.json', 'auth.ts', 'src/settings.ts', 'hooks/index.ts', 'package.json', 'secrets.txt', 'src/../.env']) {
    const action = await f.propose('file.write', { path, text: 'sensitive change', expectedHash: null });
    assert.equal(action.data.state, 'pending', path); assert.equal(action.data.classification, 'security', path);
  }
  const previous = workspace.write('large.ts', 'export const previous = true;\n'.repeat(2000), null);
  const clear = await f.propose('file.write', { path: 'large.ts', text: '', expectedHash: previous.hash });
  assert.equal(clear.data.classification, 'destructive');
  assert.equal((await f.propose('file.write', { path: 'scripts/build.ts', text: 'run()', expectedHash: null })).data.state, 'pending');
  symlinkSync(tmpdir(), join(workspace.root, 'outside'));
  await assert.rejects(f.propose('file.write', { path: 'outside/proof.ts', text: 'value', expectedHash: null }), /symlink_forbidden/);
  const fresh = await f.propose('file.write', { path: 'fresh.ts', text: 'export const value = 2;', expectedHash: null });
  workspace.write('fresh.ts', 'concurrent edit', null);
  await assert.rejects(f.gate.dispatch(fresh.id), /file_changed/);
});

test('browser observations/capture may auto; any act, open, clicks, key submission, filling, navigation and scroll never do', async t => {
  const f = fixture(t);
  for (const name of ['browser.observe', 'browser.capture']) assert.equal((await f.propose(name, {})).data.state, 'authorized');
  for (const input of [{ action: 'scroll', y: 200 }, { action: 'click', ref: 'purchase' }, { action: 'fill', ref: 'credential', text: 'secret' }, { action: 'press', key: 'Enter' }, { action: 'navigate', url: 'https://example.com/delete' }, { action: 'close_tab' }])
    assert.equal((await f.propose('browser.act', { observation: 1, input })).data.state, 'pending');
  assert.equal((await f.propose('browser.open', { url: 'https://example.com/subscribe?pay=true' })).data.state, 'pending');
});

test('unknown tools cannot certify safety and all three risk categories need exact approval; protected brokers stay forbidden', async t => {
  const f = fixture(t);
  for (const effect of ['workspace.read', 'financial.purchase', 'financial.transfer', 'financial.subscription', 'destructive.drop', 'security.credentials', 'security.access', 'security.protection']) {
    f.gate.register(effect, { version: 1, effects: [effect], parse: () => ({}), target: () => 'test', execute: async () => null });
    assert.equal((await f.propose(effect, {})).data.state, 'pending', effect);
  }
  for (const [name, effects] of [['payment.pay', ['workspace.read']], ['effect.payment', ['payment.charge']], ['trust.change', ['workspace.write']], ['owner.identity', ['workspace.read']]] as const) {
    f.gate.register(name, { version: 1, effects: [...effects], parse: () => ({}), target: () => 'protected', execute: async () => null });
    await assert.rejects(f.propose(name, {}), /protected_effect/);
  }
  const spoof = new Gate(f.db);
  spoof.register('system.inspect', { version: 1, effects: ['machine.read'], parse: () => ({}), target: () => 'spoof', execute: async () => null });
  assert.equal((await spoof.propose(f.task.id, 'system.inspect', {})).data.state, 'pending');
});

test('one approval returns the action synchronously, queue dispatches once, and a waiting runtime continues with observed result', async t => {
  const f = fixture(t), action = await f.propose('fixture.effect', {});
  let continued = false;
  const waiting = f.gate.awaitDecisionAndDispatch(action.id).then(result => { continued = true; return result; });
  await delay(40); assert.equal(continued, false); assert.equal(f.calls(), 0);
  const approved = f.decide(action);
  assert.equal(approved.id, action.id); assert.equal(approved.revision, action.revision + 1); assert.equal(approved.data.state, 'authorized');
  assert.equal(f.calls(), 0, 'Decision response must not await dispatch');
  assert.throws(() => f.decide(action), /stale_revision/);
  await Promise.all([f.coordinator.drain(), f.coordinator.drain()]);
  const observed = await waiting;
  assert.equal(observed.data.state, 'succeeded'); assert.equal(continued, true); assert.equal(f.calls(), 1);
  await f.coordinator.drain(); await assert.rejects(f.gate.dispatch(action.id), /not_authorized/);
  assert.equal(f.calls(), 1);
});

for (const change of ['nonce', 'digest', 'revision', 'expired', 'tool', 'policy', 'revoked', 'recovery', 'maintenance', 'paused'] as const)
  test(`approval fails closed for ${change}`, async t => {
    const f = fixture(t), action = await f.propose('fixture.effect', {});
    let expected = action.revision;
    const payload = { nonce: action.data.nonce, actionDigest: action.data.actionDigest, decision: 'approve' };
    if (change === 'nonce') payload.nonce = 'wrong';
    if (change === 'digest') payload.actionDigest = 'wrong';
    if (change === 'revision') expected++;
    if (change === 'expired') f.db.put('action', action.id, action.revision, { ...action.data, expiresAt: 0 });
    if (change === 'tool') f.db.put('action', action.id, action.revision, { ...action.data, toolVersion: 2 });
    if (change === 'policy') f.db.put('policy', f.task.id, 1, { mode: 'auto' });
    if (change === 'revoked') f.db.put('device', 'owner', 1, { revoked: true });
    if (change === 'recovery') f.db.put('recovery', 'server', 0, { dispatchEnabled: false });
    if (change === 'maintenance') f.db.put('runtime_update', 'server', 0, { state: 'holding' });
    if (change === 'paused') { const task = f.db.need('task', f.task.id); f.db.put('task', task.id, task.revision, { ...task.data, state: 'paused' }); }
    if (change === 'expired' || change === 'tool') expected++;
    assert.throws(() => f.gate.decide(action.id, expected, 'owner', payload));
    await f.coordinator.drain(); assert.equal(f.calls(), 0);
  });

for (const change of ['revoked', 'policy', 'recovery', 'maintenance', 'paused'] as const)
  test(`queued approval revalidates ${change} before any effect`, async t => {
    const f = fixture(t), action = await f.propose('fixture.effect', {}); f.decide(action);
    if (change === 'revoked') f.db.put('device', 'owner', 1, { revoked: true });
    if (change === 'policy') f.db.put('policy', f.task.id, 1, { mode: 'full_control' });
    if (change === 'recovery') f.db.put('recovery', 'server', 0, { dispatchEnabled: false });
    if (change === 'maintenance') f.db.put('runtime_update', 'server', 0, { state: 'holding' });
    if (change === 'paused') { const task = f.db.need('task', f.task.id); f.db.put('task', task.id, task.revision, { ...task.data, state: 'paused' }); }
    await f.coordinator.drain(); assert.equal(f.calls(), 0);
    await assert.rejects(f.gate.dispatch(action.id));
  });

test('timeout, denial and cancellation settle waiters without dispatch or replay', async t => {
  for (const reason of ['timeout', 'deny', 'cancel']) {
    const f = fixture(t), action = await f.propose('fixture.effect', {});
    const waiting = f.gate.awaitDecisionAndDispatch(action.id);
    if (reason === 'deny') { f.decide(action, 'deny'); assert.equal((await waiting).data.state, 'denied'); }
    else {
      const rejected = assert.rejects(waiting, reason === 'cancel' ? /action_cancelled/ : /expired_action/);
      if (reason === 'cancel') f.gate.stop(f.task.id);
      else f.db.put('action', action.id, action.revision, { ...action.data, expiresAt: 0 });
      await rejected;
    }
    assert.equal(f.db.need('action', action.id).data.state, 'denied');
    await f.coordinator.drain(); assert.equal(f.calls(), 0);
  }
});

test('uncertain execution returns unknown once, never an automatic retry', async t => {
  const f = fixture(t); let attempts = 0;
  f.gate.register('uncertain', { version: 1, effects: ['unknown'], parse: () => ({}), target: () => 'external', execute: async () => { attempts++; throw Error('post-send timeout'); } });
  const action = await f.propose('uncertain', {}), waiting = f.gate.awaitDecisionAndDispatch(action.id);
  f.decide(action); await f.coordinator.drain();
  assert.equal((await waiting).data.state, 'unknown');
  await f.coordinator.drain(); await assert.rejects(f.gate.dispatch(action.id)); assert.equal(attempts, 1);
});

test('active runtime and in-flight tools fence mode changes even after Pause; stopped changes cannot escalate pending work', async t => {
  const f = fixture(t, 'full_control');
  f.gate.startRuntime(f.task.id);
  assert.throws(() => f.gate.changePolicy(f.task.id, 1, 'auto'), /mode_change_requires_stopped/);
  f.gate.finishRuntime(f.task.id);
  const hold = Promise.withResolvers<null>();
  f.gate.register('slow', { version: 1, effects: ['unknown'], parse: () => ({}), target: () => 'slow', execute: () => hold.promise });
  const action = await f.propose('slow', {}), dispatch = f.gate.dispatch(action.id);
  const task = f.db.need('task', f.task.id); f.db.put('task', task.id, task.revision, { ...task.data, state: 'paused' }); f.gate.stop(task.id);
  assert.throws(() => f.gate.changePolicy(task.id, 1, 'auto'), /mode_change_requires_stopped/);
  hold.resolve(null); await dispatch;
  f.gate.changePolicy(task.id, 1, 'auto');
  const paused = f.db.need('task', task.id); f.db.put('task', task.id, paused.revision, { ...paused.data, state: 'queued' });
  const pending = await f.propose('fixture.effect', {});
  const waiting = f.db.need('task', task.id); f.db.put('task', task.id, waiting.revision, { ...waiting.data, state: 'paused' });
  f.gate.changePolicy(task.id, 2, 'full_control');
  assert.equal(f.db.need('action', pending.id).data.state, 'denied'); await assert.rejects(f.gate.dispatch(pending.id));
});

test('startup preserves valid new Auto pending actions/notices but retires pre-restart approved dispatch without replay', async t => {
  const f = fixture(t), pending = await f.propose('fixture.effect', {});
  const staleSteer = f.db.enqueue('task.steer', { taskId: f.task.id, text: 'Do not replay this old continuation' });
  f.coordinator.tasks.recover(); f.coordinator.tasks.recover();
  assert.equal(f.db.db.prepare('SELECT state FROM outbox WHERE id=?').get(staleSteer)?.state, 'done');
  assert.deepEqual(f.db.need('action', pending.id), pending);
  assert.equal(f.db.need('inbox', pending.id).data.state, 'pending');
  const approved = f.decide(pending); f.coordinator.tasks.recover();
  assert.equal(f.db.need('action', pending.id).data.state, 'denied');
  assert.equal(f.db.need('task', f.task.id).data.state, 'paused');
  await f.coordinator.drain(); assert.equal(f.calls(), 0);
  assert.equal(f.db.db.prepare('SELECT state FROM outbox WHERE id=?').get(`approval:${approved.id}`)?.state, 'done');
});

test('capabilities, worker compatibility defaults, recovery mode and prompts describe real limits', async t => {
  const f = fixture(t);
  assert.deepEqual(f.coordinator.runtimeStatus().controlModes, ['full_control', 'auto']);
  assert.equal(f.coordinator.runtimeStatus().autoPolicyVersion, 1);
  const input = { type: 'run.start', runId: id(), taskId: id(), model: { providerId: 'fixture', modelId: 'model' }, prompt: 'Inspect', systemPrompt: 'Fixture' };
  assert.equal(RunStart.parse(input).mode, 'full_control');
  assert.equal(RunStart.parse({ ...input, mode: 'ask_permission' }).mode, 'auto');
  const prompt = outpostSystemPrompt([], undefined, 'auto');
  for (const text of ['financial', 'destructive', 'security', 'unclassified', 'subagents', 'payment', 'Shells']) assert.match(prompt.toLowerCase(), new RegExp(text.toLowerCase()));
  assert.doesNotMatch(prompt, /All tasks run with full_control/);

});

test('coordinator shutdown retires pending gate work and fences admission with coordinator_stopping', async t => {
  const f = fixture(t), pending = await f.propose('fixture.effect', {});
  await f.coordinator.close();
  assert.equal(f.db.need('action', pending.id).data.state, 'denied', 'Close must retire pending work without replay');
  await assert.rejects(f.propose('fixture.effect', {}), /coordinator_stopping/);
  assert.equal(f.db.list('action').length, 1, 'Closing must fence gate admission without creating new actions');
});
