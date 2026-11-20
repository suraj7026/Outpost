import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, symlinkSync, statSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ledger } from '../core/ledger.js';
import { digest } from '../core/contracts.js';
import { LiveFeed } from '../gateway/live.js';
import { liveEvents } from './live-events.js';
import { SubagentRuns } from './subagent-runs.js';
import { SubagentRun, subagentRecordBytes } from './subagent-contract.js';
import { Projection } from '../pi-worker/contracts.js';
import { readChildTranscript, readObservedAsyncStatus } from './subagent-transcript.js';
import { SubagentPrivacy, sensitiveToolArguments } from './subagent-privacy.js';

function fixture(sessionFile?: string) {
  const taskId = randomUUID(), sessionId = randomUUID(), db = new Ledger(), feed = new LiveFeed(db);
  const observer = new SubagentRuns(feed, { taskId, sessionId, ...(sessionFile ? { sessionFile } : {}), secrets: ['literal-private-fixture-key'] });
  const consume = liveEvents(feed, taskId, sessionId, 'parent-model', observer);
  const data = () => {
    const row = feed.snapshot().find(row => row.kind === 'subagent_run') ?? db.list('subagent_run')[0];
    assert.ok(row);
    const { streaming: _s, interrupted: _i, ...value } = row.data;
    return SubagentRun.parse(value);
  };
  return { db, feed, observer, consume, data, taskId, sessionId,
    start(args: object = { agent: 'worker', task: 'Review code', async: false }, callId = 'launch') { consume({ type: 'tool_execution_start', toolCallId: callId, toolName: 'subagent', args }); },
    update(details: object, callId = 'launch') { consume({ type: 'tool_execution_update', toolCallId: callId, toolName: 'subagent', args: {}, partialResult: { content: [], details } }); },
    end(details: object, isError = false, callId = 'launch') { consume({ type: 'tool_execution_end', toolCallId: callId, toolName: 'subagent', isError, result: { content: [{ type: 'text', text: isError ? 'Authorization: Bearer PRIVATE-ERROR' : 'Done' }], details } }); },
    close() { observer.close(); feed.interrupt(taskId); db.close(); },
  };
}

test('run title uses the observed assignment first line with bounded agent fallback', () => {
  const f = fixture();
  try {
    f.start({ agent: 'worker', task: 'Update navigation and approval regressions\nInspect the existing tests.' });
    assert.equal(f.data().label, 'Update navigation and approval regressions');
    assert.equal(f.data().agent, 'worker');
    assert.match(f.data().assignment!, /Inspect the existing tests/);
  } finally { f.close(); }
  const fallback = fixture();
  try { fallback.start({ agent: 'reviewer' }); assert.equal(fallback.data().label, 'reviewer'); }
  finally { fallback.close(); }
  const long = fixture();
  try { long.start({ task: 'x'.repeat(300) }); assert.equal(long.data().label.length, 256); }
  finally { long.close(); }
});

test('foreground records correlate stable child indices, not array positions; tool end needs child proof', () => {
  const f = fixture();
  try {
    f.start();
    f.update({ runId: 'root', results: [{ index: 7, agent: 'worker', progress: { status: 'running', currentTool: 'read' } }, { index: 2, agent: 'reviewer' }] });
    f.end({ runId: 'root', results: [{ index: 2, agent: 'reviewer', exitCode: 0 }, { index: 7, agent: 'worker', exitCode: 0, model: 'child-model' }] });
    const run = f.data();
    assert.equal(run.state, 'completed'); assert.equal(run.parentSessionId, f.sessionId);
    assert.equal(run.parentToolId, digest({ sessionId: f.sessionId, callId: 'launch' }));
    assert.deepEqual(run.children?.map(child => [child.id, child.state]), [['step:7', 'completed'], ['step:2', 'completed']]);
    assert.equal(run.stopSupported, false); assert.equal(run.incomplete, true);
    assert.equal(f.db.list('subagent_run').length, 1);
    assert.ok(Projection.safeParse({ kind: 'subagent_run', sequence: 1, final: true, id: 'a'.repeat(64), data: run }).success);
    assert.equal(Projection.safeParse({ kind: 'subagent_run', sequence: 1, final: true, id: 'a'.repeat(64), data: { ...run, capabilityToken: 'not-public' } }).success, false);
  } finally { f.close(); }
});

for (const [result, expected] of [
  [{ index: 0, exitCode: 0 }, 'completed'], [{ index: 0, exitCode: 1 }, 'failed'],
  [{ index: 0, exitCode: 0, stopped: true }, 'stopped'], [{ index: 0, exitCode: 0, interrupted: true }, 'partial'],
  [{ index: 0, exitCode: 0, detached: true }, 'partial'], [{ index: 0, exitCode: 0, timedOut: true }, 'partial'],
  [{ index: 0, status: 'completed' }, 'unknown'],
] as const) test(`foreground outcome is ${expected} for ${JSON.stringify(result)}`, () => {
  const f = fixture(); try { f.start(); f.end({ runId: 'root', results: [result] }); assert.equal(f.data().state, expected); } finally { f.close(); }
});

test('async receipt does not finish child; exact owned completion is monotonic and duplicates do not create rows', () => {
  const f = fixture();
  try {
    f.start({ agent: 'worker', async: true });
    f.observer.extensionEvent('subagent:async-started', { id: 'async-root', sessionId: f.sessionId, task: '[prompt redacted]' });
    f.end({ mode: 'single', runId: 'async-root', asyncId: 'async-root', asyncDir: '/private/run', results: [] });
    assert.equal(f.data().state, 'running'); assert.equal(f.data().executionMode, 'background');
    assert.equal(f.data().endedAt, undefined);
    f.observer.extensionEvent('subagent:async-complete', { runId: 'async-root', sessionId: randomUUID(), state: 'complete' });
    assert.equal(f.data().state, 'running');
    f.observer.extensionEvent('subagent:async-complete', { runId: 'async-root', sessionId: f.sessionId, state: 'stopped', timestamp: 100 });
    f.observer.extensionEvent('subagent:async-complete', { runId: 'async-root', sessionId: f.sessionId, state: 'complete', timestamp: 110 });
    assert.equal(f.data().state, 'stopped'); assert.equal(f.data().endedAt, 100);
    assert.equal(f.db.list('subagent_run').length, 1);
  } finally { f.close(); }
});

test('custom notify and bg_wait completion details settle known runs only', () => {
  const f = fixture();
  try {
    f.start({ agent: 'worker', async: true }); f.end({ asyncId: 'background', results: [] });
    f.consume({ type: 'message_end', message: { role: 'custom', customType: 'subagent-notify', content: 'notice', display: true, timestamp: 1,
      details: { runs: [{ runId: 'background', status: 'completed' }, { runId: 'unowned', status: 'completed' }] } } });
    assert.equal(f.data().state, 'completed');
    f.start({ agent: 'worker', async: true }, 'launch2'); f.end({ asyncId: 'background2', results: [] }, false, 'launch2');
    f.consume({ type: 'tool_execution_end', toolCallId: 'wait', toolName: 'bg_wait', isError: false,
      result: { content: [], details: { completions: [{ runId: 'background2', state: 'failed' }] } } });
    assert.equal(f.db.list('subagent_run').length, 2);
    assert.equal(f.db.list('subagent_run').find(row => row.data.parentCallId === 'launch2')?.data.state, 'failed');
  } finally { f.close(); }
});

test('workflow child completion never completes its parent; unrelated, foreign and management calls produce no rows', () => {
  const f = fixture();
  try {
    f.start({ action: 'status', id: 'someone-else' });
    f.observer.extensionEvent('subagent:async-started', { id: 'other', sessionId: randomUUID(), agent: 'worker' });
    assert.equal(f.feed.snapshot().filter(row => row.kind === 'subagent_run').length, 0);
    f.start({ workflow: 'review', async: true }, 'workflow');
    f.end({ runId: 'workflow-root', asyncId: 'workflow-root', workflowChildren: { children: [{ childId: 'review', runId: 'child', agent: 'reviewer', state: 'running' }] } }, false, 'workflow');
    f.observer.extensionEvent('subagent:async-complete', { id: 'child', sessionId: f.sessionId, state: 'complete' });
    assert.equal(f.data().state, 'running'); assert.equal(f.db.list('subagent_run').length, 1);
    assert.equal(f.data().children?.find(child => child.id === 'review')?.state, 'completed');
    f.observer.close();
    assert.equal(f.data().state, 'unknown'); assert.equal(f.data().incomplete, true); assert.equal(f.data().endedAt, undefined);
    f.observer.extensionEvent('subagent:async-complete', { id: 'workflow-root', state: 'complete' });
    assert.equal(f.data().state, 'unknown');
  } finally { f.close(); }
});

test('a detached foreground child completion never turns its still-running parent group green', () => {
  const f = fixture();
  try {
    f.start({ workflow: 'review', async: false });
    f.update({ runId: 'group', results: [{ index: 0, agent: 'worker' }, { index: 1, agent: 'worker' }] });
    f.observer.extensionEvent('subagent:foreground-complete', { runId: 'group', id: 'group:0', sessionId: f.sessionId, taskIndex: 0, agent: 'worker', state: 'complete', exitCode: 0 });
    assert.equal(f.data().state, 'running'); assert.equal(f.data().endedAt, undefined);
    assert.equal(f.data().children?.[0]?.state, 'completed'); assert.equal(f.data().children?.[1]?.state, 'unknown');
  } finally { f.close(); }
});

test('private paths, capability metadata, provider errors and all reasoning stay out of public child projections', () => {
  const f = fixture();
  try {
    f.start({ agent: 'worker', task: 'Use literal-private-fixture-key at /private/session/auth.json', options: { capabilityToken: 'HIDDEN-CAPABILITY', headers: { authorization: 'Bearer HIDDEN-AUTH' } } });
    f.update({ runId: 'root', asyncDir: '/private/native', nestedRoute: { capabilityToken: 'HIDDEN-CAPABILITY' }, results: [{ index: 0, agent: 'worker', messages: [
      { role: 'assistant', timestamp: 1, content: [{ type: 'thinking', thinking: 'HIDDEN-REASONING' }, { type: 'text', text: 'Visible work' }, { type: 'toolCall', id: 'tool1', name: 'read', arguments: { path: '/private/auth.json', apiKey: 'HIDDEN-KEY', note: 'password=HIDDEN-PASSWORD' } }] },
      { role: 'toolResult', toolCallId: 'tool1', toolName: 'read', isError: true, content: [{ type: 'text', text: 'HIDDEN-PROVIDER-ERROR' }] },
    ] }] });
    f.end({}, true);
    const wire = JSON.stringify(f.db.list('subagent_run'));
    assert.match(wire, /Visible work/); assert.match(wire, /subagent_execution_failed/);
    assert.doesNotMatch(wire, /HIDDEN-|literal-private-fixture-key|\/private\//);
    assert.doesNotMatch(JSON.stringify(f.db.list('tool_stream')), /HIDDEN-|\/private\//);
  } finally { f.close(); }
});

test('sensitive file reads and unlinked tool outputs are withheld even when no secret pattern exists in their output', () => {
  const f = fixture();
  try {
    f.start(); f.update({ runId: 'root', results: [{ index: 0, agent: 'worker', messages: [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'secret', name: 'read', arguments: { path: '/private/auth.json' } }] },
      { role: 'toolResult', toolCallId: 'secret', toolName: 'read', content: [{ type: 'text', text: 'UNLABELED-SECRET' }] },
      { role: 'toolResult', toolCallId: 'unobserved', toolName: 'read', content: [{ type: 'text', text: 'UNLINKED-SECRET' }] },
    ] }] });
    assert.doesNotMatch(JSON.stringify(f.data()), /UNLABELED-SECRET|UNLINKED-SECRET/);
    assert.match(JSON.stringify(f.data()), /Tool output omitted/);
  } finally { f.close(); }
});

test('arrays, strings and serialized byte size are bounded including multibyte and escaped content', () => {
  const f = fixture();
  try {
    f.start({ task: '🦊'.repeat(20000), agent: 'worker', async: false });
    for (let batch = 0; batch < 10; batch++) f.update({ runId: 'root', results: Array.from({ length: 100 }, (_, index) => ({ index, agent: 'a'.repeat(1000), messages: [
      { role: 'assistant', timestamp: batch * 100 + index, content: [{ type: 'text', text: '\n🦊'.repeat(5000) }] },
    ] })) });
    f.end({ runId: 'root', results: [{ index: 0, exitCode: 0 }] });
    const run = f.data(); assert.equal(run.truncated, true); assert.equal(run.incomplete, true);
    assert.ok(run.activity.length <= 128); assert.ok((run.children?.length ?? 0) <= 64);
    assert.ok(Buffer.byteLength(JSON.stringify(f.db.list('subagent_run')[0])) < subagentRecordBytes);
  } finally { f.close(); }
});

test('metadata-heavy records are byte-bounded even without activity to discard; only recorded relative files survive', () => {
  const f = fixture();
  try {
    f.start({ agent: 'worker', task: '🦊'.repeat(10000), async: false });
    f.end({ runId: 'root', results: Array.from({ length: 64 }, (_, index) => ({ index, agent: '🦊'.repeat(64), model: '🦊'.repeat(128), exitCode: 0,
      effects: { fileMutation: { evidence: { changedFiles: [
        ...Array.from({ length: 64 }, (_, file) => `src/${file}-${'🦊'.repeat(240)}.txt`), '/private/auth.json', '../escape', '.env',
      ] } } } })) });
    const run = f.data();
    assert.equal(run.state, 'completed'); assert.equal(run.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(f.db.list('subagent_run')[0])) < subagentRecordBytes);
    assert.ok(run.files?.every(file => file.path.startsWith('src/')));
  } finally { f.close(); }
});

test('exact recorded transcript is read incrementally, sanitized and persisted; missing evidence remains explicit', () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-child-transcript-')), parent = join(root, 'parent.jsonl');
  const artifacts = join(root, 'subagent-artifacts'); mkdirSync(artifacts);
  const path = join(artifacts, 'run_worker_0_transcript.jsonl');
  const record = (value: object) => JSON.stringify({ version: 1, runId: 'run', agent: 'worker', childIndex: 0, ...value }) + '\n';
  writeFileSync(path, record({ recordType: 'tool_start', toolCallId: 'read1', toolName: 'read', argsPayload: '{"path":"README.md"}', ts: 1 }));
  const f = fixture(parent);
  try {
    f.start(); f.update({ runId: 'run', results: [{ index: 0, agent: 'worker', transcriptPath: path }] });
    appendFileSync(path, record({ recordType: 'message', message: { role: 'toolResult', toolCallId: 'read1', toolName: 'read', content: [{ type: 'text', text: 'Read result' }] } }));
    appendFileSync(path, record({ recordType: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE-REASONING' }, { type: 'text', text: 'Finished review' }] } }));
    f.observer.refresh(); f.end({ runId: 'run', results: [{ index: 0, agent: 'worker', transcriptPath: path, exitCode: 0 }] });
    const run = f.data(); assert.equal(run.state, 'completed');
    const tools = run.activity.filter(item => item.kind === 'tool'); assert.equal(tools.length, 1);
    assert.equal(tools[0]?.state, 'completed'); assert.equal(tools[0]?.output, 'Read result');
    assert.doesNotMatch(JSON.stringify(run), /PRIVATE-REASONING|secret|transcript\.jsonl/);
    const before = JSON.stringify(run.activity); f.observer.refresh(); assert.equal(JSON.stringify(f.data().activity), before);
  } finally { f.close(); rmSync(root, { recursive: true, force: true }); }
});

test('transcript reader refuses arbitrary, sibling, symlink, replaced and mismatched child evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-child-paths-')), artifacts = join(root, 'subagent-artifacts'); mkdirSync(artifacts);
  const parent = join(root, 'parent.jsonl'), path = join(artifacts, 'run_worker_0_transcript.jsonl');
  const line = JSON.stringify({ version: 1, recordType: 'message', runId: 'other', agent: 'worker', childIndex: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'FOREIGN' }] } }) + '\n';
  writeFileSync(path, line);
  const link = { path, runId: 'run', agent: 'worker', index: 0 };
  try {
    const mismatch = readChildTranscript(parent, link, { offset: 0 }); assert.equal(mismatch.unavailable, true); assert.equal(mismatch.records.length, 0);
    assert.equal(readChildTranscript(parent, { ...link, path: join(root, 'auth.json') }, { offset: 0 }).unavailable, true);
    assert.equal(readChildTranscript(join(root, 'foreign', 'parent.jsonl'), link, { offset: 0 }).unavailable, true);
    rmSync(path); symlinkSync(join(root, 'auth.json'), path);
    assert.equal(readChildTranscript(parent, link, { offset: 0 }).unavailable, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only a correlated launch can read its exact bounded owned async sidecar; reads do not rewrite it', () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-observed-sidecar-')), previous = process.env.PI_SUBAGENTS_TEMP_ROOT;
  process.env.PI_SUBAGENTS_TEMP_ROOT = root;
  const directory = join(root, 'async-subagent-runs', 'native-run'); mkdirSync(directory, { recursive: true });
  const path = join(directory, 'status.json'), f = fixture();
  const status = { runId: 'native-run', sessionId: f.sessionId, state: 'running', startedAt: 10,
    steps: [{ agent: 'worker', model: 'provider/real-model', status: 'running', currentTool: 'read', currentToolStartedAt: 12 }] };
  writeFileSync(path, JSON.stringify(status));
  try {
    assert.equal(readObservedAsyncStatus(directory, 'native-run', [randomUUID()]), undefined);
    assert.equal(readObservedAsyncStatus(root, 'native-run', [f.sessionId]), undefined);
    f.observer.extensionEvent('subagent:async-started', { id: 'native-run', sessionId: f.sessionId, asyncDir: directory });
    assert.equal(f.db.list('subagent_run').length, 0);
    f.start({ agent: 'worker', async: true }); f.end({ asyncId: 'native-run', results: [] });
    assert.equal(f.data().model, 'provider/real-model'); assert.equal(f.data().state, 'running');
    const before = statSync(path).mtimeMs, contents = readFileSync(path, 'utf8');
    f.observer.extensionEvent('subagent:process-terminal', { runId: 'native-run' });
    assert.equal(statSync(path).mtimeMs, before); assert.equal(readFileSync(path, 'utf8'), contents);
    assert.equal(f.data().state, 'running', 'Process exit is not child success');
    writeFileSync(path, JSON.stringify({ ...status, sessionId: randomUUID(), state: 'complete' }));
    f.observer.extensionEvent('subagent:process-terminal', { runId: 'native-run' });
    assert.equal(f.data().state, 'unknown'); assert.equal(f.data().incomplete, true);
    writeFileSync(path, ' '.repeat(300 * 1024));
    assert.equal(readObservedAsyncStatus(directory, 'native-run', [f.sessionId]), undefined);
    rmSync(path); symlinkSync(join(root, 'auth.json'), path);
    assert.equal(readObservedAsyncStatus(directory, 'native-run', [f.sessionId]), undefined);
  } finally { f.close(); if (previous === undefined) delete process.env.PI_SUBAGENTS_TEMP_ROOT; else process.env.PI_SUBAGENTS_TEMP_ROOT = previous; rmSync(root, { recursive: true, force: true }); }
});

test('workflow identities reconcile summary/results once and tool replay never reopens completed activity', () => {
  const f = fixture();
  try {
    f.start({ workflow: 'review', async: false });
    f.update({ runId: 'workflow', workflowChildren: { children: [{ childId: 'review', runId: 'child', agent: 'worker', state: 'running' }] } });
    const messages = [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call|native', name: 'read', arguments: { path: 'README.md' } }] },
      { role: 'toolResult', toolCallId: 'call|native', toolName: 'read', content: [{ type: 'text', text: 'read it' }] }];
    f.update({ runId: 'workflow', results: [{ index: 0, workflowKey: 'review', runId: 'child', agent: 'worker', messages }] });
    f.update({ runId: 'workflow', results: [{ index: 0, workflowKey: 'review', runId: 'child', agent: 'worker', messages: [messages[0]] }] });
    assert.equal(f.data().activity.find(item => item.kind === 'tool')?.state, 'completed');
    f.end({ runId: 'workflow', results: [{ index: 0, workflowKey: 'review', runId: 'child', agent: 'worker', exitCode: 0 }] });
    assert.equal(f.data().children?.length, 1); assert.equal(f.data().children?.[0]?.state, 'completed');
  } finally { f.close(); }
});

test('partial final JSONL lines are retried, and file replacement/oversize tails report lost evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-child-tail-')), artifacts = join(root, 'subagent-artifacts'); mkdirSync(artifacts);
  const parent = join(root, 'parent.jsonl'), path = join(artifacts, 'run_worker_transcript.jsonl');
  const link = { path, runId: 'run', agent: 'worker', index: 0 }, cursor = { offset: 0 };
  const line = JSON.stringify({ version: 1, runId: 'run', agent: 'worker', recordType: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'bounded' }] } });
  try {
    writeFileSync(path, line.slice(0, 10)); assert.equal(readChildTranscript(parent, link, cursor).pending, true); assert.equal(cursor.offset, 0);
    appendFileSync(path, line.slice(10) + '\n'); assert.equal(readChildTranscript(parent, link, cursor).records.length, 1);
    renameSync(path, `${path}.old`); writeFileSync(path, line + '\n');
    assert.equal(readChildTranscript(parent, link, cursor).unavailable, true);
    writeFileSync(path, (line + '\n').repeat(5000));
    const tail = readChildTranscript(parent, link, { offset: 0 }); assert.equal(tail.truncated, true); assert.equal(tail.unavailable, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const evidence of [
  { exitCode: 1 }, { success: false }, { execution: { status: 'failed' } },
  { timedOut: true }, { processSignal: 'SIGTERM' },
]) test(`workflow completion cannot override contradictory child evidence ${JSON.stringify(evidence)}`, () => {
  const f = fixture();
  try {
    f.start({ workflow: 'review', async: false });
    f.end({ runId: 'root', workflowChildren: { workflowState: 'completed', children: [{ childId: 'worker', state: 'completed', ...evidence }] } });
    assert.notEqual(f.data().state, 'completed');
    assert.notEqual(f.data().children?.[0]?.state, 'completed');
  } finally { f.close(); }
});

test('foreground failure is not overwritten by a later successful tool receipt', () => {
  const f = fixture();
  try {
    f.start(); f.end({ runId: 'root', results: [{ index: 0, exitCode: 1 }] });
    f.end({ runId: 'root', results: [{ index: 0, exitCode: 0 }] });
    assert.equal(f.data().state, 'failed');
  } finally { f.close(); }
});

test('observation failure immediately publishes unknown without inventing child completion', () => {
  const f = fixture();
  try {
    f.start({ agent: 'worker', async: true }); f.end({ asyncId: 'root' });
    f.observer.observationFailed();
    assert.equal(f.data().state, 'unknown'); assert.equal(f.data().incomplete, true);
    assert.equal(f.data().endedAt, undefined);
    f.observer.extensionEvent('subagent:async-complete', { id: 'root', sessionId: f.sessionId, state: 'complete' });
    assert.equal(f.data().state, 'completed');
  } finally { f.close(); }
});

test('labeled private metadata is redacted from permitted text, including structured values', () => {
  const privacy = new SubagentPrivacy();
  for (const input of [
    'controlInbox=PRIVATE-ROUTE sessionFile=relative/PRIVATE-SESSION.jsonl reasoning=PRIVATE-THOUGHT',
    JSON.stringify({ thinking: { text: 'PRIVATE-THOUGHT' }, controlInbox: { route: 'PRIVATE-ROUTE' }, systemPrompt: 'PRIVATE-PROMPT' }),
  ]) assert.doesNotMatch(privacy.text(input) ?? '', /PRIVATE-/);
  assert.equal(privacy.redacted, true);
});

test('uninspected or incomplete tool arguments cannot authorize public tool output', () => {
  const wide = { ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`safe${i}`, 'ok'])), path: '/private/auth.json' };
  for (const args of [wide, { command: ' '.repeat(65536) + 'cat .env' }, '{"path":"README.md"', 'README.md', { path: '.ssh/id_rsa' }]) {
    assert.equal(sensitiveToolArguments(args), true, JSON.stringify(args).slice(0, 100));
  }
  assert.equal(sensitiveToolArguments('{"path":"README.md"}'), false);
});

test('siblings sharing their root run ID retain distinct indexed identities', () => {
  const f = fixture();
  try {
    f.start();
    f.end({ runId: 'root', results: [{ runId: 'root', index: 0, agent: 'worker', exitCode: 0 }, { runId: 'root', index: 1, agent: 'worker', exitCode: 1 }] });
    assert.deepEqual(f.data().children?.map(child => [child.id, child.state]), [['step:0', 'completed'], ['step:1', 'failed']]);
  } finally { f.close(); }
});

test('a nonterminal foreground receipt remains unknown when observation closes', () => {
  const f = fixture();
  try {
    f.start(); f.end({ runId: 'root', receipt: { state: 'running' } });
    f.observer.close();
    assert.equal(f.data().state, 'unknown'); assert.equal(f.data().incomplete, true);
    assert.equal(f.data().endedAt, undefined);
  } finally { f.close(); }
});

test('indexed transcripts require matching child indices and remember observed file loss', () => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-child-index-')), artifacts = join(root, 'subagent-artifacts'); mkdirSync(artifacts);
  const parent = join(root, 'parent.jsonl'), path = join(artifacts, 'run_worker_1_transcript.jsonl');
  const link = { path, runId: 'run', agent: 'worker', index: 1 }, cursor = { offset: 0 };
  const record = { version: 1, runId: 'run', agent: 'worker', recordType: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'child text' }] } };
  try {
    writeFileSync(path, JSON.stringify(record) + '\n');
    assert.equal(readChildTranscript(parent, link, { offset: 0 }).records.length, 0);
    writeFileSync(path, JSON.stringify({ ...record, childIndex: 1 }) + '\n');
    assert.equal(readChildTranscript(parent, link, cursor).unavailable, false);
    renameSync(path, `${path}.saved`);
    assert.equal(readChildTranscript(parent, link, cursor).unavailable, true);
    renameSync(`${path}.saved`, path);
    assert.equal(readChildTranscript(parent, link, cursor).unavailable, true, 'Restoring the inode does not recover unobserved history');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sensitive arguments and private structured text are withheld in public child records', () => {
  const f = fixture();
  try {
    f.start(); f.update({ runId: 'root', results: [{ index: 0, agent: 'worker', messages: [
      { role: 'assistant', content: [
        { type: 'text', text: '{"thinking":{"text":"PRIVATE-THOUGHT"},"controlInbox":"PRIVATE-ROUTE"}' },
        { type: 'toolCall', id: 'secret', name: 'read', arguments: { ...Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`field${i}`, 'ok'])), path: '.ssh/id_rsa' } },
      ] },
      { role: 'toolResult', toolCallId: 'secret', toolName: 'read', content: [{ type: 'text', text: 'UNLABELED-SECRET' }] },
    ] }] });
    assert.doesNotMatch(JSON.stringify(f.data()), /PRIVATE-|UNLABELED-SECRET/);
    assert.equal(f.data().incomplete, true);
  } finally { f.close(); }
});

test('oversized text cannot expose a credential prefix cut at the scan boundary', () => {
  const privacy = new SubagentPrivacy(['literal-private-fixture-key']);
  assert.doesNotMatch(privacy.text(' '.repeat(65530) + 'literal-private-fixture-key', 65536) ?? '', /literal/);
  assert.equal(privacy.truncated, true); assert.equal(privacy.redacted, true);
});

test('two sessions using identical native ids never share observed state', () => {
  const a = fixture(), b = fixture();
  try {
    a.start({ agent: 'worker', async: true }); b.start({ agent: 'worker', async: true });
    a.end({ asyncId: 'same' }); b.end({ asyncId: 'same' });
    const event = { id: 'same', sessionId: a.sessionId, state: 'complete' };
    a.observer.extensionEvent('subagent:async-complete', event); b.observer.extensionEvent('subagent:async-complete', event);
    assert.equal(a.data().state, 'completed'); assert.equal(b.data().state, 'running');
    assert.notEqual(a.data().parentToolId, b.data().parentToolId);
  } finally { a.close(); b.close(); }
});
