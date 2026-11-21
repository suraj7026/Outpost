import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createRestartController, restartApplyBlocker, restartBinding, restartErrorPresentation, restartHeld, restartNeedsStop,
  validateRestartReview, validateRestartResult, type RestartCandidate, type RestartClient, type RestartResult, type RestartReview,
} from '../src/server-restart.ts';
import { createDraftController } from '../src/server-setup-drafts.ts';
import { canVisitSetupStage, createSetupStore, mergeSetupEntry, setupArchiveBlocker, setupWasExecuted, type Entry, type InstallPlan } from '../src/server-setup-state.ts';

const plan: InstallPlan = { planId: 'plan-original', operationId: 'operation-original', environmentId: 'environment-original', releaseId: 'release-original',
  sha256: 'a'.repeat(64), size: 1000, expiresAt: 5000, browser: true, fullControl: false, coexistenceRequired: false,
  deviceId: 'device', publicKey: 'public', nodeVersion: '24' };
const working: Entry = { id: 'working', label: 'Server 2', target: { host: 'server.example', port: 22, user: 'new-admin', identityFile: '/new/key' },
  fingerprint: 'SHA256:verified', phase: 'review', inspection: null, recommendation: 'ambiguous_installation', endpoint: null, error: null, log: [] };
const original: Entry = { ...working, id: 'original', label: 'Archived original', target: { ...working.target, user: 'old-admin', identityFile: '/old/key' }, plan,
  installation: { operationId: plan.operationId, environmentId: plan.environmentId, releaseId: plan.releaseId, state: 'failed', completedSteps: 4, totalSteps: 12,
    stage: 'Dependencies failed', startedAt: 10, updatedAt: 100, log: ['Failed 4/12'], error: 'Failed 4/12' } };
const candidate: RestartCandidate = { id: original.id, label: original.label, operationId: plan.operationId, environmentId: plan.environmentId, state: 'failed', completedSteps: 4, totalSteps: 12 };
const review: RestartReview = { reviewId: 'review', resetId: 'reset', sourceId: original.id, host: working.target.host,
  operationId: plan.operationId, environmentId: plan.environmentId, releaseId: plan.releaseId, expiresAt: 5000,
  paths: ['/opt/outpost-native', '/etc/outpost-native', '/var/lib/outpost-native'], services: ['outpost-native-worker.service', 'outpost-native-coordinator.service'],
  accounts: ['user:outpost-coord', 'user:outpost-pi', 'group:outpost-coord', 'group:outpost-workspaces'], preserved: ['/var/lib/outpost-setup/operations', 'Kubernetes', 'SSH', 'Other data'], warnings: ['Native data will be erased.'],
  blockers: [], canReset: true, state: 'failed', completedSteps: 4, totalSteps: 12 };
const fresh: Entry = { ...working, id: 'fresh', phase: 'trusted', inspection: null, recommendation: null, log: ['Restart completed. Review a new plan.'] };
const none = JSON.parse(readFileSync(new URL('../test-fixtures/restart-status-none.json', import.meta.url), 'utf8')) as { state: 'none'; resetId: ''; entry: null; message: string };
const complete: RestartResult = { state: 'complete', resetId: review.resetId, entry: fresh, message: 'Removed and archived original operation.' };
const unknown: RestartResult = { state: 'unknown', resetId: review.resetId, entry: null, message: 'Check restart outcome.' };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(overrides: Partial<RestartClient> = {}) {
  const calls: Array<{ command: string; args: unknown[] }> = [];
  let clock = 1000;
  const client: RestartClient = {
    candidates: async (...args) => { calls.push({ command: 'candidates', args }); return [candidate]; },
    status: async (...args) => { calls.push({ command: 'status', args }); return none; },
    review: async (...args) => { calls.push({ command: 'review', args }); return review; },
    stop: async (...args) => { calls.push({ command: 'stop', args }); },
    apply: async (...args) => { calls.push({ command: 'apply', args }); return unknown; },
    beforeApply: (...args) => { calls.push({ command: 'hold', args }); },
    noPending: (...args) => { calls.push({ command: 'release', args }); },
    ...overrides,
  };
  const store = createRestartController(client, () => clock);
  return { store, calls, client, advance: () => { clock = 6000; }, session: () => store.getSnapshot()[working.id],
    prepare: async () => { await store.open(working); await store.review(working, true); } };
}

test('restart error presentation distinguishes native prompt cancellation, timeout and failures', () => {
  for (const [tag, title, tone] of [
    ['userCancel', 'Authorization cancelled', 'warning'],
    ['timeout', 'Authorization prompt timed out', 'warning'],
    ['unavailable', 'Authorization prompt unavailable', 'warning'],
    ['invalidResponse', 'Authorization response invalid', 'negative'],
    ['requestCancel', 'Authorization request cancelled', 'warning'],
  ]) {
    for (const prefix of ['', 'Error: ']) {
      const error = `${prefix}[localAuthorization:${tag}] Safe native detail; no cleanup was dispatched.`;
      assert.deepEqual(restartErrorPresentation(error), { title, tone });
    }
  }
});

test('prompt process failure codes never imply user cancellation, timeout or a server failure', () => {
  for (const phase of ['pipe', 'spawn', 'read', 'wait', 'exit', 'appleScript']) {
    for (const code of [-128, -1712, -1743, 1, 127]) {
      const error = `[localAuthorization:processFailure:${phase}] The native prompt failed (code ${code}); no cleanup was dispatched.`;
      assert.deepEqual(restartErrorPresentation(error), { title: 'Authorization prompt failed', tone: 'negative' });
    }
  }
});

test('restart request errors are not reported as native prompt Cancel or server execution failures', () => {
  for (const [tag, title] of [
    ['requestCancel', 'Restart request cancelled'],
    ['requestReplaced', 'Restart request needs a fresh review'],
    ['targetChanged', 'Restart request needs a fresh review'],
    ['targetUnverified', 'Restart request needs a fresh review'],
    ['supervisorUnavailable', 'Restart request unavailable'],
    ['transportUnavailable', 'Restart connection unavailable'],
    ['futureReason', 'Restart request could not continue'],
  ]) {
    assert.deepEqual(restartErrorPresentation(`[restartRequest:${tag}] Safe request detail.`), { title, tone: 'warning' });
  }
});

test('server error presentation distinguishes execution and response validation from local authorization', () => {
  for (const [tag, title] of [
    ['serverExecution:review', 'Server restart review failed'],
    ['serverProtocol:review', 'Server review response could not be verified'],
    ['serverExecution:stop', 'Server stop request unconfirmed'],
    ['serverProtocol:stop', 'Server stop response could not be verified'],
    ['serverExecution:apply', 'Server removal outcome unconfirmed'],
    ['serverProtocol:apply', 'Server removal response could not be verified'],
    ['serverExecution:status', 'Server restart outcome unavailable'],
    ['serverProtocol:status', 'Server restart outcome could not be verified'],
  ]) {
    for (const prefix of ['', 'Error: ', 'Could not check restart outcome. ', 'Could not check restart outcome. Error: ']) {
      assert.deepEqual(restartErrorPresentation(`${prefix}[${tag}] Not a local authorization cancellation.`), { title, tone: 'negative' });
    }
  }
  assert.deepEqual(restartErrorPresentation('[serverExecution:review] [localAuthorization:userCancel]'), {
    title: 'Server restart review failed', tone: 'negative',
  });
});

test('restart error classification is cosmetic only and never infers provenance from prose or numeric codes', () => {
  for (const error of [
    '', 'Authorization cancelled', 'The native prompt timed out (-1712)', 'User cancelled (-128)',
    'No pending restart for this verified setup', 'Nothing was removed; removal is allowed',
    'Server failed while prompting for a password', 'Error: [localAuthorization:userCancel',
    '[localAuthorization:userCancel]suffix', '[localAuthorization:unknown] Safe detail.',
    '[localAuthorization:processFailure:] Missing phase.', '[serverProtocol:unknown] Safe detail.',
    'Quoted text: [localAuthorization:userCancel] is not an error tag.',
  ]) {
    assert.deepEqual(restartErrorPresentation(error), { title: 'Restart could not continue', tone: 'negative' });
  }
});

test('first restart opens candidate review using the same no-pending wire fixture as native serialization', async () => {
  const h = harness();
  await h.store.open(working);
  assert.equal(h.session().error, '');
  assert.equal(h.session().reconciled, true);
  assert.equal(h.session().pending, false);
  assert.equal(h.session().result, null);
  assert.deepEqual(h.session().candidates, [candidate]);
  assert.equal(h.session().sourceId, original.id);
  assert.deepEqual(h.calls.map(call => call.command), ['status', 'release', 'candidates']);
});

test('no-pending status is independent of human-readable wording and can recover a previously failed first check', async () => {
  const h = harness({ status: async () => { throw new Error('No pending restart for this verified setup'); } });
  await h.store.open(working);
  assert.equal(h.session().reconciled, false);
  assert.match(h.session().error, /Could not check restart outcome/);
  h.client.status = async () => ({ ...none, message: 'Aucune réinitialisation en cours.' });
  await h.store.open(working);
  assert.equal(h.session().error, '');
  assert.equal(h.session().sourceId, original.id);
  assert.equal(h.calls.some(call => ['review', 'stop', 'apply'].includes(call.command)), false);
});

test('unstructured absence errors and malformed empty results cannot grant permission to restart', async () => {
  for (const message of ['No pending restart for this setup', 'No pending restart for this verified setup', 'Restart journal is unreadable']) {
    for (const error of [message, new Error(message)]) {
      const h = harness({ status: async () => { throw error; } });
      await h.store.open(working);
      assert.equal(h.session().reconciled, false);
      assert.equal(h.calls.some(call => ['release', 'candidates', 'apply'].includes(call.command)), false);
    }
  }
  for (const value of [
    { ...none, resetId: 'unexpected-reset' }, { ...none, entry: fresh },
    { ...none, entry: undefined }, { ...none, message: null },
    { state: 'failed', resetId: '', entry: null, message: 'No pending restart for this setup' },
  ]) {
    const h = harness({ status: async () => value as unknown as typeof none });
    await h.store.open(working);
    assert.equal(h.session().reconciled, false);
    assert.equal(h.calls.some(call => ['release', 'candidates', 'apply'].includes(call.command)), false);
  }
});

test('an apply reply cannot use the status-only none state to clear a deletion hold', async () => {
  const h = harness({ apply: async () => none as unknown as RestartResult });
  await h.prepare(); await h.store.apply(working, working.target.host, true, true);
  assert.equal(h.session().pending, true);
  assert.equal(h.session().result?.state, 'unknown');
  assert.equal(h.session().resetId, review.resetId);
});

test('restart uses the verified current connection and explicitly selected archived operation, not old login details', async () => {
  const h = harness(); await h.prepare();
  assert.deepEqual(h.calls.find(call => call.command === 'review')?.args, [working.id, original.id, true]);
  assert.equal(h.session().review?.completedSteps, 4);
  assert.equal(restartApplyBlocker(working, h.session(), working.target.host, true, 1000), '');
  await h.store.apply(working, working.target.host, true, false);
  assert.deepEqual(h.calls.find(call => call.command === 'apply')?.args, [working.id, review.reviewId, working.target.host, false]);
  assert.equal(h.session().pending, true);
  assert.equal(restartHeld(original, h.store.getSnapshot()), true, 'same host/fingerprint protects archived source despite new login');
  assert.equal(restartHeld({ ...original, target: { ...original.target, host: 'other.example' } }, h.store.getSnapshot()), false);
});

test('multiple candidates require an explicit choice and changing source invalidates the reviewed identity', async () => {
  const second = { ...candidate, id: 'second', operationId: 'second-operation' };
  const h = harness({ candidates: async () => [candidate, second] });
  await h.store.open(working);
  assert.equal(h.session().sourceId, '');
  assert.equal(await h.store.review(working, true), false);
  h.store.choose(working, original.id); await h.store.review(working, true);
  assert.equal(h.session().review?.sourceId, original.id);
  h.store.choose(working, second.id);
  assert.equal(h.session().review, null);
  assert.match(restartApplyBlocker(working, h.session(), working.target.host, true, 1000), /Review the original/);
  assert.equal(await h.store.review(working, true), false, 'old source reply is rejected');
  assert.match(h.session().error, /does not match/);
});

test('typed hostname, explicit approval, expiry, native blockers and current evidence all guard removal', async () => {
  const h = harness(); await h.prepare();
  for (const host of ['', working.target.host.toUpperCase(), ` ${working.target.host}`, 'other.example'])
    assert.match(restartApplyBlocker(working, h.session(), host, true, 1000), /exact hostname/);
  assert.match(restartApplyBlocker(working, h.session(), working.target.host, false, 1000), /Explicitly approve/);
  assert.match(restartApplyBlocker(working, h.session(), working.target.host, true, 5000), /expired/);
  assert.match(restartApplyBlocker({ ...working, plan }, h.session(), working.target.host, true, 1000), /evidence.*changed/);
  assert.match(restartApplyBlocker(working, { ...h.session(), review: { ...review, blockers: ['Mounted subtree'], canReset: false } }, working.target.host, true, 1000), /Mounted subtree/);
  assert.equal(await h.store.apply(working, 'wrong', true, true), false);
  h.advance(); assert.equal(await h.store.apply(working, working.target.host, true, true), false);
  assert.equal(h.calls.filter(call => call.command === 'apply').length, 0);
});

test('review rejects foreign host/source/operation/environment/release and unsafe removal scope', () => {
  const changes: Partial<RestartReview>[] = [
    { host: 'foreign' }, { sourceId: working.id }, { operationId: 'foreign' }, { environmentId: 'foreign' },
    { paths: ['/'] }, { services: ['sshd.service'] }, { accounts: ['root'] }, { completedSteps: 13 }, { expiresAt: NaN },
  ];
  for (const change of changes) assert.throws(() => validateRestartReview(working, candidate, { ...review, ...change }));
  assert.throws(() => validateRestartReview(original, candidate, { ...review, releaseId: 'foreign' }), /release changed/);
  assert.equal(validateRestartReview(working, candidate, review), review);
});

test('changed trusted host, port, user, key and fingerprint never inherit restart review or saved trust', async () => {
  const h = harness(); await h.prepare();
  const entries = [
    { ...working, target: { ...working.target, host: 'foreign' } }, { ...working, target: { ...working.target, port: 2222 } },
    { ...working, target: { ...working.target, user: 'root' } }, { ...working, target: { ...working.target, identityFile: '/other' } },
    { ...working, fingerprint: 'foreign' },
  ];
  for (const entry of entries) {
    assert.notEqual(restartBinding(working), restartBinding(entry));
    assert.match(restartApplyBlocker(entry, h.session(), entry.target.host, true, 1000), /connection changed/);
    assert.throws(() => mergeSetupEntry(working, entry, working.id), /cannot be overwritten/);
  }
});

test('active and unknown installations require explicit scoped stop, then a fresh review before removal', async () => {
  const active = { ...review, state: 'running', canReset: false, blockers: ['Installer active'] };
  const h = harness({ review: async () => active }); await h.prepare();
  for (const state of ['running', 'queued', 'authorizing', 'unknown', 'unexpected']) assert.equal(restartNeedsStop({ ...review, state, canReset: false }), true);
  assert.equal(await h.store.apply(working, working.target.host, true, true), false);
  assert.equal(restartNeedsStop({ ...review, state: 'running', canReset: true }), false, 'live native inactivity proof outranks a stale receipt');
  assert.equal(await h.store.stop(working, false), true);
  assert.deepEqual(h.calls.find(call => call.command === 'stop')?.args, [working.id, original.id, false]);
  assert.equal(h.session().review, null);
  assert.equal(await h.store.apply(working, working.target.host, true, true), false);
  h.client.review = async () => review;
  await h.store.review(working, true);
  assert.equal(restartApplyBlocker(working, h.session(), working.target.host, true, 1000), '');
});

test('declined review/stop authorization never dispatches removal and clears old review', async () => {
  const h = harness({ review: async () => { throw new Error('Authorization cancelled'); } });
  await h.store.open(working);
  assert.equal(await h.store.review(working, true), false);
  assert.equal(h.session().pending, false); assert.equal(h.session().review, null);
  h.client.review = async () => ({ ...review, state: 'running', canReset: false });
  await h.store.review(working, true);
  h.client.stop = async () => { throw new Error('Authorization cancelled'); };
  assert.equal(await h.store.stop(working, true), false);
  assert.equal(h.session().review, null);
  assert.equal(h.calls.filter(call => call.command === 'apply').length, 0);
});

test('double apply is fenced synchronously; close/unsubscribe/remount retain unknown receipt and cannot replay', async () => {
  const reply = deferred<RestartResult>();
  const h = harness({ apply: (...args) => { h.calls.push({ command: 'apply', args }); return reply.promise; } });
  await h.prepare();
  const unsubscribe = h.store.subscribe(() => {});
  const pending = h.store.apply(working, working.target.host, true, true);
  assert.equal(h.session().busy, 'apply'); assert.equal(h.session().pending, true);
  assert.equal(await h.store.apply(working, working.target.host, true, true), false);
  h.store.close(working.id); unsubscribe();
  reply.reject(new Error('SSH reply lost')); await pending;
  assert.equal(h.session().open, false); assert.equal(h.session().result?.state, 'unknown');
  assert.equal(h.session().resetId, review.resetId);
  const remount = h.store.subscribe(() => {});
  h.client.status = async () => unknown;
  await h.store.open(working);
  assert.equal(h.session().pending, true); assert.equal(h.session().open, true);
  assert.equal(await h.store.review(working, true), false);
  assert.equal(await h.store.apply(working, working.target.host, true, true), false);
  assert.equal(h.calls.filter(call => call.command === 'apply').length, 1);
  h.client.status = async () => complete;
  await h.store.check(working);
  assert.equal(h.session().pending, false); assert.equal(h.session().result?.entry, fresh);
  assert.equal(await h.store.apply(working, working.target.host, true, true), false);
  remount();
});

test('reopen queries native durable state even with no local session; unknown/failed hold and transport failures fail closed', async () => {
  for (const state of ['unknown', 'failed'] as const) {
    const h = harness({ status: async () => ({ ...unknown, state }) });
    await h.store.open(working);
    assert.equal(h.session().pending, true);
    assert.equal(h.calls.some(call => call.command === 'candidates'), false);
    assert.equal(await h.store.review(working, true), false);
  }
  const h = harness({ status: async () => { throw new Error('Receipt unavailable'); } });
  await h.store.open(working);
  assert.equal(h.session().reconciled, false);
  assert.match(h.session().error, /Could not check restart outcome/);
  assert.equal(await h.store.review(working, true), false);
  assert.equal(await h.store.apply(working, working.target.host, true, true), false);
});

test('a missing receipt cannot unlock native-fenced history, and a peer absence cannot release another pending host reset', async () => {
  const h = harness({ status: async () => none });
  const fenced = { ...working, phase: 'restart_pending' };
  await h.store.open(fenced);
  assert.equal(h.session().reconciled, false);
  assert.equal(await h.store.review(fenced, true), false);
  assert.equal(h.calls.filter(call => call.command === 'release').length, 0);
  h.client.status = async () => unknown;
  await h.store.open(original);
  h.client.status = async () => none;
  await h.store.open(working);
  assert.equal(h.calls.filter(call => call.command === 'release').length, 0, 'peer durable pending state keeps the host hold');
});

test('only explicit native no-pending result unlocks cancelled apply; no automatic repeat or fresh installation', async () => {
  const h = harness({ status: async () => none, apply: async () => { throw new Error('Authorization cancelled'); } });
  await h.prepare();
  await h.store.apply(working, working.target.host, true, true);
  assert.equal(h.session().pending, true);
  h.client.status = async () => { throw new Error('Network unavailable'); };
  await h.store.check(working); assert.equal(h.session().pending, true);
  h.client.status = async () => none;
  await h.store.check(working);
  assert.equal(h.session().pending, false); assert.equal(h.session().result, null); assert.equal(h.session().review, null);
  assert.ok(h.calls.filter(call => call.command === 'release').length >= 2);
  assert.equal(await h.store.apply(working, working.target.host, true, true), false, 'new review and approval are mandatory');
});

test('late review after closing cannot resurrect consent; in-flight operations are serialized', async () => {
  const reply = deferred<RestartReview>();
  const h = harness({ review: async () => reply.promise });
  await h.store.open(working);
  const pending = h.store.review(working, true);
  assert.equal(await h.store.review(working, true), false);
  assert.equal(await h.store.check(working), false);
  h.store.close(working.id); reply.resolve(review); await pending;
  assert.equal(h.session().review, null); assert.equal(h.session().open, false);
});

test('mismatched reset replies stay unknown and never expose an unapproved fresh entry', async () => {
  const h = harness({ apply: async () => ({ ...complete, resetId: 'foreign' }) }); await h.prepare();
  await h.store.apply(working, working.target.host, true, true);
  assert.equal(h.session().result?.state, 'unknown'); assert.equal(h.session().result?.entry, null);
  for (const entry of [original, { ...fresh, plan }, { ...fresh, installation: original.installation }, { ...fresh, endpoint: 'http://route' },
    { ...fresh, target: { ...fresh.target, host: 'foreign.example' } }, { ...fresh, fingerprint: 'foreign' }, { ...fresh, phase: 'reset' }])
    assert.throws(() => validateRestartResult(working, { ...complete, entry }, review.resetId, original.id));
  assert.throws(() => validateRestartResult(working, { ...unknown, entry: fresh }));
  assert.equal(validateRestartResult(working, complete, review.resetId, original.id), complete);
});

test('same-host peer sessions cannot dispatch a second apply and reconcile one confirmed reset together', async () => {
  const h = harness(); await h.prepare();
  h.client.status = async () => unknown;
  await h.store.open(original);
  assert.equal(await h.store.apply(working, working.target.host, true, true), false);
  assert.match(h.session().error, /Another restart is pending/);
  assert.equal(h.calls.filter(call => call.command === 'apply').length, 0);
  h.client.status = async () => complete;
  await h.store.check(working);
  assert.equal(h.store.getSnapshot()[original.id].pending, false);
  assert.equal(h.store.getSnapshot()[original.id].delivered, true, 'only the working connection owns fresh-entry bookkeeping');
  assert.equal(restartHeld(fresh, h.store.getSnapshot()), false);
  await h.store.open(original);
  assert.equal(h.store.getSnapshot()[original.id].result?.state, 'complete');
  assert.equal(h.store.getSnapshot()[original.id].error, '');
});

test('copying a trusted setup reuses every entered field but not scan/trust/plan; clearing draft fences late scans', async () => {
  let sequence = 0;
  const drafts = createDraftController(() => `draft-${++sequence}`);
  const id = drafts.fromEntry(working), copied = drafts.getSnapshot().drafts[0];
  assert.deepEqual({ host: copied.host, user: copied.user, port: copied.port, key: copied.identityFile, label: copied.label },
    { host: working.target.host, user: working.target.user, port: '22', key: working.target.identityFile, label: working.label });
  assert.equal(copied.scan, null); assert.equal(copied.confirmed, false);
  const scan = { id: 'scan', target: working.target, fingerprint: working.fingerprint };
  drafts.update(id, { scan, confirmed: true });
  drafts.update(id, { user: 'other' });
  assert.equal(drafts.getSnapshot().drafts[0].scan, null); assert.equal(drafts.getSnapshot().drafts[0].confirmed, false);
  const reply = deferred<void>();
  const pending = drafts.operate(id, 'Scanning', async request => { await reply.promise; request.update({ scan, confirmed: true }); });
  assert.equal(drafts.restart(id), true);
  reply.resolve(); await pending;
  assert.equal(drafts.getSnapshot().drafts[0].host, ''); assert.equal(drafts.getSnapshot().drafts[0].scan, null);
  const trust = deferred<void>();
  const saving = drafts.operate(id, 'Saving trust', async () => { await trust.promise; }, true);
  assert.equal(drafts.restart(id), false); trust.resolve(); await saving;
});

test('capability and inspection edits invalidate plans even across stale journal reads; launched plans cannot be edited', async () => {
  const store = createSetupStore({ enabled: () => true, list: async () => [{ ...working, plan }], status: async () => original }, { schedule: () => () => {} });
  try {
    store.replace({ ...working, plan });
    assert.equal(store.invalidatePlan(working.id), true); assert.equal(store.getSnapshot().entries[0].plan, null);
    await store.reload(); assert.equal(store.getSnapshot().entries[0].plan, null);
    store.replace({ ...working, plan: { ...plan, planId: 'new-plan' } });
    assert.equal(store.getSnapshot().entries[0].plan?.planId, 'new-plan');
    store.replace(original); assert.equal(store.invalidatePlan(original.id), false);
    assert.equal(setupWasExecuted(original), true); assert.equal(setupWasExecuted(working), false);
  } finally { store.dispose(); }
});

test('completed step navigation is bounded; reset fences survive late receipts, archive reads and explicit reconnect attempts', async () => {
  for (let stage = 0; stage <= 4; stage++) {
    for (let requested = 0; requested <= 4; requested++) assert.equal(canVisitSetupStage(requested, stage), requested <= stage);
  }
  for (const step of [-1, 1.5, 5, NaN]) assert.equal(canVisitSetupStage(step, 4), false);
  let statusCalls = 0;
  const active = { ...original, installation: { ...original.installation!, state: 'running' } };
  const reset = { ...active, phase: 'reset', endpoint: null };
  const store = createSetupStore({ enabled: () => true, list: async () => [active], status: async () => { statusCalls++; return active; }, historyList: async () => [original.id] }, { schedule: () => () => {} });
  try {
    store.replace(active); store.replace(reset);
    await store.reload(); await store.reloadHistory(); await store.checkStatus(original.id);
    assert.equal(store.getSnapshot().entries[0].phase, 'reset');
    assert.deepEqual(store.getSnapshot().archivedIds, [original.id]); assert.equal(statusCalls, 0);
    assert.equal(await store.operate(original.id, 'Reconnect', async () => assert.fail('retired operation')), false);
    assert.equal(setupArchiveBlocker(reset), '');
  } finally { store.dispose(); }
});

test('native restart_pending fences a reloaded client before local reset session state exists', async () => {
  let statusCalls = 0;
  const pending = { ...original, phase: 'restart_pending', installation: { ...original.installation!, state: 'running' } };
  const store = createSetupStore({ enabled: () => true, list: async () => [original], status: async () => { statusCalls++; return original; }, historyList: async () => [original.id] }, { schedule: () => () => {} });
  try {
    store.replace(pending); await store.reload(); await store.reloadHistory(); await store.checkStatus(original.id);
    assert.equal(store.getSnapshot().entries[0].phase, 'restart_pending'); assert.equal(statusCalls, 0);
    assert.deepEqual(store.getSnapshot().archivedIds, [original.id]);
    assert.match(setupArchiveBlocker(pending), /Check restart outcome/);
    assert.equal(await store.operate(original.id, 'Retry', async () => assert.fail('pending reset')), false);
    store.replace({ ...pending, phase: 'reset' }); assert.equal(store.getSnapshot().entries[0].phase, 'reset');
  } finally { store.dispose(); }
});

test('delivered completion reconciliation does not replay selection or replace newly reviewed work', async () => {
  const h = harness({ apply: async () => complete }); await h.prepare();
  await h.store.apply(working, working.target.host, true, true); h.store.delivered(working.id);
  h.client.status = async () => structuredClone(complete);
  await h.store.open(working);
  assert.equal(h.session().delivered, true); assert.equal(h.session().result?.state, 'complete');
  assert.equal(h.session().result?.entry?.plan, undefined); assert.equal(h.session().error, '');
});

test('pending reset pauses same-host peers, not unrelated systems; confirmed completion fences originals and accepts only a fresh entry', async () => {
  const peer = { ...original, id: 'peer' }, other = { ...original, id: 'other', target: { ...original.target, host: 'elsewhere' } };
  const calls: string[] = [];
  const nativeEntries = [working, original, peer].map(entry => ({ ...entry, phase: 'reset', endpoint: null }));
  const store = createSetupStore({ enabled: () => true, list: async () => [...nativeEntries, other, fresh], status: async id => { calls.push(id); return id === other.id ? other : original; } }, { schedule: () => () => {} });
  try {
    [working, original, peer, other].forEach(store.replace);
    store.holdRestart(working);
    await store.checkStatus(original.id); await store.checkStatus(peer.id); await store.checkStatus(other.id);
    assert.deepEqual(calls, [other.id]);
    assert.equal(await store.operate(working.id, 'Install', async () => assert.fail('held')), false);
    assert.throws(() => store.completeRestart(working, { ...fresh, plan }), /fresh trusted/);
    store.completeRestart(working, fresh);
    await store.reload();
    for (const id of [working.id, original.id, peer.id]) assert.equal(store.getSnapshot().entries.find(entry => entry.id === id)?.phase, 'reset');
    assert.equal(store.getSnapshot().entries.find(entry => entry.id === other.id)?.phase, other.phase);
    const next = store.getSnapshot().entries.find(entry => entry.id === fresh.id)!;
    assert.equal(next.plan, undefined); assert.equal(next.installation, undefined); assert.equal(next.phase, 'trusted');
    assert.equal(await store.operate(fresh.id, 'Read-only inspection', async () => {}), true);
    assert.equal(await store.operate(original.id, 'Old install', async () => assert.fail('old approval')), false);
  } finally { store.dispose(); }
});

test('historical completion after relaunch preserves newer same-host G and its polling/actions', async () => {
  const retired = { ...working, phase: 'reset' };
  const newerPlan = { ...plan, planId: 'plan-G', operationId: 'operation-G', environmentId: 'environment-G' };
  const newer: Entry = { ...working, id: 'G', phase: 'installing', plan: newerPlan,
    installation: { ...original.installation!, operationId: newerPlan.operationId, environmentId: newerPlan.environmentId, state: 'running' } };
  const entries = [retired, fresh, newer];
  const statusCalls: string[] = [];
  const store = createSetupStore({ enabled: () => true, list: async () => entries,
    status: async id => { statusCalls.push(id); return newer; } }, { schedule: () => () => {} });
  try {
    await store.reload();
    const before = store.getSnapshot().entries.find(entry => entry.id === newer.id);
    const relaunched = harness({ status: async () => structuredClone(complete) });
    await relaunched.store.open(retired);
    const result = relaunched.store.getSnapshot()[retired.id].result;
    assert.equal(result?.state, 'complete'); assert.ok(result?.entry);
    store.completeRestart(retired, result.entry);
    assert.equal(store.getSnapshot().entries.find(entry => entry.id === newer.id), before, 'R cannot retire G, which was created after R');
    await store.reload();
    await store.checkStatus(retired.id); await store.checkStatus(newer.id);
    assert.deepEqual(statusCalls, [newer.id]);
    assert.equal(await store.operate(newer.id, 'Current G action', async () => {}), true);
    assert.equal(await store.operate(retired.id, 'Old action', async () => assert.fail('retired setup')), false);
    store.completeRestart(retired, result.entry);
    assert.equal(store.getSnapshot().entries.find(entry => entry.id === newer.id)?.phase, 'installing', 'repeated reconciliation is harmless');
  } finally { store.dispose(); }
});

test('immutable creation receipt after relaunch preserves fresh inspected, planned and executing states', async () => {
  const inspected: Entry = { ...fresh, phase: 'review', recommendation: 'fresh_install_candidate', inspection: {
    os: 'ubuntu', osVersion: '24.04', architecture: 'x86_64', systemd: true, uid: 1000,
    freeBytes: 20 * 1024 ** 3, memoryBytes: 8 * 1024 ** 3, markers: [], sudo: 'required', api: 'absent', environment: null,
  } };
  const currentPlan = { ...plan, planId: 'fresh-plan', operationId: 'fresh-operation', environmentId: 'fresh-environment' };
  const planned: Entry = { ...inspected, plan: currentPlan };
  const executing: Entry = { ...planned, phase: 'installing', installation: {
    ...original.installation!, operationId: currentPlan.operationId, environmentId: currentPlan.environmentId, state: 'running',
  } };
  for (const current of [inspected, planned, executing]) {
    const retired = { ...working, phase: 'reset' };
    const store = createSetupStore({ enabled: () => true, list: async () => [retired, current], status: async () => current }, { schedule: () => () => {} });
    try {
      await store.reload();
      const before = store.getSnapshot().entries.find(entry => entry.id === fresh.id);
      const relaunched = harness({ status: async () => structuredClone(complete) });
      await relaunched.store.open(retired);
      const result = relaunched.store.getSnapshot()[retired.id].result;
      assert.ok(result?.entry); assert.equal(result.entry.inspection, null); assert.equal(result.entry.plan, undefined);
      store.completeRestart(retired, result.entry);
      assert.equal(store.getSnapshot().entries.find(entry => entry.id === fresh.id), before, 'do not install the immutable creation snapshot over current work');
      await store.reload();
      assert.equal(store.getSnapshot().entries.find(entry => entry.id === fresh.id)?.phase, current.phase);
      assert.equal(await store.operate(fresh.id, 'Current fresh setup action', async () => {}), true);
    } finally { store.dispose(); }
  }
});

test('relaunch completion through old source, affected peer or newly verified login preserves actual working credentials', async () => {
  const callers: Entry[] = [
    { ...original, phase: 'reset' },
    { ...original, id: 'affected-peer', phase: 'reset', target: { ...original.target, host: 'SERVER.EXAMPLE.' } },
    { ...working, id: 'newly-verified', phase: 'trusted', target: { ...working.target, user: 'recovery-admin', identityFile: '/recovery/key' } },
  ];
  for (const caller of callers) {
    const h = harness({ status: async () => structuredClone(complete) });
    await h.store.open(caller);
    const session = h.store.getSnapshot()[caller.id];
    assert.equal(session.error, '', caller.id); assert.equal(session.result?.state, 'complete', caller.id);
    assert.deepEqual(session.result?.entry?.target, working.target, 'status uses caller login; the new entry retains the native persisted reset origin');
    assert.equal(h.calls.some(call => ['review', 'stop', 'apply'].includes(call.command)), false);
    const store = createSetupStore({ enabled: () => true, list: async () => [caller, fresh], status: async () => caller }, { schedule: () => () => {} });
    try {
      store.replace(caller);
      assert.ok(session.result?.entry);
      store.completeRestart(caller, session.result.entry);
      assert.deepEqual(store.getSnapshot().entries.find(entry => entry.id === fresh.id)?.target, working.target);
      assert.equal(store.getSnapshot().entries.find(entry => entry.id === caller.id)?.phase, caller.phase, 'status caller is not necessarily part of the reset affected set');
    } finally { store.dispose(); }
  }
});

test('newly verified login reconciles unknown then complete while host/port/pin mismatches remain blocked', async () => {
  const caller = { ...working, id: 'recovery', target: { ...working.target, user: 'recovery', identityFile: '/recovery/key' } };
  const h = harness({ status: async () => unknown });
  await h.store.open(caller);
  assert.equal(h.store.getSnapshot()[caller.id].pending, true);
  h.client.status = async () => complete;
  assert.equal(await h.store.check(caller), true);
  assert.equal(h.store.getSnapshot()[caller.id].pending, false);
  for (const mismatch of [
    { ...fresh, target: { ...fresh.target, host: 'other.example' } },
    { ...fresh, target: { ...fresh.target, port: 2222 } }, { ...fresh, fingerprint: 'SHA256:other' },
  ]) {
    const rejected = harness({ status: async () => ({ ...complete, entry: mismatch }) });
    await rejected.store.open(caller);
    assert.equal(rejected.store.getSnapshot()[caller.id].reconciled, false);
    assert.equal(rejected.store.getSnapshot()[caller.id].result, null);
    assert.match(rejected.store.getSnapshot()[caller.id].error, /fresh trusted/);
    const store = createSetupStore({ enabled: () => true, list: async () => [], status: async () => caller }, { schedule: () => () => {} });
    try { assert.throws(() => store.completeRestart(caller, mismatch), /fresh trusted/); }
    finally { store.dispose(); }
  }
});

test('completion follows a pre-reset journal flight with native affected phases, without guessing from host membership', async () => {
  const stale = deferred<Entry[]>(), authoritative = deferred<Entry[]>();
  let reads = 0;
  const newer: Entry = { ...working, id: 'G', phase: 'trusted' };
  const current: Entry = { ...fresh, phase: 'review', plan: { ...plan, planId: 'fresh-plan', operationId: 'fresh-operation' } };
  const store = createSetupStore({ enabled: () => true,
    list: () => ++reads === 1 ? stale.promise : authoritative.promise,
    status: async () => original,
  }, { schedule: () => () => {} });
  try {
    [working, original, current, newer].forEach(store.replace);
    const oldRead = store.reload();
    await Promise.resolve(); assert.equal(reads, 1);
    store.completeRestart(working, structuredClone(fresh));
    assert.equal(store.getSnapshot().entries.find(entry => entry.id === original.id)?.phase, original.phase, 'do not invent affected phases before the native read');
    assert.equal(store.getSnapshot().entries.find(entry => entry.id === newer.id), newer);
    stale.resolve([working, original, fresh, newer]);
    await oldRead;
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    assert.equal(reads, 2, 'completion must not accept the pre-reset list as its authoritative phase refresh');
    const refresh = store.reload();
    authoritative.resolve([{ ...original, phase: 'reset' }, working, current, newer]);
    await refresh;
    assert.equal(store.getSnapshot().entries.find(entry => entry.id === original.id)?.phase, 'reset');
    assert.equal(store.getSnapshot().entries.find(entry => entry.id === working.id)?.phase, working.phase, 'even the status caller need not belong to the affected set');
    assert.equal(store.getSnapshot().entries.find(entry => entry.id === fresh.id), current);
    assert.equal(store.getSnapshot().entries.find(entry => entry.id === newer.id), newer);
    assert.equal(await store.operate(newer.id, 'Newer setup action', async () => {}), true);
  } finally { store.dispose(); }
});

test('recovery host binding accepts canonical IPv6 but not a different verified address', () => {
  const caller = { ...original, target: { ...original.target, host: '2001:0db8:0000:0000:0000:0000:0000:0001' } };
  const ipv6Fresh = { ...fresh, target: { ...fresh.target, host: '2001:db8::1' } };
  const result = { ...complete, entry: ipv6Fresh };
  assert.equal(validateRestartResult(caller, result), result);
  assert.throws(() => validateRestartResult(caller, { ...result, entry: { ...ipv6Fresh, target: { ...ipv6Fresh.target, host: '2001:db8::2' } } }), /fresh trusted/);
});

test('known reset identity cannot change its fresh entry or reset ID during status reconciliation', async () => {
  const h = harness({ status: async () => complete });
  await h.store.open(working); h.store.delivered(working.id);
  h.client.status = async () => ({ ...complete, entry: { ...fresh, id: 'foreign-fresh' } });
  assert.equal(await h.store.check(working), false);
  assert.equal(h.session().result?.entry?.id, fresh.id);
  h.client.status = async () => ({ ...complete, resetId: 'other-reset' });
  assert.equal(await h.store.check(working), false);
  assert.equal(h.session().resetId, complete.resetId);
});
