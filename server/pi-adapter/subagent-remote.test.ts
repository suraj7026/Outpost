import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../core/ledger.js';
import { digest } from '../core/contracts.js';
import { Coordinator, publicKinds } from '../gateway/coordinator.js';
import { WorkerClient } from '../pi-worker/client.js';
import { Projection, RunPoll, type WorkerRequest } from '../pi-worker/contracts.js';
import { RemotePiRuntime } from './remote-runtime.js';

type PollRequest = Extract<WorkerRequest, { type: 'run.poll' }>;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'outpost-child-remote-')), db = new Ledger(join(root, 'ledger.sqlite'));
  const coordinator = new Coordinator(db, root), sessionId = randomUUID(), model = { providerId: 'fixture', modelId: 'real-model' };
  const task = coordinator.tasks.create(randomUUID(), { goal: 'Observe children', profile: 'code', mode: 'full_control' });
  const requests: WorkerRequest[] = [], stops: string[] = [], publicFrames: unknown[] = [];
  const unsubscribe = coordinator.live.subscribe(frame => publicFrames.push(frame));
  const gate = coordinator.gate(task.id), stop = gate.stop.bind(gate);
  gate.stop = id => { stops.push(id); stop(id); };
  let polls = 0, reply: (request: PollRequest, index: number) => unknown = () => { throw new Error('unexpected_poll'); };
  class FixtureWorker extends WorkerClient {
    override async request(request: WorkerRequest): Promise<unknown> {
      requests.push(request);
      return request.type === 'run.poll' ? reply(request, ++polls) : {};
    }
  }
  const worker = new FixtureWorker('http://127.0.0.1', 'fixture-token-with-at-least-32-characters');
  const runtime = new RemotePiRuntime(db, gate, worker, coordinator.live);
  const child = (owner = sessionId): Projection => ({ sequence: 1, final: true, kind: 'subagent_run',
    id: digest({ kind: 'subagent_run', sessionId: owner, callId: 'launch' }), data: {
      taskId: task.id, parentSessionId: owner, parentCallId: 'launch', parentToolId: digest({ sessionId: owner, callId: 'launch' }),
      label: 'Observed child', executionMode: 'background', state: 'completed', activity: [{ id: 'message', kind: 'message', text: 'Recorded child output' }],
      incomplete: false, truncated: false, stopSupported: false,
    } });
  const poll = (request: PollRequest, projections: unknown[], overrides: Record<string, unknown> = {}) => ({
    runId: request.runId, taskId: task.id, state: 'finished', session: { id: sessionId, file: 'parent.jsonl' }, model,
    cursor: request.after + 1, hasMore: false, actions: [], error: null, projections, ...overrides,
  });
  return { db, coordinator, task, sessionId, model, requests, stops, publicFrames, child, poll,
    setReply(value: typeof reply) { reply = value; },
    run: () => runtime.run(task.id, 'Observe', model),
    publicWire: () => JSON.stringify([publicFrames, db.snapshot(publicKinds), coordinator.live.snapshot()]),
    assertNoCancellation() { assert.equal(requests.some(request => request.type === 'run.abort'), false); assert.deepEqual(stops, []); },
    close() { unsubscribe(); coordinator.live.close(); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('remote child projections persist through the existing public snapshot transport', async () => {
  const f = fixture();
  try {
    f.setReply(request => f.poll(request, [f.child()]));
    await f.run(); f.assertNoCancellation();
    assert.equal(f.db.list('subagent_run').length, 1);
    assert.match(f.publicWire(), /Recorded child output/);
    assert.equal(f.db.list('subagent_run')[0]?.data.streaming, false);
  } finally { f.close(); }
});

const invalidChildren: [string, (frame: Projection) => unknown][] = [
  ['cross-session', frame => { const sessionId = randomUUID(), callId = String(frame.data.parentCallId); return { ...frame,
    id: digest({ kind: 'subagent_run', sessionId, callId }), data: { ...frame.data, parentSessionId: sessionId, parentToolId: digest({ sessionId, callId }) } }; }],
  ['cross-task', frame => ({ ...frame, data: { ...frame.data, taskId: randomUUID() } })],
  ['record digest mismatch', frame => ({ ...frame, id: 'b'.repeat(64) })],
  ['parent tool digest mismatch', frame => ({ ...frame, data: { ...frame.data, parentToolId: 'c'.repeat(64) } })],
  ['invalid logical owner UUID', frame => ({ ...frame, data: { ...frame.data, parentSessionId: '/private/session.jsonl' } })],
  ['malformed state', frame => ({ ...frame, data: { ...frame.data, state: 'invented' } })],
  ['malformed activity', frame => ({ ...frame, data: { ...frame.data, activity: 'UNTRUSTED-DISPLAY' } })],
  ['private extra field', frame => ({ ...frame, data: { ...frame.data, capabilityToken: 'UNTRUSTED-DISPLAY' } })],
  ['oversized payload', frame => ({ ...frame, data: { ...frame.data, activity: Array.from({ length: 128 }, (_, i) => ({ id: `entry${i}`, kind: 'message', text: 'x'.repeat(8192) })) } })],
  ['null payload', frame => ({ ...frame, data: null })],
  ['missing payload', frame => ({ kind: frame.kind, sequence: frame.sequence, final: frame.final, id: frame.id })],
  ['invalid envelope id', frame => ({ ...frame, id: '/private/UNTRUSTED-DISPLAY' })],
  ['invalid envelope sequence', frame => ({ ...frame, sequence: -1 })],
  ['invalid envelope final', frame => ({ ...frame, final: 'yes' })],
  ['unexpected envelope field', frame => ({ ...frame, privateRoute: 'UNTRUSTED-DISPLAY' })],
];
for (const [name, invalidate] of invalidChildren) test(`invalid child display is omitted without cancellation: ${name}`, async () => {
  const f = fixture(), callId = randomUUID();
  try {
    const child = f.child(); child.data.label = 'UNTRUSTED-DISPLAY';
    const invalid = invalidate(child);
    f.setReply(request => f.poll(request, [invalid,
      { sequence: 2, final: true, kind: 'message', id: 'd'.repeat(64), data: { taskId: f.task.id, text: 'Valid parent message' } },
      { sequence: 3, final: true, kind: 'tool_stream', id: 'e'.repeat(64), data: { taskId: f.task.id, output: 'Valid parent tool' } },
    ], { actions: [{ callId, tool: 'unregistered-fixture-tool', arguments: {} }] }));
    await f.run(); f.assertNoCancellation();
    assert.equal(f.db.list('subagent_run').length, 0, 'Never synthesize an owned identity for a rejected child');
    assert.equal(f.db.need('message', 'd'.repeat(64)).data.text, 'Valid parent message');
    assert.equal(f.db.need('tool_stream', 'e'.repeat(64)).data.output, 'Valid parent tool');
    assert.doesNotMatch(f.publicWire(), /UNTRUSTED-DISPLAY|capabilityToken|privateRoute/);
    assert.equal(f.requests.filter(request => request.type === 'run.action-result' && request.callId === callId).length, 1);
    assert.equal(f.db.need('task', f.task.id).data.state, 'verifying');
    if (name === 'malformed state' || name === 'private extra field') {
      assert.equal(Projection.safeParse(invalid).success, false);
      assert.equal(RunPoll.safeParse(f.poll({ type: 'run.poll', runId: randomUUID(), after: 0 }, [invalid])).success, false, 'Shared worker contracts remain strict');
    }
  } finally { f.close(); }
});

test('child display without a poll session is omitted, not assigned a fabricated owner', async () => {
  const f = fixture();
  try {
    f.setReply(request => f.poll(request, [f.child()], { session: null }));
    await f.run(); f.assertNoCancellation(); assert.equal(f.db.list('subagent_run').length, 0);
  } finally { f.close(); }
});

for (const terminal of [false, true]) test(`a malformed update marks only cached owned observation incomplete (${terminal ? 'terminal' : 'active'})`, async () => {
  const f = fixture(), child = f.child();
  child.final = terminal; child.data.state = terminal ? 'completed' : 'running';
  try {
    f.setReply((request, index) => {
      assert.equal(request.after, index - 1, 'Rejected frames must still advance the poll cursor');
      if (index === 1) return f.poll(request, [child], { state: 'running' });
      if (index === 2) return f.poll(request, [{ ...child, sequence: 2, final: true, data: { ...child.data, state: 'invalid', label: 'UNTRUSTED-DISPLAY', capabilityToken: 'UNTRUSTED-DISPLAY' } }], { state: 'running' });
      assert.equal(index, 3);
      const known = f.coordinator.live.snapshot().find(row => row.id === child.id) ?? f.db.need('subagent_run', child.id);
      assert.equal(known.data.state, terminal ? 'completed' : 'unknown'); assert.equal(known.data.incomplete, true);
      assert.equal(known.data.label, 'Observed child'); assert.equal(known.data.parentSessionId, f.sessionId);
      assert.equal(known.data.endedAt, undefined); assert.equal(known.data.streaming, !terminal);
      f.assertNoCancellation(); assert.doesNotMatch(f.publicWire(), /UNTRUSTED-DISPLAY|capabilityToken/);
      return f.poll(request, terminal ? [] : [{ ...f.child(), sequence: 3 }]);
    });
    await f.run(); f.assertNoCancellation();
    const known = f.db.need('subagent_run', child.id);
    assert.equal(known.data.state, 'completed'); assert.equal(known.data.incomplete, terminal);
  } finally { f.close(); }
});

for (const field of ['taskId', 'parentSessionId', 'parentCallId', 'parentToolId']) test(`foreign ${field} cannot contaminate a cached owned observation`, async () => {
  const f = fixture(), child = f.child(); child.final = false; child.data.state = 'running';
  try {
    f.setReply((request, index) => {
      if (index === 1) return f.poll(request, [child], { state: 'running' });
      if (index === 2) return f.poll(request, [{ ...child, sequence: 2, data: { ...child.data, [field]: randomUUID(), label: 'UNTRUSTED-DISPLAY' } }], { state: 'running' });
      assert.equal(index, 3);
      const known = f.coordinator.live.snapshot().find(row => row.id === child.id);
      assert.equal(known?.data.state, 'running'); assert.equal(known?.data.incomplete, false);
      return f.poll(request, [{ ...f.child(), sequence: 3 }]);
    });
    await f.run(); f.assertNoCancellation(); assert.doesNotMatch(f.publicWire(), /UNTRUSTED-DISPLAY/);
    assert.equal(f.db.list('subagent_run').length, 1);
  } finally { f.close(); }
});

const invalidPolls: [string, Record<string, unknown>][] = [
  ['malformed action', { actions: [{ callId: randomUUID(), tool: 'file.read', arguments: null }] }],
  ['unknown poll field', { privateExtra: true }],
  ['invalid cursor', { cursor: -1 }],
  ['wrong task', { taskId: randomUUID() }],
  ['wrong run', { runId: randomUUID() }],
  ['wrong model', { model: { providerId: 'foreign', modelId: 'foreign' } }],
  ['invalid session', { session: { id: 'session', file: 'parent.jsonl', extra: true } }],
  ['too many child frames', { projections: Array.from({ length: 65 }, () => ({ kind: 'subagent_run' })) }],
];
for (const [name, overrides] of invalidPolls) test(`invalid child display does not weaken poll/action validation: ${name}`, async () => {
  const f = fixture();
  try {
    f.setReply(request => f.poll(request, [{ kind: 'subagent_run', data: null }], overrides));
    await assert.rejects(f.run());
    assert.equal(f.requests.some(request => request.type === 'run.abort'), true); assert.deepEqual(f.stops, [f.task.id]);
    assert.equal(f.requests.some(request => request.type === 'run.action-result'), false);
    assert.equal(f.db.list('subagent_run').length, 0);
  } finally { f.close(); }
});

for (const kind of ['message', 'tool_stream']) for (const malformed of [false, true]) test(`non-child ${kind} ${malformed ? 'schema' : 'owner'} validation stays strict`, async () => {
  const f = fixture();
  try {
    f.setReply(request => f.poll(request, [{ kind: 'subagent_run', data: null },
      { sequence: 2, final: true, kind, id: 'd'.repeat(64), data: malformed ? null : { taskId: randomUUID(), text: 'UNTRUSTED-DISPLAY' } },
    ]));
    await assert.rejects(f.run());
    assert.equal(f.requests.some(request => request.type === 'run.abort'), true); assert.deepEqual(f.stops, [f.task.id]);
    assert.equal(f.db.get(kind, 'd'.repeat(64)), undefined); assert.doesNotMatch(f.publicWire(), /UNTRUSTED-DISPLAY/);
  } finally { f.close(); }
});

for (const projection of [null, { kind: 'unknown' }, { data: { taskId: 'invalid' } }]) test(`only the exact child kind is isolated: ${JSON.stringify(projection)}`, async () => {
  const f = fixture();
  try {
    f.setReply(request => f.poll(request, [projection]));
    await assert.rejects(f.run());
    assert.equal(f.requests.some(request => request.type === 'run.abort'), true);
  } finally { f.close(); }
});
