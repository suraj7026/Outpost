import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { Ledger } from '../core/ledger.js';
import { LiveFeed } from '../gateway/live.js';
import { liveEvents } from './live-events.js';

test('tool errors retain their explanation without requiring a coordinator action ID', () => {
  const db = new Ledger(), feed = new LiveFeed(db), consume = liveEvents(feed, 'task', 'session', 'fixture');
  try {
    consume({ type: 'tool_execution_start', toolCallId: 'bad-arguments', toolName: 'outpost_action', args: { tool: 'file.write', arguments: { path: 'MEMORY.md' } } });
    consume({ type: 'tool_execution_end', toolCallId: 'bad-arguments', toolName: 'outpost_action', isError: true,
      result: { content: [{ type: 'text', text: 'invalid_tool_arguments: No action was executed. Use the inputSchema.' }], details: { diagnostic: 'not-public' } } });
    const record = db.list('tool_stream')[0]; assert.ok(record);
    assert.equal(record.data.state, 'error'); assert.equal(record.data.actionId, null);
    assert.match(String(record.data.output), /invalid_tool_arguments/);
    assert.equal(record.data.streaming, false);
    assert.doesNotMatch(JSON.stringify(record), /not-public/);
    consume({ type: 'tool_execution_start', toolCallId: 'corrected', toolName: 'outpost_action', args: { tool: 'command.run', arguments: { argv: ['/bin/pwd'] } } });
    consume({ type: 'tool_execution_end', toolCallId: 'corrected', toolName: 'outpost_action', isError: false,
      result: { content: [{ type: 'text', text: 'Succeeded' }], details: { actionId: 'actual-action' } } });
    const success = db.list('tool_stream').find(r => r.data.callId === 'corrected');
    assert.equal(success?.data.state, 'finished'); assert.equal(success?.data.actionId, 'actual-action');
    assert.equal(db.list('tool_stream').find(r => r.data.callId === 'bad-arguments')?.data.state, 'error', 'A later success never rewrites an earlier failure');
  } finally { db.close(); }
});

test('live projections exclude redacted reasoning and opaque signatures, and finalize once',() => {
  const db = new Ledger(), feed = new LiveFeed(db), consume = liveEvents(feed,'task','session','fixture');
  const event: AgentSessionEvent = { type: 'message_start',message: {
    role: 'assistant',api: 'openai-completions',provider: 'outpost-ollama',model: 'fixture',timestamp: 1,stopReason: 'pending',
    usage: { input: 0,output: 0,cacheRead: 0,cacheWrite: 0,totalTokens: 0,cost: { input: 0,output: 0,cacheRead: 0,cacheWrite: 0,total: 0 } },
    content: [{ type: 'thinking',thinking: 'redacted-secret',thinkingSignature: 'opaque-secret',redacted: true },{ type: 'thinking',thinking: 'provider-visible',thinkingSignature: 'opaque-replay' },{ type: 'text',text: 'answer' }],
  } };
  try {
    consume(event);
    const wire = JSON.stringify(feed.snapshot());
    assert.match(wire,/provider-visible/); assert.doesNotMatch(wire,/redacted-secret|opaque-secret|opaque-replay/);
    consume({ type: 'message_end',message: event.message });
    assert.equal(feed.snapshot().length,0);
    assert.equal(db.list('message').length,1);
    assert.equal(db.list('message')[0]?.data.streaming,false);
  } finally { db.close(); }
});
