import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createEventBus } from '@earendil-works/pi-coding-agent';
import { inspectNativeSessionWork, installSessionLiveness, SessionBackground, SessionWorkJournal, within } from './session-background.js';

const root = mkdtempSync(join(tmpdir(), 'outpost-background-test-'));
const originalTemp = process.env.PI_SUBAGENTS_TEMP_ROOT;
process.env.PI_SUBAGENTS_TEMP_ROOT = join(root, 'native-temp');
after(() => {
  if (originalTemp === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = originalTemp;
  rmSync(root, { recursive: true, force: true });
});

const requireNative = createRequire(import.meta.url);
function native(module: string) {
  return requireNative(fileURLToPath(new URL(`../src/${module}`, import.meta.resolve('pi-subagents')))) as Record<string, (...args: unknown[]) => unknown>;
}
function nativeRun(base: string, runId: string, sessionId: string, state = 'complete', proof: 'observed' | 'pending' | 'unknown' = 'observed') {
  const directory = join(base, runId), runnerProcessInstanceId = `runner-${runId}`, sessionFile = join(directory, 'session.jsonl');
  mkdirSync(directory, { recursive: true }); writeFileSync(sessionFile, '');
  writeFileSync(join(directory, 'status.json'), JSON.stringify({ lifecycleArtifactVersion: 3, runId, sessionId, state, mode: 'single', startedAt: Date.now(), sessionFile,
    processTerminal: { version: 1, state: 'pending', runId, runnerProcessInstanceId }, steps: [{ agent: 'fixture', status: state, sessionFile }] }));
  const api = native('runs/background/process-terminal.js');
  api.initializeProcessTerminal!(directory, runId, runnerProcessInstanceId);
  if (proof !== 'pending') {
    api.writeProcessTerminalCandidate!(directory, { version: 1, runId, runnerProcessInstanceId, sessionFile,
      expectedWriters: { 0: 1 }, writers: { 0: [{ kind: 'pi-writer', processInstanceId: `writer-${runId}`, attempt: 0, closeObservedAt: Date.now(), exitCode: 0, signal: null,
        processTree: proof === 'unknown' ? { state: 'unknown', reason: 'verification-failed' } : { state: 'observed', mechanism: 'posix-process-group', processGroupId: 12345, verifiedAt: Date.now() } }] } });
    api.finalizeProcessTerminal!(directory, runId, { processInstanceId: runnerProcessInstanceId, closeObservedAt: Date.now(), exitCode: 0, signal: null });
  }
  return directory;
}

function fixture(options: { omitted?: boolean; stopWorks?: boolean; largeHistory?: boolean; pendingNotice?: boolean; inspectOwned?: typeof inspectNativeSessionWork } = {}) {
  const sessionId = `session-${Math.random()}`, sessionFile = join(root, `${sessionId}.jsonl`);
  const events = createEventBus();
  let working = false, idle = true, abortCalled = false;
  const background = new SessionBackground(events, true, options.inspectOwned ?? (() => ({ activeIds: working ? ['owned-native-job'] : [], terminalIds: working ? [] : ['owned-native-job'], unknown: false, nested: false })));
  const stopped: string[] = [];
  installSessionLiveness();
  const registry = Reflect.get(globalThis, Symbol.for('@agegr/pi-web/session-liveness/v1')) as {
    register(entry: { name: string; sessionId: string; sessionFile: string; isActive: () => boolean }): () => void;
  };
  const release = registry.register({ name: 'pi-subagents', sessionId, sessionFile, isActive: () => working || !!options.pendingNotice });
  events.on('subagents:rpc:v1:request', raw => {
    const request = raw as { requestId: string; method: string; params?: { id: string } };
    if (request.method === 'stop') {
      stopped.push(request.params!.id);
      if (options.stopWorks !== false) { working = false; idle = true; }
    }
    const history = options.largeHistory ? Array.from({ length: 20 }, (_, i) => ({ id: `old-${i}`, state: 'complete',
      children: Array.from({ length: 8 }, (_, j) => ({ id: `child-${j}`, state: 'complete' })) })) : [];
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true,
      data: { fleet: { totalActive: working ? 1 : 0 }, asyncSnapshot: { runs: working ? [{ id: 'owned-native-job', state: 'running' }] : history,
        omitted: { runs: options.largeHistory ? 30 : options.omitted ? 1 : 0, children: options.largeHistory ? 80 : 0, byteLimitExceeded: !!options.largeHistory } } } });
  });
  const session = { sessionId, sessionFile, get isIdle() { return idle; }, abort: async () => { abortCalled = true; } };
  return { background, session, stopped, get aborted() { return abortCalled; },
    work: (value: boolean) => { working = value; }, busy: (value: boolean) => { idle = !value; },
    close: () => { background.release(); release(); events.clear(); } };
}

test('native liveness holds callbacks independently of the external-provider registry', async () => {
  const item = fixture();
  try {
    await item.background.bind(item.session);
    item.work(true);
    const { snapshotBackgroundWork } = await import('pi-subagents/background-work');
    assert.equal(snapshotBackgroundWork([item.session.sessionId]).items.length, 0);
    assert.equal(item.background.active, true);
    let drained = false;
    const completion = item.background.drain().then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(drained, false);
    item.work(false); item.busy(true);
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(drained, false, 'Parent completion turn must also finish');
    item.busy(false); await within(completion, 500);
    assert.equal(item.background.active, false);
  } finally { item.close(); }
});

test('empty sessions and future schedules without current native work drain immediately', async () => {
  const item = fixture();
  try { await item.background.bind(item.session); await within(item.background.drain(), 250); assert.equal(item.background.active, false); }
  finally { item.close(); }
});

test('native cancellation uses session-owned RPC ids and does not wait for parent abort before stopping children', async () => {
  const item = fixture();
  try {
    await item.background.bind(item.session); item.work(true);
    assert.equal(await item.background.cancel(500), true);
    assert.equal(item.aborted, true); assert.deepEqual(item.stopped, ['owned-native-job']);
    assert.equal(item.background.active, false);
  } finally { item.close(); }
});

test('unconfirmed cancellation is bounded, remains active, and requires attention', async () => {
  const item = fixture({ stopWorks: false, omitted: true });
  try {
    await item.background.bind(item.session); item.work(true);
    const start = Date.now();
    assert.equal(await item.background.cancel(80), false);
    assert.ok(Date.now() - start < 500);
    assert.equal(item.background.active, true); assert.equal(item.background.needsAttention, true);
    assert.deepEqual(item.stopped, ['owned-native-job'], 'A stop request is issued once, not flooded');
    item.work(false); await within(item.background.drain(), 250);
  } finally { item.close(); }
});

test('truncated terminal history and nested display trees do not impose cancellation ceilings', async () => {
  const item = fixture({ largeHistory: true, pendingNotice: true });
  try {
    await item.background.bind(item.session);
    assert.equal(item.background.active, true, 'An aborted notice is still awaiting native shutdown persistence');
    assert.equal(await item.background.cancel(500), true);
    await within(item.background.drain(), 500);
    assert.equal(item.background.needsAttention, false);
  } finally { item.close(); }
});

test('real native nested-run layout and native proof readers are not limited by display counts', () => {
  const temp = process.env.PI_SUBAGENTS_TEMP_ROOT!, runs = join(temp, 'async-subagent-runs'), nested = join(temp, 'nested-subagent-runs');
  const sessionFile = join(root, 'large-session.jsonl');
  try {
    for (let i = 0; i < 50; i++) nativeRun(runs, `root-${i}`, sessionFile);
    for (let i = 0; i < 12; i++) nativeRun(join(nested, 'root-49'), `nested-${i}`, sessionFile);
    const quiet = inspectNativeSessionWork([sessionFile], new Set());
    assert.equal(quiet.terminalIds.length, 62); assert.equal(quiet.unknown, false); assert.deepEqual(quiet.activeIds, []);
    nativeRun(join(nested, 'root-49'), 'nested-11', sessionFile, 'running', 'pending');
    assert.deepEqual(inspectNativeSessionWork([sessionFile], new Set()).activeIds, ['nested-11']);
    assert.equal(inspectNativeSessionWork([sessionFile], new Set(['missing-launch'])).unknown, true);
  } finally { rmSync(runs, { recursive: true, force: true }); rmSync(nested, { recursive: true, force: true }); }
});

test('a live foreground nested route cannot be dismissed as queued notices when fleet is empty', async () => {
  const item = fixture({ pendingNotice: true, inspectOwned: inspectNativeSessionWork });
  const api = native('runs/shared/nested-events.js');
  try {
    await item.background.bind(item.session);
    const childSession = join(root, 'custom-child-location.jsonl');
    native('runs/foreground/foreground-history.js').persistForegroundRun!({ runId: 'foreground-root', mode: 'single', cwd: root,
      sessionId: item.session.sessionFile, updatedAt: Date.now(), children: [{ agent: 'fixture', index: 0, status: 'completed', sessionFile: childSession }] });
    const route = api.createNestedRoute!('foreground-root');
    api.writeNestedEvent!(route, { type: 'subagent.nested.started', ts: Date.now(), parentRunId: 'foreground-root',
      child: { id: 'foreground-descendant', parentRunId: 'foreground-root', state: 'running', depth: 1, path: [], sessionId: childSession } });
    const inspection = inspectNativeSessionWork([item.session.sessionFile], new Set());
    assert.equal(inspection.nested, true);
    assert.equal(await item.background.cancel(80), false);
    assert.equal(item.background.active, true); assert.equal(item.background.needsAttention, true);
    assert.deepEqual(item.stopped, [], 'Never signal an unrelated or guessed process');
  } finally {
    item.close(); rmSync(join(process.env.PI_SUBAGENTS_TEMP_ROOT!, 'nested-subagent-events'), { recursive: true, force: true });
    rmSync(join(process.env.PI_SUBAGENTS_TEMP_ROOT!, 'async-subagent-results', 'foreground-history'), { recursive: true, force: true });
  }
});

for (const proof of ['pending', 'unknown'] as const) test(`logical completion with native ${proof} process proof retains ownership`, async () => {
  const item = fixture({ inspectOwned: inspectNativeSessionWork }), runs = join(process.env.PI_SUBAGENTS_TEMP_ROOT!, 'async-subagent-runs');
  try {
    await item.background.bind(item.session);
    const directory = nativeRun(runs, 'uncertain-run', item.session.sessionFile, 'complete', proof);
    const observed = native('runs/background/process-terminal.js').readProcessTerminal!(directory, { runId: 'uncertain-run' }) as { state: string; reason?: string };
    assert.equal(observed.state, proof);
    if (proof === 'unknown') assert.equal(observed.reason, 'process-tree-unverified');
    assert.equal(item.background.active, true, 'A false native liveness flag cannot erase pending process evidence');
    assert.equal(await item.background.cancel(80), false);
    assert.equal(item.background.needsAttention, true);
    assert.equal(new SessionWorkJournal(root).needsAttention, true, 'Restart must block maintenance too');
  } finally { item.close(); rmSync(runs, { recursive: true, force: true }); }
});

for (const state of ['owned', 'unreadable'] as const) test(`an ${state} canonical lease blocks cleanup despite observed process proof`, async () => {
  const item = fixture({ inspectOwned: inspectNativeSessionWork }), runs = join(process.env.PI_SUBAGENTS_TEMP_ROOT!, 'async-subagent-runs');
  let lease: { leaseDir: string; release(): boolean } | undefined;
  try {
    await item.background.bind(item.session);
    const directory = nativeRun(runs, 'leased-run', item.session.sessionFile);
    lease = native('runs/shared/session-lease.js').acquireSessionLease!({ sessionFile: join(directory, 'session.jsonl'), runId: 'lease-holder', sourceRunId: 'leased-run' }) as typeof lease;
    assert.ok(lease);
    if (state === 'unreadable') writeFileSync(join(lease.leaseDir, 'owner.json'), '{');
    assert.equal(inspectNativeSessionWork([item.session.sessionFile], new Set()).unknown, true);
    assert.equal(await item.background.cancel(80), false);
    assert.equal(item.background.active, true); assert.equal(item.background.needsAttention, true);
  } finally {
    item.close(); if (lease) rmSync(lease.leaseDir, { recursive: true, force: true });
    rmSync(runs, { recursive: true, force: true });
  }
});

test('restart receipts remain unresolved until the owning session is recovered and drained', () => {
  const sessions = mkdtempSync(join(root, 'sessions-'));
  const session = { sessionId: 'owned-session', sessionFile: join(sessions, 'owned.jsonl') };
  const owner = new SessionWorkJournal(sessions); owner.own(session);
  assert.equal(owner.needsAttention, false, 'A live owner is not an orphan');
  const restarted = new SessionWorkJournal(sessions);
  assert.equal(restarted.needsAttention, true); assert.deepEqual(restarted.unresolvedSessions, [session.sessionFile]);
  restarted.own(session); assert.equal(restarted.needsAttention, false);
  restarted.settled(session);
  assert.equal(new SessionWorkJournal(sessions).needsAttention, false);
  assert.equal(readdirSync(join(sessions, '.outpost-native-work')).length, 0);
});

test('restart discovers legacy native jobs without receipts and never claims malformed state is idle', () => {
  const sessions = mkdtempSync(join(root, 'legacy-'));
  const nativeRuns = join(process.env.PI_SUBAGENTS_TEMP_ROOT!, 'async-subagent-runs');
  const status = (id: string, value: unknown) => {
    const directory = join(nativeRuns, id); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'status.json'), JSON.stringify(value));
  };
  status('unrelated', { sessionId: join(root, 'other-owner', 'session.jsonl'), state: 'running' });
  nativeRun(nativeRuns, 'future', join(sessions, 'future.jsonl'), 'paused');
  assert.equal(new SessionWorkJournal(sessions).needsAttention, false);
  nativeRun(nativeRuns, 'legacy', join(sessions, 'previous.jsonl'), 'running', 'pending');
  assert.deepEqual(new SessionWorkJournal(sessions).unresolvedSessions, [join(sessions, 'previous.jsonl')]);
  nativeRun(nativeRuns, 'legacy', join(sessions, 'previous.jsonl'));
  assert.equal(new SessionWorkJournal(sessions).needsAttention, false);
  status('broken', { state: 'not-a-native-state' });
  assert.equal(new SessionWorkJournal(sessions).needsAttention, true);
  rmSync(nativeRuns, { recursive: true });
});

test('a failed receipt replacement preserves unresolved ownership and removes its staging file', () => {
  const sessions = mkdtempSync(join(root, 'replace-failure-'));
  const session = { sessionId: 'old-session', sessionFile: join(sessions, 'old.jsonl') };
  const journal = new SessionWorkJournal(sessions); journal.own(session); journal.releaseOwnership(session);
  const directory = join(sessions, '.outpost-native-work'), name = readdirSync(directory)[0]!;
  rmSync(join(directory, name)); mkdirSync(join(directory, name));
  assert.throws(() => journal.own(session));
  assert.equal(journal.needsAttention, true, 'Failed ownership acquisition cannot clear possibly running old work');
  assert.deepEqual(readdirSync(directory), [name], 'The failed replacement leaves no staging receipt');
});

test('corrupt ownership receipts fail closed rather than disappearing', () => {
  const sessions = mkdtempSync(join(root, 'corrupt-'));
  const directory = join(sessions, '.outpost-native-work'); mkdirSync(directory);
  writeFileSync(join(directory, 'broken.json'), '{');
  assert.equal(new SessionWorkJournal(sessions).needsAttention, true);
  assert.deepEqual(readdirSync(directory), ['broken.json']);
});
