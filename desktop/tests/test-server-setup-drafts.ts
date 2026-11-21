import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDraftController, isDraftEdited, nextSetupLabel, sameSetupTarget, targetForDraft, type DraftPatch } from '../src/server-setup-drafts.ts';
import type { Entry, Scan } from '../src/server-setup-state.ts';

function controller() {
  let id = 0;
  return createDraftController(() => `draft-${++id}`);
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const target = { host: 'server.example', user: 'admin', port: 22, identityFile: null };
const scan: Scan = { id: 'saved-id', fingerprint: 'SHA256:verified', target };
const entry: Entry = { ...scan, label: 'Saved', phase: 'trusted', inspection: null, recommendation: null, endpoint: null, error: null, log: [] };

test('temporary defaults and whitespace do not count; normalization and resetting all editable fields are reversible', () => {
  const store = controller(), id = store.add([], true);
  const initial = store.getSnapshot().drafts[0];
  assert.equal(isDraftEdited(initial), false);
  store.update(id, { host: ' \t', user: ' ', port: '022', identityFile: ' ', label: ' Outpost 1 ' });
  assert.equal(isDraftEdited(store.getSnapshot().drafts[0]), false);
  const changes: DraftPatch[] = [{ label: 'Custom' }, { host: 'server' }, { user: 'admin' }, { port: '2222' }, { port: 'invalid' }, { auth: 'file' }, { identityFile: '/private/key' }];
  for (const patch of changes) {
    store.update(id, patch);
    assert.equal(isDraftEdited(store.getSnapshot().drafts[0]), true, JSON.stringify(patch));
    store.update(id, initial);
    assert.equal(isDraftEdited(store.getSnapshot().drafts[0]), false);
  }
  store.update(id, { label: '   ', port: ' ' });
  assert.equal(isDraftEdited(store.getSnapshot().drafts[0]), false);
});

test('repeated Add reuses the one empty form; only edited drafts contribute to rows and names', () => {
  const store = controller(), id = store.add(['Outpost 1', 'Outpost 3'], true);
  assert.equal(store.add(['Outpost 1', 'Outpost 3'], true), id);
  assert.equal(store.getSnapshot().drafts.filter(isDraftEdited).length, 0);
  store.update(id, { host: 'one.example' });
  const second = store.add(['Outpost 1', 'Outpost 3'], true);
  assert.notEqual(second, id);
  assert.equal(store.getSnapshot().drafts[1].label, 'Outpost 4');
  assert.equal(store.add(['Outpost 1', 'Outpost 3'], true), second);
  assert.equal(store.getSnapshot().drafts.filter(isDraftEdited).length, 1);
});

test('all leave paths share cleanup; edited forms and their order survive close and settings remounts', () => {
  for (const leavePath of ['Close', 'X', 'Escape', 'select setup', 'URL', 'leave settings']) {
    const store = controller(), empty = store.add([], true);
    store.leave(empty);
    assert.deepEqual(store.getSnapshot().drafts, [], leavePath);
    const edited = store.add([], true);
    store.update(edited, { host: 'kept.example' });
    const snapshot = store.getSnapshot();
    const unmount = store.subscribe(() => {});
    unmount(); store.leaveAll();
    const remount = store.subscribe(() => {});
    assert.equal(store.getSnapshot(), snapshot, leavePath);
    remount();
    store.update(edited, { host: '' });
    store.leaveAll();
    assert.equal(store.getSnapshot().drafts.length, 0, 'reset form becomes temporary again');
  }
});

test('generated labels use actual registry, saved and archived labels, gaps and trimmed duplicates', () => {
  assert.equal(nextSetupLabel(['Outpost 1', 'Outpost 3', 'Custom', ' Outpost 1 ', 'Outpost 01']), 'Outpost 2');
  const store = controller();
  const id = store.add(['Outpost 1', 'Outpost 2', 'Outpost 4'], true);
  assert.equal(store.getSnapshot().drafts[0].label, 'Outpost 3');
  store.update(id, { host: 'edited.example' });
  store.add(['Outpost 1', 'Outpost 2', 'Outpost 4'], true);
  assert.equal(store.getSnapshot().drafts[1].label, 'Outpost 5');
});

test('late or failed initial journals do not assign unsafe defaults or overwrite custom input', () => {
  const store = controller(), id = store.add(['Outpost 1'], false);
  assert.equal(store.getSnapshot().drafts[0].label, '');
  assert.equal(store.getSnapshot().drafts[0].defaultLabel, null);
  assert.equal(isDraftEdited(store.getSnapshot().drafts[0]), false);
  store.reconcileNames(['Outpost 1'], false);
  assert.equal(store.getSnapshot().drafts[0].label, '');
  store.update(id, { label: 'My choice' });
  store.reconcileNames(['Outpost 1', 'Outpost 2'], true);
  assert.equal(store.getSnapshot().drafts[0].label, 'My choice');
  assert.equal(isDraftEdited(store.getSnapshot().drafts[0]), true);
  const blank = store.add(['Outpost 1', 'Outpost 2'], false);
  store.reconcileNames(['Outpost 1', 'Outpost 2', 'Outpost 3'], true);
  assert.equal(store.getSnapshot().drafts.find(draft => draft.id === blank)?.label, 'Outpost 4');
});

test('newly observed collisions reassign only automatic draft labels, without renaming user labels', () => {
  const store = controller(), first = store.add([], true);
  store.update(first, { host: 'one' });
  const second = store.add([], true);
  store.update(second, { label: 'Outpost 1', host: 'two' });
  store.reconcileNames(['Outpost 3'], true);
  assert.deepEqual(store.getSnapshot().drafts.map(draft => draft.label), ['Outpost 2', 'Outpost 1']);
  store.reconcileNames(['Outpost 3'], true);
  assert.deepEqual(store.getSnapshot().drafts.map(draft => draft.label), ['Outpost 2', 'Outpost 1']);
});

test('deliberately entered labels are never renamed, including a normalized initial default', () => {
  const store = controller(), id = store.add([], true);
  store.update(id, { label: ' Outpost 1 ' });
  store.reconcileNames(['Outpost 1'], true);
  assert.equal(store.getSnapshot().drafts[0].label, ' Outpost 1 ');
  assert.equal(isDraftEdited(store.getSnapshot().drafts[0]), false);
  store.update(id, { label: 'Custom duplicate' });
  store.reconcileNames(['Custom duplicate'], true);
  assert.equal(store.getSnapshot().drafts[0].label, 'Custom duplicate');
  assert.equal(isDraftEdited(store.getSnapshot().drafts[0]), true);
  store.update(id, { label: '' });
  store.reconcileNames(['Outpost 1'], true);
  assert.equal(store.getSnapshot().drafts[0].label, '', 'reconciliation does not refill a field the user is clearing');
  assert.equal(isDraftEdited(store.getSnapshot().drafts[0]), false);
});

test('discard removes draft, error, busy and order together and fences late picker/scan success and failure', async () => {
  for (const rejects of [false, true]) {
    const store = controller(), id = store.add([], true), result = deferred<string>();
    store.update(id, { host: 'old' });
    const pending = store.operate(id, 'Selecting SSH key', async request => {
      const path = await result.promise;
      request.update({ identityFile: path, scan });
    });
    assert.equal(store.discard(id), true);
    const next = store.add([], true);
    if (rejects) result.reject(new Error('old failure')); else result.resolve('/private/old-key');
    assert.equal(await pending, false);
    assert.deepEqual(store.getSnapshot().drafts.map(draft => draft.id), [next]);
    assert.equal(store.getSnapshot().drafts[0].identityFile, '');
    assert.deepEqual(store.getSnapshot().busy, {});
    assert.deepEqual(store.getSnapshot().errors, {});
    assert.deepEqual(store.getSnapshot().committing, {});
  }
});

test('navigation fences stale reads on edited forms, without erasing or unlocking newer work or peer operations', async () => {
  const store = controller(), a = store.add([], true);
  store.update(a, { host: 'a' });
  const b = store.add([], true); store.update(b, { host: 'b' });
  const old = deferred<void>(), fresh = deferred<void>(), peer = deferred<void>();
  const oldRequest = store.operate(a, 'Old scan', async request => { await old.promise; request.update({ scan }); });
  const peerRequest = store.operate(b, 'Peer scan', async () => { await peer.promise; });
  store.leave(a);
  const newRequest = store.operate(a, 'New scan', async request => { await fresh.promise; request.update({ scan: { ...scan, id: 'fresh' } }); });
  old.resolve(); await oldRequest;
  assert.deepEqual(store.getSnapshot().busy, { [a]: 'New scan', [b]: 'Peer scan' });
  assert.equal(store.getSnapshot().drafts[0].scan, null);
  fresh.resolve(); peer.resolve(); await Promise.all([newRequest, peerRequest]);
  assert.equal(store.getSnapshot().drafts[0].scan?.id, 'fresh');
});

test('trust cannot be discarded or edited; closing and unmounting retain a late committed entry', async () => {
  const store = controller(), id = store.add([], true), done = deferred<void>();
  store.update(id, { host: target.host, user: target.user, scan, confirmed: true });
  const saved: Entry[] = [];
  const pending = store.operate(id, 'Trusting host', async () => {
    await done.promise;
    saved.push(entry);
    store.reconcileTrusted(saved);
  }, true);
  assert.equal(await store.operate(id, 'Duplicate trust', async () => assert.fail('duplicate')), false);
  assert.equal(store.discard(id), false);
  store.update(id, { host: 'foreign' });
  store.leaveAll();
  assert.equal(store.getSnapshot().drafts[0].host, target.host);
  assert.equal(store.getSnapshot().committing[id], true);
  done.resolve(); await pending;
  assert.deepEqual(saved, [entry]);
  assert.deepEqual(store.getSnapshot(), { drafts: [], busy: {}, errors: {}, committing: {}, uncertainTrust: {} });
});

test('journal reconciliation removes only matching trusted drafts, never peers or a foreign SSH key/target', () => {
  const store = controller(), id = store.add([], true);
  store.update(id, { host: target.host, user: target.user, scan });
  const peer = store.add([], true);
  for (const foreign of [{ ...entry, id: 'foreign' }, { ...entry, fingerprint: 'foreign' }, { ...entry, target: { ...target, identityFile: '/foreign' } }]) {
    store.reconcileTrusted([foreign]);
    assert.equal(store.getSnapshot().drafts.length, 2);
  }
  store.reconcileTrusted([entry]);
  assert.deepEqual(store.getSnapshot().drafts.map(draft => draft.id), [peer]);
});

test('trust failure keeps edited input and error until an explicit retry or discard', async () => {
  const store = controller(), id = store.add([], true);
  store.update(id, { host: 'one' });
  assert.equal(await store.operate(id, 'Trusting host', async () => { throw new Error('trust refused'); }, true), false);
  assert.equal(store.getSnapshot().committing[id], undefined);
  assert.match(store.getSnapshot().errors[id], /trust refused/);
  store.leaveAll();
  assert.equal(store.getSnapshot().drafts.length, 1);
  store.discard(id);
  assert.deepEqual(store.getSnapshot().errors, {});
});

test('unreconciled trust stays protected across unmount until a fresh journal establishes its outcome', async () => {
  const store = controller(), id = store.add([], true);
  store.update(id, { host: target.host, user: target.user, scan, confirmed: true });
  await store.operate(id, 'Trusting host', async request => {
    request.keepTrustPending();
    throw new Error('Trust reply lost and journal unavailable');
  }, true);
  store.leaveAll();
  assert.equal(store.discard(id), false);
  assert.equal(store.getSnapshot().uncertainTrust[id], true);
  assert.equal(store.getSnapshot().committing[id], true);
  store.resolveUncertainTrust(id);
  assert.equal(store.getSnapshot().uncertainTrust[id], undefined);
  assert.equal(store.getSnapshot().committing[id], undefined);
  assert.equal(store.discard(id), true);
});

test('SSH target validation includes private key identity and never relaxes host checks', () => {
  const store = controller(), id = store.add([], true);
  assert.throws(() => targetForDraft(store.getSnapshot().drafts[0]), /Enter a server name/);
  store.update(id, { host: ' [2001:db8::1] ', user: ' admin ', port: '2222', auth: 'file', identityFile: ' /private/key ' });
  assert.deepEqual(targetForDraft(store.getSnapshot().drafts[0]), { host: '2001:db8::1', user: 'admin', port: 2222, identityFile: '/private/key' });
  assert.equal(sameSetupTarget(target, { ...target, identityFile: '/another-key' }), false);
  for (const host of ['-option', 'user@host', 'bad host', '/path']) {
    store.update(id, { host });
    assert.throws(() => targetForDraft(store.getSnapshot().drafts[0]));
  }
});
