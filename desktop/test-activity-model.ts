import assert from 'node:assert/strict';
import test from 'node:test';
import { activityChunks, activitySummary, executionOutcome } from './src/activity-model';
import type { ServerRecord } from './src/types';

const row = (kind: string, id: string, data: ServerRecord['data'] = {}): ServerRecord => ({
  kind, id, revision: 1, updatedAt: '2026-11-17T12:00:00Z', data: { taskId: 'task', ...data },
});
const tool = (id: string, state = 'finished') => row('tool_stream', id, { name: id, state, streaming: state !== 'finished' });
const message = (id: string, data: ServerRecord['data'] = {}) => row('message', id, { author: 'assistant', text: '', ...data });

test('real tool-only model steps form one six-row stack rather than six singleton cards', () => {
  const names = ['pwd', 'ollama_web_search', 'ollama_web_fetch', 'ollama_web_fetch_2', 'mkdir', 'write'];
  const records = names.flatMap((name, index) => [message(`message-${index}`, { stopReason: 'toolUse', thinking: index % 2 ? 'Inspecting tool results.' : '' }), tool(name, index === 5 ? 'preparing' : 'finished')]);
  const chunks = activityChunks(records);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].map(record => record.id), names);
  assert.deepEqual(activitySummary(chunks[0]), { completed: 5, attention: false, active: true, complete: false, label: 'Working' });
});

for (const data of [{}, { text: ' \n\t' }, { thinking: 'Visible reasoning stays in RunReasoning.' }, { streaming: true }, { stopReason: 'toolUse' }]) {
  test(`invisible assistant envelope does not split activity: ${JSON.stringify(data)}`, () => {
    const first = tool('first'), last = tool('last');
    assert.deepEqual(activityChunks([first, message('envelope', data), last]), [[first, last]]);
  });
}

for (const data of [
  { text: 'A visible answer.' }, { error: 'Provider failed.' }, { interrupted: true }, { outputTruncated: true },
  { stopReason: 'error' }, { stopReason: 'aborted' }, { author: 'owner' }, { author: 'system' },
]) {
  test(`visible and non-assistant messages preserve a boundary: ${JSON.stringify(data)}`, () => {
    const first = tool('first'), divider = message('divider', data), last = tool('last');
    assert.deepEqual(activityChunks([first, divider, last]), [[first], [divider], [last]]);
  });
}

test('images remain outside groups and no input records, text or reasoning are modified', () => {
  const records = [tool('first'), message('reasoning', { thinking: 'Retained model reasoning.' }), row('artifact', 'image', { mime: 'image/png' }), tool('last')];
  const before = structuredClone(records);
  assert.deepEqual(activityChunks(records).map(chunk => chunk.map(record => record.id)), [['first'], ['image'], ['last']]);
  assert.deepEqual(records, before);
});

test('authorized actions are active queued work, not approval or completion', () => {
  const authorized = row('action', 'automatic', { state: 'authorized' });
  assert.equal(executionOutcome(authorized), 'active');
  assert.deepEqual(activitySummary([tool('finished'), authorized]), {
    completed: 1, attention: false, active: true, complete: false, label: 'Working',
  });
  assert.deepEqual(activitySummary([authorized, row('action', 'legacy', { state: 'pending' })]), {
    completed: 0, attention: true, active: true, complete: false, label: 'Waiting for approval',
  });
});

test('automatic work does not hide failures, unknown outcomes, interruptions or denied actions', () => {
  for (const data of [
    { state: 'failed' }, { state: 'unknown' }, { state: 'denied' }, { state: 'cancelled' },
    { state: 'authorized', interrupted: true }, { state: 'authorized', result: { exitCode: 7 } },
    { state: 'succeeded', result: { agent_reported_success: false } },
  ]) {
    const evidence = row('action', 'evidence', data);
    assert.equal(executionOutcome(evidence), 'attention');
    assert.deepEqual(activitySummary([row('action', 'automatic', { state: 'authorized' }), evidence]), {
      completed: 0, attention: true, active: true, complete: false, label: 'Needs attention',
    });
  }
  assert.equal(executionOutcome(row('action', 'unfamiliar', { state: 'future_state' })), 'waiting');
});

test('late visible content splits and clearing it merges the presentation without reordering records', () => {
  const first = tool('first'), last = tool('last');
  assert.deepEqual(activityChunks([first, message('changing'), last]), [[first, last]]);
  const visible = message('changing', { text: 'A later response.' });
  assert.deepEqual(activityChunks([first, visible, last]), [[first], [visible], [last]]);
  assert.deepEqual(activityChunks([first, message('changing', { thinking: 'Still retained.' }), last]), [[first, last]]);
});
