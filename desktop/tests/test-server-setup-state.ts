import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  createSetupStore, mergeSetupEntry, setupArchiveBlocker,
  type Entry, type InstallPlan, type InstallProgress, type SetupClient,
} from '../src/server-setup-state.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function plan(id: string, patch: Partial<InstallPlan> = {}): InstallPlan {
  return { planId: `plan-${id}`, operationId: `operation-${id}`, environmentId: `environment-${id}`,
    releaseId: 'host-release', sha256: 'a'.repeat(64), size: 1000, expiresAt: 100000,
    browser: true, fullControl: true, coexistenceRequired: false, deviceId: 'device', publicKey: 'key',
    nodeVersion: '24.22.1', ...patch };
}
function progress(id: string, patch: Partial<InstallProgress> = {}): InstallProgress {
  return { operationId: `operation-${id}`, environmentId: `environment-${id}`, releaseId: 'host-release',
    state: 'running', completedSteps: 3, totalSteps: 12, stage: 'Private runtime', startedAt: 100,
    updatedAt: 200, log: ['Three steps complete'], error: null, ...patch };
}
function entry(id: string, patch: Partial<Entry> = {}): Entry {
  return { id, label: `Server ${id}`, target: { host: `${id}.example.test`, user: 'admin', port: 22, identityFile: null },
    fingerprint: `SHA256:${id}`, phase: 'review', inspection: null, recommendation: 'fresh_install_candidate',
    endpoint: null, error: null, log: ['Inspection complete'], ...patch };
}
const installing = (id: string, patch: Partial<InstallProgress> = {}): Entry => entry(id, {
  phase: patch.state === 'complete' ? 'tunnel_ready' : patch.state === 'ready' ? 'installed'
    : ['failed', 'cancelled', 'interrupted'].includes(patch.state ?? '') ? 'installation_stopped' : 'installing',
  plan: plan(id), installation: progress(id, patch),
});

function harness(t: TestContext, historyClient: Pick<SetupClient, 'historyList' | 'historyArchive' | 'historyRestore'> = {}) {
  let clock = 1000, allowed = true, timerId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const journals: ReturnType<typeof deferred<Entry[]>>[] = [];
  const receipts = new Map<string, ReturnType<typeof deferred<Entry>>[]>();
  const calls: string[] = [];
  const client: SetupClient = {
    ...historyClient,
    enabled: () => allowed,
    list: () => { calls.push('setup_list'); const request = deferred<Entry[]>(); journals.push(request); return request.promise; },
    status: id => {
      calls.push(`setup_install_status:${id}`);
      const request = deferred<Entry>();
      receipts.set(id, [...receipts.get(id) ?? [], request]);
      return request.promise;
    },
  };
  const store = createSetupStore(client, {
    now: () => clock,
    journalIntervalMs: 1500, statusIntervalMs: 2500,
    schedule: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { due: clock + delay, callback });
      return () => { timers.delete(id); };
    },
  });
  t.after(() => store.dispose());
  return { store, journals, receipts, calls, timers,
    disable: () => { allowed = false; },
    status: (id: string, index = 0) => {
      const request = receipts.get(id)?.[index];
      assert.ok(request, `Expected receipt request ${id}/${index}`);
      return request;
    },
    advance: async (milliseconds: number) => {
      clock += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= clock && timers.delete(id)) timer.callback();
      }
      await flush();
    },
  };
}

test('stable entry ordering, additive journals, cached snapshots and stable API references', async t => {
  const h = harness(t), { store } = h, initial = store.getSnapshot();
  assert.equal(initial, store.getSnapshot());
  store.replace(entry('b'));
  store.replace(entry('a'));
  store.replace(entry('b', { label: 'Updated B' }));
  const loading = store.reload();
  assert.equal(store.getSnapshot().loading, true);
  assert.equal(store.reload(), loading, 'journal requests are coalesced');
  await flush();
  assert.equal(h.journals.length, 1);
  h.journals[0].resolve([entry('a'), entry('b', { label: 'Journal B' }), entry('c')]);
  await loading;
  assert.deepEqual(store.getSnapshot().entries.map(value => value.id), ['b', 'a', 'c']);
  assert.equal(store.getSnapshot().entries[0].label, 'Journal B');
  const partial = store.reload(); await flush(); h.journals[1].resolve([]); await partial;
  assert.deepEqual(store.getSnapshot().entries.map(value => value.id), ['b', 'a', 'c']);
  for (const method of ['replace', 'operate', 'checkStatus', 'reload', 'reloadHistory', 'archive', 'restore'] as const)
    assert.equal(initial[method], store.getSnapshot()[method]);
  assert.equal(store.getSnapshot().loading, false);
});

test('per-target locks reject duplicates but allow peers and isolate command errors', async t => {
  const { store } = harness(t), a = deferred<void>(), b = deferred<void>();
  const first = store.operate('a', 'Inspecting A', () => a.promise);
  const peer = store.operate('b', 'Inspecting B', () => b.promise);
  let duplicateRan = false;
  assert.equal(await store.operate('a', 'Duplicate', async () => { duplicateRan = true; }), false);
  assert.equal(duplicateRan, false);
  assert.deepEqual(store.getSnapshot().busy, { a: 'Inspecting A', b: 'Inspecting B' });
  a.reject(new Error('A failed'));
  assert.equal(await first, false);
  assert.match(store.getSnapshot().errors.a, /A failed/);
  assert.deepEqual(store.getSnapshot().busy, { b: 'Inspecting B' });
  b.resolve(); assert.equal(await peer, true);
  assert.match(store.getSnapshot().errors.a, /A failed/);
  assert.equal(store.getSnapshot().errors.b, undefined);
  assert.equal(await store.operate('b', 'Failure B', async () => { throw 'B failed'; }), false);
  assert.equal(await store.operate('a', 'Retry A', async () => {}), true);
  assert.equal(store.getSnapshot().errors.a, undefined);
  assert.equal(store.getSnapshot().errors.b, 'B failed');
  assert.deepEqual(store.getSnapshot().busy, {});
});

test('commands invalidate only their target in an older journal, not loading or peer work', async t => {
  const h = harness(t), { store } = h;
  store.replace(entry('a')); store.replace(entry('b'));
  const journal = store.reload(); await flush();
  assert.equal(await store.operate('a', 'Connect A', async () => {
    store.replace(entry('a', { phase: 'tunnel_ready', endpoint: 'http://127.0.0.1:4500' }));
  }), true);
  assert.equal(store.getSnapshot().loading, true);
  h.journals[0].resolve([entry('a'), entry('b', { label: 'Peer advanced' }), entry('c')]);
  await journal;
  assert.equal(store.getSnapshot().entries[0].phase, 'tunnel_ready');
  assert.equal(store.getSnapshot().entries[0].endpoint, 'http://127.0.0.1:4500');
  assert.equal(store.getSnapshot().entries[1].label, 'Peer advanced');
  assert.equal(store.getSnapshot().entries[2].id, 'c');
});

test('journals issued during a command cannot overwrite it, even if the command fails without replace', async t => {
  const h = harness(t), { store } = h, action = deferred<void>();
  store.replace(entry('a')); store.replace(entry('b'));
  const command = store.operate('a', 'Inspecting A', () => action.promise);
  const journal = store.reload(); await flush();
  action.reject(new Error('Inspection failed')); await command;
  h.journals[0].resolve([entry('a', { phase: 'inspecting' }), entry('b', { phase: 'connecting' })]);
  await journal;
  assert.equal(store.getSnapshot().entries[0].phase, 'review');
  assert.equal(store.getSnapshot().entries[1].phase, 'connecting');
  assert.match(store.getSnapshot().errors.a, /Inspection failed/);
  assert.equal(store.getSnapshot().journalError, '');
});

test('a newer command result survives both a late receipt and late journal, while a peer advances', async t => {
  const h = harness(t), { store } = h;
  store.replace(installing('a')); store.replace(installing('b'));
  const journal = store.reload(), a = store.checkStatus('a'), b = store.checkStatus('b'); await flush();
  const complete = installing('a', { state: 'complete', completedSteps: 12, updatedAt: 500 });
  await store.operate('a', 'Finish A', async () => store.replace(complete));
  h.status('a').resolve(installing('a', { completedSteps: 4, updatedAt: 300 }));
  h.status('b').resolve(installing('b', { completedSteps: 6, updatedAt: 400 }));
  await Promise.all([a, b]);
  h.journals[0].resolve([installing('a'), installing('b')]); await journal;
  assert.equal(store.getSnapshot().entries[0], complete);
  assert.equal(store.getSnapshot().entries[1].installation?.completedSteps, 6);
  assert.equal(store.getSnapshot().lastChecked.a, undefined);
  assert.equal(store.getSnapshot().lastChecked.b, 1000);
});

test('stale receipt failures cannot overwrite a subsequent command or touch its peer', async t => {
  const h = harness(t), { store } = h;
  store.replace(installing('a')); store.replace(installing('b'));
  const a = store.checkStatus('a'), b = store.checkStatus('b'); await flush();
  await store.operate('a', 'Cancel A', async () => store.replace(installing('a', { state: 'cancelled', updatedAt: 300 })));
  h.status('a').reject(new Error('Old A error')); h.status('b').reject(new Error('Current B error'));
  await Promise.all([a, b]);
  assert.equal(store.getSnapshot().statusErrors.a, undefined);
  assert.match(store.getSnapshot().statusErrors.b, /Current B error/);
  assert.equal(store.getSnapshot().entries[0].installation?.state, 'cancelled');
});

test('one receipt request per target, parallel peers, separate status/command/journal errors and timestamps', async t => {
  const h = harness(t), { store } = h;
  store.replace(installing('a')); store.replace(installing('b'));
  await store.operate('a', 'Fail command', async () => { throw new Error('Command failure'); });
  const journal = store.reload(), a = store.checkStatus('a'), b = store.checkStatus('b');
  assert.equal(store.checkStatus('a'), a);
  await flush();
  assert.equal(h.receipts.get('a')?.length, 1); assert.equal(h.receipts.get('b')?.length, 1);
  h.journals[0].reject(new Error('Journal failure'));
  h.status('a').reject(new Error('Receipt failure')); h.status('b').resolve(installing('b'));
  await Promise.all([journal, a, b]);
  assert.match(store.getSnapshot().errors.a, /Command failure/);
  assert.match(store.getSnapshot().statusErrors.a, /Receipt failure/);
  assert.match(store.getSnapshot().journalError, /Journal failure/);
  assert.deepEqual(store.getSnapshot().lastChecked, { a: 1000, b: 1000 });
  const retry = store.checkStatus('a'); await flush(); h.status('a', 1).resolve(installing('a', { updatedAt: 300 })); await retry;
  assert.equal(store.getSnapshot().statusErrors.a, undefined);
  assert.match(store.getSnapshot().errors.a, /Command failure/);
  assert.match(store.getSnapshot().journalError, /Journal failure/);
  const recovered = store.reload(); await flush(); h.journals[1].resolve([]); await recovered;
  assert.equal(store.getSnapshot().journalError, '');
  assert.match(store.getSnapshot().errors.a, /Command failure/);
});

test('receipt ID is checked against the requested target rather than the returned entry', async t => {
  const h = harness(t), { store } = h;
  store.replace(installing('a')); store.replace(installing('b'));
  const before = store.getSnapshot().entries;
  const request = store.checkStatus('a'); await flush();
  h.status('a').resolve(installing('b', { completedSteps: 9, updatedAt: 999 })); await request;
  assert.equal(store.getSnapshot().entries, before);
  assert.match(store.getSnapshot().statusErrors.a, /requested target/);
  assert.equal(store.getSnapshot().statusErrors.b, undefined);
});

for (const field of ['operationId', 'environmentId', 'releaseId'] as const) {
  test(`foreign ${field} is rejected in receipts, commands and journals`, async t => {
    const h = harness(t), { store } = h, before = installing('a');
    store.replace(before);
    const foreign = installing('a', { [field]: 'foreign', completedSteps: 9, updatedAt: 900 });
    foreign.plan = { ...plan('a'), [field]: 'foreign' };
    const status = store.checkStatus('a'); await flush(); h.status('a').resolve(foreign); await status;
    assert.equal(store.getSnapshot().entries[0], before);
    assert.match(store.getSnapshot().statusErrors.a, /expected operation/);
    assert.equal(await store.operate('a', 'Bad response', async () => store.replace(foreign)), false);
    assert.match(store.getSnapshot().errors.a, /expected operation/);
    const journal = store.reload(); await flush(); h.journals[0].resolve([foreign, entry('b')]); await journal;
    assert.equal(store.getSnapshot().entries[0], before);
    assert.equal(store.getSnapshot().entries[1].id, 'b');
    assert.match(store.getSnapshot().journalError, /expected operation/);
  });
}

test('pure merge checks expected IDs, internal plan identity and valid receipt counters', () => {
  assert.throws(() => mergeSetupEntry(entry('a'), entry('b'), 'a'), /requested target/);
  assert.throws(() => mergeSetupEntry(undefined, entry(''), ''), /requested target/);
  assert.throws(() => mergeSetupEntry(undefined, installing('a', { operationId: 'foreign' }), 'a'), /match its plan/);
  for (const patch of [{ completedSteps: -1 }, { completedSteps: 13 }, { completedSteps: 1.5 },
    { totalSteps: 0 }, { updatedAt: NaN }, { startedAt: -1 }])
    assert.throws(() => mergeSetupEntry(undefined, installing('a', patch), 'a'), /Invalid installation receipt/);
  assert.throws(() => mergeSetupEntry(installing('a'), installing('a', { totalSteps: 11 }), 'a'), /total number/);
});

test('older steps, timestamps and stage regressions cannot replace newer progress or surrounding entry fields', () => {
  const current = installing('a', { completedSteps: 6, updatedAt: 600 });
  for (const patch of [
    { completedSteps: 5, updatedAt: 700 }, { completedSteps: 7, updatedAt: 500 },
    { completedSteps: 6, updatedAt: 700, state: 'queued' },
    { completedSteps: 6, updatedAt: 700, state: 'authorizing' },
  ]) {
    const old = { ...installing('a', patch), endpoint: 'old-route', phase: 'old-phase', log: ['old log'] };
    assert.equal(mergeSetupEntry(current, old, 'a'), current);
  }
  assert.equal(mergeSetupEntry(current, entry('a'), 'a'), current);
  const fresh = installing('a', { completedSteps: 7, updatedAt: 600 });
  assert.equal(mergeSetupEntry(current, fresh, 'a'), fresh, 'same-millisecond forward progress is accepted');
});

test('ready and complete receipts cannot restart or regress to a stopped state', () => {
  for (const state of ['ready', 'complete']) {
    const current = installing('a', { state, completedSteps: state === 'complete' ? 12 : 10, updatedAt: 500 });
    for (const next of ['authorizing', 'queued', 'running', 'unknown', 'failed', 'ready']) {
      if (next === state) continue;
      const incoming = installing('a', { state: next, completedSteps: 12, updatedAt: 900 });
      assert.equal(mergeSetupEntry(current, incoming, 'a'), current, `${state} must not become ${next}`);
    }
  }
  const ready = installing('a', { state: 'ready', completedSteps: 10, updatedAt: 500 });
  const complete = installing('a', { state: 'complete', completedSteps: 12, updatedAt: 600 });
  assert.equal(mergeSetupEntry(ready, complete, 'a'), complete);
});

test('unknown can resolve to a receipt for the same operation without artificially becoming terminal', () => {
  const unknown = installing('a', { state: 'unknown', completedSteps: 0, updatedAt: 200 });
  for (const state of ['authorizing', 'queued', 'running', 'ready', 'failed', 'cancelled', 'interrupted']) {
    const resolved = installing('a', { state, updatedAt: 200 });
    assert.equal(mergeSetupEntry(unknown, resolved, 'a'), resolved);
  }
});

test('initial local authorizing and unknown receipts resolve even when the host clock is behind the Mac', () => {
  for (const localState of ['authorizing', 'unknown']) {
    for (const localTime of [0, 1_000_000]) {
      const local = installing('a', { state: localState, completedSteps: 0, startedAt: localTime, updatedAt: localTime });
      for (const remoteState of ['queued', 'unknown', 'running', 'ready', 'failed', 'cancelled', 'interrupted']) {
        const remote = installing('a', { state: remoteState, completedSteps: remoteState === 'ready' ? 10 : 0,
          startedAt: 50, updatedAt: 100 });
        assert.equal(mergeSetupEntry(local, remote, 'a'), remote, `${localState} (${localTime}) -> ${remoteState} (100)`);
      }
      const running = installing('a', { completedSteps: 0, startedAt: 50, updatedAt: 100 });
      const observed = mergeSetupEntry(local, running, 'a');
      const stale = installing('a', { completedSteps: 0, startedAt: 50, updatedAt: 99 });
      assert.equal(mergeSetupEntry(observed, stale, 'a'), observed, 'remote freshness applies after the clock handoff');
      assert.equal(mergeSetupEntry(observed, installing('a', {
        state: 'authorizing', completedSteps: 0, updatedAt: 2_000_000,
      }), 'a'), observed, 'a later local timestamp cannot restart authorization');
    }
  }
});

test('cross-clock resolution still rejects step regressions, foreign operations and older nonzero unknown receipts', () => {
  const unknown = installing('a', { state: 'unknown', completedSteps: 4, updatedAt: 600 });
  for (const patch of [{ completedSteps: 3, updatedAt: 700 }, { completedSteps: 4, updatedAt: 599 }])
    assert.equal(mergeSetupEntry(unknown, installing('a', patch), 'a'), unknown);
  for (const field of ['operationId', 'environmentId', 'releaseId'] as const) {
    const local = installing('a', { state: 'unknown', completedSteps: 0, updatedAt: 1_000_000 });
    const foreign = installing('a', { [field]: 'foreign', completedSteps: 0, updatedAt: 100 });
    foreign.plan = { ...plan('a'), [field]: 'foreign' };
    assert.throws(() => mergeSetupEntry(local, foreign, 'a'), /expected operation/);
  }
});

test('ready advances to native completion even when the Mac clock is behind the host', () => {
  const ready = installing('a', { state: 'ready', completedSteps: 10, startedAt: 900_000, updatedAt: 1_000_000 });
  const complete = { ...installing('a', { state: 'complete', completedSteps: 12, startedAt: 900_000, updatedAt: 100 }),
    phase: 'tunnel_ready', endpoint: 'http://127.0.0.1:4500' };
  assert.equal(mergeSetupEntry(ready, complete, 'a'), complete);
  assert.equal(mergeSetupEntry(ready, { ...complete, installation: progress('a', {
    state: 'complete', completedSteps: 9, updatedAt: 100,
  }) }, 'a'), ready, 'completion cannot bypass the count guard');
  for (const state of ['running', 'ready', 'failed', 'cancelled', 'interrupted', 'unknown']) {
    const late = installing('a', { state, completedSteps: 12, updatedAt: 2_000_000 });
    assert.equal(mergeSetupEntry(complete, late, 'a'), complete);
  }
});

test('same-count stale receipts cannot overwrite logs, stages or fields, but unchanged receipts allow route updates', () => {
  const current = installing('a', { completedSteps: 4, updatedAt: 600 });
  for (const updatedAt of [599, 600]) {
    const stale = { ...installing('a', { completedSteps: 4, updatedAt, stage: 'Stale stage', log: ['Stale receipt'] }),
      phase: 'old-phase', endpoint: 'old-route', log: ['Stale journal'] };
    assert.equal(mergeSetupEntry(current, stale, 'a'), current);
  }
  const fresh = installing('a', { completedSteps: 4, updatedAt: 601, log: ['Fresh receipt'] });
  assert.equal(mergeSetupEntry(current, fresh, 'a'), fresh);
  const ambiguous = installing('a', { state: 'unknown', completedSteps: 4, updatedAt: 600 });
  assert.equal(mergeSetupEntry(current, ambiguous, 'a'), current, 'equal freshness cannot erase observed running progress');
  for (const state of ['running', 'ready', 'complete', 'failed']) {
    const original = installing('a', { state, completedSteps: state === 'complete' ? 12 : 10 });
    const reconnected = { ...structuredClone(original), endpoint: 'http://127.0.0.1:4510', phase: 'tunnel_ready' };
    assert.equal(mergeSetupEntry(original, reconnected, 'a'), reconnected, 'unchanged receipt does not freeze connection metadata');
  }
});

test('native ready and complete receipts remain fixed even if a replacement claims a newer timestamp', () => {
  for (const state of ['ready', 'complete']) {
    const current = installing('a', { state, completedSteps: state === 'complete' ? 12 : 10, updatedAt: 600 });
    const changed = { ...current, installation: { ...current.installation!, updatedAt: 700, log: ['Different terminal receipt'] } };
    assert.equal(mergeSetupEntry(current, changed, 'a'), current);
  }
});

test('stopped receipts require strictly newer same-operation recovery, not just a higher step count', () => {
  for (const state of ['failed', 'cancelled', 'interrupted']) {
    const running = installing('a', { completedSteps: 4, updatedAt: 100 });
    const stopped = { ...installing('a', { state, completedSteps: 4, updatedAt: 100 }), phase: 'installation_stopped' };
    assert.equal(mergeSetupEntry(running, stopped, 'a'), stopped, 'native liveness inference can share the remote timestamp');
    for (const [completedSteps, updatedAt] of [[4, 99], [4, 100], [5, 100], [3, 101]]) {
      const stale = installing('a', { completedSteps, updatedAt });
      assert.equal(mergeSetupEntry(stopped, stale, 'a'), stopped, `${state}: ${completedSteps} steps at ${updatedAt}`);
    }
    assert.equal(mergeSetupEntry(stopped, installing('a', { state: 'ready', completedSteps: 10, updatedAt: 100 }), 'a'), stopped);
    assert.equal(mergeSetupEntry(stopped, installing('a', { state: 'authorizing', completedSteps: 4, updatedAt: 1_000_000 }), 'a'), stopped);
    for (const recovery of ['running', 'ready']) {
      const recovered = installing('a', { state: recovery, completedSteps: recovery === 'ready' ? 10 : 4, updatedAt: 101 });
      assert.equal(mergeSetupEntry(stopped, recovered, 'a'), recovered);
      assert.equal(mergeSetupEntry(recovered, stopped, 'a'), recovered, 'late stopped observations cannot undo recovery');
      const foreign = { ...recovered, plan: plan('other'), installation: progress('other', { state: recovery, completedSteps: 10, updatedAt: 102 }) };
      assert.throws(() => mergeSetupEntry(stopped, foreign, 'a'), /expected operation/);
    }
  }
});

test('manual status can recover an unmounted stopped installation and resume active polling', async t => {
  const h = harness(t), { store } = h;
  const stopped = installing('a', { state: 'interrupted', completedSteps: 4, updatedAt: 100 });
  store.replace(stopped); assert.equal(h.timers.size, 0);
  const stale = store.checkStatus('a'); await flush();
  h.status('a').resolve(installing('a', { completedSteps: 5, updatedAt: 100 })); await stale;
  assert.equal(store.getSnapshot().entries[0], stopped); assert.equal(h.timers.size, 0);
  const recovered = store.checkStatus('a'); await flush();
  h.status('a', 1).resolve(installing('a', { completedSteps: 4, updatedAt: 101 })); await recovered;
  assert.equal(store.getSnapshot().entries[0].installation?.state, 'running');
  await h.advance(2500);
  assert.equal(h.receipts.get('a')?.length, 3);
  h.status('a', 2).resolve(installing('a', { state: 'ready', completedSteps: 10, updatedAt: 102 }));
  h.journals[0].resolve([stopped]); await flush();
  assert.equal(store.getSnapshot().entries[0].installation?.state, 'ready');
  assert.equal(h.timers.size, 0);
});

test('new plans are accepted only before installation and cannot bypass the expected first receipt identity', () => {
  const current = entry('a', { plan: plan('a') });
  const newPlan = plan('new', { expiresAt: 200000 });
  const refreshed = entry('a', { plan: newPlan });
  assert.equal(mergeSetupEntry(current, refreshed, 'a'), refreshed);
  assert.equal(mergeSetupEntry(refreshed, current, 'a'), refreshed, 'older plan cannot replace newer one');
  assert.throws(() => mergeSetupEntry(current, { ...refreshed, installation: progress('new') }, 'a'), /expected operation/);
  const firstReceipt = { ...refreshed, installation: progress('new') };
  assert.equal(mergeSetupEntry(refreshed, firstReceipt, 'a'), firstReceipt);
  assert.throws(() => mergeSetupEntry(installing('a'), refreshed, 'a'), /plan cannot be replaced/);
  assert.throws(() => mergeSetupEntry(installing('a'), installing('a', { operationId: 'new' }), 'a'), /match its plan/);
  const changedPlanId = { ...installing('a'), plan: plan('a', { planId: 'new-plan' }) };
  assert.throws(() => mergeSetupEntry(installing('a'), changedPlanId, 'a'), /plan cannot be replaced/);
});

test('shared subscriptions poll once; active work continues after all consumers unmount and stops on terminal', async t => {
  const h = harness(t), { store } = h;
  let notifications = 0;
  const unsubscribeA = store.subscribe(() => { notifications++; });
  const unsubscribeB = store.subscribe(() => { notifications++; });
  await flush(); assert.equal(h.journals.length, 1);
  h.journals[0].resolve([installing('a'), installing('b', { state: 'complete', completedSteps: 12 })]); await flush();
  unsubscribeA(); unsubscribeB();
  const atUnmount = notifications;
  await h.advance(2500);
  assert.equal(h.journals.length, 2);
  assert.equal(h.receipts.get('a')?.length, 1);
  assert.equal(h.receipts.has('b'), false);
  await h.advance(5000);
  assert.equal(h.receipts.get('a')?.length, 1, 'no overlapping remote receipt requests');
  assert.equal(h.journals.length, 2, 'no overlapping journal requests');
  h.journals[1].resolve([installing('a')]); await flush();
  h.status('a').resolve(installing('a', { state: 'ready', completedSteps: 10, updatedAt: 400 })); await flush();
  assert.equal(store.getSnapshot().entries[0].installation?.state, 'ready');
  assert.equal(notifications, atUnmount, 'unmounted subscribers are not called');
  assert.equal(h.timers.size, 0);
  const calls = h.calls.length; await h.advance(10000); assert.equal(h.calls.length, calls);
});

test('an unmounted command retains its target and completes without changing a selected server', async t => {
  const h = harness(t), { store } = h, done = deferred<void>();
  const selectedEnvironmentId = 'environment-a';
  const unsubscribe = store.subscribe(() => {});
  await flush(); h.journals[0].resolve([entry('a'), entry('b')]); await flush();
  const command = store.operate('b', 'Start B', async () => {
    await done.promise;
    store.replace(installing('b'));
  });
  unsubscribe(); done.resolve(); assert.equal(await command, true);
  assert.equal(store.getSnapshot().entries[0].id, 'a');
  assert.equal(store.getSnapshot().entries[1].installation?.environmentId, 'environment-b');
  assert.deepEqual(store.getSnapshot().busy, {});
  await h.advance(2500);
  assert.equal(h.receipts.get('b')?.length, 1);
  assert.equal(h.receipts.has('a'), false);
  assert.equal(selectedEnvironmentId, 'environment-a');
  assert.ok(h.calls.every(call => call === 'setup_list' || call.startsWith('setup_install_status:')));
  h.journals[1].resolve([]); h.status('b').resolve(installing('b', { state: 'failed', updatedAt: 400 })); await flush();
});

test('active target command does not stall journal polling or peer receipt polling', async t => {
  const h = harness(t), { store } = h, done = deferred<void>();
  store.replace(installing('a')); store.replace(installing('b'));
  const command = store.operate('a', 'Authorizing A', () => done.promise);
  await h.advance(2500);
  assert.equal(h.journals.length, 1);
  assert.equal(h.receipts.has('a'), false);
  assert.equal(h.receipts.get('b')?.length, 1);
  h.journals[0].resolve([]); h.status('b').resolve(installing('b', { completedSteps: 4, updatedAt: 400 })); await flush();
  assert.equal(store.getSnapshot().busy.a, 'Authorizing A');
  assert.equal(store.getSnapshot().entries[1].installation?.completedSteps, 4);
  done.resolve(); await command;
});

test('frequent cached journal reads cannot starve a slower remote receipt or suppress its error', async t => {
  const h = harness(t), { store } = h;
  store.replace(installing('a')); store.replace(installing('b'));
  const a = store.checkStatus('a'), b = store.checkStatus('b'); await flush();
  for (let index = 0; index < 3; index++) {
    const journal = store.reload(); await flush();
    h.journals[index].resolve([installing('a'), installing('b')]); await journal;
  }
  h.status('a').resolve(installing('a', { completedSteps: 8, updatedAt: 800 }));
  h.status('b').reject(new Error('Remote receipt timed out'));
  await Promise.all([a, b]);
  assert.equal(store.getSnapshot().entries[0].installation?.completedSteps, 8);
  assert.equal(store.getSnapshot().lastChecked.a, 1000);
  assert.match(store.getSnapshot().statusErrors.b, /Remote receipt timed out/);
  assert.equal(store.getSnapshot().lastChecked.b, 1000);
});

test('only nonterminal receipts are polled, including unknown; plans alone do not request receipts', async t => {
  const h = harness(t), { store } = h;
  for (const state of ['authorizing', 'queued', 'running', 'unknown', 'ready', 'complete', 'failed', 'cancelled', 'interrupted'])
    store.replace(installing(state, { state }));
  store.replace(entry('planned', { plan: plan('planned') }));
  await h.advance(2500);
  assert.deepEqual([...h.receipts.keys()].sort(), ['authorizing', 'queued', 'running', 'unknown']);
  h.journals[0].resolve([]);
  for (const id of h.receipts.keys()) h.status(id).resolve(installing(id, { state: 'cancelled', updatedAt: 400 }));
  await flush(); assert.equal(h.timers.size, 0);
});

test('disabled/browser/recorded clients never issue IPC, run commands or start polling', async t => {
  const h = harness(t), { store } = h; h.disable();
  store.replace(installing('a'));
  const unsubscribe = store.subscribe(() => {});
  await store.reload(); await store.checkStatus('a');
  let invoked = false;
  assert.equal(await store.operate('a', 'Must not run', async () => { invoked = true; }), false);
  await h.advance(10000);
  assert.equal(invoked, false); assert.deepEqual(h.calls, []); assert.equal(h.timers.size, 0);
  assert.equal(store.getSnapshot().loading, false);
  unsubscribe();
});

test('disabling before queued IPC starts prevents even those reserved requests', async t => {
  const h = harness(t), { store } = h;
  store.replace(installing('a'));
  const journal = store.reload(), status = store.checkStatus('a');
  h.disable(); await Promise.all([journal, status]);
  assert.deepEqual(h.calls, []); assert.equal(h.timers.size, 0);
  assert.equal(store.getSnapshot().loading, false);
});

test('a command invalidates a queued receipt before it reaches IPC, without blocking a peer', async t => {
  const h = harness(t), { store } = h;
  store.replace(installing('a')); store.replace(installing('b'));
  const a = store.checkStatus('a'), b = store.checkStatus('b');
  const command = store.operate('a', 'Cancel A', async () => {
    store.replace(installing('a', { state: 'cancelled', updatedAt: 300 }));
  });
  await flush();
  assert.equal(h.receipts.has('a'), false);
  h.status('b').resolve(installing('b')); await Promise.all([a, b, command]);
  assert.equal(store.getSnapshot().entries[0].installation?.state, 'cancelled');
});

test('idle unmount cancels timers but an already pending journal safely populates the persistent store', async t => {
  const h = harness(t), { store } = h;
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications++; });
  await flush(); unsubscribe(); const atUnmount = notifications;
  h.journals[0].resolve([entry('a')]); await flush();
  assert.equal(store.getSnapshot().entries[0].id, 'a');
  assert.equal(store.getSnapshot().loading, false);
  assert.equal(notifications, atUnmount); assert.equal(h.timers.size, 0);
});

test('dispose prevents pending work from notifying subscribers or scheduling more work', async t => {
  const h = harness(t), { store } = h;
  store.replace(installing('a'));
  const request = store.checkStatus('a'); await flush();
  const before = store.getSnapshot(); store.dispose();
  h.status('a').resolve(installing('a', { completedSteps: 8, updatedAt: 800 })); await request;
  assert.equal(store.getSnapshot(), before); assert.equal(h.timers.size, 0);
});

test('initial naming readiness requires journal success and is independent of history support', async t => {
  const h = harness(t), { store } = h;
  const journal = store.reload(), history = store.reloadHistory(); await flush();
  assert.equal(store.getSnapshot().journalReady, false);
  h.journals[0].reject(new Error('journal unavailable'));
  await Promise.all([journal, history]);
  assert.equal(store.getSnapshot().journalReady, false);
  assert.match(store.getSnapshot().journalError, /journal unavailable/);
  assert.match(store.getSnapshot().historyError, /history is unavailable/);
  const retry = store.reload(); await flush();
  h.journals[1].resolve([entry('saved', { label: 'Outpost 1' })]); await retry;
  assert.equal(store.getSnapshot().journalReady, true);
  assert.equal(store.getSnapshot().journalError, '');
  assert.match(store.getSnapshot().historyError, /history is unavailable/);
  assert.equal(store.getSnapshot().entries[0].id, 'saved');
});

test('journal and history have independent flights, loading, errors and snapshots', async t => {
  const response = deferred<string[]>();
  const h = harness(t, { historyList: () => response.promise }), { store } = h;
  store.replace(entry('a'));
  const journal = store.reload(), history = store.reloadHistory();
  assert.equal(store.reloadHistory(), history);
  await flush();
  assert.equal(store.getSnapshot().loading, true);
  assert.equal(store.getSnapshot().historyLoading, true);
  response.resolve(['a']); await history;
  assert.deepEqual(store.getSnapshot().archivedIds, ['a']);
  assert.equal(store.getSnapshot().loading, true);
  assert.equal(store.getSnapshot().historyLoading, false);
  h.journals[0].reject(new Error('bad journal')); await journal;
  assert.equal(store.getSnapshot().entries[0].id, 'a');
  assert.deepEqual(store.getSnapshot().archivedIds, ['a']);
  assert.equal(store.getSnapshot().historyError, '');
  assert.match(store.getSnapshot().journalError, /bad journal/);
});

test('archive and restore preserve native entries, receipts, trust and connection bindings through late journals', async t => {
  const archived = new Set<string>();
  const calls: string[] = [];
  const h = harness(t, {
    historyList: async () => [...archived],
    historyArchive: async id => { calls.push(`archive:${id}`); archived.add(id); return [...archived]; },
    historyRestore: async id => { calls.push(`restore:${id}`); archived.delete(id); return [...archived]; },
  }), { store } = h;
  const saved = entry('a', { ...installing('a', { state: 'failed' }), endpoint: 'http://127.0.0.1:5555' });
  store.replace(saved); store.replace(entry('b'));
  await store.reloadHistory();
  const lateJournal = store.reload(); await flush();
  assert.equal(await store.archive('a'), true);
  assert.equal(store.getSnapshot().entries[0], saved);
  h.journals[0].resolve([saved]); await lateJournal;
  assert.deepEqual(store.getSnapshot().entries.map(value => value.id), ['a', 'b']);
  assert.deepEqual(store.getSnapshot().archivedIds, ['a']);
  assert.equal(await store.restore('a'), true);
  assert.deepEqual(store.getSnapshot().archivedIds, []);
  assert.equal(store.getSnapshot().entries[0], saved);
  assert.deepEqual(calls, ['archive:a', 'restore:a']);
});

test('late history reads and failures cannot undo archive or restore mutations', async t => {
  for (const rejecting of [false, true]) {
    let pending: ReturnType<typeof deferred<string[]>> | undefined;
    const { store } = harness(t, {
      historyList: () => pending?.promise ?? Promise.resolve([]),
      historyArchive: async () => ['a'], historyRestore: async () => [],
    });
    store.replace(entry('a')); await store.reloadHistory();
    pending = deferred<string[]>();
    let history = store.reloadHistory(); await flush();
    assert.equal(await store.archive('a'), true);
    if (rejecting) pending.reject(new Error('old history error')); else pending.resolve([]);
    await history;
    assert.deepEqual(store.getSnapshot().archivedIds, ['a']);
    assert.equal(store.getSnapshot().historyError, '');
    pending = deferred<string[]>(); history = store.reloadHistory(); await flush();
    assert.equal(await store.restore('a'), true);
    pending.resolve(['a']); await history;
    assert.deepEqual(store.getSnapshot().archivedIds, []);
  }
});

test('full-list history mutations are serialized, fence their target, and do not block peer installation work', async t => {
  const result = deferred<string[]>();
  const h = harness(t, { historyList: async () => [], historyArchive: () => result.promise, historyRestore: async () => [] });
  const { store } = h;
  store.replace(entry('a')); store.replace(entry('b')); await store.reloadHistory();
  const archive = store.archive('a');
  assert.equal(store.getSnapshot().historyBusy, 'a');
  assert.equal(await store.archive('b'), false);
  assert.equal(await store.restore('b'), false);
  assert.equal(await store.operate('a', 'Conflict', async () => assert.fail('locked target')), false);
  assert.equal(await store.operate('b', 'Peer', async () => {}), true);
  result.resolve(['a']); assert.equal(await archive, true);
  assert.deepEqual(store.getSnapshot().busy, {});
  assert.equal(store.getSnapshot().historyBusy, '');
});

test('active, unknown, status-unavailable, locally busy and checking targets never issue archive IPC', async t => {
  let archiveCalls = 0;
  const h = harness(t, { historyList: async () => [], historyArchive: async () => { archiveCalls++; return ['a']; } });
  const { store } = h; await store.reloadHistory();
  for (const state of ['running', 'queued', 'authorizing', 'unknown', 'unrecognized']) {
    const id = state;
    store.replace(installing(id, { state }));
    assert.match(setupArchiveBlocker(store.getSnapshot().entries.find(value => value.id === id)!), /Active or unconfirmed/);
    assert.equal(await store.archive(id), false);
  }
  for (const phase of ['inspecting', 'connecting', 'unknown', 'unrecognized']) {
    const id = `phase-${phase}`;
    store.replace(entry(id, { phase }));
    assert.equal(await store.archive(id), false);
  }
  store.replace(installing('a', { state: 'failed' }));
  const action = deferred<void>(), command = store.operate('a', 'Exporting', () => action.promise);
  assert.equal(await store.archive('a'), false);
  action.resolve(); await command;
  const status = store.checkStatus('a'); await flush();
  assert.equal(store.getSnapshot().checkingStatus.a, true);
  assert.equal(await store.archive('a'), false);
  h.status('a').reject(new Error('offline')); await status;
  assert.equal(store.getSnapshot().checkingStatus.a, undefined);
  assert.equal(await store.archive('a'), false);
  assert.match(store.getSnapshot().historyErrors.a, /status is unavailable/);
  assert.equal(archiveCalls, 0);
});

test('native archive refusal leaves entries visible and isolates errors from installation and journal state', async t => {
  const h = harness(t, { historyList: async () => [], historyArchive: async () => { throw new Error('Fresh status is active'); } });
  const { store } = h;
  const saved = installing('a', { state: 'failed' }); store.replace(saved);
  await store.reloadHistory();
  await store.operate('a', 'Original failure', async () => { throw new Error('Original installation error'); });
  assert.equal(await store.archive('a'), false);
  assert.equal(store.getSnapshot().entries[0], saved);
  assert.deepEqual(store.getSnapshot().archivedIds, []);
  assert.match(store.getSnapshot().historyErrors.a, /Fresh status is active/);
  assert.match(store.getSnapshot().errors.a, /Original installation error/);
  assert.equal(store.getSnapshot().journalError, '');
  assert.equal(store.getSnapshot().historyError, '');
});

for (const phase of ['connecting', 'inspecting']) {
  test(`archived completed setup stays archived during ${phase} journal/history reloads and peer history changes`, async t => {
    let archiveCalls = 0;
    const h = harness(t, {
      historyList: async () => ['a'],
      historyArchive: async id => { archiveCalls++; assert.equal(id, 'b'); return ['a', 'b']; },
      historyRestore: async id => { assert.equal(id, 'b'); return ['a']; },
    }), { store } = h;
    const complete = installing('a', { state: 'complete', completedSteps: 12 });
    store.replace(complete); store.replace(entry('b'));
    await store.reloadHistory();
    assert.deepEqual(store.getSnapshot().archivedIds, ['a']);

    const recovering = { ...complete, phase }, journal = store.reload(); await flush();
    h.journals[0].resolve([recovering]); await journal;
    assert.equal(store.getSnapshot().entries[0], recovering);
    assert.deepEqual(store.getSnapshot().archivedIds, ['a'], 'SSH recovery must not undo history cleanup');
    await store.reloadHistory();
    assert.deepEqual(store.getSnapshot().archivedIds, ['a'], 'native archived IDs must remain effective during recovery');
    assert.match(setupArchiveBlocker(recovering), /Active or unconfirmed/);
    assert.equal(await store.archive('a'), false, 'connection/inspection activity still blocks a new archive');
    assert.equal(archiveCalls, 0);

    assert.equal(await store.archive('b'), true);
    assert.deepEqual(store.getSnapshot().archivedIds, ['a', 'b'], 'peer archive replies must not reveal a recovering setup');
    assert.equal(await store.restore('b'), true);
    assert.deepEqual(store.getSnapshot().archivedIds, ['a'], 'peer restore replies must not reveal a recovering setup');
    store.replace({ ...complete, endpoint: 'http://127.0.0.1:5555' });
    await store.reloadHistory();
    assert.deepEqual(store.getSnapshot().archivedIds, ['a']);
    assert.equal(store.getSnapshot().entries[0].installation, complete.installation);
  });

  test(`archived completed setup ${phase} recovery does not invalidate an in-flight history reply`, async t => {
    const response = deferred<string[]>();
    const h = harness(t, { historyList: () => response.promise }), { store } = h;
    const complete = installing('a', { state: 'complete', completedSteps: 12 });
    store.replace(complete);
    const history = store.reloadHistory(), journal = store.reload(); await flush();
    h.journals[0].resolve([{ ...complete, phase }]); await journal;
    response.resolve(['a']); await history;
    assert.equal(store.getSnapshot().historyLoaded, true);
    assert.deepEqual(store.getSnapshot().archivedIds, ['a']);
  });
}

test('only installation activity automatically revives archived history, matching native phase and receipt checks', async t => {
  const observations = [
    ...['installing', 'authorizing', 'unknown'].map(phase => ({ ...installing('a', { state: 'complete', completedSteps: 12 }), phase })),
    ...['running', 'queued', 'authorizing', 'unknown', 'unrecognized'].map(state => ({ ...installing('a', { state }), phase: 'connecting' })),
  ];
  for (const observation of observations) {
    const { store } = harness(t, { historyList: async () => ['a'] });
    store.replace(entry('a')); await store.reloadHistory();
    assert.deepEqual(store.getSnapshot().archivedIds, ['a']);
    store.replace(observation);
    assert.deepEqual(store.getSnapshot().archivedIds, [], `phase=${observation.phase}, receipt=${observation.installation?.state}`);
    await store.reloadHistory();
    assert.deepEqual(store.getSnapshot().archivedIds, [], 'native replies cannot hide an active installation');
  }
});

test('active archived histories reappear on status, journal, commands and effective native history lists', async t => {
  let ids = ['a'];
  const h = harness(t, { historyList: async () => ids }), { store } = h;
  store.replace(installing('a', { state: 'failed', updatedAt: 100 })); await store.reloadHistory();
  assert.deepEqual(store.getSnapshot().archivedIds, ['a']);
  const status = store.checkStatus('a'); await flush();
  h.status('a').resolve(installing('a', { updatedAt: 200 })); await status;
  assert.deepEqual(store.getSnapshot().archivedIds, []);
  await store.reloadHistory();
  assert.deepEqual(store.getSnapshot().archivedIds, [], 'even a stale list cannot hide known active work');
  store.replace(installing('a', { state: 'failed', updatedAt: 300 })); await store.reloadHistory();
  assert.deepEqual(store.getSnapshot().archivedIds, ['a']);
  ids = []; await store.reloadHistory();
  assert.deepEqual(store.getSnapshot().archivedIds, [], 'native effective list revives history without needing a local receipt');
  ids = ['a']; await store.reloadHistory();
  const journal = store.reload(); await flush();
  h.journals[0].resolve([installing('a', { updatedAt: 400 })]); await journal;
  assert.deepEqual(store.getSnapshot().archivedIds, []);
});

test('a late history list cannot re-hide a revived setup even if it has already stopped again', async t => {
  let pending: ReturnType<typeof deferred<string[]>> | undefined;
  const h = harness(t, { historyList: () => pending?.promise ?? Promise.resolve(['a']) }), { store } = h;
  store.replace(installing('a', { state: 'failed', updatedAt: 100 })); await store.reloadHistory();
  pending = deferred<string[]>(); const history = store.reloadHistory(); await flush();
  store.replace(installing('a', { updatedAt: 200 }));
  store.replace(installing('a', { state: 'failed', updatedAt: 300 }));
  pending.resolve(['a']); await history;
  assert.deepEqual(store.getSnapshot().archivedIds, []);
});

test('history polling and errors continue independently while a journal read is stalled', async t => {
  let reads = 0;
  const h = harness(t, { historyList: async () => { reads++; if (reads > 1) throw new Error('history only'); return []; } });
  const unsubscribe = h.store.subscribe(() => {}); await flush();
  assert.equal(reads, 1); assert.equal(h.store.getSnapshot().loading, true);
  await h.advance(1500);
  assert.equal(reads, 2); assert.equal(h.journals.length, 1);
  assert.match(h.store.getSnapshot().historyError, /history only/);
  assert.equal(h.store.getSnapshot().journalError, '');
  unsubscribe();
});

test('archive metadata survives remount/restart-style clients and missing journal entries', async t => {
  const client = { historyList: async () => ['a', 'not-loaded-yet'] };
  const first = harness(t, client), second = harness(t, client);
  first.store.replace(entry('a')); await first.store.reloadHistory();
  await second.store.reloadHistory();
  assert.deepEqual(second.store.getSnapshot().archivedIds, ['a', 'not-loaded-yet']);
  const read = second.store.reload(); await flush(); second.journals[0].resolve([entry('a')]); await read;
  assert.equal(second.store.getSnapshot().entries.length, 1);
  assert.deepEqual(second.store.getSnapshot().archivedIds, ['a', 'not-loaded-yet']);
});

test('malformed history responses cannot erase known archive metadata or journal records', async t => {
  let malformed = false;
  const h = harness(t, { historyList: async () => malformed ? JSON.parse('{"archived":[]}') : ['a'] });
  const { store } = h; store.replace(entry('a')); await store.reloadHistory();
  malformed = true; await store.reloadHistory();
  assert.deepEqual(store.getSnapshot().archivedIds, ['a']);
  assert.equal(store.getSnapshot().entries.length, 1);
  assert.match(store.getSnapshot().historyError, /Invalid setup history response/);
  assert.equal(store.getSnapshot().journalError, '');
  assert.equal(await store.archive('a'), false);
});

test('disabled or disposed stores cannot issue history IPC or apply late mutations', async t => {
  let calls = 0;
  const response = deferred<string[]>();
  const h = harness(t, { historyList: async () => { calls++; return []; }, historyArchive: () => { calls++; return response.promise; } });
  const { store } = h; store.replace(entry('a')); await store.reloadHistory();
  const command = store.archive('a');
  assert.equal(calls, 2);
  const before = store.getSnapshot(); store.dispose();
  response.resolve(['a']); assert.equal(await command, false);
  await store.reloadHistory(); assert.equal(await store.restore('a'), false);
  assert.equal(store.getSnapshot(), before); assert.equal(calls, 2);
  const disabled = harness(t, { historyList: async () => { assert.fail('disabled history'); } });
  const read = disabled.store.reloadHistory(); disabled.disable(); await read;
  assert.equal(disabled.store.getSnapshot().historyError, '');
});
