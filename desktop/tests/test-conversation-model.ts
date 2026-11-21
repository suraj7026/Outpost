import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionLabel, groupConversation, linkedToolStreams, taskRunStatus } from '../src/conversation-model.ts';
import type { ServerRecord } from '../src/types.ts';

const at = (milliseconds: number) => new Date(milliseconds).toISOString();
function record(kind: string, id: string, time: number, data: ServerRecord['data'] = {}): ServerRecord {
  return { kind, id, revision: 1, updatedAt: at(time), data: { taskId: 'task', ...data } };
}
const task = (state: string, data: ServerRecord['data'] = {}) => record('task', 'task', 100, { state, ...data });
const owner = (id: string, time: number) => record('message', id, time, { author: 'owner' });
const assistant = (id: string, time: number) => record('message', id, time, { author: 'assistant', startedAt: time });
const ids = (groups: ReturnType<typeof groupConversation>) => groups.flatMap(group =>
  group.kind === 'owner' ? [group.record.id] : group.records.map(item => item.id));

// These fixtures mirror tasks/tasks.ts, pi-adapter/live-events.ts and policy/trust.ts.
test('one chronological timeline includes only conversation records and splits at every owner message', () => {
  const records = [
    record('artifact', 'artifact', 50), assistant('answer-2', 60), owner('owner-2', 40),
    record('action', 'action', 30), assistant('answer-1', 20), owner('owner-1', 10),
    record('policy', 'policy', 25), record('browser', 'browser', 26), record('run', 'server-run', 27),
  ];
  const groups = groupConversation(records, new Map());
  assert.deepEqual(groups.map(group => group.kind), ['owner', 'run', 'owner', 'run']);
  assert.deepEqual(ids(groups), ['owner-1', 'answer-1', 'action', 'owner-2', 'artifact', 'answer-2']);
  assert.deepEqual(groups.filter(group => group.kind === 'run').map(group => group.records.length), [2, 2]);
});

test('leading activity, consecutive owners and empty input do not create empty runs', () => {
  const groups = groupConversation([assistant('leading', 1), owner('one', 2), owner('two', 3)], new Map());
  assert.deepEqual(groups.map(group => group.kind), ['run', 'owner', 'owner']);
  assert.deepEqual(ids(groups), ['leading', 'one', 'two']);
  assert.deepEqual(groupConversation([], new Map()), []);
});

test('first observed updatedAt survives revisions, input reordering and owner boundaries', () => {
  const firstSeen = new Map<string, number>();
  const action = record('action', 'action', 20);
  const artifact = record('artifact', 'artifact', 30);
  const stream = record('tool_stream', 'stream', 25, { state: 'running' });
  const records = [owner('one', 10), action, stream, artifact, owner('two', 40), assistant('answer', 50)];
  const before = groupConversation(records, firstSeen);
  const after = groupConversation(records.toReversed().map(item =>
    ['action', 'artifact', 'stream'].includes(item.id) ? { ...item, revision: 2, updatedAt: at(1000) } : item), firstSeen);
  assert.deepEqual(ids(after), ids(before));
  assert.deepEqual(after.map(group => group.id), before.map(group => group.id));
});

test('immutable timestamps accept epoch milliseconds and ISO dates, including zero', () => {
  const records = [
    record('message', 'numeric', 900, { startedAt: 10 }),
    record('message', 'iso', 800, { startedAt: at(20) }),
    record('artifact', 'created', 700, { createdAt: at(30) }),
    record('artifact', 'created-number', 700, { createdAt: 35 }),
    record('message', 'zero', 600, { startedAt: 0 }),
    record('message', 'precedence', 500, { startedAt: 40, createdAt: 1 }),
  ];
  assert.deepEqual(ids(groupConversation(records, new Map())), ['zero', 'numeric', 'iso', 'created', 'created-number', 'precedence']);
});

test('invalid dates fall through safely and ties retain first-seen order across snapshots', () => {
  const firstSeen = new Map<string, number>();
  const records = [
    record('action', 'z', 10, { startedAt: 'invalid', createdAt: null }),
    record('artifact', 'a', 10, { startedAt: false }),
    record('tool_stream', 'm', 10, { startedAt: Number.NaN }),
    { ...assistant('invalid', 20), updatedAt: 'invalid', data: { startedAt: {} } },
  ];
  const initial = ids(groupConversation(records, firstSeen));
  assert.deepEqual(initial, ['z', 'a', 'm', 'invalid']);
  assert.deepEqual(ids(groupConversation(records.toReversed(), firstSeen)), initial);
  assert.ok([...firstSeen.values()].every(Number.isFinite));
});

test('run identity is tied to the owner boundary, not a changing first assistant chunk', () => {
  const firstSeen = new Map<string, number>();
  const instruction = owner('owner', 1);
  const chunk = assistant('chunk', 3);
  const before = groupConversation([instruction, chunk], firstSeen);
  const after = groupConversation([instruction, assistant('earlier', 2), chunk, assistant('later', 4)], firstSeen);
  assert.equal(after[1].id, before[1].id);
  assert.equal(after.filter(group => group.kind === 'run').length, 1);
});

test('snapshot revisions retain one latest record per identity, not one assistant identity per chunk', () => {
  const chunk = assistant('chunk', 10);
  const updated = { ...chunk, revision: 2, updatedAt: at(100), data: { ...chunk.data, text: 'Full answer' } };
  const groups = groupConversation([updated, assistant('next-chunk', 20), chunk], new Map());
  assert.equal(groups.length, 1);
  assert.deepEqual(ids(groups), ['chunk', 'next-chunk']);
  assert.ok(groups[0].kind === 'run');
  assert.equal(groups[0].records[0], updated);
});

test('record identities include kind, as in the server ledger', () => {
  assert.deepEqual(ids(groupConversation([
    record('action', 'same', 10), record('artifact', 'same', 20),
  ], new Map())), ['same', 'same']);
});

test('linked actions replace the earliest stream slot and retain every linked output', () => {
  const firstSeen = new Map<string, number>();
  const instruction = owner('owner', 1);
  const stream = record('tool_stream', 'stream', 10, { name: 'outpost_action', state: 'running', output: 'partial' });
  groupConversation([instruction, stream, assistant('chunk', 20)], firstSeen);
  const linked = { ...stream, updatedAt: at(80), data: { ...stream.data, actionId: 'action', output: 'full output', state: 'finished' } };
  const failed = record('tool_stream', 'linked-failure', 15, { actionId: 'action', state: 'error', output: 'additional failure evidence' });
  const action = record('action', 'action', 70, { state: 'succeeded' });
  const records = [instruction, assistant('chunk', 20), action, linked, failed];
  assert.deepEqual(ids(groupConversation(records, firstSeen)), ['owner', 'action', 'chunk']);
  assert.deepEqual(linkedToolStreams(records).get('action'), [linked, failed]);
  assert.equal(linkedToolStreams(records).get('action')?.[1].data.output, 'additional failure evidence');
});

test('an early linked stream keeps the replacement action before a later owner boundary', () => {
  const records = [owner('one', 1), record('tool_stream', 'stream', 10, { actionId: 'action' }),
    owner('two', 20), record('action', 'action', 30)];
  const groups = groupConversation(records, new Map());
  assert.deepEqual(groups.map(group => group.kind), ['owner', 'run', 'owner']);
  assert.deepEqual(ids(groups), ['one', 'action', 'two']);
});

test('deduplication requires an explicit actionId and a present action, never matching tool names or arguments', () => {
  const records = [
    record('action', 'action', 10, { tool: 'file.read', arguments: { path: 'a' } }),
    record('tool_stream', 'unlinked', 20, { name: 'outpost_action', callId: 'action', state: 'error', arguments: { tool: 'file.read', arguments: { path: 'a' } } }),
    record('tool_stream', 'orphan', 30, { actionId: 'missing', state: 'error' }),
    record('tool_stream', 'linked', 40, { actionId: 'action' }),
    record('tool_stream', 'null-link', 50, { actionId: null, state: 'error' }),
  ];
  assert.deepEqual(ids(groupConversation(records, new Map())), ['action', 'unlinked', 'orphan', 'null-link']);
  assert.deepEqual([...linkedToolStreams(records).keys()], ['missing', 'action']);
});

test('grouping and linkage do not mutate input records, data or array order', () => {
  const records = [record('artifact', 'b', 20), assistant('a', 10)];
  const before = structuredClone(records);
  for (const item of records) { Object.freeze(item.data); Object.freeze(item); }
  Object.freeze(records);
  groupConversation(records, new Map());
  linkedToolStreams(records);
  assert.deepEqual(records, before);
});

test('action labels reflect actual command, path and URL arguments without invented outcomes', () => {
  const cases: Array<[string, ServerRecord['data'], string]> = [
    ['host.execute', { host: 'server', command: 'apt-get install jq\necho done' }, 'Run apt-get install jq'],
    ['command.run', { argv: ['/usr/bin/git', 'status', '--short'] }, 'Run /usr/bin/git status --short'],
    ['command.run', { argv: ['/bin/bash', '-lc', 'printf hello\nprintf world'] }, 'Run printf hello'],
    ['command.run', { argv: ['/bin/sh', '-c', 'echo hello'] }, 'Run echo hello'],
    ['file.read', { path: 'src/main.ts' }, 'Read src/main.ts'],
    ['file.write', { path: 'docs/notes.md', text: 'content' }, 'Write docs/notes.md'],
    ['browser.open', { url: 'https://example.test/path' }, 'Open https://example.test/path'],
    ['system.inspect', {}, 'System inspect'],
    ['browser.act', { action: 'click' }, 'Browser act'],
  ];
  for (const [tool, args, expected] of cases) {
    assert.equal(actionLabel(record('action', tool, 1, { tool, arguments: args })), expected);
    for (const name of [undefined, 'outpost_action', 'fixture-wrapper']) {
      assert.equal(actionLabel(record('tool_stream', tool, 1, {
        ...(name ? { name } : {}), arguments: { tool, arguments: args },
      })), expected);
    }
  }
});

test('malformed or missing arguments fall back to readable tool names', () => {
  assert.equal(actionLabel(record('action', 'a', 1, { tool: 'command.run', arguments: { argv: [null, {}] } })), 'Command run');
  assert.equal(actionLabel(record('action', 'b', 1, { tool: 'file.read', arguments: { path: {} } })), 'File read');
  assert.equal(actionLabel(record('tool_stream', 'c', 1, { name: 'outpost_action' })), 'Outpost action');
  assert.equal(actionLabel(record('tool_stream', 'd', 1)), 'Tool call');
});

test('display labels are bounded, single-line and stripped of terminal and directional controls', () => {
  const label = actionLabel(record('action', 'a', 1, {
    tool: 'host.execute', arguments: { command: '\u001b[31mecho\u001b[0m \u202E' + '🙂'.repeat(200) + '\nsecret next line' },
  }));
  assert.ok(label.startsWith('Run echo '));
  assert.ok(Array.from(label).length <= 160);
  assert.ok(label.endsWith('…'));
  assert.doesNotMatch(label, /[\u001b\u202e\r\n]/u);
  assert.ok(!label.includes('secret next line'));
  assert.ok(!label.includes('\uFFFD'));
});

test('every actual task state has a truthful label and only clean terminal states are transient', () => {
  const cases: Array<[string, string, ReturnType<typeof taskRunStatus>['kind'], boolean, boolean]> = [
    ['queued', 'Queued', 'running', true, false],
    ['running', 'Running', 'running', true, false],
    ['reconciling', 'Reconciling', 'running', true, false],
    ['waiting_for_approval', 'Waiting for approval', 'review', false, false],
    ['waiting_for_login', 'Waiting for login', 'review', false, false],
    ['waiting_for_human', 'Waiting for human', 'review', false, false],
    ['waiting_for_payment_auth', 'Waiting for payment authorization', 'review', false, false],
    ['waiting_for_capacity', 'Waiting for capacity', 'idle', false, false],
    ['verifying', 'Ready for your review', 'review', false, false],
    ['completed', 'Completed', 'success', false, true],
    ['paused', 'Paused', 'stopped', false, false],
    ['cancelled', 'Cancelled', 'stopped', false, true],
    ['failed', 'Failed', 'error', false, false],
    ['interrupted', 'Interrupted', 'stopped', false, false],
  ];
  for (const [state, label, kind, active, transient] of cases) {
    assert.deepEqual(taskRunStatus(task(state), []), { label, kind, active, transient }, state);
  }
});

test('pending approval takes priority over current activity, completion and historical failures', () => {
  const records = [record('action', 'failed', 1, { state: 'failed' }),
    record('tool_stream', 'stream', 2, { state: 'running', streaming: true }),
    record('action', 'pending', 3, { state: 'pending' })];
  for (const state of ['running', 'reconciling', 'verifying', 'completed']) {
    assert.deepEqual(taskRunStatus(task(state), records), {
      label: 'Waiting for approval', kind: 'review', active: false, transient: false,
    });
  }
});

test('latest failed actions, nonzero exits and agent-reported failure persist without live work', () => {
  const failures: ServerRecord['data'][] = [
    { state: 'failed' }, { state: 'succeeded', result: { exitCode: 2 } },
    { state: 'succeeded', result: { exitCode: -1 } },
    { state: 'succeeded', result: { agent_reported_success: false } },
  ];
  for (const data of failures) {
    const result = taskRunStatus(task('verifying'), [record('action', 'action', 1, data)]);
    assert.equal(result.kind, 'error');
    assert.equal(result.transient, false);
  }
  assert.equal(taskRunStatus(task('completed'), [record('action', 'a', 1, { state: 'succeeded', result: { exitCode: 0 } })]).kind, 'success');
});

test('unknown action outcomes and latest denied actions stay visible for review', () => {
  for (const [state, label] of [['unknown', 'Action outcome unknown'], ['denied', 'Action denied']]) {
    assert.deepEqual(taskRunStatus(task('verifying'), [record('action', 'a', 1, { state })]), {
      label, kind: 'review', active: false, transient: false,
    });
  }
});

test('historical failures remain evidence without pinning the bar after newer successful work', () => {
  for (const actionId of [null, 'action']) {
    const failure = record('tool_stream', 'bad-attempt', 1, { state: 'error', actionId, output: 'Invalid arguments' });
    const records = [failure, record('action', 'action', 2, { state: 'succeeded', result: { exitCode: 0 } })];
    const before = structuredClone(records);
    assert.deepEqual(taskRunStatus(task('verifying'), records), {
      label: 'Ready for your review', kind: 'review', active: false, transient: false,
    });
    assert.deepEqual(taskRunStatus(task('running'), records), {
      label: 'Running', kind: 'running', active: true, transient: false,
    });
    const timeline = groupConversation(records, new Map());
    if (actionId) assert.deepEqual(linkedToolStreams(records).get(actionId), [failure]);
    else assert.ok(ids(timeline).includes(failure.id));
    assert.deepEqual(records, before);
  }
});

test('latest message errors and interruptions persist without newer activity or task completion', () => {
  const failures: ServerRecord['data'][] = [{ error: 'Provider failed' }, { stopReason: 'error' }];
  for (const data of failures) {
    assert.equal(taskRunStatus(task('verifying'), [record('message', 'a', 1, data)]).kind, 'error');
  }
  for (const kind of ['message', 'tool_stream']) {
    assert.deepEqual(taskRunStatus(task('verifying'), [record(kind, 'partial', 1, { streaming: false, interrupted: true })]), {
      label: 'Interrupted', kind: 'stopped', active: false, transient: false,
    });
  }
});

test('task failures and interruptions are preserved despite successful records', () => {
  const records = [record('action', 'ok', 1, { state: 'succeeded', result: { exitCode: 0 } })];
  assert.deepEqual(taskRunStatus(task('failed'), records), { label: 'Failed', kind: 'error', active: false, transient: false });
  assert.deepEqual(taskRunStatus(task('interrupted'), records), { label: 'Interrupted', kind: 'stopped', active: false, transient: false });
});

test('blocked and unfamiliar states never default to success or auto-hide', () => {
  assert.deepEqual(taskRunStatus(task('running', { blocker: 'Needs operator input' }), []), {
    label: 'Blocked', kind: 'review', active: false, transient: false,
  });
  assert.deepEqual(taskRunStatus(task('future_state'), []), {
    label: 'Future state', kind: 'idle', active: false, transient: false,
  });
  assert.deepEqual(taskRunStatus(task(''), []), { label: 'Idle', kind: 'idle', active: false, transient: false });
});

test('cancelled is neutral and transient despite errors, safety notices or stale streaming flags', () => {
  const records = [
    record('tool_stream', 'old-error', 1, { state: 'error' }),
    record('action', 'unknown', 2, { state: 'unknown' }),
    record('action', 'pending', 3, { state: 'pending' }),
    record('action', 'dispatched', 4, { state: 'dispatching' }),
    record('message', 'partial', 5, { author: 'assistant', streaming: true, interrupted: true }),
  ];
  assert.deepEqual(taskRunStatus(task('cancelled', { blocker: 'Old blocker' }), records), {
    label: 'Cancelled', kind: 'stopped', active: false, transient: true,
  });
  assert.equal(ids(groupConversation(records, new Map())).length, records.length);
});

test('completed is authoritative except for pending or unknown action safety notices', () => {
  const records = [record('action', 'failed', 1, { state: 'failed', result: { exitCode: 1 } }),
    record('tool_stream', 'error', 2, { state: 'error' }),
    record('message', 'partial', 3, { interrupted: true }),
    record('action', 'stale-active', 4, { state: 'dispatching' })];
  assert.deepEqual(taskRunStatus(task('completed'), records), {
    label: 'Completed', kind: 'success', active: false, transient: true,
  });
  for (const [state, label] of [['pending', 'Waiting for approval'], ['unknown', 'Action outcome unknown']]) {
    assert.deepEqual(taskRunStatus(task('completed'), [...records, record('action', state, 1, { state })]), {
      label, kind: 'review', active: false, transient: false,
    });
  }
});

test('an active retry outranks historical failures without removing or rewriting them', () => {
  const failures = [record('action', 'failed-action', 1, { state: 'failed' }),
    record('tool_stream', 'failed-tool', 2, { state: 'error', output: 'First attempt failed' }),
    record('message', 'interrupted-message', 3, { interrupted: true })];
  const retries = [
    record('action', 'retry', 4, { state: 'dispatching', tool: 'host.execute', arguments: { command: 'apt-get install jq' } }),
    record('tool_stream', 'retry-stream', 4, { state: 'running', streaming: true,
      arguments: { tool: 'host.execute', arguments: { command: 'apt-get install jq' } } }),
  ];
  for (const state of ['running', 'reconciling']) for (const retry of retries) {
    const records = [retry, ...failures];
    const before = structuredClone(records);
    assert.deepEqual(taskRunStatus(task(state), records), {
      label: 'Run apt-get install jq', kind: 'running', active: true, transient: false,
    });
    assert.deepEqual(ids(groupConversation(records, new Map())), [...failures.map(item => item.id), retry.id]);
    assert.deepEqual(records, before);
  }
});

test('running phases follow actual streaming content, tool arguments and dispatch state', () => {
  const message = record('message', 'message', 1, { author: 'assistant', streaming: true });
  assert.equal(taskRunStatus(task('running'), [message]).label, 'Waiting for model output');
  const thinking = { ...message, updatedAt: at(2), data: { ...message.data, thinking: 'Considering the request' } };
  assert.equal(taskRunStatus(task('running'), [thinking]).label, 'Thinking');
  const responding = { ...thinking, updatedAt: at(3), data: { ...thinking.data, text: 'I will inspect the file.' } };
  assert.equal(taskRunStatus(task('running'), [responding]).label, 'Responding');
  const settled = { ...responding, data: { ...responding.data, streaming: false } };
  const stream = record('tool_stream', 'tool', 4, { state: 'preparing', streaming: true,
    arguments: { tool: 'file.read', arguments: { path: 'package.json' } } });
  assert.equal(taskRunStatus(task('running'), [settled, stream]).label, 'Read package.json');
  const action = record('action', 'action', 5, { state: 'dispatching', tool: 'file.read', arguments: { path: 'package.json' } });
  const linked = { ...stream, data: { ...stream.data, state: 'running', actionId: action.id } };
  assert.equal(taskRunStatus(task('running'), [settled, linked, action]).label, 'Read package.json');
  const done = { ...action, updatedAt: at(6), data: { ...action.data, state: 'succeeded' } };
  assert.equal(taskRunStatus(task('running'), [settled, linked, done]).label, 'Running');
});

test('parallel count deduplicates linked streams and uses the newest tool label before message text', () => {
  const action = record('action', 'action', 1, { state: 'dispatching', tool: 'file.read', arguments: { path: 'a.ts' } });
  const records = [action,
    record('tool_stream', 'linked', 5, { state: 'running', streaming: true, actionId: action.id }),
    record('tool_stream', 'also-linked', 6, { state: 'running', streaming: true, actionId: action.id }),
    record('tool_stream', 'independent', 7, { state: 'running', streaming: true,
      arguments: { tool: 'file.write', arguments: { path: 'b.ts' } } }),
    record('message', 'response', 8, { author: 'assistant', streaming: true, text: 'Working on files' })];
  for (const snapshot of [records, records.toReversed()]) {
    assert.deepEqual(taskRunStatus(task('running'), snapshot), {
      label: 'Write b.ts · 3 active', kind: 'running', active: true, transient: false,
    });
  }
});

test('parallel activity labels remain bounded and retain the count for huge commands', () => {
  const records = [record('action', 'a', 2, { state: 'dispatching', tool: 'host.execute', arguments: { command: '🙂'.repeat(200) } }),
    record('action', 'b', 1, { state: 'dispatching', tool: 'file.read', arguments: { path: 'a' } })];
  const label = taskRunStatus(task('running'), records).label;
  assert.ok(Array.from(label).length <= 160);
  assert.match(label, /… · 2 active$/u);
});

test('authorized actions show queued automatic work without claiming dispatch or requiring approval', () => {
  const queued = record('action', 'automatic', 1, { state: 'authorized', tool: 'file.read', arguments: { path: 'a' } });
  const wrapper = record('tool_stream', 'wrapper', 2, { state: 'running', streaming: true, actionId: queued.id });
  for (const state of ['running', 'reconciling']) {
    assert.deepEqual(taskRunStatus(task(state), [queued, wrapper]), {
      label: 'Queued: Read a', kind: 'running', active: true, transient: false,
    });
  }
  const dispatched = { ...queued, revision: 2, data: { ...queued.data, state: 'dispatching' } };
  assert.equal(taskRunStatus(task('running'), [queued, dispatched, wrapper]).label, 'Read a');
  assert.equal(taskRunStatus(task('running'), [queued, record('action', 'pending', 3, { state: 'pending' })]).label, 'Waiting for approval');
  assert.equal(taskRunStatus(task('running'), [queued, record('action', 'unknown', 3, { state: 'unknown' })]).label, 'Action outcome unknown');
  for (const state of ['paused', 'failed', 'interrupted', 'cancelled', 'completed', 'waiting_for_approval']) {
    assert.deepEqual(taskRunStatus(task(state), [queued]), taskRunStatus(task(state), []));
  }
  for (const result of [{ exitCode: 7 }, { agent_reported_success: false }]) {
    const failed = { ...queued, data: { ...queued.data, result } };
    assert.equal(taskRunStatus(task('running'), [failed]).kind, 'error');
  }
  const long = { ...queued, data: { ...queued.data, arguments: { path: 'a'.repeat(200) } } };
  assert.ok(Array.from(taskRunStatus(task('running'), [long]).label).length <= 160);
});

test('inactive, failed or interrupted projections are not live work', () => {
  const cases: ServerRecord[] = [
    record('action', 'not-a-server-state', 1, { state: 'running', tool: 'file.read', arguments: { path: 'a' } }),
    record('tool_stream', 'settled', 1, { state: 'running', streaming: false }),
    record('tool_stream', 'finished', 1, { state: 'finished', streaming: true }),
    record('tool_stream', 'interrupted', 1, { state: 'running', streaming: true, interrupted: true }),
    record('tool_stream', 'failed', 1, { state: 'error', streaming: true }),
    record('message', 'partial', 1, { author: 'assistant', streaming: true, interrupted: true }),
  ];
  const newer = record('message', 'newer', 10, { author: 'assistant', text: 'Next step', streaming: false });
  for (const candidate of cases) {
    assert.equal(taskRunStatus(task('running'), [candidate, newer]).label, 'Running', candidate.id);
  }
});

test('pending and unknown actions outrank live retries but explicit stopped or failed tasks remain authoritative', () => {
  const retry = record('action', 'retry', 3, { state: 'dispatching', tool: 'file.read', arguments: { path: 'a' } });
  const unknown = record('action', 'unknown', 1, { state: 'unknown' });
  const pending = record('action', 'pending', 2, { state: 'pending' });
  assert.equal(taskRunStatus(task('running'), [retry, unknown]).label, 'Action outcome unknown');
  assert.equal(taskRunStatus(task('running'), [retry, unknown, pending]).label, 'Waiting for approval');
  for (const state of ['failed', 'interrupted']) {
    assert.equal(taskRunStatus(task(state), [retry, unknown, pending]).label, state === 'failed' ? 'Failed' : 'Interrupted');
  }
  assert.equal(taskRunStatus(task('paused'), [retry]).label, 'Paused');
  assert.equal(taskRunStatus(task('waiting_for_login'), [retry]).label, 'Waiting for login');
});

test('when a retry ends in failure, the latest observation becomes a persistent error', () => {
  const earlierSuccess = record('action', 'old-success', 1, { state: 'succeeded', result: { exitCode: 0 } });
  const retry = record('tool_stream', 'retry', 2, { state: 'running', streaming: true,
    arguments: { tool: 'file.read', arguments: { path: 'missing.txt' } } });
  assert.equal(taskRunStatus(task('running'), [earlierSuccess, retry]).label, 'Read missing.txt');
  const failed = { ...retry, updatedAt: at(4), data: { ...retry.data, state: 'error', streaming: false } };
  for (const snapshot of [[earlierSuccess, failed], [failed, earlierSuccess]]) {
    assert.deepEqual(taskRunStatus(task('running'), snapshot), {
      label: 'Tool attempt failed', kind: 'error', active: false, transient: false,
    });
  }
  const artifact = record('artifact', 'artifact', 5);
  assert.equal(taskRunStatus(task('verifying'), [failed, artifact]).kind, 'error');
});

test('a newer finished wrapper does not hide the linked action failure or nonzero exit', () => {
  const action = record('action', 'action', 2, { state: 'succeeded', result: { exitCode: 1 } });
  const wrapper = record('tool_stream', 'wrapper', 3, { actionId: action.id, state: 'finished', streaming: false });
  assert.deepEqual(taskRunStatus(task('verifying'), [action, wrapper]), {
    label: 'Action failed', kind: 'error', active: false, transient: false,
  });
});

test('latest failures use observation times, not old start times, and timestamp ties stay conservative', () => {
  const failure = record('message', 'failure', 5, { author: 'assistant', startedAt: 1, error: 'Provider failed' });
  const success = record('action', 'success', 4, { state: 'succeeded' });
  assert.equal(taskRunStatus(task('verifying'), [failure, success]).label, 'Response failed');
  const sameTime = { ...success, updatedAt: at(5) };
  for (const records of [[failure, sameTime], [sameTime, failure]]) {
    assert.equal(taskRunStatus(task('verifying'), records).label, 'Response failed');
  }
});

test('status ignores other tasks, non-conversation records and superseded record revisions', () => {
  const failure = record('action', 'a', 1, { state: 'failed' });
  const records = [failure, { ...failure, revision: 2, data: { taskId: 'task', state: 'succeeded' } },
    record('action', 'other', 2, { taskId: 'other-task', state: 'pending' }),
    record('browser', 'browser', 3, { state: 'error', interrupted: true })];
  assert.equal(taskRunStatus(task('completed'), records).kind, 'success');
});
