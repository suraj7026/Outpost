import assert from 'node:assert/strict';
import test from 'node:test';
import { activityChunks, isExecutionRecord } from './src/activity-model';
import { groupConversation, taskRunStatus } from './src/conversation-model';
import {
  isSubagentParent, isSubagentRecord, subagentCopyText, subagentDurationMs, subagentRun, subagentStatusLabel,
  type SubagentState,
} from './src/subagents/model';
import type { Json, ServerRecord } from './src/types';

const taskId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const otherTask = '33333333-3333-4333-8333-333333333333';
const otherSession = '44444444-4444-4444-8444-444444444444';
const parentToolId = 'a'.repeat(64);
const recordId = 'b'.repeat(64);
const row = (kind: string, id: string, time: number, data: ServerRecord['data'] = {}): ServerRecord => ({
  kind, id, revision: 1, updatedAt: new Date(time).toISOString(), data: { taskId, ...data },
});
const projected = (data: ServerRecord['data'] = {}, time = 30) => row('subagent_run', recordId, time, {
  parentSessionId: sessionId, parentCallId: 'launch', parentToolId, label: 'Reviewer',
  executionMode: 'background', state: 'running', activity: [], incomplete: true, truncated: false, stopSupported: false, ...data,
});
const wrapper = (data: ServerRecord['data'] = {}, time = 10) => row('tool_stream', parentToolId, time, {
  name: 'subagent', callId: 'launch', arguments: { agent: 'reviewer', task: 'Review the code', async: true },
  state: 'finished', streaming: false, ...data,
});
const owner = (id: string, time: number) => row('message', id, time, { author: 'owner', text: id });
const task = (state: string) => row('task', taskId, 100, { state });
const ids = (groups: ReturnType<typeof groupConversation>) => groups.flatMap(group =>
  group.kind === 'owner' ? [group.record.id] : group.records.map(record => record.id));
const parse = (record: ServerRecord) => {
  const run = subagentRun(record, taskId);
  assert.ok(run);
  return run;
};

test('public contract fields and optional omissions are preserved without a parent-model fallback', () => {
  const record = projected({
    runId: 'native-run', agent: 'reviewer', model: 'provider/child-model', assignment: 'Review carefully',
    startedAt: 0, endedAt: 500, state: 'completed', summary: 'Reviewed', streaming: false,
    activity: [{ id: 'read:1', kind: 'tool', tool: 'read', arguments: 'README.md', output: 'Read result', state: 'completed', startedAt: 0 }],
    files: [{ path: 'src/main.ts', change: 'modified' }],
    children: [{ id: 'step:0', agent: 'reviewer', model: 'provider/child-model', state: 'completed' }],
  });
  const before = structuredClone(record);
  const run = parse(record);
  assert.deepEqual(run, { ...record.data, recordId, legacy: false });
  assert.equal(subagentStatusLabel(run), 'Completed');
  assert.equal(subagentDurationMs(run), 500);
  assert.match(subagentCopyText(run), /provider\/child-model/);
  assert.match(subagentCopyText(run), /Read result/);
  assert.match(subagentCopyText(run), /Details incomplete/);
  assert.deepEqual(record, before);
  assert.equal(parse(projected()).model, undefined);
  assert.equal(parse(projected()).assignment, undefined);
  assert.equal(parse(projected()).runId, undefined);
  assert.equal(subagentRun(record, otherTask), undefined);
});

const malformedPublicPatches: ServerRecord['data'][] = [
  { taskId: 'not-a-uuid' }, { parentSessionId: 'not-a-uuid' }, { parentCallId: '' }, { parentToolId: 'bad' },
  { runId: '../escape' }, { state: 'finished' }, { executionMode: 'async' }, { stopSupported: true },
  { incomplete: 'true' }, { truncated: 0 }, { streaming: 'false' }, { interrupted: 'true' },
  { startedAt: -1 }, { startedAt: Infinity }, { endedAt: Number.MAX_SAFE_INTEGER + 1 },
  { label: 'x'.repeat(257) }, { model: 'x'.repeat(257) }, { agent: 'x'.repeat(129) }, { assignment: 'x'.repeat(8193) },
  { activity: [{ id: 'x', kind: 'thinking', text: 'private' }] },
  { activity: [{ id: 'x', kind: 'message', text: 'x'.repeat(8193) }] },
  { activity: [{ id: 'x', kind: 'tool', arguments: 'x'.repeat(4097) }] },
  { activity: [{ id: 'x', kind: 'message', rawMetadata: { secret: 'private' } }] },
  { files: [{ path: 'a', token: 'private' }] }, { children: [{ id: 'a', state: 'finished' }] },
  { metadata: { secret: 'private' } }, { output: '{"secret":"private"}' },
];
for (const patch of malformedPublicPatches) {
  test(`reject malformed public field: ${Object.keys(patch).join(',')}`, () => {
    const record = projected(patch);
    assert.equal(isSubagentRecord(record), true);
    assert.equal(subagentRun(record), undefined);
  });
}

test('public arrays, UTF-8/escaped byte size, cycles and deeply nested metadata are bounded', () => {
  assert.equal(subagentRun(projected({ activity: Array.from({ length: 129 }, (_, i) => ({ id: String(i), kind: 'message' })) })), undefined);
  assert.equal(subagentRun(projected({ children: Array.from({ length: 65 }, (_, i) => ({ id: String(i), state: 'unknown' })) })), undefined);
  assert.equal(subagentRun(projected({ files: Array.from({ length: 65 }, () => ({ path: 'a' })) })), undefined);
  for (const text of ['🦊'.repeat(4096), '\u0000'.repeat(8192)]) {
    assert.equal(subagentRun(projected({ activity: Array.from({ length: 16 }, (_, i) => ({ id: String(i), kind: 'message', text })) })), undefined);
  }
  const cyclic = projected();
  cyclic.data.loop = cyclic.data;
  assert.equal(subagentRun(cyclic), undefined);
  let nested: Json = 'private';
  for (let i = 0; i < 100; i++) nested = { nested };
  assert.equal(subagentRun(projected({ nested })), undefined);
  assert.ok(subagentRun(projected({ activity: Array.from({ length: 128 }, (_, i) => ({ id: String(i), kind: 'notice', text: 'available' })) })));
});

test('non-object envelopes and hostile JSON field shapes fail safely without coercing metadata', () => {
  for (const value of [null, [], false, { kind: 'subagent_run', data: null }, { kind: 'tool_stream', data: [] }]) {
    const record = value as unknown as ServerRecord;
    assert.equal(subagentRun(record), undefined);
    assert.doesNotThrow(() => isSubagentRecord(record));
  }
  const run = parse(wrapper({ arguments: { async: false }, state: 'finished',
    details: { results: [{ exitCode: 0, status: { toString: null } }] } }));
  assert.equal(run.state, 'unknown');
  assert.equal(parse(wrapper({ state: { toString: null }, streaming: true })).state, 'unknown');
});

test('gateway streaming is not native lifecycle evidence; interruption preserves terminal outcomes', () => {
  assert.equal(parse(projected({ streaming: false })).state, 'running');
  assert.equal(parse(projected({ state: 'completed', streaming: true })).state, 'completed');
  for (const state of ['queued', 'running', 'unknown'] as const) {
    const run = parse(projected({ state, interrupted: true, incomplete: false }));
    assert.equal(run.state, 'unknown');
    assert.equal(run.incomplete, true);
  }
  for (const state of ['completed', 'failed', 'partial', 'stopped'] as const) {
    assert.equal(parse(projected({ state, interrupted: true })).state, state);
  }
});

test('legacy object and serialized launch args preserve observed fields, not parent model or raw metadata', () => {
  for (const key of ['name', 'tool']) for (const serialized of [false, true]) {
    const args = { agent: 'worker', task: 'Observed assignment', model: 'provider/child', async: true, options: { token: 'PRIVATE' } };
    const record = wrapper({ name: null, [key]: 'subagent', arguments: serialized ? JSON.stringify(args) : args,
      model: 'PARENT-MODEL', output: JSON.stringify({ content: [{ type: 'thinking', text: 'PRIVATE-REASONING' }], details: { asyncId: 'native', asyncDir: '/private/path', token: 'PRIVATE' } }) });
    const run = parse(record);
    assert.equal(isSubagentRecord(record), true);
    assert.equal(run.legacy, true);
    assert.equal(run.agent, 'worker');
    assert.equal(run.assignment, 'Observed assignment');
    assert.equal(run.model, 'provider/child');
    assert.equal(run.executionMode, 'background');
    assert.equal(run.state, 'unknown');
    assert.equal(run.parentSessionId, undefined);
    assert.equal(run.runId, undefined);
    assert.equal(run.endedAt, undefined);
    assert.deepEqual(run.activity, []);
    assert.match(run.summary!, /Older-run details unavailable/);
    assert.doesNotMatch(JSON.stringify(run), /PRIVATE|PARENT-MODEL|\/private\/path/);
    assert.doesNotMatch(subagentCopyText(run), /PRIVATE|PARENT-MODEL/);
  }
  assert.equal(parse(wrapper({ model: 'parent-model' })).model, undefined);
});

const managementArguments: ServerRecord['data'][] = [
  { action: 'list' }, { action: 'status', agent: 'worker' }, { action: 'stop', task: 'work' },
  { options: { action: 'list' }, agent: 'worker' }, { action: 'unknown' },
];
for (const args of managementArguments) test(`management calls are not launches: ${JSON.stringify(args)}`, () => {
  const record = wrapper({ arguments: args });
  assert.equal(isSubagentRecord(record), false);
  assert.equal(subagentRun(record), undefined);
  assert.equal(isExecutionRecord(record), true);
});

test('malformed legacy args and task mismatches are rejected; long allowed fields are clipped', () => {
  for (const args of [null, [], 'not JSON', 'null', '[]', 'x'.repeat(65537)]) {
    assert.equal(subagentRun(wrapper({ arguments: args })), undefined);
  }
  assert.equal(subagentRun(wrapper(), otherTask), undefined);
  const run = parse(wrapper({ arguments: { agent: 'x'.repeat(1000), model: 'm'.repeat(1000), task: 't'.repeat(20000) } }));
  assert.equal(run.agent!.length, 128);
  assert.equal(run.model!.length, 256);
  assert.equal(run.assignment!.length, 8192);
  assert.equal(run.truncated, true);
  assert.equal(run.incomplete, true);
  assert.equal(parse(wrapper({ output: 'x'.repeat(1000000) })).state, 'unknown');
});

for (const [child, expected] of [
  [{ exitCode: 0 }, 'completed'], [{ exitCode: 1 }, 'failed'], [{ exitCode: 0, success: false }, 'failed'],
  [{ exitCode: 0, stopped: true }, 'stopped'], [{ exitCode: 0, interrupted: true }, 'partial'],
  [{ exitCode: 0, detached: true }, 'partial'], [{ exitCode: 0, timedOut: true }, 'partial'],
  [{ status: 'completed' }, 'unknown'], [{ exitCode: 0, status: 'running' }, 'unknown'],
] satisfies [ServerRecord['data'], SubagentState][]) test(`legacy foreground requires terminal child evidence: ${JSON.stringify(child)}`, () => {
  const run = parse(wrapper({ arguments: { async: false }, output: JSON.stringify({ details: { results: [{ agent: 'observed', model: 'provider/observed', ...child }] } }) }));
  assert.equal(run.state, expected);
  assert.equal(run.agent, 'observed');
  assert.equal(run.model, 'provider/observed');
  assert.equal(run.incomplete, true);
  assert.equal(run.endedAt, undefined);
});

test('legacy sync wrapper alone is not completion and async receipts never inherit nested child success', () => {
  for (const async of [true, false]) {
    const run = parse(wrapper({ arguments: { async }, output: 'Successfully finished all work', durationMs: 50 }));
    assert.equal(run.state, 'unknown');
    assert.equal(subagentDurationMs(run), undefined);
  }
  const receipts: ServerRecord['data'][] = [{ results: [{ exitCode: 0 }] }, { asyncId: 'native', results: [{ exitCode: 0 }] }];
  for (const details of receipts) {
    assert.equal(parse(wrapper({ result: { details } })).state, 'unknown');
  }
  const receipt = parse(wrapper({ arguments: { async: false }, details: { asyncId: 'native', results: [{ exitCode: 0 }] } }));
  assert.equal(receipt.executionMode, 'background');
  assert.equal(receipt.state, 'unknown');
  assert.equal(parse(wrapper({ arguments: { async: false }, state: 'running', streaming: true })).state, 'running');
  assert.equal(parse(wrapper({ state: 'preparing', streaming: true })).state, 'queued');
  assert.equal(parse(wrapper({ state: 'running', streaming: true, interrupted: true })).state, 'unknown');
});

test('duration requires observed start and terminal end or actual ongoing work', () => {
  assert.equal(subagentDurationMs(parse(projected({ startedAt: 0 })), 100), 100);
  assert.equal(subagentDurationMs(parse(projected({ startedAt: 200 })), 100), undefined);
  assert.equal(subagentDurationMs(parse(projected({ startedAt: 0, state: 'unknown' })), 100), undefined);
  assert.equal(subagentDurationMs(parse(projected({ startedAt: 0, state: 'completed' })), 100), undefined);
  assert.equal(subagentDurationMs(parse(projected({ startedAt: 0, state: 'completed', endedAt: 50 })), 100), 50);
});

test('public run replaces its exact wrapper at the original owner turn; late revisions never move it', () => {
  const firstSeen = new Map<string, number>();
  const first = owner('first', 1), second = owner('second', 20), stream = wrapper();
  assert.deepEqual(ids(groupConversation([first, stream, second], firstSeen)), ['first', parentToolId, 'second']);
  const run = projected({}, 500);
  const records = [second, run, first, { ...stream, revision: 2, updatedAt: new Date(600).toISOString() }];
  const before = structuredClone(records);
  let groups = groupConversation(records, firstSeen);
  assert.deepEqual(ids(groups), ['first', recordId, 'second']);
  assert.equal(groups[1].id, 'run:after:first');
  assert.deepEqual(records, before);
  const done = { ...run, revision: 2, updatedAt: new Date(1000).toISOString(), data: { ...run.data, state: 'completed' } };
  groups = groupConversation([done, second, first, run, records[3], done], firstSeen);
  assert.deepEqual(ids(groups), ['first', recordId, 'second']);
  assert.ok(groups[1].kind === 'run');
  assert.equal(groups[1].records[0], done);
  assert.deepEqual(ids(groupConversation([second, done, first], firstSeen)), ['first', recordId, 'second']);
});

test('same-timestamp wrapper slot remains before a later owner when the wrapper disappears', () => {
  const firstSeen = new Map<string, number>();
  const records = [owner('first', 1), wrapper({}, 10), owner('second', 10)];
  groupConversation(records, firstSeen);
  const run = projected({}, 100);
  assert.deepEqual(ids(groupConversation([...records, run], firstSeen)), ['first', recordId, 'second']);
  assert.deepEqual(ids(groupConversation([records[2], run, records[0]], firstSeen)), ['first', recordId, 'second']);
});

test('a known parent slot wins over a conflicting child timestamp, and late wrappers cannot move an existing card later', () => {
  const seen = new Map<string, number>();
  const first = owner('first', 1), second = owner('second', 20);
  groupConversation([first, wrapper(), second], seen);
  assert.deepEqual(ids(groupConversation([projected({ startedAt: 0 }), first, wrapper(), second], seen)), ['first', recordId, 'second']);
  const publicFirst = new Map<string, number>();
  const run = projected({ startedAt: 10 });
  const tiedOwner = owner('second', 10);
  groupConversation([first, run, tiedOwner], publicFirst);
  assert.deepEqual(ids(groupConversation([first, tiedOwner, run, wrapper({}, 10)], publicFirst)), ['first', recordId, 'second']);
  assert.deepEqual(ids(groupConversation([first, tiedOwner, run, wrapper({}, 500)], publicFirst)), ['first', recordId, 'second']);
});

test('public-only start time and first-seen identity stay stable across identical async enrichments', () => {
  const seen = new Map<string, number>();
  const records = [owner('first', 1), projected({ startedAt: 10 }, 500), owner('second', 20)];
  assert.deepEqual(ids(groupConversation(records, seen)), ['first', recordId, 'second']);
  const updated = projected({ startedAt: 10, summary: 'late result', state: 'completed' }, 1000);
  assert.deepEqual(ids(groupConversation([records[2], updated, updated, records[0]], seen)), ['first', recordId, 'second']);
});

const unsafeParentPatches: ServerRecord['data'][] = [
  { taskId: otherTask }, { taskId: null }, { taskId: [] }, { sessionId: otherSession },
  { sessionId: null }, { parentSessionId: otherSession }, { callId: 'other' }, { callId: null },
  { arguments: { action: 'status' } }, { name: 'another-tool' },
];
for (const patch of unsafeParentPatches) test(`no unsafe parent matching: ${JSON.stringify(patch)}`, () => {
  const stream = wrapper(patch), run = projected();
  assert.equal(isSubagentParent(stream, parse(run)), false);
  assert.deepEqual(ids(groupConversation([stream, run], new Map())), [parentToolId, recordId]);
});

test('name/args/callId alone never dedupe; exact task and digest allow session-omitting real wrappers', () => {
  const run = projected();
  const unrelated = { ...wrapper(), id: 'c'.repeat(64) };
  assert.equal(isSubagentParent(wrapper(), parse(run)), true);
  assert.equal(isSubagentParent(wrapper({ sessionId }), parse(run)), true);
  assert.equal(isSubagentParent(unrelated, parse(run)), false);
  assert.deepEqual(ids(groupConversation([unrelated, run], new Map())), [unrelated.id, recordId]);
  assert.deepEqual(ids(groupConversation([wrapper(), projected({ taskId: 'bad' })], new Map())), [parentToolId]);
});

test('subagent cards stay outside activity groups without changing empty-envelope/reasoning behavior', () => {
  const tool = (id: string) => row('tool_stream', id, 1, { name: 'read' });
  for (const run of [wrapper(), projected()]) {
    assert.equal(isExecutionRecord(run), false);
    const records = [tool('a'), row('message', 'reasoning', 1, { author: 'assistant', thinking: 'Retained reasoning', text: '' }), tool('b'), run, tool('c')];
    const before = structuredClone(records);
    assert.deepEqual(activityChunks(records).map(chunk => chunk.map(record => record.id)), [['a', 'b'], [run.id], ['c']]);
    assert.deepEqual(records, before);
  }
});

for (const [child, kind, active] of [
  ['running', 'running', true], ['queued', 'running', true], ['failed', 'error', false],
  ['partial', 'review', false], ['unknown', 'review', false], ['stopped', 'stopped', false],
] as const) for (const parent of ['running', 'verifying', 'completed']) {
  test(`parent ${parent} reports child ${child} without false success`, () => {
    const result = taskRunStatus(task(parent), [projected({ state: child, streaming: false }), wrapper()]);
    assert.equal(result.kind, kind);
    assert.equal(result.active, active);
    assert.equal(result.transient, false);
  });
}

test('completed native child may have incomplete details without inventing a failed outcome', () => {
  assert.equal(taskRunStatus(task('completed'), [projected({ state: 'completed', incomplete: true })]).kind, 'success');
});

test('authoritative cancellation/failure/interruption and pending approval retain precedence', () => {
  for (const child of ['running', 'failed', 'partial', 'unknown'] as const) {
    const records = [projected({ state: child })];
    assert.deepEqual(taskRunStatus(task('cancelled'), records), { label: 'Cancelled', kind: 'stopped', active: false, transient: true });
    assert.equal(taskRunStatus(task('failed'), records).label, 'Failed');
    assert.equal(taskRunStatus(task('interrupted'), records).label, 'Interrupted');
    assert.equal(taskRunStatus(task('completed'), [...records, row('action', 'approval', 1, { state: 'pending' })]).label, 'Waiting for approval');
  }
});

test('a mismatched foreign wrapper cannot mask a child outcome or become linked by actionId', () => {
  const foreign = wrapper({ taskId: otherTask, state: 'running', streaming: true });
  const child = projected({ state: 'failed' });
  assert.equal(taskRunStatus(task('completed'), [foreign, child]).kind, 'error');
  const action = row('action', 'linked-action', 30, { state: 'succeeded' });
  const launch = wrapper({ actionId: action.id });
  assert.deepEqual(ids(groupConversation([launch, action], new Map())), [parentToolId, action.id]);
  const plain = row('tool_stream', 'plain', 10, { name: 'read', taskId: otherTask, actionId: action.id });
  assert.deepEqual(ids(groupConversation([plain, action], new Map())), [plain.id, action.id]);
});

test('parent active count deduplicates wrappers and gateway interruption cannot report ongoing child work', () => {
  const records = [wrapper({ state: 'running', streaming: true }), projected(),
    row('message', 'response', 40, { author: 'assistant', streaming: true, text: 'Working' })];
  assert.match(taskRunStatus(task('running'), records).label, /2 active/);
  assert.equal(taskRunStatus(task('completed'), [projected({ interrupted: true, streaming: true })]).kind, 'review');
  assert.equal(taskRunStatus(task('completed'), [wrapper()]).kind, 'review');
  assert.equal(taskRunStatus(task('completed'), [projected({ taskId: otherTask, state: 'failed' })]).kind, 'success');
  const old = projected({ state: 'failed' });
  const newer = { ...projected({ state: 'completed' }), revision: 2 };
  assert.equal(taskRunStatus(task('completed'), [newer, old, wrapper()]).kind, 'success');
});
